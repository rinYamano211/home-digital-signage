import { spawn, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  access,
  chmod,
  symlink,
} from "node:fs/promises";
import { tmpdir, release, arch } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeAll, expect, test } from "vitest";

// Synthetic processes only: no production paths, credentials, SQLite or HTTP.
const worker = String.raw`
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const dir = process.argv[1], mode = process.argv[2];
const mark = (n, v = '') => fs.writeFileSync(path.join(dir, n), String(v));
const inherit = ['ignore', 'ignore', 'ignore', 9];
if (mode === 'convert') {
  cp.execFileSync('flock', ['-s', '-w', '1', '3'], {stdio: inherit, timeout: 1500});
}
mark('pid', process.pid);
if (mode === 'leak') {
  const grand = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),8000)'], {stdio: inherit});
  mark('grand', grand.pid);
  grand.unref();
}
mark('ready');
const timer = setInterval(() => {
  if (fs.existsSync(path.join(dir, 'stop'))) { clearInterval(timer); process.exit(0); }
}, 10);
setTimeout(() => process.exit(99), 8000);
`;
const linux = test.runIf(process.platform === "linux");
const dirs: string[] = [];
const groups: number[] = [];
const children: { child: ChildProcess; exited: Promise<void> }[] = [];
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "signage-flock-poc-"));
  dirs.push(dir);
  return dir;
}
function start(command: string, args: string[]) {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  if (!child.pid) throw new Error("spawn failed");
  groups.push(child.pid);
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  children.push({ child, exited });
  return { child, exited };
}
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function waitFile(path: string) {
  const end = Date.now() + 3000;
  while (!(await exists(path))) {
    if (Date.now() > end) throw new Error("marker timeout: " + path);
    await delay(10);
  }
}
async function holder(dir: string, mode = "shared", wrapper = false) {
  const lock = mode === "shared" ? "-s" : "-x";
  const script = wrapper
    ? 'exec 9>>"$1/lock"; flock "$2" -w 1 9 || exit 73; "$3" -e "$4" "$1" "$5" & wait'
    : 'exec 9>>"$1/lock"; flock "$2" -w 1 9 || exit 73; exec "$3" -e "$4" "$1" "$5"';
  const running = start("sh", [
    "-c",
    script,
    "poc",
    dir,
    lock,
    process.execPath,
    worker,
    mode,
  ]);
  await waitFile(join(dir, "ready"));
  return { ...running, pid: Number(await readFile(join(dir, "pid"), "utf8")) };
}
async function probe(dir: string, mode = "-x", seconds = "0") {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      "flock",
      [mode, "-w", seconds, "-E", "73", join(dir, "lock"), "true"],
      { stdio: "ignore" },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
function kill(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
}
async function released(dir: string) {
  const end = Date.now() + 2000;
  while ((await probe(dir)) !== 0) {
    if (Date.now() > end) throw new Error("lock still held");
    await delay(10);
  }
}
beforeAll(() => {
  if (process.platform !== "linux") return;
  console.log(
    "POC_ENV",
    JSON.stringify({
      kernel: release(),
      arch: arch(),
      node: process.version,
      flock: execFileSync("flock", ["--version"], { encoding: "utf8" }).trim(),
      uid: process.getuid?.(),
    }),
  );
});
afterEach(async () => {
  for (const pid of groups.splice(0)) kill(-pid, "SIGKILL");
  await Promise.all(children.splice(0).map((x) => x.exited));
  for (const dir of dirs.splice(0)) {
    await chmod(dir, 0o700);
    await rm(dir, { recursive: true, force: true });
  }
});

linux("LOCK-01 exclusive excludes another exclusive process", async () => {
  const dir = await directory();
  await holder(dir, "exclusive");
  expect(await probe(dir)).toBe(73);
});
linux("LOCK-02 shared holders coexist", async () => {
  const dir = await directory();
  await holder(dir);
  expect(await probe(dir, "-s")).toBe(0);
});
linux("LOCK-03 shared excludes provisioning exclusive", async () => {
  const dir = await directory();
  await holder(dir);
  expect(await probe(dir)).toBe(73);
});
linux(
  "LOCK-04 convert same inherited open file description; contend without assuming atomicity",
  async () => {
    const dir = await directory();
    await holder(dir, "convert");
    expect(await probe(dir, "-s")).toBe(0);
    expect(await probe(dir)).toBe(73);
    let interruptions = 0;
    for (let i = 0; i < 20; i++) {
      const race = await directory();
      const script =
        'exec 9>>"$1/lock"; flock -x 9; (exec 9>&-; touch "$1/queued"; flock -x -w 1 "$1/lock" touch "$1/interrupted") & contender=$!; while [ ! -f "$1/queued" ]; do sleep 0.001; done; sleep 0.01; flock -s -w 1 9; test -f "$1/interrupted" && touch "$1/observed"; exec 9>&-; wait "$contender"';
      const job = start("sh", ["-c", script, "poc", race]);
      await job.exited;
      expect(job.child.exitCode).toBe(0);
      if (await exists(join(race, "observed"))) interruptions++;
    }
    console.log(
      "LOCK-04 measured conversion interruptions",
      interruptions,
      "/20; zero does not prove atomicity",
    );
  },
  15000,
);
linux("LOCK-05 inherited FD protects Node after wrapper dies", async () => {
  const dir = await directory();
  const h = await holder(dir, "convert", true);
  expect(await probe(dir)).toBe(73);
  kill(h.child.pid!, "SIGKILL");
  await h.exited;
  expect(await probe(dir)).toBe(73);
  await writeFile(join(dir, "stop"), "");
  await released(dir);
});
linux("LOCK-06 normal Node exit releases final FD", async () => {
  const dir = await directory();
  const h = await holder(dir, "convert");
  await writeFile(join(dir, "stop"), "");
  await h.exited;
  expect(h.child.exitCode).toBe(0);
  await released(dir);
});
linux.each(["SIGTERM", "SIGKILL"] as const)(
  "LOCK-07 %s backend/wrapper/group and inherited descendant lifetime",
  async (signal) => {
    // Wrapper keeps its own FD while waiting, but exits after Node terminates.
    const dir = await directory();
    const h = await holder(dir, "convert", true);
    kill(h.pid, signal);
    await h.exited;
    await released(dir);
    const orphanDir = await directory();
    const orphan = await holder(orphanDir, "convert", true);
    kill(orphan.child.pid!, signal);
    await orphan.exited;
    expect(await probe(orphanDir)).toBe(73);
    kill(orphan.pid, signal);
    await released(orphanDir);
    const groupDir = await directory();
    const group = await holder(groupDir, "convert", true);
    kill(-group.child.pid!, signal);
    await group.exited;
    await released(groupDir);
    const leakDir = await directory();
    const leak = await holder(leakDir, "leak");
    const grand = Number(await readFile(join(leakDir, "grand"), "utf8"));
    kill(leak.pid, signal);
    await leak.exited;
    expect(await probe(leakDir)).toBe(73);
    kill(grand, signal);
    await released(leakDir);
    console.log(
      "LOCK-07",
      signal,
      "backend/group released; wrapper-only and explicit grandchild FD retain lock",
    );
  },
  15000,
);
linux(
  "LOCK-08 bounded conflict timeout never enters synthetic DB operation",
  async () => {
    const dir = await directory();
    await holder(dir);
    const marker = join(dir, "db-operation");
    const began = performance.now();
    const job = start("flock", [
      "-x",
      "-w",
      "0.15",
      "-E",
      "73",
      join(dir, "lock"),
      "touch",
      marker,
    ]);
    await job.exited;
    expect(job.child.exitCode).toBe(73);
    expect(performance.now() - began).toBeLessThan(1800);
    expect(await exists(marker)).toBe(false);
  },
);
linux("LOCK-09 lock pathname survives holder and is reusable", async () => {
  const dir = await directory();
  const h = await holder(dir);
  await writeFile(join(dir, "stop"), "");
  await h.exited;
  expect(await exists(join(dir, "lock"))).toBe(true);
  expect(await probe(dir)).toBe(0);
});
linux(
  "LOCK-10 shared lock does not enforce single Backend instance",
  async () => {
    const dir = await directory();
    await holder(dir);
    const second = await directory();
    await symlink(join(dir, "lock"), join(second, "lock"));
    await holder(second);
    expect(await probe(dir)).toBe(73);
  },
);
const create = String.raw`
const fs = require('node:fs');
try { const fd = fs.openSync(process.argv[1], 'wx', 0o600); fs.writeSync(fd, 'sentinel'); fs.closeSync(fd); }
catch(e) { console.log(e.code); process.exitCode = e.code === 'EEXIST' ? 17 : e.code === 'EACCES' ? 13 : 1; }
`;
async function creator(file: string) {
  const job = start(process.execPath, ["-e", create, file]);
  await job.exited;
  return job.child.exitCode;
}
linux(
  "LOCK-11 wx concurrent/existing/symlink/permission/crash safety",
  async () => {
    const dir = await directory(),
      file = join(dir, "db");
    expect((await Promise.all([creator(file), creator(file)])).sort()).toEqual([
      0, 17,
    ]);
    expect(await creator(file)).toBe(17);
    expect(await readFile(file, "utf8")).toBe("sentinel");
    const link = join(dir, "link");
    await symlink(file, link);
    expect(await creator(link)).toBe(17);
    const dangling = join(dir, "dangling");
    await symlink(join(dir, "absent"), dangling);
    expect(await creator(dangling)).toBe(17);
    expect(await exists(join(dir, "absent"))).toBe(false);
    if (process.getuid?.() === 0)
      throw new Error("Permission test requires unprivileged Linux user");
    const denied = await directory();
    await chmod(denied, 0o500);
    try {
      expect(await creator(join(denied, "db"))).toBe(13);
    } finally {
      await chmod(denied, 0o700);
    }
    const crash = await directory();
    const job = start(process.execPath, [
      "-e",
      "const fs=require('node:fs');fs.openSync(process.argv[1],'wx');fs.writeFileSync(process.argv[2],'');setInterval(()=>{},1000)",
      join(crash, "db"),
      join(crash, "created"),
    ]);
    await waitFile(join(crash, "created"));
    kill(job.child.pid!, "SIGKILL");
    await job.exited;
    expect(await exists(join(crash, "db"))).toBe(true);
    expect(await creator(join(crash, "db"))).toBe(17);
  },
);
linux(
  "LOCK-12 exclusive flock plus wx protects existing artifact",
  async () => {
    const dir = await directory();
    const h = await holder(dir, "exclusive");
    expect(await creator(join(dir, "db"))).toBe(0);
    expect(await probe(dir)).toBe(73);
    await writeFile(join(dir, "stop"), "");
    await h.exited;
    expect(await probe(dir)).toBe(0);
    const job = start("flock", [
      "-x",
      "-w",
      "1",
      join(dir, "lock"),
      process.execPath,
      "-e",
      create,
      join(dir, "db"),
    ]);
    await job.exited;
    expect(job.child.exitCode).toBe(17);
    expect(await readFile(join(dir, "db"), "utf8")).toBe("sentinel");
  },
);
