import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  lstat,
  link,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { once } from "node:events";
import Database from "better-sqlite3";
import { afterEach, beforeAll, expect, test } from "vitest";

const linux = test.runIf(process.platform === "linux");
const dirs: string[] = [];
const children: {
  child: ChildProcess;
  done: Promise<number | null>;
  output: () => string;
}[] = [];
beforeAll(async () => {
  if (process.platform === "linux")
    await promisify(execFile)(process.execPath, [
      "node_modules/typescript/bin/tsc",
      "-p",
      "tsconfig.backend.json",
    ]);
}, 30000);
afterEach(async () => {
  for (const running of children)
    if (running.child.exitCode === null && running.child.signalCode === null)
      running.child.kill("SIGKILL");
  await Promise.all(children.splice(0).map((running) => running.done));
  for (const dir of dirs.splice(0)) {
    await chmod(dir, 0o700);
    await rm(dir, { recursive: true, force: true });
  }
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "signage-store-"));
  await chmod(dir, 0o700);
  dirs.push(dir);
  return dir;
}
function launch(
  command: string,
  args: string[],
  dir: string,
  extra: NodeJS.ProcessEnv = {},
) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("SIGNAGE_")),
  );
  const child = spawn(command, args, {
    env: { ...env, SIGNAGE_DATA_DIR: dir, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout!.on("data", (data) => {
    output += data;
  });
  child.stderr!.on("data", (data) => {
    output += data;
  });
  const done = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const running = { child, done, output: () => output };
  children.push(running);
  return running;
}
function command(
  dir: string,
  mode = "provision",
  extra: NodeJS.ProcessEnv = {},
) {
  return launch("sh", ["scripts/with-backend-lock.sh", mode], dir, extra);
}
async function provision(dir: string) {
  const job = command(dir);
  expect(await job.done, job.output()).toBe(0);
}
async function port() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const p = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return p;
}
async function backend(dir: string) {
  const p = await port();
  const job = command(dir, "backend", { SIGNAGE_BACKEND_PORT: String(p) });
  await expect
    .poll(job.output, { timeout: 8000 })
    .toContain("startup_complete");
  return { ...job, port: p };
}
async function probe(dir: string) {
  const job = launch(
    "flock",
    ["-x", "-n", "-E", "73", join(dir, "backend.lock"), "true"],
    dir,
  );
  return job.done;
}
function moduleUrl(file: string) {
  return JSON.stringify(pathToFileURL(resolve(`dist/backend/${file}.js`)).href);
}
function harness(dir: string, code: string) {
  // Same EX/exec/FD protocol; arbitrary harness is test-only, never a production CLI option.
  return launch(
    "sh",
    [
      "-c",
      'exec 9>>"$1/backend.lock"; chmod 600 "$1/backend.lock"; flock -x -w 2 -E 73 9 || exit 73; exec "$2" --input-type=module -e "$3"',
      "test",
      dir,
      process.execPath,
      code,
    ],
    dir,
  );
}
async function mutate(dir: string, sql: string) {
  const db = new Database(join(dir, "signage.db"));
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

linux(
  "first provisioning creates exact schema/WAL/NORMAL; existing DB is unchanged",
  async () => {
    const dir = await directory();
    await provision(dir);
    const file = join(dir, "signage.db");
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    const prior = await readFile(file);
    const second = command(dir);
    expect(await second.done).toBe(1);
    expect(await readFile(file)).toEqual(prior);
    const job = harness(
      dir,
      `import {ExclusiveLock} from ${moduleUrl("storage/lock")}; import {BackendStore} from ${moduleUrl("storage/store")}; const store=BackendStore.open(ExclusiveLock.inherited(process.env.SIGNAGE_DATA_DIR)); store.close();store.close();`,
    );
    expect(await job.done, job.output()).toBe(0);
    const db = new Database(file);
    try {
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("user_version", { simple: true })).toBe(1);
    } finally {
      db.close();
    }
    expect(await probe(dir)).toBe(0);
  },
);
linux(
  "concurrent provisioning yields one success and never overwrites",
  async () => {
    const dir = await directory();
    const jobs = [command(dir), command(dir)];
    const codes = await Promise.all(jobs.map((j) => j.done));
    expect(codes.filter((c) => c === 0)).toHaveLength(1);
    expect(codes.filter((c) => c === 1 || c === 73)).toHaveLength(1);
  },
);
linux(
  "backend holds EX, times out competing backend/provision before DB creation",
  async () => {
    const dir = await directory();
    const job = await backend(dir);
    expect(job.output()).toContain('"state":"DEGRADED"');
    const began = performance.now();
    const competitor = command(dir, "backend");
    expect(await competitor.done).toBe(73);
    expect(performance.now() - began).toBeGreaterThan(1800);
    expect(performance.now() - began).toBeLessThan(4500);
    const creator = command(dir);
    expect(await creator.done).toBe(73);
    await expect(lstat(join(dir, "signage.db"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(competitor.output()).not.toContain("database_initializing");
    expect(competitor.output()).not.toContain("BLOCKED");
  },
  10000,
);
linux.each(["SIGTERM", "SIGINT", "SIGKILL"] as const)(
  "%s releases EX after real backend lifetime",
  async (signal) => {
    const dir = await directory();
    await provision(dir);
    const job = await backend(dir);
    expect(job.output()).toContain('"state":"HEALTHY"');
    const response = await fetch(`http://127.0.0.1:${job.port}/ping`);
    expect(await response.json()).toEqual({ message: "pong" });
    expect(await probe(dir)).toBe(73);
    job.child.kill(signal);
    const code = await job.done;
    if (signal !== "SIGKILL") {
      expect(code).toBe(0);
      expect(job.output()).toContain("database_closed");
      expect(job.output()).toContain("shutdown_complete");
    }
    expect(await probe(dir)).toBe(0);
  },
);
linux("direct Node and unheld FD cannot bypass the lock", async () => {
  const dir = await directory();
  const direct = launch(process.execPath, ["dist/backend/main.js"], dir);
  expect(await direct.done).toBe(1);
  expect(direct.output()).toContain("lock_required");
  const unheld = launch(
    "sh",
    [
      "-c",
      'umask 077; exec 9>>"$1/backend.lock"; exec "$2" "$3"',
      "test",
      dir,
      process.execPath,
      resolve("dist/backend/main.js"),
    ],
    dir,
  );
  expect(await unheld.done).toBe(1);
  await expect(lstat(join(dir, "signage.db"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
linux(
  "rejects directory aliases, bad permissions, symlink/hardlink lock",
  async () => {
    const dir = await directory();
    const alias = join(await directory(), "alias");
    await symlink(dir, alias);
    expect(await command(alias).done).toBe(74);
    await chmod(dir, 0o755);
    expect(await command(dir).done).toBe(74);
    await chmod(dir, 0o700);
    const target = join(dir, "target");
    await writeFile(target, "sentinel", { mode: 0o600 });
    await symlink(target, join(dir, "backend.lock"));
    expect(await command(dir).done).toBe(74);
    expect(await readFile(target, "utf8")).toBe("sentinel");
    await rm(join(dir, "backend.lock"));
    await link(target, join(dir, "backend.lock"));
    expect(await command(dir).done).toBe(74);
  },
);
linux("DB symlink never provisions or truncates its target", async () => {
  const dir = await directory();
  const target = join(dir, "untouched");
  await writeFile(target, "sentinel", { mode: 0o600 });
  await symlink(target, join(dir, "signage.db"));
  expect(await command(dir).done).toBe(1);
  expect(await readFile(target, "utf8")).toBe("sentinel");
});
linux(
  "incomplete file remains after failure and is not repaired by either entry",
  async () => {
    const dir = await directory();
    // Real creation path; deliberately fail SQLite initialization after wx, test-only fault injection.
    const job = harness(
      dir,
      `import Database from 'better-sqlite3'; import {ExclusiveLock} from ${moduleUrl("storage/lock")}; import {provision} from ${moduleUrl("storage/provision")}; Database.prototype.pragma=function(){throw new Error('injected');};try{provision(ExclusiveLock.inherited(process.env.SIGNAGE_DATA_DIR));}catch{process.exitCode=1;}`,
    );
    expect(await job.done).toBe(1);
    const file = join(dir, "signage.db");
    expect((await lstat(file)).size).toBe(0);
    expect(await command(dir).done).toBe(1);
    const server = await backend(dir);
    expect(server.output()).toContain('"state":"BLOCKED"');
    expect((await lstat(file)).size).toBe(0);
  },
);
linux.each([
  "DROP TABLE state_generation_counters",
  "PRAGMA user_version=0",
  "PRAGMA user_version=99",
])("schema fault %s is BLOCKED while /ping remains HTTP-only", async (sql) => {
  const dir = await directory();
  await provision(dir);
  await mutate(dir, sql);
  const job = await backend(dir);
  expect(job.output()).toContain('"state":"BLOCKED"');
  expect((await fetch(`http://127.0.0.1:${job.port}/ping`)).status).toBe(200);
});
linux("Listen failure closes Store and releases EX", async () => {
  const dir = await directory();
  await provision(dir);
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const job = command(dir, "backend", {
      SIGNAGE_BACKEND_PORT: String((server.address() as { port: number }).port),
    });
    expect(await job.done).toBe(1);
    expect(job.output()).toContain("listen_failed");
    expect(job.output()).toContain("database_closed");
    expect(await probe(dir)).toBe(0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
linux.each(["SIGTERM", "SIGINT"] as const)(
  "startup %s before handoff closes acquired Connection without Listen",
  async (signal) => {
    const dir = await directory();
    await provision(dir);
    const job = harness(
      dir,
      `import {startBackend} from ${moduleUrl("main")}; import {BackendStore} from ${moduleUrl("storage/store")}; import fs from 'node:fs'; import {setTimeout as delay} from 'node:timers/promises'; await startBackend(process.env,undefined,{initializeStore:async(lock)=>{const store=BackendStore.open(lock);const close=store.close.bind(store);store.close=()=>{close();fs.appendFileSync(process.env.SIGNAGE_DATA_DIR+'/closed','1');};fs.writeFileSync(process.env.SIGNAGE_DATA_DIR+'/acquired','');while(!fs.existsSync(process.env.SIGNAGE_DATA_DIR+'/continue'))await delay(10);return store;}});`,
    );
    await expect
      .poll(
        async () => {
          try {
            return await readFile(join(dir, "acquired"), "utf8");
          } catch {
            return null;
          }
        },
        { timeout: 5000 },
      )
      .toBe("");
    job.child.kill(signal);
    await new Promise((r) => setTimeout(r, 100));
    await writeFile(join(dir, "continue"), "");
    expect(await job.done).toBe(0);
    expect(await readFile(join(dir, "closed"), "utf8")).toBe("1");
    expect(job.output()).not.toContain("startup_complete");
    expect(await probe(dir)).toBe(0);
  },
);
linux(
  "ordinary children do not retain the Lock FD after normal parent exit",
  async () => {
    const dir = await directory();
    const job = harness(
      dir,
      `import {ExclusiveLock} from ${moduleUrl("storage/lock")}; import {spawn} from 'node:child_process';import fs from 'node:fs';ExclusiveLock.inherited(process.env.SIGNAGE_DATA_DIR);const child=spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],{stdio:'ignore'});fs.writeFileSync(process.env.SIGNAGE_DATA_DIR+'/child',String(child.pid));child.unref();`,
    );
    expect(await job.done).toBe(0);
    const pid = Number(await readFile(join(dir, "child"), "utf8"));
    try {
      process.kill(pid, 0);
      expect(await probe(dir)).toBe(0);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already exited */
      }
    }
  },
);

linux("replaced lock pathname cannot authorize database access", async () => {
  const dir = await directory();
  const job = harness(
    dir,
    `import fs from 'node:fs';import {ExclusiveLock} from ${moduleUrl("storage/lock")};const path=process.env.SIGNAGE_DATA_DIR+'/backend.lock';fs.renameSync(path,path+'.old');fs.writeFileSync(path,'',{mode:0o600});try{ExclusiveLock.inherited(process.env.SIGNAGE_DATA_DIR);process.exitCode=99;}catch{process.exitCode=1;}`,
  );
  expect(await job.done).toBe(1);
  await expect(lstat(join(dir, "signage.db"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
linux.each(["SIGTERM", "SIGINT"] as const)(
  "%s received before initialization prevents Store open and Listen",
  async (signal) => {
    const dir = await directory();
    const job = harness(
      dir,
      `import {startBackend} from ${moduleUrl("main")};await startBackend(process.env,{write(chunk){process.stdout.write(chunk);if(chunk.includes('database_initializing'))process.kill(process.pid,${JSON.stringify(signal)});}},{initializeStore(){process.stdout.write('unexpected_store_open');throw new Error('unexpected');}});`,
    );
    expect(await job.done, job.output()).toBe(0);
    expect(job.output()).toContain("shutdown_complete");
    expect(job.output()).not.toContain("unexpected_store_open");
    expect(job.output()).not.toContain("startup_complete");
    expect(await probe(dir)).toBe(0);
  },
);

linux.each(["SIGTERM", "SIGINT"] as const)(
  "%s queued during synchronous SQLite failure stops before routes/listen",
  async (signal) => {
    const dir = await directory();
    const job = harness(
      dir,
      `import Database from 'better-sqlite3';import {startBackend} from ${moduleUrl("main")};await startBackend(process.env,undefined,{initializeStore(){const db=new Database(':memory:');process.kill(process.pid,${JSON.stringify(signal)});try{db.prepare('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<500000) SELECT sum(x) FROM n').get();}finally{db.close();console.log('sync_sql_closed');}throw Object.assign(new Error('missing'),{code:'ENOENT'});}});`,
    );
    expect(await job.done, job.output()).toBe(0);
    expect(job.output()).toContain("sync_sql_closed");
    expect(job.output()).toContain("shutdown_complete");
    expect(job.output()).not.toContain("database_status");
    expect(job.output()).not.toContain("startup_complete");
    expect(await probe(dir)).toBe(0);
  },
);
linux(
  "PR-A 10 second deadline forces exit and releases lock during stalled handoff",
  async () => {
    const dir = await directory();
    await provision(dir);
    const job = harness(
      dir,
      `import {startBackend} from ${moduleUrl("main")};import {BackendStore} from ${moduleUrl("storage/store")};await startBackend(process.env,undefined,{initializeStore:async(lock)=>{BackendStore.open(lock);console.log('handoff_stalled');setInterval(()=>{},1000);await new Promise(()=>{});}});`,
    );
    await expect
      .poll(job.output, { timeout: 5000 })
      .toContain("handoff_stalled");
    const began = performance.now();
    job.child.kill("SIGTERM");
    expect(await job.done, job.output()).toBe(1);
    expect(performance.now() - began).toBeGreaterThanOrEqual(9500);
    expect(job.output()).toContain("shutdown_timeout");
    expect(job.output()).not.toContain("startup_complete");
    expect(await probe(dir)).toBe(0);
  },
  20000,
);
linux(
  "SQLite-created DB/WAL/SHM are private during provisioning and backend lifetime",
  async () => {
    const dir = await directory();
    const job = harness(
      dir,
      `import Database from 'better-sqlite3';import fs from 'node:fs';import {provision} from ${moduleUrl("storage/provision")};import {ExclusiveLock} from ${moduleUrl("storage/lock")};const close=Database.prototype.close;Database.prototype.close=function(){for(const suffix of ['','-wal','-shm']){const stat=fs.lstatSync(process.env.SIGNAGE_DATA_DIR+'/signage.db'+suffix);if((stat.mode&4095)!==384||stat.uid!==process.getuid()||!stat.isFile())throw new Error('unsafe sidecar');}console.log('sidecars_checked');return close.call(this);};provision(ExclusiveLock.inherited(process.env.SIGNAGE_DATA_DIR));`,
    );
    expect(await job.done, job.output()).toBe(0);
    expect(job.output()).toContain("sidecars_checked");
    await backend(dir);
    for (const suffix of ["", "-wal", "-shm"]) {
      const stat = await lstat(join(dir, "signage.db" + suffix));
      expect(stat.mode & 0o7777).toBe(0o600);
      expect(stat.uid).toBe(process.getuid!());
      expect(stat.isSymbolicLink()).toBe(false);
    }
  },
);
linux(
  "symlink substituted between preflight and FD open is refused without target changes",
  async () => {
    const dir = await directory();
    const bin = await directory();
    const target = join(dir, "sentinel");
    await writeFile(target, "untouched", { mode: 0o600 });
    // A PATH shim changes the file after the real second preflight: no production fault hook.
    const shim = `#!/bin/sh
case "$1" in
  */storage/paths.js)
    "${process.execPath}" "$@" || exit $?
    if [ -f "$2/backend.lock" ]; then
      mv "$2/backend.lock" "$2/original.lock"
      ln -s "$2/sentinel" "$2/backend.lock"
    fi
    ;;
  *) exec "${process.execPath}" "$@" ;;
esac
`;
    await writeFile(join(bin, "node"), shim, { mode: 0o700 });
    const job = command(dir, "provision", {
      PATH: bin + ":" + process.env.PATH,
    });
    expect(await job.done, job.output()).toBe(74);
    expect(await readFile(target, "utf8")).toBe("untouched");
    await expect(lstat(join(dir, "signage.db"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await lstat(join(dir, "backend.lock"))).isSymbolicLink()).toBe(
      true,
    );
  },
);

linux(
  "BackendStore Repository uses the owned Connection and cannot save after Close",
  async () => {
    const dir = await directory();
    await provision(dir);
    const job = harness(
      dir,
      `import {BackendStore} from ${moduleUrl("storage/store")};import {ExclusiveLock} from ${moduleUrl("storage/lock")};const store=BackendStore.open(ExclusiveLock.inherited(process.env.SIGNAGE_DATA_DIR));const result=store.publishedStates.save('schedule','{"data":null,"meta":{}}');if(result.outcome!=='saved'||result.generation!==1)throw new Error('save failed');store.close();store.close();if(store.publishedStates.save('schedule','{}').outcome==='saved')throw new Error('closed connection used');`,
    );
    expect(await job.done, job.output()).toBe(0);
    const db = new Database(join(dir, "signage.db"), { fileMustExist: true });
    try {
      expect(
        db
          .prepare(
            "SELECT last_generation FROM state_generation_counters WHERE state_key='schedule'",
          )
          .get(),
      ).toEqual({ last_generation: 1 });
    } finally {
      db.close();
    }
    expect(await probe(dir)).toBe(0);
  },
);

linux(
  "BackendStore shares Cache and Published Connection lifecycle",
  async () => {
    const dir = await directory();
    await provision(dir);
    const job = harness(
      dir,
      `import {BackendStore} from ${moduleUrl("storage/store")};import {ExclusiveLock} from ${moduleUrl("storage/lock")};const store=BackendStore.open(ExclusiveLock.inherited(process.env.SIGNAGE_DATA_DIR));const validator={schema(value){return {valid:true,value};},semantic(value){return {valid:true,value};}};const read=store.cache.read('schedule',validator);if(read.outcome!=='empty')throw new Error('expected empty');const result=store.cache.saveConditionally({stateKey:'schedule',entry:{schemaVersion:1,data:{value:1},dataUpdatedAt:'2026-10-25T00:00:00Z',expiresAt:'2026-10-25T01:00:00Z'},evidence:read.evidence,adoption:{outcome:'adopt'}});if(result.outcome!=='saved')throw new Error('cache save');if(store.publishedStates.save('schedule','{}').outcome!=='saved')throw new Error('snapshot save');store.close();store.close();if(store.cache.read('schedule',validator).outcome!=='database_error')throw new Error('cache close');if(store.publishedStates.save('schedule','{}').outcome==='saved')throw new Error('snapshot close');`,
    );
    expect(await job.done, job.output()).toBe(0);
    expect(await probe(dir)).toBe(0);
  },
);
