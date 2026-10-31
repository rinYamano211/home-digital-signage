import Database from "better-sqlite3";
import { migrate, V1_TO_V2 } from "./migrations.js";
import { storagePaths, validateDatabaseFiles } from "./paths.js";
import { ExclusiveLock } from "./lock.js";
import { createLogger } from "../logging/logger.js";

/** Administrative operation only, never invoked by normal startup/recovery.
 * Operator stops the old Release, backs up DB/WAL consistently, and accepts
 * that v2 cannot be rolled back to v1 by switching a release symlink alone.
 */
export function upgradeToV2(
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
    migrate(db, [V1_TO_V2], 2);
    validateDatabaseFiles(lock.directory);
  } finally {
    db.close();
  }
}
if (import.meta.main) {
  try {
    if (
      process.env.SIGNAGE_V2_UPGRADE_ACK !==
      "backup-verified-incompatible-rollback-accepted"
    )
      throw new Error("Confirmation required");
    upgradeToV2(
      ExclusiveLock.inherited(
        process.env.SIGNAGE_DATA_DIR ?? "/var/lib/home-digital-signage",
      ),
      { backupConfirmed: true, incompatibleRollbackAccepted: true },
    );
    createLogger().info(
      { event: "schema_v2_upgraded" },
      "Schema upgrade complete; Provider remains unprovisioned",
    );
  } catch {
    createLogger().error(
      { event: "schema_upgrade_failed" },
      "Schema upgrade refused or unconfirmed",
    );
    process.exitCode = 1;
  }
}
