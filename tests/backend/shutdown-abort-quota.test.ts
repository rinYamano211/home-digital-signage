// Issue #93 (technology-stack 21.9): Shutdown must abort the in-flight
// Tomorrow.io HTTP that went through the Send Gate and reach DB Close well
// within the 10-second deadline, saving nothing for the aborted attempt and
// keeping the Quota already consumed by Tx-Q.
// Real SQLite, real Startup / Shutdown path and a real Loopback server that
// never answers. Only the OS boundaries are mocked, as in coordinator.test.ts:
// the OS time-sync probe (`node:child_process`), the wall / monotonic clocks
// (so Clock Trust and the Quota wait can be reached without real waiting) and
// the timers. Elapsed time is measured with the real clock.
import Database from "better-sqlite3";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { Writable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as realYield } from "node:timers/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startBackend } from "../../src/backend/main.js";
import { ExclusiveLock } from "../../src/backend/storage/lock.js";
import { readOsBootId } from "../../src/backend/time/boot-id.js";
import { initializeSchema } from "../../src/backend/storage/schema.js";
import { LIFECYCLE_DDL } from "../../src/backend/storage/lifecycle-ddl.js";
import {
  BackendStore,
  configureDatabase,
  type StartupStoreAccess,
} from "../../src/backend/storage/store.js";
import { TOMORROW_IO } from "../../src/backend/quota/quota-guard.js";
import type { StateProvider } from "../../src/backend/acquisition/coordinator.js";

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) =>
    (args.at(-1) as (e: Error | null, out: string) => void)(null, "yes\n"),
}));
vi.mock("../../src/backend/app.js", async (original) => {
  const m = await original<typeof import("../../src/backend/app.js")>();
  return {
    ...m,
    buildApp: vi.fn((...args: Parameters<typeof m.buildApp>) => {
      const app = m.buildApp(...args);
      vi.spyOn(app, "listen").mockResolvedValue(undefined);
      return app;
    }),
  };
});
vi.mock("../../src/backend/time/boot-id.js", async (original) => ({
  ...(await original<typeof import("../../src/backend/time/boot-id.js")>()),
  readOsBootId: vi.fn(),
}));
vi.mock("../../src/backend/storage/paths.js", async (original) => ({
  ...(await original<typeof import("../../src/backend/storage/paths.js")>()),
  validateDatabaseFiles: vi.fn(),
}));
const realNow = performance.now.bind(performance); // captured before any spy
const boot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const dirs: string[] = [];
const servers: Server[] = [];
let wall = 0,
  mono = 0n;
beforeEach(() => {
  vi.mocked(readOsBootId).mockReturnValue(boot);
  wall = Date.parse("2026-11-05T00:00:00Z");
  mono = 10_000_000_000n;
  vi.spyOn(Date, "now").mockImplementation(() => wall);
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => mono);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const move = (ms: number) => {
  wall += ms;
  mono += BigInt(ms) * 1_000_000n;
};
/** Provisioned (PROVISIONED / 0) v3 database, as in coordinator.test.ts. */
function provisionedV3() {
  const dir = mkdtempSync(join(tmpdir(), "signage-shutdown-quota-"));
  dirs.push(dir);
  const path = join(dir, "signage.db");
  const db = new Database(path);
  initializeSchema(db);
  configureDatabase(db, 3);
  db.exec(LIFECYCLE_DDL);
  db.prepare("INSERT INTO backend_lifecycle VALUES (1,'RUNNING',?,1)").run(
    boot,
  );
  db.prepare("INSERT INTO provider_quota_metadata VALUES (?,'ACTIVE',0,0)").run(
    TOMORROW_IO,
  );
  db.pragma("user_version=3");
  db.close();
  return { dir, path };
}
/** Accepts connections and never answers. */
async function silentServer() {
  let count = 0;
  let reached!: () => void;
  const requested = new Promise<void>((resolve) => (reached = resolve));
  const server = createServer(() => {
    count++;
    reached();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  return {
    url: `http://127.0.0.1:${address.port}/`,
    requested,
    requests: () => count,
  };
}
const rain = (url: string): StateProvider => ({
  stateKey: "rainForecast",
  periodMs: 300_000,
  quota: true,
  http: { url, maxBodyBytes: 4096 },
  parse: () => ({ kind: "failure" }),
});

test("SIGTERM during a hanging Tomorrow.io (Send Gate) request reaches DB Close well within 10 s, saves nothing and keeps the consumed Quota", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  const data = provisionedV3();
  const server = await silentServer();
  const signals = new EventEmitter();
  const finish = vi.fn();
  let logs = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs += chunk;
      cb();
    },
  });
  vi.spyOn(ExclusiveLock, "inherited").mockReturnValue({
    directory: data.dir,
    assertHeld: vi.fn(),
  } as unknown as ExclusiveLock);
  const result = await startBackend({}, stream, {
    signals,
    finish,
    providers: [rain(server.url)],
  });
  expect(result?.status).toEqual({ state: "HEALTHY" });
  // Reach Clock / History Trust and the Scheduler's next evaluation with the
  // mocked clocks; stop as soon as the Gate really sends the Request.
  let reached = false;
  void server.requested.then(() => (reached = true));
  for (let i = 0; i < 900 && !reached; i++) {
    move(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await realYield(); // let real Loopback I/O progress
  }
  await server.requested; // the HTTP is now in flight through the Gate
  expect(server.requests()).toBe(1);
  const before = new Database(data.path, { readonly: true });
  try {
    // Tx-Q is already durable before the HTTP started.
    expect(
      before
        .prepare("SELECT COUNT(*) AS n FROM provider_quota_consumptions")
        .get(),
    ).toEqual({ n: 1 });
  } finally {
    before.close();
  }
  const started = realNow();
  signals.emit("SIGTERM");
  while (!finish.mock.calls.length && realNow() - started < 9000)
    await realYield();
  const elapsed = realNow() - started;
  expect(finish).toHaveBeenCalledExactlyOnceWith(0);
  expect(elapsed).toBeLessThan(3000); // real time; the 10 s deadline is far away
  expect(logs).toContain("database_closed");
  expect(logs).not.toContain("shutdown_timeout");
  expect(signals.listenerCount("SIGTERM")).toBe(0);
  expect(server.requests()).toBe(1); // no new send after Shutdown began
  const db = new Database(data.path, { readonly: true });
  try {
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM acquisition_control").get(),
    ).toEqual({ n: 0 }); // no Tx-A, no Backoff
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM published_state_snapshots").get(),
    ).toEqual({ n: 0 }); // no Tx-P
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM provider_quota_consumptions").get(),
    ).toEqual({ n: 1 }); // the consumed Quota is not cancelled
  } finally {
    db.close();
  }
}, 60_000);

test("an Abort that never ends the Tomorrow.io HTTP keeps DB Close pending (shutdown_timeout exits 1) and sends nothing new", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  const data = provisionedV3();
  const signals = new EventEmitter();
  const finish = vi.fn();
  let logs = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs += chunk;
      cb();
    },
  });
  vi.spyOn(ExclusiveLock, "inherited").mockReturnValue({
    directory: data.dir,
    assertHeld: vi.fn(),
  } as unknown as ExclusiveLock);
  // Adapter contract failure: the Request neither answers nor honours Abort,
  // so its end is never proven.
  const hang = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(() => new Promise<Response>(() => {}));
  let store: StartupStoreAccess | undefined;
  const result = await startBackend({}, stream, {
    signals,
    finish,
    providers: [rain("http://127.0.0.1:9/")],
    initializeStore: (lock) => (store = BackendStore.openV3ForStartup(lock)),
  });
  expect(result?.status).toEqual({ state: "HEALTHY" });
  try {
    for (let i = 0; i < 900 && hang.mock.calls.length === 0; i++) {
      move(1000);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(hang).toHaveBeenCalledOnce();
    signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(9999);
    expect(finish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(finish).toHaveBeenCalledExactlyOnceWith(1);
    expect(logs).toContain("shutdown_timeout");
    expect(logs).not.toContain("database_closed"); // no unsafe DB Close
    expect(hang).toHaveBeenCalledOnce(); // no new send while Shutdown waits
    const db = new Database(data.path, { readonly: true });
    try {
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM acquisition_control").get(),
      ).toEqual({ n: 0 });
      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM provider_quota_consumptions")
          .get(),
      ).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  } finally {
    store?.close(); // the pending close hook never reaches its Close
  }
}, 60_000);
