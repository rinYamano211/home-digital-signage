import { StoragePathError } from "./paths.js";
export class SchemaError extends Error {
  constructor() {
    super("Unsupported database schema");
  }
}
export type DatabaseStatus =
  | { state: "HEALTHY" }
  | {
      state: "DEGRADED" | "BLOCKED";
      layer: "L1" | "L2" | "L3";
      reason: string;
    };
export function classifyDatabaseError(
  error: unknown,
): Exclude<DatabaseStatus, { state: "HEALTHY" }> {
  const code = (error as { code?: string })?.code ?? "";
  if (
    error instanceof SchemaError ||
    /^SQLITE_(CORRUPT|NOTADB|SCHEMA|ERROR)/.test(code)
  )
    return { state: "BLOCKED", layer: "L3", reason: "schema_or_integrity" };
  if (/^(SQLITE_(BUSY|LOCKED))/.test(code))
    return { state: "DEGRADED", layer: "L1", reason: "temporary_sql" };
  if (/^(ENOENT|EACCES|EPERM|SQLITE_CANTOPEN|SQLITE_READONLY)/.test(code))
    return { state: "DEGRADED", layer: "L2", reason: "database_unavailable" };
  // Unsafe paths and unknown/storage/OS errors are not safe Degraded Start.
  if (error instanceof StoragePathError)
    throw new Error("Storage safety failure (L4)");
  throw new Error("Storage initialization failure (L4)");
}
