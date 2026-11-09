import Database from "better-sqlite3";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../config/loader.js";
import { createLogger } from "../logging/logger.js";
import { TOMORROW_IO } from "../quota/quota-guard.js";
import { ExclusiveLock } from "./lock.js";
import { storagePaths, validateDatabaseFiles } from "./paths.js";
import { QuotaRepository } from "./quota-repository.js";
import { validateSchema } from "./schema.js";
import { configureDatabase } from "./store.js";

/** Explicit F-01 initial Provisioning of the Tomorrow.io Quota history
 * (technology-stack 21.9). An offline administration command: it runs under
 * the Backend's exclusive Lock, never starts the Backend or its Startup
 * Transaction, and never reads or prints the API key. The administrator
 * answers each of the four F-01 conditions individually; anything but an
 * exact "yes" refuses, and nothing is written.
 */
export const PROVISION_QUESTIONS = [
  "1. The system clock is trusted (the OS reports it as synchronized). Continue? [yes/no]",
  "2. Past use of this API key is outside the Quota periods (24 hours / 60 minutes / 1 second). Continue? [yes/no]",
  "3. A sufficient safety margin has passed since the last use. Continue? [yes/no]",
  "4. No other sender uses the same API key. Continue? [yes/no]",
] as const;

export type QuotaProvisionResult =
  { outcome: "initialized" } | { outcome: "refused"; reason: string };

/** `ask` returns the administrator's answer to one question. Only the exact
 * answer "yes" counts; the test seam is the prompt, never a Trust value.
 */
export async function provisionQuota(
  lock: ExclusiveLock,
  ask: (question: string) => Promise<string>,
): Promise<QuotaProvisionResult> {
  lock.assertHeld();
  validateDatabaseFiles(lock.directory);
  let db: Database.Database | undefined;
  try {
    db = new Database(storagePaths(lock.directory).database, {
      fileMustExist: true,
      timeout: 5000,
    });
    // Never migrate or create tables: only an existing v3 database qualifies.
    if (db.pragma("user_version", { simple: true }) !== 3)
      return { outcome: "refused", reason: "schema_incompatible" };
    configureDatabase(db, 3);
    validateSchema(db, 3);
    const answers: boolean[] = [];
    for (const question of PROVISION_QUESTIONS)
      answers.push((await ask(question)) === "yes");
    if (answers.some((answer) => !answer))
      return { outcome: "refused", reason: "initial_safety_unconfirmed" };
    const result = new QuotaRepository(db, 3).provisionProvider(TOMORROW_IO, {
      clockTrusted: answers[0]!,
      pastUseOutsideQuotaPeriodsConfirmed: answers[1]!,
      safetyMarginConfirmed: answers[2]!,
      exclusiveKeyUseConfirmed: answers[3]!,
    });
    return result.outcome === "initialized"
      ? { outcome: "initialized" }
      : { outcome: "refused", reason: result.reason ?? result.outcome };
  } catch {
    return { outcome: "refused", reason: "storage_error" };
  } finally {
    db?.close();
  }
}

/** Piped or scripted input must not answer the confirmations. */
export const isInteractive = (input: { isTTY?: boolean }) =>
  input.isTTY === true;

if (import.meta.main) {
  const logger = createLogger();
  try {
    const config = loadConfig({ ...process.env });
    if (!isInteractive(process.stdin)) {
      logger.error(
        { event: "provision_quota_refused", reason: "not_interactive" },
        "Quota provisioning refused",
      );
      process.exitCode = 1;
    } else {
      const lock = ExclusiveLock.inherited(config.dataDirectory);
      const terminal = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        process.stdout.write(
          `Current system time (UTC): ${new Date().toISOString()}\n` +
            "Check the OS time synchronization before answering (for example: timedatectl).\n",
        );
        const result = await provisionQuota(lock, (question) =>
          terminal.question(`${question} `),
        );
        if (result.outcome === "initialized") {
          logger.info(
            { event: "provision_quota_complete" },
            "Quota provisioned",
          );
        } else {
          logger.error(
            { event: "provision_quota_refused", reason: result.reason },
            "Quota provisioning refused",
          );
          process.exitCode = 1;
        }
      } finally {
        terminal.close();
      }
    }
  } catch {
    logger.error(
      { event: "provision_quota_refused", reason: "startup_error" },
      "Quota provisioning refused",
    );
    process.exitCode = 1;
  }
}
