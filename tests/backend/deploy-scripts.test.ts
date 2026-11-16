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

// health: "ok" or "fail". The fake curl serves current/dist/frontend for /,
// like nginx, so the index.html comparison is exercised.
async function setup(health = "ok") {
  const root = await mkdtemp(join(tmpdir(), "hds-deploy-"));
  dirs.push(root);
  const base = join(root, "opt");
  const bin = join(root, "bin");
  await mkdir(join(base, "releases"), { recursive: true });
  await mkdir(bin);
  const log = join(root, "systemctl.log");
  await writeFile(
    join(bin, "systemctl"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`,
  );
  await writeFile(
    join(bin, "curl"),
    [
      "#!/bin/sh",
      `[ "$(cat '${join(root, "health")}')" = ok ] || exit 22`,
      'out=""; url=""',
      'while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2;; --max-time) shift 2;; -*) shift;; *) url=$1; shift;; esac; done',
      `if [ "$url" = http://127.0.0.1/ ] && [ "$out" != /dev/null ]; then cp '${base}/current/dist/frontend/index.html' "$out"; fi`,
      "",
    ].join("\n"),
  );
  await chmod(join(bin, "systemctl"), 0o755);
  await chmod(join(bin, "curl"), 0o755);
  await writeFile(join(root, "health"), health);
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
      "dist/frontend",
      "scripts",
      "node_modules",
    ])
      await mkdir(join(dir, sub), { recursive: true });
    await writeFile(join(dir, "dist/backend/main.js"), "");
    await writeFile(join(dir, "dist/frontend/index.html"), name);
    await writeFile(join(dir, "scripts/with-backend-lock.sh"), "");
    await writeFile(join(dir, "scripts/kiosk.sh"), "");
    await writeFile(join(dir, "package.json"), "{}");
    return dir;
  };
  const link = (name: string) =>
    readlink(join(base, name)).catch(() => undefined);
  const setHealth = (value: string) => writeFile(join(root, "health"), value);
  const calls = () => readFile(log, "utf8").catch(() => "");
  return { base, env, stage, link, setHealth, calls };
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
  const first = await t.stage(names[0]);
  expect((await run([script, "activate", first], t.env)).code).toBe(0);
  expect(await t.link("current")).toBe(join(t.base, "releases", names[0]));
  expect(await t.link("previous")).toBeUndefined();
  expect(await t.calls()).toBe(
    "restart home-digital-signage-backend.service\n",
  );

  const second = await t.stage(names[1]);
  expect((await run([script, "activate", second], t.env)).code).toBe(0);
  expect(await t.link("current")).toBe(join(t.base, "releases", names[1]));
  expect(await t.link("previous")).toBe(join(t.base, "releases", names[0]));
});

linux("keeps three releases", async () => {
  const t = await setup();
  for (const name of names)
    expect(
      (await run([script, "activate", await t.stage(name)], t.env)).code,
    ).toBe(0);
  expect((await readdir(join(t.base, "releases"))).sort()).toEqual(
    names.slice(1),
  );
});

linux("switches back when the health check fails", async () => {
  const t = await setup();
  await run([script, "activate", await t.stage(names[0])], t.env);
  await t.setHealth("fail");
  const result = await run(
    [script, "activate", await t.stage(names[1])],
    t.env,
  );
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("switched back");
  expect(await t.link("current")).toBe(join(t.base, "releases", names[0]));
  expect(await t.link("previous")).toBeUndefined();
});

linux("refuses a badly named or incomplete staging directory", async () => {
  const t = await setup();
  const bad = await t.stage("latest");
  expect((await run([script, "activate", bad], t.env)).code).not.toBe(0);
  const incomplete = await t.stage(names[0]);
  await rm(join(incomplete, "node_modules"), { recursive: true });
  expect((await run([script, "activate", incomplete], t.env)).code).not.toBe(0);
  expect(await readdir(join(t.base, "releases"))).toEqual([]);
  expect(await t.link("current")).toBeUndefined();
});

linux("rolls back only with the schema confirmation", async () => {
  const t = await setup();
  await run([script, "activate", await t.stage(names[0])], t.env);
  await run([script, "activate", await t.stage(names[1])], t.env);
  expect((await run([script, "rollback"], t.env)).code).not.toBe(0);
  expect(await t.link("current")).toBe(join(t.base, "releases", names[1]));
  expect(
    (await run([script, "rollback", "--schema-checked"], t.env)).code,
  ).toBe(0);
  expect(await t.link("current")).toBe(join(t.base, "releases", names[0]));
  expect(await t.link("previous")).toBe(join(t.base, "releases", names[1]));
});
