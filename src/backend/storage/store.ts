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
}
const startupOwners = new WeakMap<StartupStoreAccess, BackendStore>();
export class BackendStore {
  readonly publishedStates: PublishedStateRepository;
  readonly cache: BackendCacheRepository;
  readonly acquisitionControl: AcquisitionControlRepository;
  readonly quota: QuotaRepository;
  private closing = false;
  private runtime?: RuntimeStoreAccess;
  private constructor(
    private readonly db: Database.Database,
    version: 2 | 3 = 2,
  ) {
    this.publishedStates = new PublishedStateRepository(db);
    this.cache = new BackendCacheRepository(db);
    this.acquisitionControl = new AcquisitionControlRepository(db);
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
  private activate(): RuntimeStoreAccess | null {
    try {
      const c = connectionCoordination(this.db);
      if (
        this.closing ||
        !this.db.open ||
        c.busy ||
        c.blocked ||
        c.connectionUnresolved ||
        this.db.inTransaction !== false ||
        !committedStartup(this.db)
      )
        return null;
    } catch {
      return null;
    }
    this.runtime ??= Object.freeze({
      runtimeActive: true as const,
      quota: this.quota,
    });
    return this.runtime;
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
