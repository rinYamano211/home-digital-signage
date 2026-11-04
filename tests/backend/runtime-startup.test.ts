import Database from "better-sqlite3";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startBackend } from "../../src/backend/main.js";
import { buildApp } from "../../src/backend/app.js";
import {
  BackendStore,
  configureDatabase,
  type StartupStoreAccess,
} from "../../src/backend/storage/store.js";
import type { StartupResult } from "../../src/backend/storage/startup-transaction.js";
import { ExclusiveLock } from "../../src/backend/storage/lock.js";
import { readOsBootId } from "../../src/backend/time/boot-id.js";
import { initializeSchema } from "../../src/backend/storage/schema.js";
import { LIFECYCLE_DDL } from "../../src/backend/storage/lifecycle-ddl.js";
import { SchemaError } from "../../src/backend/storage/errors.js";
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
const boot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const dirs: string[] = [];
const fixtures: { signals: EventEmitter }[] = [];
const apps: ReturnType<typeof buildApp>[] = [];
beforeEach(() => {
  vi.mocked(readOsBootId).mockReturnValue(boot);
});
afterEach(async () => {
  vi.useRealTimers();
  for (const f of fixtures.splice(0)) {
    f.signals.removeAllListeners();
  }
  for (const app of apps.splice(0)) await app.close().catch(() => {});
  vi.restoreAllMocks();
  vi.mocked(buildApp).mockClear();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture(
  result: StartupResult = { outcome: "committed", generation: 2 },
) {
  const signals = new EventEmitter();
  const finish = vi.fn();
  let logs = "";
  const store: StartupStoreAccess = {
    startupComplete: false,
    startup: { execute: vi.fn(() => result) },
    lifecycle: { read: vi.fn() },
    close: vi.fn(),
  };
  const lock = {
    directory: tmpdir(),
    assertHeld: vi.fn(),
  } as unknown as ExclusiveLock;
  vi.spyOn(ExclusiveLock, "inherited").mockReturnValue(lock);
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs += chunk;
      cb();
    },
  });
  const initializeStore = vi.fn(() => store);
  const f = {
    signals,
    finish,
    store,
    lock,
    stream,
    initializeStore,
    logs: () => logs,
  };
  fixtures.push(f);
  return f;
}
async function start(f: ReturnType<typeof fixture>) {
  const result = await startBackend({}, f.stream, {
    signals: f.signals,
    finish: f.finish,
    initializeStore: f.initializeStore,
  });
  const app = vi.mocked(buildApp).mock.results.at(-1)!.value;
  apps.push(app);
  return { result, app };
}
const failure = (layer: "L1" | "L2" | "L3" | "L4"): StartupResult => ({
  outcome: "database_error",
  layer,
  reason: "synthetic_database_failure",
});
const cases: [StartupResult, string][] = [
  [{ outcome: "committed", generation: 2 }, "HEALTHY"],
  [{ outcome: "rejected", reason: "fingerprint_mismatch" }, "BLOCKED"],
  [failure("L1"), "DEGRADED"],
  [failure("L2"), "DEGRADED"],
  [failure("L3"), "BLOCKED"],
  [failure("L4"), "BLOCKED"],
  [{ outcome: "unknown", reason: "startup_commit_unknown" }, "BLOCKED"],
];
for (const [result, state] of cases)
  test(`Startup ${result.outcome} ${"layer" in result ? result.layer : ""} -> ${state}, ping remains Connectivity only`, async () => {
    const f = fixture(result);
    const b = await start(f);
    expect(b.result?.status.state).toBe(state);
    expect(f.store.startup.execute).toHaveBeenCalledExactlyOnceWith({
      bootId: boot,
    });
    const response = await b.app.inject({ method: "GET", url: "/ping" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: "pong" });
    expect((await b.app.inject({ url: "/health" })).statusCode).toBe(404);
    // A non-Store facade never activates Runtime, even when "committed".
    const api = await b.app.inject({ url: "/api/published-states" });
    expect(api.statusCode).toBe(503);
    expect(api.json()).toEqual({ error: "database_unavailable" });
    expect(f.store.startupComplete).toBe(false);
    expect(b.result).not.toHaveProperty("store");
    expect(b.result).not.toHaveProperty("permit");
    if (result.outcome === "unknown")
      expect(f.logs()).not.toContain("storage_startup_committed");
    await b.result?.shutdown.shutdown();
    expect(f.store.close).toHaveBeenCalledTimes(1);
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(0);
    expect(f.signals.listenerCount("SIGTERM")).toBe(0);
    expect(f.signals.listenerCount("SIGINT")).toBe(0);
  });
for (const invalid of [null, "bad", "00000000-0000-0000-0000-000000000000"])
  test(`OS Boot invalid ${invalid} never executes Startup but offers ping`, async () => {
    const f = fixture();
    vi.mocked(readOsBootId).mockReturnValue(invalid as unknown as string);
    const b = await start(f);
    expect(b.result?.status).toMatchObject({
      state: "BLOCKED",
      reason: "os_boot_id_unverified",
    });
    expect(f.store.startup.execute).not.toHaveBeenCalled();
    expect((await b.app.inject({ url: "/ping" })).statusCode).toBe(200);
  });
test("OS Boot read exception sanitized, no Startup retry", async () => {
  const f = fixture();
  vi.mocked(readOsBootId).mockImplementation(() => {
    throw Error("private credential");
  });
  const b = await start(f);
  expect(b.result?.status.state).toBe("BLOCKED");
  expect(f.store.startup.execute).not.toHaveBeenCalled();
  expect(f.logs()).not.toContain("private credential");
});
for (const signal of ["SIGTERM", "SIGINT"])
  test(`${signal} before Open prevents every DB / route / Listen operation`, async () => {
    const f = fixture();
    const stream = new Writable({
      write(chunk, _enc, cb) {
        if (chunk.includes("database_initializing")) f.signals.emit(signal);
        cb();
      },
    });
    const result = await startBackend({}, stream, {
      signals: f.signals,
      finish: f.finish,
      initializeStore: f.initializeStore,
    });
    const app = vi.mocked(buildApp).mock.results.at(-1)!.value;
    apps.push(app);
    expect(result).toBeUndefined();
    expect(f.initializeStore).not.toHaveBeenCalled();
    expect(f.store.startup.execute).not.toHaveBeenCalled();
    expect(app.listen).not.toHaveBeenCalled();
    expect(app.hasRoute({ method: "GET", url: "/ping" })).toBe(false);
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(0);
  });
for (const signal of ["SIGTERM", "SIGINT"])
  test(`${signal} after Open transfers Close ownership, skips Startup and Listen`, async () => {
    const f = fixture();
    f.initializeStore.mockImplementation(() => {
      f.signals.emit(signal);
      return f.store;
    });
    const b = await start(f);
    expect(b.result).toBeUndefined();
    expect(f.store.startup.execute).not.toHaveBeenCalled();
    expect(f.store.close).toHaveBeenCalledTimes(1);
    expect(b.app.listen).not.toHaveBeenCalled();
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(0);
  });
test("Shutdown after Startup begin log is processed before execute", async () => {
  const f = fixture();
  const stream = new Writable({
    write(chunk, _enc, cb) {
      if (chunk.includes("storage_startup_begin")) f.signals.emit("SIGTERM");
      cb();
    },
  });
  expect(
    await startBackend({}, stream, {
      signals: f.signals,
      finish: f.finish,
      initializeStore: f.initializeStore,
    }),
  ).toBeUndefined();
  const app = vi.mocked(buildApp).mock.results.at(-1)!.value;
  apps.push(app);
  expect(f.store.startup.execute).not.toHaveBeenCalled();
  expect(f.store.close).toHaveBeenCalledTimes(1);
  expect(app.listen).not.toHaveBeenCalled();
});
for (const result of [
  { outcome: "committed", generation: 2 },
  { outcome: "unknown", reason: "startup_commit_unknown" },
] as const)
  test(`Shutdown inside synchronous ${result.outcome} completion prevents routes / Listen`, async () => {
    const f = fixture(result);
    vi.mocked(f.store.startup.execute).mockImplementation(() => {
      f.signals.emit("SIGTERM");
      return result;
    });
    const b = await start(f);
    expect(b.result).toBeUndefined();
    expect(f.store.startup.execute).toHaveBeenCalledTimes(1);
    expect(f.store.close).toHaveBeenCalledTimes(1);
    expect(b.app.listen).not.toHaveBeenCalled();
    expect(b.app.hasRoute({ method: "GET", url: "/ping" })).toBe(false);
  });
for (const code of ["SQLITE_BUSY", "ENOENT", "SQLITE_CORRUPT"])
  test(`Open ${code} preserves existing classification, no Boot read / execute`, async () => {
    const f = fixture();
    f.initializeStore.mockImplementation(() => {
      throw Object.assign(Error("private"), { code });
    });
    const b = await start(f);
    expect(b.result?.status.state).toBe(
      code === "SQLITE_CORRUPT" ? "BLOCKED" : "DEGRADED",
    );
    expect(f.store.startup.execute).not.toHaveBeenCalled();
    expect(readOsBootId).not.toHaveBeenCalled();
    expect(f.logs()).not.toContain("private");
  });
test("Unknown unsafe Open failure retains fatal Startup behavior", async () => {
  const f = fixture();
  f.initializeStore.mockImplementation(() => {
    throw Error("private path");
  });
  await expect(start(f)).rejects.toThrow("Backend startup failed");
  expect(f.finish).toHaveBeenCalledExactlyOnceWith(1);
  expect(f.logs()).not.toContain("private path");
  expect(f.store.startup.execute).not.toHaveBeenCalled();
});
test("Lock lost before Startup is fatal, closes acquired Store exactly once", async () => {
  const f = fixture();
  vi.mocked(f.lock.assertHeld).mockImplementation(() => {
    throw Error("private lock");
  });
  await expect(start(f)).rejects.toThrow("Backend startup failed");
  expect(f.store.startup.execute).not.toHaveBeenCalled();
  expect(f.store.close).toHaveBeenCalledTimes(1);
  expect(f.finish).toHaveBeenCalledExactlyOnceWith(1);
});
test("Close failure during Shutdown is not normal completion", async () => {
  const f = fixture();
  const b = await start(f);
  vi.mocked(f.store.close).mockImplementation(() => {
    throw Error("private close");
  });
  await b.result?.shutdown.shutdown();
  expect(f.finish).toHaveBeenCalledExactlyOnceWith(1);
  expect(f.store.close).toHaveBeenCalledTimes(1);
  expect(f.logs()).toContain("shutdown_failed");
  expect(f.logs()).not.toContain("private close");
});
test("Close failure for Store returned after Shutdown cannot be lost in temporary ownership", async () => {
  const f = fixture();
  f.initializeStore.mockImplementation(() => {
    f.signals.emit("SIGTERM");
    return f.store;
  });
  vi.mocked(f.store.close).mockImplementation(() => {
    throw Error("private close");
  });
  const b = await start(f);
  expect(b.result).toBeUndefined();
  expect(f.finish).toHaveBeenCalledExactlyOnceWith(1);
  expect(f.store.close).toHaveBeenCalledTimes(1);
});
test("Listen failure triggers exactly one Store Close and removes listeners", async () => {
  const f = fixture();
  vi.mocked(buildApp).mockImplementationOnce((...args) => {
    // The default mocked builder provides the real Fastify instance.
    const result = vi.mocked(buildApp).getMockImplementation()!(...args);
    vi.mocked(result.listen).mockRejectedValue(Error("private listen"));
    return result;
  });
  await expect(start(f)).rejects.toThrow("Backend startup failed");
  expect(f.store.close).toHaveBeenCalledTimes(1);
  expect(f.finish).toHaveBeenCalledExactlyOnceWith(1);
  expect(f.signals.listenerCount("SIGTERM")).toBe(0);
  expect(f.logs()).not.toContain("private listen");
});
function v3() {
  const dir = mkdtempSync(join(tmpdir(), "signage-runtime-startup-"));
  dirs.push(dir);
  const path = join(dir, "signage.db");
  const db = new Database(path);
  initializeSchema(db);
  configureDatabase(db, 3);
  db.exec(LIFECYCLE_DDL);
  db.prepare("INSERT INTO backend_lifecycle VALUES (1,'RUNNING',?,1)").run(
    boot,
  );
  db.pragma("user_version=3");
  db.close();
  return { dir, path };
}
test("Default production opener is v3, real SQLite Atomic Startup and restart advance Generation", async () => {
  const data = v3();
  vi.spyOn(BackendStore, "open").mockImplementation(() => {
    throw Error("v2 forbidden");
  });
  const opener = vi.spyOn(BackendStore, "openV3ForStartup");
  for (const generation of [2, 3]) {
    const f = fixture();
    vi.mocked(ExclusiveLock.inherited).mockReturnValue({
      directory: data.dir,
      assertHeld: vi.fn(),
    } as unknown as ExclusiveLock);
    const result = await startBackend({}, f.stream, {
      signals: f.signals,
      finish: f.finish,
    });
    expect(result?.status).toEqual({ state: "HEALTHY" });
    if (result) apps.push(result.app);
    expect(f.logs()).toContain("storage_startup_committed");
    const api = await result!.app.inject({ url: "/api/published-states" });
    expect(api.statusCode).toBe(200);
    expect(api.json()).toEqual({ schemaVersion: 1, states: {} });
    // Trust/History monitoring is wired on the committed Store (no adapter).
    expect(f.logs()).not.toContain("send_monitoring_unavailable");
    await result?.shutdown.shutdown();
    const db = new Database(data.path, { readonly: true });
    try {
      expect(
        db.prepare("SELECT generation FROM backend_lifecycle").get(),
      ).toEqual({ generation });
      expect(
        db
          .prepare(
            "SELECT provider_key,provider_state FROM startup_provider_boundaries WHERE generation=?",
          )
          .get(generation),
      ).toEqual({
        provider_key: "tomorrow.io",
        provider_state: "UNPROVISIONED",
      });
    } finally {
      db.close();
    }
  }
  expect(opener).toHaveBeenCalledTimes(2);
  expect(BackendStore.open).not.toHaveBeenCalled();
});
test("v2 is BLOCKED with no auto-Migration, file initialization or Startup attempt", async () => {
  const data = v3();
  const db = new Database(data.path);
  db.exec(
    "DROP TABLE history_uncertain_ranges;DROP TABLE startup_provider_boundaries;DROP TABLE startup_generations;DROP TABLE backend_lifecycle;PRAGMA user_version=2",
  );
  db.close();
  const f = fixture();
  vi.mocked(ExclusiveLock.inherited).mockReturnValue({
    directory: data.dir,
    assertHeld: vi.fn(),
  } as unknown as ExclusiveLock);
  const result = await startBackend({}, f.stream, {
    signals: f.signals,
    finish: f.finish,
  });
  expect(result?.status).toMatchObject({ state: "BLOCKED", layer: "L3" });
  if (result) apps.push(result.app);
  await result?.shutdown.shutdown();
  const reopened = new Database(data.path);
  try {
    expect(reopened.pragma("user_version", { simple: true })).toBe(2);
    expect(
      reopened
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name='backend_lifecycle'",
        )
        .all(),
    ).toEqual([]);
  } finally {
    reopened.close();
  }
});
test("SchemaError Open remains BLOCKED and Connectivity is independent", async () => {
  const f = fixture();
  f.initializeStore.mockImplementation(() => {
    throw new SchemaError();
  });
  const b = await start(f);
  expect(b.result?.status).toMatchObject({ state: "BLOCKED", layer: "L3" });
  expect((await b.app.inject({ url: "/ping" })).json()).toEqual({
    message: "pong",
  });
});

test("Existing 10-second Shutdown deadline remains active with runtime Store ownership", async () => {
  const f = fixture();
  const b = await start(f);
  let resume!: () => void;
  b.app.addHook(
    "onClose",
    async () =>
      new Promise<void>((resolve) => {
        resume = resolve;
      }),
  );
  vi.useFakeTimers();
  const pending = b.result!.shutdown.shutdown();
  await vi.advanceTimersByTimeAsync(9999);
  expect(f.finish).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(f.finish).toHaveBeenCalledExactlyOnceWith(1);
  expect(f.logs()).toContain("shutdown_timeout");
  expect(f.signals.listenerCount("SIGTERM")).toBe(0);
  resume();
  await b.app.close();
  expect(f.store.close).toHaveBeenCalledTimes(1);
  expect(f.finish).toHaveBeenCalledTimes(1);
});
test("Async Open returned after Shutdown still has exactly one Close owner", async () => {
  const f = fixture();
  let deliver!: (store: StartupStoreAccess) => void;
  const pending = startBackend({}, f.stream, {
    signals: f.signals,
    finish: f.finish,
    initializeStore: () =>
      new Promise((resolve) => {
        deliver = resolve;
        f.signals.emit("SIGTERM");
        queueMicrotask(() => deliver(f.store));
      }),
  });
  expect(await pending).toBeUndefined();
  const app = vi.mocked(buildApp).mock.results.at(-1)!.value;
  apps.push(app);
  expect(f.store.close).toHaveBeenCalledTimes(1);
  expect(f.store.startup.execute).not.toHaveBeenCalled();
  expect(f.finish).toHaveBeenCalledExactlyOnceWith(0);
});
for (const after of [false, true])
  test(`Real SQLite COMMIT ${after ? "after" : "before"} throw -> BLOCKED, one Startup, no auto Retry`, async () => {
    const data = v3();
    const f = fixture();
    vi.mocked(ExclusiveLock.inherited).mockReturnValue({
      directory: data.dir,
      assertHeld: vi.fn(),
    } as unknown as ExclusiveLock);
    const exec = Database.prototype.exec;
    const spy = vi
      .spyOn(Database.prototype, "exec")
      .mockImplementation(function (this: Database.Database, sql: string) {
        if (sql === "COMMIT") {
          if (after) exec.call(this, sql);
          throw Object.assign(Error("secret commit"), { code: "SQLITE_BUSY" });
        }
        return exec.call(this, sql);
      });
    const result = await startBackend({}, f.stream, {
      signals: f.signals,
      finish: f.finish,
    });
    if (result) apps.push(result.app);
    expect(result?.status).toEqual({
      state: "BLOCKED",
      layer: "L4",
      reason: "startup_commit_unknown",
    });
    expect(
      spy.mock.calls.filter((c) => c[0] === "BEGIN IMMEDIATE"),
    ).toHaveLength(1);
    expect(f.logs()).not.toContain("storage_startup_committed");
    expect(f.logs()).not.toContain("secret commit");
    await result?.shutdown.shutdown();
    const db = new Database(data.path, { readonly: true });
    try {
      expect(
        db.prepare("SELECT generation FROM backend_lifecycle").get(),
      ).toEqual({ generation: after ? 2 : 1 });
    } finally {
      db.close();
    }
  });

test("Shutdown synchronously requested during Boot read cannot enter Startup", async () => {
  const f = fixture();
  vi.mocked(readOsBootId).mockImplementation(() => {
    f.signals.emit("SIGTERM");
    return boot;
  });
  const b = await start(f);
  expect(b.result).toBeUndefined();
  expect(f.store.startup.execute).not.toHaveBeenCalled();
  expect(b.app.listen).not.toHaveBeenCalled();
  expect(f.store.close).toHaveBeenCalledTimes(1);
});
test("Shutdown synchronously requested during DB status logging cannot register routes or Listen", async () => {
  const f = fixture();
  const stream = new Writable({
    write(chunk, _enc, cb) {
      if (chunk.includes('"event":"database_status"'))
        f.signals.emit("SIGTERM");
      cb();
    },
  });
  expect(
    await startBackend({}, stream, {
      signals: f.signals,
      finish: f.finish,
      initializeStore: f.initializeStore,
    }),
  ).toBeUndefined();
  const app = vi.mocked(buildApp).mock.results.at(-1)!.value;
  apps.push(app);
  expect(app.hasRoute({ method: "GET", url: "/ping" })).toBe(false);
  expect(app.listen).not.toHaveBeenCalled();
  expect(f.store.startup.execute).toHaveBeenCalledTimes(1);
  expect(f.store.close).toHaveBeenCalledTimes(1);
  expect(f.finish).toHaveBeenCalledExactlyOnceWith(0);
});
