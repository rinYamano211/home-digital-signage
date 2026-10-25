import { expect, test } from "vitest";
import {
  evaluateCacheRead,
  isCacheEntry,
  utcInstant,
  type CacheEntry,
  type CacheReadResult,
  type CacheReadEvidence,
} from "../../src/backend/storage/cache-entry.js";
const entry: CacheEntry<{ value: number }> = {
  schemaVersion: 1,
  data: { value: 1 },
  dataUpdatedAt: "2026-10-25T00:00:00Z",
  expiresAt: "2026-10-25T02:00:00Z",
};
// TTL helper accepts a Repository result; the token is never used for a save here.
const result: CacheReadResult<{ value: number }> = {
  outcome: "found",
  entry,
  evidence: {} as CacheReadEvidence,
};
test("C-30 exact expiration is excluded and source timestamps never change", () => {
  const source = JSON.stringify(entry);
  const expires = Date.parse(entry.expiresAt);
  expect(evaluateCacheRead(result, expires - 1)).toEqual({
    outcome: "usable",
    entry,
  });
  expect(evaluateCacheRead(result, expires)).toEqual({ outcome: "expired" });
  expect(evaluateCacheRead(result, expires + 1)).toEqual({
    outcome: "expired",
  });
  expect(JSON.stringify(entry)).toBe(source);
});
test.each([null, NaN, Infinity, -Infinity, 9e15])(
  "C-30 untrusted or nonrepresentable time %s provides no Fallback data",
  (now) => {
    expect(evaluateCacheRead(result, now)).toEqual({ outcome: "time_unknown" });
    expect(evaluateCacheRead(result, now)).not.toHaveProperty("entry");
  },
);
test.each([
  "empty",
  "invalid",
  "validator_error",
  "database_error",
  "pending",
] as const)("C-30 %s never supplies Fallback data", (outcome) => {
  const denied = { ...result, outcome } as unknown as CacheReadResult<{
    value: number;
  }>;
  const actual = evaluateCacheRead(denied, Date.parse(entry.dataUpdatedAt));
  expect(actual.outcome).toBe(
    outcome === "invalid" ? "invalid" : "unavailable",
  );
  expect(actual).not.toHaveProperty("entry");
});
test.each([
  "2026-02-29T00:00:00Z",
  "2026-04-31T00:00:00Z",
  "2026-00-01T00:00:00Z",
  "2026-13-01T00:00:00Z",
  "2026-01-00T00:00:00Z",
  "2026-01-01T24:00:00Z",
  "2026-01-01T00:60:00Z",
  "2026-01-01T00:00:61Z",
  "2026-01-01",
  "2026-01-01T00:00:00",
  "2026-01-01T00:00:00+09:00",
  "2026-01-01T00:00:00-00:00",
])("C-08 common schema rejects invalid/non-UTC timestamp %s", (timestamp) => {
  expect(utcInstant(timestamp)).toBeNull();
  expect(isCacheEntry({ ...entry, expiresAt: timestamp })).toBe(false);
});
test.each([
  "2024-02-29T00:00:00Z",
  "2000-02-29T00:00:00.123Z",
  "2026-01-01T00:00:00+00:00",
  "2026-01-01t00:00:00z",
])("UTC RFC3339 timestamp %s is accepted", (timestamp) => {
  expect(utcInstant(timestamp)).toBe(Date.parse(timestamp));
  expect(isCacheEntry({ ...entry, dataUpdatedAt: timestamp })).toBe(true);
});
test("C-30 RFC3339 fractional seconds are not prematurely expired by Date.parse truncation", () => {
  const expiresAt = "2026-10-25T02:00:00.0005Z";
  const baseline = Date.parse("2026-10-25T02:00:00Z");
  const value = { ...result, entry: { ...entry, expiresAt } };
  expect(evaluateCacheRead(value, baseline).outcome).toBe("usable");
  expect(evaluateCacheRead(value, baseline + 1).outcome).toBe("expired");
});
test("C-30 forged found with invalid envelope cannot bypass common validation", () => {
  expect(
    evaluateCacheRead(
      { ...result, entry: { ...entry, expiresAt: "invalid" } },
      Date.now(),
    ),
  ).toEqual({ outcome: "invalid" });
});
