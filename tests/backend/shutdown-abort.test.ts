// Issue #10 (technology-stack 18.7): before a production Provider is
// registered, Shutdown must abort in-flight HTTP and finish the whole path
// (Abort → Scheduler stop → Shutdown gate → monitoring stop → DB Close) well
// within the 10-second deadline, saving nothing for the aborted attempt.
// Real SQLite (Linux CI) and a real Loopback server that never answers.
import Database from "better-sqlite3";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { Writable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type {
  AcquisitionProvider,
  MultiHttpProvider,
  StateProvider,
} from "../../src/backend/acquisition/coordinator.js";
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
const servers: Server[] = [];
beforeEach(() => {
  vi.mocked(readOsBootId).mockReturnValue(boot);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function v3() {
  const dir = mkdtempSync(join(tmpdir(), "signage-shutdown-abort-"));
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
/** Accepts connections and never answers; resolves `reached` per request. */
async function silentServer() {
  let reached!: () => void;
  const requested = new Promise<void>((resolve) => (reached = resolve));
  const server = createServer(() => reached());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  return { url: `http://127.0.0.1:${address.port}/`, requested };
}
const expiresAt = () => new Date(Date.now() + 3_600_000).toISOString();
const multi = (url: string): MultiHttpProvider => ({
  stateKey: "currentWeather",
  periodMs: 600_000,
  quota: false,
  async acquire(ctx) {
    const r = await ctx.http({ url, maxBodyBytes: 1024 });
    return r.kind === "response"
      ? { kind: "success", data: {}, expiresAt: expiresAt() }
      : { kind: "failure" };
  },
});
const single = (url: string): StateProvider => ({
  stateKey: "currentWeather",
  periodMs: 600_000,
  quota: false,
  http: { url, maxBodyBytes: 1024 },
  parse: (o) =>
    o.kind === "response"
      ? { kind: "success", data: {}, expiresAt: expiresAt() }
      : { kind: "failure" },
});
test.each([
  ["multi-HTTP", multi],
  ["single-HTTP", single],
] as [string, (url: string) => AcquisitionProvider][])(
  "SIGTERM during a hanging %s request reaches DB Close well within 10 s and saves nothing",
  async (_name, make) => {
    const data = v3();
    const { url, requested } = await silentServer();
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
      providers: [make(url)],
    });
    expect(result?.status).toEqual({ state: "HEALTHY" });
    await requested; // the Provider HTTP is now in flight
    const started = performance.now();
    signals.emit("SIGTERM");
    await vi.waitFor(() => expect(finish).toHaveBeenCalled(), {
      timeout: 9000,
      interval: 10,
    });
    expect(performance.now() - started).toBeLessThan(3000);
    expect(finish).toHaveBeenCalledExactlyOnceWith(0);
    expect(logs).toContain("database_closed");
    expect(logs).not.toContain("shutdown_timeout");
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    const db = new Database(data.path, { readonly: true });
    try {
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM acquisition_control").get(),
      ).toEqual({ n: 0 });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM published_state_snapshots").get(),
      ).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  },
);

test("an unproven HTTP end keeps DB Close pending: shutdown_timeout exits 1", async () => {
  const data = v3();
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
  // Adapter contract violation: the Body yields a non-byte chunk, so the
  // Request end (reader release) is never proven.
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue("text");
            c.close();
          },
        }),
      ),
  );
  let store: StartupStoreAccess | undefined;
  const result = await startBackend({}, stream, {
    signals,
    finish,
    providers: [single("https://provider.example.test/")],
    initializeStore: (lock) => (store = BackendStore.openV3ForStartup(lock)),
  });
  expect(result?.status).toEqual({ state: "HEALTHY" });
  try {
    // The failed attempt is recorded (Tx-A) while its end stays unproven.
    await vi.waitFor(
      () => {
        const db = new Database(data.path, { readonly: true });
        try {
          expect(
            db.prepare("SELECT COUNT(*) AS n FROM acquisition_control").get(),
          ).toEqual({ n: 1 });
        } finally {
          db.close();
        }
      },
      { timeout: 5000, interval: 20 },
    );
    vi.useFakeTimers();
    signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(9999);
    expect(finish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(finish).toHaveBeenCalledExactlyOnceWith(1);
    expect(logs).toContain("shutdown_timeout");
    expect(logs).not.toContain("database_closed");
  } finally {
    vi.useRealTimers();
    store?.close(); // the pending close hook never reaches its Close
  }
});
