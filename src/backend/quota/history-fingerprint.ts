import { createHash } from "node:crypto";
import { quotaTimestamp, type QuotaHistory } from "./quota-guard.js";
import {
  encodeHistoryField,
  unsignedInteger,
  FingerprintInputError,
} from "./internal/history-fingerprint-encoding.js";
export { FingerprintInputError } from "./internal/history-fingerprint-encoding.js";
/** Deterministic historical serialization only. Timestamp structure is checked;
 * chronology/current Clock/History Trust are separate, never inferred here.
 */
export function historyFingerprint(history: QuotaHistory): string {
  try {
    if (
      !history ||
      typeof history !== "object" ||
      Array.isArray(history) ||
      Object.keys(history).length !== 2 ||
      !Object.hasOwn(history, "metadata") ||
      !Object.hasOwn(history, "consumptions")
    )
      throw new FingerprintInputError();
    const metadata = history.metadata,
      rows = history.consumptions;
    if (!Array.isArray(rows)) throw new FingerprintInputError();
    const count = rows.length;
    const hash = createHash("sha256");
    const field = (tag: number, value: unknown) => {
      hash.update(encodeHistoryField(tag, value));
    };
    field(0x01, "quota-history-v1");
    if (metadata === null) {
      if (count !== 0) throw new FingerprintInputError();
      field(0x04, null);
      field(0x05, 0);
    } else {
      if (
        !metadata ||
        typeof metadata !== "object" ||
        Array.isArray(metadata) ||
        Object.keys(metadata).length !== 4 ||
        ![
          "providerKey",
          "historyStatus",
          "initializedAtMs",
          "lastSequence",
        ].every((k) => Object.hasOwn(metadata, k))
      )
        throw new FingerprintInputError();
      const { providerKey, historyStatus, initializedAtMs, lastSequence } =
        metadata;
      if (
        typeof providerKey !== "string" ||
        providerKey.length === 0 ||
        !["ACTIVE", "SUSPENDED"].includes(historyStatus) ||
        !quotaTimestamp(initializedAtMs) ||
        !unsignedInteger(lastSequence) ||
        lastSequence !== count
      )
        throw new FingerprintInputError();
      field(0x01, providerKey);
      field(0x01, historyStatus);
      field(0x02, initializedAtMs);
      field(0x02, lastSequence);
      field(0x05, count);
      for (let i = 0; i < count; i++) {
        const row = rows[i];
        if (
          !row ||
          typeof row !== "object" ||
          Array.isArray(row) ||
          Object.keys(row).length !== 2 ||
          !Object.hasOwn(row, "sequence") ||
          !Object.hasOwn(row, "reservedAtMs")
        )
          throw new FingerprintInputError();
        const { sequence, reservedAtMs } = row;
        if (
          !unsignedInteger(sequence) ||
          sequence !== i + 1 ||
          !quotaTimestamp(reservedAtMs)
        )
          throw new FingerprintInputError();
        field(0x02, sequence);
        field(0x02, reservedAtMs);
      }
    }
    return hash.digest("hex");
  } catch {
    throw new FingerprintInputError();
  }
}
