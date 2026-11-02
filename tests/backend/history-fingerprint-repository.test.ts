import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { initializeSchema } from "../../src/backend/storage/schema.js";
import { configureDatabase } from "../../src/backend/storage/store.js";
import { LIFECYCLE_DDL } from "../../src/backend/storage/lifecycle-ddl.js";
import { HistoryFingerprintRepository } from "../../src/backend/storage/history-fingerprint-repository.js";
import { connectionCoordination } from "../../src/backend/storage/connection-coordination.js";
import { PublishedStateRepository } from "../../src/backend/storage/published-state-repository.js";
const vectors = JSON.parse(
  readFileSync(
    new URL("../fixtures/quota-history-v1-vectors.json", import.meta.url),
    "utf8",
  ),
) as { name: string; digest: string }[];
const digest = (name: string) => vectors.find((v) => v.name === name)!.digest;
const boot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const dirs: string[] = [];
const dbs: Database.Database[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "signage-fingerprint-"));
  dirs.push(dir);
  const path = join(dir, "signage.db");
  const db = new Database(path);
  dbs.push(db);
  initializeSchema(db);
  configureDatabase(db, 3);
  db.exec(LIFECYCLE_DDL);
  db.pragma("user_version=3");
  db.prepare("INSERT INTO backend_lifecycle VALUES (1,'RUNNING',?,2)").run(
    boot,
  );
  db.prepare("INSERT INTO startup_generations VALUES (2,?,'RUNNING',?,1)").run(
    boot,
    boot,
  );
  db.exec(
    "INSERT INTO provider_quota_metadata VALUES ('p','ACTIVE',0,2); INSERT INTO provider_quota_consumptions VALUES ('p',1,10),('p',2,20)",
  );
  db.prepare(
    "INSERT INTO startup_provider_boundaries VALUES (2,'p','PROVISIONED',2,'ACTIVE',0,?)",
  ).run(digest("provisioned-multiple"));
  return { db, path, repo: new HistoryFingerprintRepository(db) };
}
function enter(f: ReturnType<typeof fixture>) {
  connectionCoordination(f.db).busy = true;
  f.db.exec("BEGIN IMMEDIATE");
}
function leave(f: ReturnType<typeof fixture>) {
  if (f.db.inTransaction) f.db.exec("ROLLBACK");
  connectionCoordination(f.db).busy = false;
}
function verify(f: ReturnType<typeof fixture>, provider = "p") {
  enter(f);
  try {
    return f.repo.verifyLatestWithinTransaction(provider);
  } finally {
    leave(f);
  }
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("D04-R01/R05 Snapshot digest matches inside the caller's Transaction, no SQL writes or commits", () => {
  const f = fixture();
  enter(f);
  const exec = vi.spyOn(f.db, "exec");
  const before = f.db
    .prepare("SELECT * FROM startup_provider_boundaries")
    .all();
  expect(f.repo.verifyLatestWithinTransaction("p")).toEqual({
    outcome: "matched",
    providerKey: "p",
    generation: 2,
    cutoffSequence: 2,
    fingerprint: digest("provisioned-multiple"),
  });
  expect(exec).not.toHaveBeenCalled();
  expect(f.db.inTransaction).toBe(true);
  expect(connectionCoordination(f.db).busy).toBe(true);
  expect(
    f.db.prepare("SELECT * FROM startup_provider_boundaries").all(),
  ).toEqual(before);
  leave(f);
});
test("D04-R05 current Metadata changes cannot substitute for historical Snapshot", () => {
  const f = fixture();
  f.db.exec(
    "UPDATE provider_quota_metadata SET history_status='SUSPENDED',initialized_at_ms=1000,last_sequence=3; INSERT INTO provider_quota_consumptions VALUES ('p',3,1000)",
  );
  const prepare = vi.spyOn(f.db, "prepare");
  expect(verify(f).outcome).toBe("matched");
  expect(
    prepare.mock.calls.some(([sql]) =>
      /SELECT .*FROM provider_quota_metadata/i.test(sql),
    ),
  ).toBe(false);
});
test("D04-R01 cutoff-after invalid Timestamp is outside this fingerprint, requires later full validation", () => {
  const f = fixture();
  f.db.exec(
    "INSERT INTO provider_quota_consumptions VALUES ('p',3,-1); UPDATE provider_quota_metadata SET last_sequence=3",
  );
  expect(verify(f).outcome).toBe("matched");
});
test("D04-R05 UNPROVISIONED Snapshot ignores later provisioning, hashes Metadata absence", () => {
  const f = fixture();
  f.db
    .prepare(
      "UPDATE startup_provider_boundaries SET provider_state='UNPROVISIONED',cutoff_sequence=NULL,history_status_snapshot=NULL,initialized_at_ms_snapshot=NULL,history_fingerprint=?",
    )
    .run(digest("unprovisioned"));
  expect(verify(f)).toMatchObject({
    outcome: "matched",
    cutoffSequence: null,
    fingerprint: digest("unprovisioned"),
  });
});
test("D04-R05 PROVISIONED zero differs from UNPROVISIONED and includes Snapshot", () => {
  const f = fixture();
  f.db
    .prepare(
      "UPDATE startup_provider_boundaries SET cutoff_sequence=0,history_fingerprint=?",
    )
    .run(digest("provisioned-zero"));
  expect(verify(f)).toMatchObject({ outcome: "matched", cutoffSequence: 0 });
});
test("D04-R01 missing latest Boundary rejects rather than claiming an empty new history", () => {
  const f = fixture();
  f.db.exec("DELETE FROM startup_provider_boundaries");
  expect(verify(f)).toEqual({
    outcome: "rejected",
    reason: "boundary_missing",
  });
});
test("D04-R01 Migration Gen1 has no Boundary; absence is not fingerprint success", () => {
  const f = fixture();
  f.db.exec(
    "DELETE FROM startup_provider_boundaries;DELETE FROM startup_generations;UPDATE backend_lifecycle SET generation=1",
  );
  expect(verify(f).outcome).toBe("rejected");
});
function generation3(f: ReturnType<typeof fixture>) {
  f.db
    .prepare("INSERT INTO startup_generations VALUES (3,?,'RUNNING',?,2)")
    .run(boot, boot);
  f.db.exec("UPDATE backend_lifecycle SET generation=3");
}
test.each(["missing", "digest", "snapshot", "future"])(
  "D04-R01 invalid latest Boundary %s never falls back to valid older Row",
  (fault) => {
    const f = fixture();
    generation3(f);
    if (fault !== "missing")
      f.db
        .prepare(
          "INSERT INTO startup_provider_boundaries VALUES (3,'p','PROVISIONED',2,'ACTIVE',0,?)",
        )
        .run(digest("provisioned-multiple"));
    if (fault === "digest")
      f.db
        .prepare(
          "UPDATE startup_provider_boundaries SET history_fingerprint=? WHERE generation=3",
        )
        .run("0".repeat(64));
    if (fault === "snapshot")
      f.db.exec(
        "UPDATE startup_provider_boundaries SET initialized_at_ms_snapshot=9007199254740991 WHERE generation=3",
      );
    if (fault === "future")
      f.db.exec("UPDATE backend_lifecycle SET generation=2");
    const result = verify(f);
    expect(result.outcome).toBe("rejected");
    expect(
      f.db
        .prepare(
          "SELECT history_fingerprint FROM startup_provider_boundaries WHERE generation=2",
        )
        .get(),
    ).toEqual({ history_fingerprint: digest("provisioned-multiple") });
  },
);
test.each([null, "bad", "A".repeat(64), "a".repeat(63)])(
  "D04-R05 missing/invalid Digest %s fails closed with no repair",
  (value) => {
    const f = fixture();
    f.db.pragma("ignore_check_constraints=ON");
    if (value === null) {
      // NOT NULL cannot be bypassed: inject a missing field in the read result.
      const prepare = f.db.prepare.bind(f.db);
      vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
        const stmt = prepare(sql);
        if (sql.includes("WHERE provider_key=? ORDER BY generation DESC")) {
          vi.spyOn(stmt, "get").mockImplementation(() => ({
            generation: 2n,
            provider_key: "p",
            provider_state: "PROVISIONED",
            cutoff_sequence: 2n,
            history_status_snapshot: "ACTIVE",
            initialized_at_ms_snapshot: 0n,
            history_fingerprint: null,
          }));
        }
        return stmt;
      });
    } else
      f.db
        .prepare("UPDATE startup_provider_boundaries SET history_fingerprint=?")
        .run(value);
    const before = f.db
      .prepare("SELECT * FROM startup_provider_boundaries")
      .all();
    expect(verify(f).outcome).not.toBe("matched");
    expect(
      f.db.prepare("SELECT * FROM startup_provider_boundaries").all(),
    ).toEqual(before);
  },
);
test.each([
  "missing",
  "negative_timestamp",
  "real_timestamp",
  "real_sequence",
  "zero_sequence",
])(
  "D04-R05 invalid prefix Consumption %s rejected without normalization",
  (fault) => {
    const f = fixture();
    f.db.pragma("ignore_check_constraints=ON");
    if (fault === "missing")
      f.db.exec("DELETE FROM provider_quota_consumptions WHERE sequence=1");
    if (fault === "negative_timestamp")
      f.db.exec(
        "UPDATE provider_quota_consumptions SET reserved_at_ms=-1 WHERE sequence=1",
      );
    if (fault === "real_timestamp")
      f.db.exec(
        "UPDATE provider_quota_consumptions SET reserved_at_ms=1.5 WHERE sequence=1",
      );
    if (fault === "real_sequence")
      f.db.exec(
        "UPDATE provider_quota_consumptions SET sequence=1.5 WHERE sequence=1",
      );
    if (fault === "zero_sequence")
      f.db.exec(
        "UPDATE provider_quota_consumptions SET sequence=0 WHERE sequence=1",
      );
    expect(verify(f).outcome).not.toBe("matched");
  },
);
test("D04-R05 returned duplicate/out-of-order rows are rejected, never sorted or deduplicated", () => {
  const f = fixture();
  const prepare = f.db.prepare.bind(f.db);
  vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
    const stmt = prepare(sql);
    if (sql.includes("sequence<=? ORDER BY sequence ASC"))
      vi.spyOn(stmt, "all").mockReturnValue([
        { sequence: 1n, reserved_at_ms: 10n },
        { sequence: 1n, reserved_at_ms: 10n },
      ]);
    return stmt;
  });
  expect(verify(f)).toEqual({ outcome: "rejected", reason: "invalid_history" });
});
test("D04-R05 prefix byte change rejects without updating the saved Digest", () => {
  const f = fixture();
  f.db.exec(
    "UPDATE provider_quota_consumptions SET reserved_at_ms=11 WHERE sequence=1",
  );
  expect(verify(f)).toEqual({
    outcome: "rejected",
    reason: "fingerprint_mismatch",
  });
  expect(
    f.db
      .prepare("SELECT history_fingerprint FROM startup_provider_boundaries")
      .get(),
  ).toEqual({ history_fingerprint: digest("provisioned-multiple") });
});
test("same v3 file can be verified from a regenerated owner Connection", () => {
  const f = fixture();
  f.db.close();
  const db = new Database(f.path, { fileMustExist: true });
  dbs.push(db);
  configureDatabase(db, 3);
  const next = { ...f, db, repo: new HistoryFingerprintRepository(db) };
  expect(verify(next).outcome).toBe("matched");
});
test("owned Transaction and shared gate required; never starts a Transaction itself", () => {
  const f = fixture();
  const exec = vi.spyOn(f.db, "exec");
  expect(() => f.repo.verifyLatestWithinTransaction("p")).toThrow(
    "Owned Transaction required",
  );
  expect(exec).not.toHaveBeenCalled();
  connectionCoordination(f.db).busy = true;
  expect(f.repo.verifyLatestWithinTransaction("p").outcome).toBe(
    "database_error",
  );
  expect(exec).not.toHaveBeenCalled();
});
test.each(["blocked", "connectionUnresolved"] as const)(
  "shared %s refuses all queries without clearing the owner's busy",
  (flag) => {
    const f = fixture();
    enter(f);
    const c = connectionCoordination(f.db);
    if (flag === "blocked")
      c.blocked = { scope: "database", layer: "L3", reason: "blocked" };
    else c.connectionUnresolved = true;
    const prepare = vi.spyOn(f.db, "prepare");
    expect(f.repo.verifyLatestWithinTransaction("p").outcome).toBe(
      "database_error",
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(c.busy).toBe(true);
    leave(f);
  },
);
test.each(["SQLITE_BUSY", "SQLITE_CORRUPT", "unknown"])(
  "SQLite exception %s never resolves the owner's Transaction or returns a match",
  (code) => {
    const f = fixture();
    enter(f);
    const prepare = f.db.prepare.bind(f.db);
    const exec = vi.spyOn(f.db, "exec");
    vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
      if (sql.includes("FROM startup_provider_boundaries WHERE"))
        throw Object.assign(
          new Error("private SQL detail"),
          code === "unknown" ? {} : { code },
        );
      return prepare(sql);
    });
    const result = f.repo.verifyLatestWithinTransaction("p");
    expect(result.outcome).toBe("database_error");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(exec).not.toHaveBeenCalled();
    expect(f.db.inTransaction).toBe(true);
    expect(connectionCoordination(f.db).busy).toBe(true);
    if (code !== "SQLITE_BUSY") {
      expect(connectionCoordination(f.db).blocked).toBeDefined();
      expect(
        new PublishedStateRepository(f.db).save("schedule", "{}").outcome,
      ).not.toBe("saved");
    }
    leave(f);
  },
);
test("read does not create Trust, Startup, send or update capabilities", () => {
  const f = fixture();
  expect(verify(f)).not.toHaveProperty("trusted");
  expect(f.repo).not.toHaveProperty("save");
  expect(f.repo).not.toHaveProperty("commit");
  expect(
    f.db.prepare("SELECT state,generation FROM backend_lifecycle").get(),
  ).toEqual({ state: "RUNNING", generation: 2 });
  expect(f.db.prepare("SELECT * FROM history_uncertain_ranges").all()).toEqual(
    [],
  );
});

test("Transaction status unreadable is shared-unresolved, never a match or implicit recovery", () => {
  const f = fixture();
  f.db.exec("BEGIN IMMEDIATE");
  const proxy = new Proxy(f.db, {
    get(target, key) {
      if (key === "inTransaction") throw new Error("private status");
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const c = connectionCoordination(proxy);
  c.busy = true;
  const repo = new HistoryFingerprintRepository(proxy);
  expect(repo.verifyLatestWithinTransaction("p")).toMatchObject({
    outcome: "database_error",
    reason: "transaction_unresolved",
  });
  expect(c.connectionUnresolved).toBe(true);
  expect(c.blocked).toBeDefined();
  expect(c.busy).toBe(true);
  expect(f.db.inTransaction).toBe(true);
});
test("prefix Timestamp beyond JS Date range is rejected even within safe INTEGER range", () => {
  const f = fixture();
  f.db.exec(
    "UPDATE provider_quota_consumptions SET reserved_at_ms=9007199254740991 WHERE sequence=1",
  );
  expect(verify(f)).toEqual({ outcome: "rejected", reason: "invalid_history" });
});
