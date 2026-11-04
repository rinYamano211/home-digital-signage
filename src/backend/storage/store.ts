import Database from "better-sqlite3";
import {
  StartupTransactionService,
  type StartupRequest,
  type StartupResult,
} from "./startup-transaction.js";
import type { ExclusiveLock } from "./lock.js";
import { storagePaths, validateDatabaseFiles } from "./paths.js";
import { migrate } from "./migrations.js";
import { QuotaRepository } from "./quota-repository.js";
import {
  LifecycleRepository,
  type LifecycleReadResult,
} from "./lifecycle-repository.js";
import { connectionCoordination } from "./connection-coordination.js";
import { enableForeignKeys, validateSchema } from "./schema.js";
import { SchemaError } from "./errors.js";
import { PublishedStateRepository } from "./published-state-repository.js";
import { AcquisitionControlRepository } from "./acquisition-control-repository.js";
import { BackendCacheRepository } from "./backend-cache-repository.js";
import { committedStartup } from "./internal/startup-commit.js";
import { HistoryRangeRepository } from "./history-range-repository.js";
import { RuntimeHistory } from "../quota/internal/runtime-history.js";
import { ClockTrustMonitor } from "../send/internal/trust.js";
import { HistoryRecovery } from "../quota/internal/history-boundaries.js";
import type { ProviderSendGate } from "../send/internal/provider-send-gate.js";

export function configureDatabase(db: Database.Database, version: 2 | 3 = 2) {
  enableForeignKeys(db);
  db.pragma("journal_mode = WAL");
  db.pragma(version === 3 ? "synchronous = FULL" : "synchronous = NORMAL");
  db.pragma("wal_autocheckpoint = 1000");
  if (
    db.pragma("journal_mode", { simple: true }) !== "wal" ||
    db.pragma("synchronous", { simple: true }) !== (version === 3 ? 2 : 1) ||
    db.pragma("wal_autocheckpoint", { simple: true }) !== 1000
  )
    throw new SchemaError();
}
export interface StartupStoreAccess {
  readonly startupComplete: false;
  readonly startup: Readonly<{
    execute(request: StartupRequest): StartupResult;
  }>;
  readonly lifecycle: Readonly<{ read(): LifecycleReadResult }>;
  close(): void;
}
/** DB access only, never Clock/History Trust, a quota decision or Send Permit.
 * The Startup facade remains the single Close owner of the same Connection.
 */
export interface RuntimeStoreAccess {
  readonly runtimeActive: true;
  readonly quota: QuotaRepository;
  /** Read only; saving belongs to the Coordinator (C-Impl-5C). */
  readonly publishedStates: Readonly<{
    read: PublishedStateRepository["read"];
  }>;
}
/** Thin bundle of existing components; neither Trust nor a Send Permit. */
export interface RuntimeHistoryAccess {
  readonly history: RuntimeHistory;
  readonly ranges: HistoryRangeRepository;
}
const startupOwners = new WeakMap<StartupStoreAccess, BackendStore>();
export class BackendStore {
  readonly publishedStates: PublishedStateRepository;
  readonly cache: BackendCacheRepository;
  readonly acquisitionControl: AcquisitionControlRepository;
  readonly quota: QuotaRepository;
  private closing = false;
  private runtime?: RuntimeStoreAccess;
  private history?: { clock: ClockTrustMonitor; access: RuntimeHistoryAccess };
  private historyFailed = false;
  private recovery?: { gate: ProviderSendGate; owner: HistoryRecovery };
  private recoveryFailed = false;
  private constructor(
    private readonly db: Database.Database,
    version: 2 | 3 = 2,
  ) {
    this.publishedStates = new PublishedStateRepository(db, undefined, version);
    this.cache = new BackendCacheRepository(db, undefined, version);
    this.acquisitionControl = new AcquisitionControlRepository(
      db,
      undefined,
      version,
    );
    this.quota = new QuotaRepository(db, version);
  }
  /** Opens Runtime DB access on the same Connection only after this facade's
   * own confirmed Startup Commit. The Lifecycle row alone is not evidence.
   * Repeated calls re-check and return the same object; no new Repository.
   */
  static activateRuntime(
    startup: StartupStoreAccess,
  ): RuntimeStoreAccess | null {
    const owner = startupOwners.get(startup);
    return owner ? owner.activate() : null;
  }
  /** Existing History components on the same Connection and QuotaRepository,
   * under the same conditions as activateRuntime(). Clock TRUSTED is not
   * required; creation grants no Clock/History Trust, quota or send authority.
   * One RuntimeHistory per Connection: another Clock or a failed creation is
   * refused permanently rather than re-created.
   */
  static createRuntimeHistory(
    startup: StartupStoreAccess,
    clock: ClockTrustMonitor,
  ): RuntimeHistoryAccess | null {
    const owner = startupOwners.get(startup);
    return owner ? owner.historyAccess(clock) : null;
  }
  /** The single HistoryRecovery for this Connection, after createRuntimeHistory()
   * with the same Clock. Creation closes the Gate and freezes RuntimeHistory;
   * it grants no Trust or send authority. Another Gate/Clock, Close or a failed
   * creation returns null without re-creation.
   */
  static createHistoryRecovery(
    startup: StartupStoreAccess,
    gate: ProviderSendGate,
    clock: ClockTrustMonitor,
  ): HistoryRecovery | null {
    const owner = startupOwners.get(startup);
    return owner ? owner.recoveryOwner(gate, clock) : null;
  }
  private runtimeReady(): boolean {
    try {
      const c = connectionCoordination(this.db);
      return (
        !this.closing &&
        this.db.open &&
        !c.busy &&
        !c.blocked &&
        !c.connectionUnresolved &&
        this.db.inTransaction === false &&
        !!committedStartup(this.db)
      );
    } catch {
      return false;
    }
  }
  private activate(): RuntimeStoreAccess | null {
    if (!this.runtimeReady()) return null;
    this.runtime ??= Object.freeze({
      runtimeActive: true as const,
      quota: this.quota,
      publishedStates: Object.freeze({
        read: this.publishedStates.read.bind(this.publishedStates),
      }),
    });
    return this.runtime;
  }
  private historyAccess(clock: ClockTrustMonitor): RuntimeHistoryAccess | null {
    if (
      this.historyFailed ||
      !(clock instanceof ClockTrustMonitor) ||
      (this.history && this.history.clock !== clock) ||
      !this.runtimeReady()
    )
      return null;
    if (!this.history) {
      try {
        const history = new RuntimeHistory(this.db, this.quota, clock);
        const ranges = new HistoryRangeRepository(this.db, history);
        this.history = {
          clock,
          access: Object.freeze({ history, ranges }),
        };
      } catch {
        // RuntimeHistory may already own this Connection; never retry it.
        this.historyFailed = true;
        return null;
      }
    }
    return this.history.access;
  }
  private recoveryOwner(
    gate: ProviderSendGate,
    clock: ClockTrustMonitor,
  ): HistoryRecovery | null {
    const history = this.history;
    if (
      this.recoveryFailed ||
      !history ||
      history.clock !== clock ||
      (this.recovery && this.recovery.gate !== gate) ||
      !this.runtimeReady()
    )
      return null;
    if (!this.recovery) {
      try {
        // The constructor re-checks Runtime/Gate/Clock identity itself.
        const owner = new HistoryRecovery(
          this.db,
          this.quota,
          history.access.history,
          gate,
          clock,
        );
        this.recovery = { gate, owner };
      } catch {
        // Gate/Repository bindings may be partially made; never retry them.
        this.recoveryFailed = true;
        return null;
      }
    }
    return this.recovery.owner;
  }
  static open(lock: ExclusiveLock): BackendStore {
    lock.assertHeld();
    validateDatabaseFiles(lock.directory);
    const db = new Database(storagePaths(lock.directory).database, {
      fileMustExist: true,
      timeout: 5000,
    });
    try {
      // Validate before changing persistent journal mode. Never auto-create tables.
      if (db.pragma("quick_check", { simple: true }) !== "ok")
        throw new SchemaError();
      migrate(db);
      configureDatabase(db);
      validateDatabaseFiles(lock.directory);
      return new BackendStore(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  /** Explicit restricted v3 connection; not wired into startBackend().
   * No Quota/HTTP/Control writer or raw Connection escapes before Startup.
   */
  static openV3ForStartup(lock: ExclusiveLock): StartupStoreAccess {
    lock.assertHeld();
    validateDatabaseFiles(lock.directory);
    const db = new Database(storagePaths(lock.directory).database, {
      fileMustExist: true,
      timeout: 5000,
    });
    const c = connectionCoordination(db);
    let ownsBusy = false;
    try {
      if (c.busy)
        throw Object.assign(new Error("Connection busy"), {
          code: "SQLITE_BUSY",
        });
      if (c.blocked || c.connectionUnresolved || db.inTransaction !== false)
        throw new SchemaError();
      c.busy = true;
      ownsBusy = true;
      // Reject old/unknown versions before any configuration; never migrate.
      if (db.pragma("user_version", { simple: true }) !== 3)
        throw new SchemaError();
      configureDatabase(db, 3);
      validateSchema(db, 3);
      validateDatabaseFiles(lock.directory);
      const owner = new BackendStore(db, 3);
      const lifecycle = new LifecycleRepository(db);
      const startup = new StartupTransactionService(db, lock);
      const access: StartupStoreAccess = Object.freeze({
        startupComplete: false as const,
        startup: Object.freeze({ execute: startup.execute.bind(startup) }),
        lifecycle: Object.freeze({ read: lifecycle.read.bind(lifecycle) }),
        close: () => owner.close(),
      });
      startupOwners.set(access, owner);
      return access;
    } catch (error) {
      db.close();
      throw error;
    } finally {
      if (ownsBusy) c.busy = false;
    }
  }
  close() {
    this.closing = true;
    if (this.db.open) this.db.close();
  }
}
