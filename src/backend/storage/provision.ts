import { closeSync, openSync } from "node:fs";
import Database from "better-sqlite3";
import { loadConfig } from "../config/loader.js";
import { createLogger } from "../logging/logger.js";
import { ExclusiveLock } from "./lock.js";
import { storagePaths, validateDatabaseFiles } from "./paths.js";
import { configureDatabase } from "./store.js";
import { initializeSchema, validateSchema } from "./schema.js";

export function provision(lock: ExclusiveLock) {
  lock.assertHeld();
  const path = storagePaths(lock.directory).database;
  // wx rechecks existence atomically under EX, including dangling symlinks.
  const fd = openSync(path, "wx", 0o600);
  closeSync(fd);
  let db: Database.Database | undefined;
  try {
    validateDatabaseFiles(lock.directory);
    db = new Database(path, { fileMustExist: true });
    configureDatabase(db);
    initializeSchema(db);
    validateSchema(db);
  } finally {
    db?.close();
  }
  // Deliberately preserve even incomplete files on failure. FD 9 dies with Node.
}
if (import.meta.main) {
  const logger = createLogger();
  try {
    const config = loadConfig({ ...process.env });
    provision(ExclusiveLock.inherited(config.dataDirectory));
    logger.info({ event: "provision_complete" }, "Database provisioned");
  } catch {
    logger.error(
      { event: "provision_failed" },
      "Database provisioning refused or failed",
    );
    process.exitCode = 1;
  }
}
