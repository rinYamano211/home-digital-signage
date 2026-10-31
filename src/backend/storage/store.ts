import Database from "better-sqlite3";
import type { ExclusiveLock } from "./lock.js";
import { storagePaths, validateDatabaseFiles } from "./paths.js";
import { migrate } from "./migrations.js";
import { QuotaRepository } from "./quota-repository.js";
import { enableForeignKeys } from "./schema.js";
import { SchemaError } from "./errors.js";
import { PublishedStateRepository } from "./published-state-repository.js";
import { AcquisitionControlRepository } from "./acquisition-control-repository.js";
import { BackendCacheRepository } from "./backend-cache-repository.js";

export function configureDatabase(db: Database.Database) {
  enableForeignKeys(db);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("wal_autocheckpoint = 1000");
  if (
    db.pragma("journal_mode", { simple: true }) !== "wal" ||
    db.pragma("synchronous", { simple: true }) !== 1 ||
    db.pragma("wal_autocheckpoint", { simple: true }) !== 1000
  )
    throw new SchemaError();
}
export class BackendStore {
  readonly publishedStates: PublishedStateRepository;
  readonly cache: BackendCacheRepository;
  readonly acquisitionControl: AcquisitionControlRepository;
  readonly quota: QuotaRepository;
  private constructor(private readonly db: Database.Database) {
    this.publishedStates = new PublishedStateRepository(db);
    this.cache = new BackendCacheRepository(db);
    this.acquisitionControl = new AcquisitionControlRepository(db);
    this.quota = new QuotaRepository(db);
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
  close() {
    if (this.db.open) this.db.close();
  }
}
