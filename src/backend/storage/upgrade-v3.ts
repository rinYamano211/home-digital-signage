import Database from "better-sqlite3";
import { migrate } from "./migrations.js";
import { v2ToV3Migration } from "./migration-v3.js";
import { validateSchema } from "./schema.js";
import { configureDatabase } from "./store.js";
import { storagePaths, validateDatabaseFiles } from "./paths.js";
import { ExclusiveLock } from "./lock.js";
import { createLogger } from "../logging/logger.js";

/** Offline administrative EX operation; not Startup/Recovery or Provisioning. */
export function upgradeToV3(
  lock: ExclusiveLock,
  confirmation: {
    backupConfirmed: boolean;
    incompatibleRollbackAccepted: boolean;
  },
): void {
  if (
    confirmation.backupConfirmed !== true ||
    confirmation.incompatibleRollbackAccepted !== true
  )
    throw new Error("Migration confirmation required");
  lock.assertHeld();
  validateDatabaseFiles(lock.directory);
  const db = new Database(storagePaths(lock.directory).database, {
    fileMustExist: true,
  });
  try {
    if (db.pragma("quick_check", { simple: true }) !== "ok")
      throw new Error("Database integrity unconfirmed");
    // Validate v2 BEFORE changing journal settings; no same-version repair/replay.
    db.pragma("foreign_keys=ON");
    validateSchema(db, 2);
    const migration = v2ToV3Migration(); // fail before persistent changes if OS ID unavailable
    configureDatabase(db, 3);
    migrate(db, [migration], 3);
    validateDatabaseFiles(lock.directory);
  } finally {
    db.close();
  }
}
if (import.meta.main) {
  try {
    if (
      process.env.SIGNAGE_V3_UPGRADE_ACK !==
      "backup-verified-incompatible-rollback-accepted"
    )
      throw new Error("Confirmation required");
    upgradeToV3(
      ExclusiveLock.inherited(
        process.env.SIGNAGE_DATA_DIR ?? "/var/lib/home-digital-signage",
      ),
      { backupConfirmed: true, incompatibleRollbackAccepted: true },
    );
    createLogger().info(
      { event: "schema_v3_upgraded" },
      "Schema upgraded; Startup and sending remain disabled",
    );
  } catch {
    createLogger().error(
      { event: "schema_upgrade_failed" },
      "Schema upgrade refused or unconfirmed",
    );
    process.exitCode = 1;
  }
}
