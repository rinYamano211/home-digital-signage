import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

// Issue #12 (technology-stack 26.7, 26.9). Runs on Linux (CI) only: the
// scripts use flock, mv -T and POSIX ownership. systemctl and curl are fakes.
const linux = test.runIf(process.platform === "linux");
const script = resolve("scripts/activate-release.sh");
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

interface Run {
  code: number;
  stderr: string;
}

function run(args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((done) => {
    execFile("sh", args, { env }, (error, _stdout, stderr) =>
      done({ code: error ? Number(error.code ?? 1) : 0, stderr }),
    );
  });
}

// Fakes:
// - curl fails while `current` points at a release listed in `bad`. For
//   http://127.0.0.1/... (nginx) it serves files of current/dist/frontend.
// - systemctl logs its arguments; `systemctl-mode` is ok, fail or fail-once.
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "hds-deploy-"));
  dirs.push(root);
  const base = join(root, "opt");
  const bin = join(root, "bin");
  const log = join(root, "systemctl.log");
  const mode = join(root, "systemctl-mode");
  const bad = join(root, "bad");
  await mkdir(join(base, "releases"), { recursive: true });
  await mkdir(bin);
  await writeFile(
    join(bin, "systemctl"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${log}'`,
      `case "$(cat '${mode}')" in`,
      "  fail) exit 1 ;;",
      `  fail-once) echo ok > '${mode}'; exit 1 ;;`,
      "esac",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(bin, "curl"),
    [
      "#!/bin/sh",
      `cur=$(basename "$(readlink '${base}/current')")`,
      `grep -qx "$cur" '${bad}' && exit 22`,
      'out=""; url=""',
      'while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2;; --max-time) shift 2;; -*) shift;; *) url=$1; shift;; esac; done',
      'case "$url" in http://127.0.0.1/*)',
      "  path=${url#http://127.0.0.1}",
      '  [ "$path" != / ] || path=/index.html',
      `  [ "$out" = /dev/null ] || cp '${base}/current/dist/frontend'"$path" "$out" || exit 22`,
      ";; esac",
      "",
    ].join("\n"),
  );
  await chmod(join(bin, "systemctl"), 0o755);
  await chmod(join(bin, "curl"), 0o755);
  await writeFile(mode, "ok");
  await writeFile(bad, "");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HDS_BASE: base,
    HDS_RELEASE_OWNER: `${process.getuid!()}:${process.getgid!()}`,
    HDS_HEALTH_TRIES: "1",
  };
  const stage = async (name: string) => {
    const dir = join(root, "incoming", name);
    for (const sub of [
      "dist/backend",
      "dist/frontend/assets",
      "scripts",
      "node_modules",
    ])
      await mkdir(join(dir, sub), { recursive: true });
    await writeFile(join(dir, "dist/backend/main.js"), "");
    await writeFile(
      join(dir, "dist/frontend/index.html"),
      `<script type="module" src="/assets/app-${name}.js"></script>` +
        `<link rel="stylesheet" href="/assets/app-${name}.css">`,
    );
    await writeFile(join(dir, `dist/frontend/assets/app-${name}.js`), name);
    await writeFile(join(dir, `dist/frontend/assets/app-${name}.css`), name);
    await writeFile(join(dir, "scripts/with-backend-lock.sh"), "");
    await writeFile(join(dir, "scripts/kiosk.sh"), "");
    await writeFile(join(dir, "package.json"), "{}");
    return dir;
  };
  const release = (name: string) => join(base, "releases", name);
  const link = (name: string) =>
    readlink(join(base, name)).catch(() => undefined);
  const markBad = (...names: string[]) => writeFile(bad, names.join("\n"));
  const setSystemctl = (value: string) => writeFile(mode, value);
  const restarts = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => line === "restart home-digital-signage-backend.service")
      .length;
  const activate = async (name: string) =>
    run([script, "activate", await stage(name)], env);
  const rollback = () => run([script, "rollback", "--schema-checked"], env);
  return {
    base,
    env,
    stage,
    release,
    link,
    markBad,
    setSystemctl,
    restarts,
    activate,
    rollback,
  };
}

const names = [
  "20261116-100000-aaaaaaa",
  "20261116-110000-bbbbbbb",
  "20261116-120000-ccccccc",
  "20261116-130000-ddddddd",
];

linux("scripts pass the shell syntax check", async () => {
  for (const file of [
    "scripts/activate-release.sh",
    "scripts/kiosk.sh",
    "scripts/with-backend-lock.sh",
  ])
    expect((await run(["-n", resolve(file)], process.env)).code).toBe(0);
});

linux("activates releases and records the previous one", async () => {
  const t = await setup();
  expect((await t.activate(names[0])).code).toBe(0);
  expect(await t.link("current")).toBe(t.release(names[0]));
  expect(await t.link("previous")).toBeUndefined();
  expect(await t.restarts()).toBe(1);

  expect((await t.activate(names[1])).code).toBe(0);
  expect(await t.link("current")).toBe(t.release(names[1]));
  expect(await t.link("previous")).toBe(t.release(names[0]));
});

linux("keeps three releases", async () => {
  const t = await setup();
  for (const name of names) expect((await t.activate(name)).code).toBe(0);
  expect((await readdir(join(t.base, "releases"))).sort()).toEqual(
    names.slice(1),
  );
});

linux("refuses a badly named or incomplete staging directory", async () => {
  const t = await setup();
  const bad = await t.stage("latest");
  expect((await run([script, "activate", bad], t.env)).code).toBe(1);
  const incomplete = await t.stage(names[0]);
  await rm(join(incomplete, "node_modules"), { recursive: true });
  expect((await run([script, "activate", incomplete], t.env)).code).toBe(1);
  expect(await readdir(join(t.base, "releases"))).toEqual([]);
  expect(await t.link("current")).toBeUndefined();
});

linux("fails the check when a static file is missing", async () => {
  const t = await setup();
  const dir = await t.stage(names[0]);
  await rm(join(dir, `dist/frontend/assets/app-${names[0]}.css`));
  const result = await run([script, "activate", dir], t.env);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("no previous release");
});

linux("switches back when the restart of the new release fails", async () => {
  const t = await setup();
  await t.activate(names[0]);
  await t.setSystemctl("fail-once");
  const result = await t.activate(names[1]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("systemctl restart failed");
  expect(result.stderr).toContain("it is healthy");
  expect(await t.link("current")).toBe(t.release(names[0]));
  expect(await t.link("previous")).toBeUndefined();
  expect(await t.restarts()).toBe(3);
});

linux("switches back and recovers from an unhealthy release", async () => {
  const t = await setup();
  await t.activate(names[0]);
  await t.markBad(names[1]);
  const result = await t.activate(names[1]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`switched back to ${names[0]}`);
  expect(result.stderr).toContain("it is healthy");
  expect(await t.link("current")).toBe(t.release(names[0]));
  expect(await t.link("previous")).toBeUndefined();
});

linux("reports when the switched-back release is unhealthy too", async () => {
  const t = await setup();
  await t.activate(names[0]);
  await t.markBad(names[0], names[1]);
  const result = await t.activate(names[1]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("NOT healthy");
  expect(await t.link("current")).toBe(t.release(names[0]));
  expect(await t.link("previous")).toBeUndefined();
});

linux("rolls back only with the schema confirmation", async () => {
  const t = await setup();
  await t.activate(names[0]);
  await t.activate(names[1]);
  const refused = await run([script, "rollback"], t.env);
  expect(refused.code).toBe(1);
  expect(await t.link("current")).toBe(t.release(names[1]));
  expect((await t.rollback()).code).toBe(0);
  expect(await t.link("current")).toBe(t.release(names[0]));
  expect(await t.link("previous")).toBe(t.release(names[1]));
});

linux("returns to the original when the rollback target fails", async () => {
  const t = await setup();
  await t.activate(names[0]);
  await t.activate(names[1]);
  await t.markBad(names[0]);
  const result = await t.rollback();
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`switched back to ${names[1]}`);
  expect(result.stderr).toContain("it is healthy");
  expect(await t.link("current")).toBe(t.release(names[1]));
  expect(await t.link("previous")).toBe(t.release(names[0]));
});

linux("reports when the original also fails after a rollback", async () => {
  const t = await setup();
  await t.activate(names[0]);
  await t.activate(names[1]);
  await t.setSystemctl("fail");
  const result = await t.rollback();
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("NOT healthy");
  expect(await t.link("current")).toBe(t.release(names[1]));
  expect(await t.link("previous")).toBe(t.release(names[0]));
});
