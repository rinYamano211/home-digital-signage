import { readFileSync } from "node:fs";
import { platform } from "node:os";
import { SchemaError } from "../storage/errors.js";

export function normalizedBootId(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      value,
    )
  )
    return null;
  const normalized = value.toLowerCase();
  return normalized === "00000000-0000-0000-0000-000000000000"
    ? null
    : normalized;
}
/** Fixed OS source, not an env/config override or randomly generated ID. */
export function readOsBootId(): string {
  try {
    if (platform() !== "linux") throw new SchemaError();
    const raw = readFileSync("/proc/sys/kernel/random/boot_id", "utf8");
    const id = normalizedBootId(raw.replace(/\r?\n$/, ""));
    if (id === null) throw new SchemaError();
    return id;
  } catch {
    throw new SchemaError();
  }
}
