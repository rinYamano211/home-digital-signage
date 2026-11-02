import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { historyFingerprint } from "../../src/backend/quota/history-fingerprint.js";
import { encodeHistoryField } from "../../src/backend/quota/internal/history-fingerprint-encoding.js";
import {
  QuotaGuard,
  type QuotaHistory,
} from "../../src/backend/quota/quota-guard.js";
const vectors = JSON.parse(
  readFileSync(
    new URL("../fixtures/quota-history-v1-vectors.json", import.meta.url),
    "utf8",
  ),
) as { name: string; history: QuotaHistory; hex: string; digest: string }[];
const zero = () =>
  structuredClone(vectors.find((v) => v.name === "provisioned-zero")!.history);
const multiple = () =>
  structuredClone(
    vectors.find((v) => v.name === "provisioned-multiple")!.history,
  );
test.each(vectors)(
  "D04-R05 independent fixed bytes and digest: $name",
  ({ history, hex, digest }) => {
    expect(
      createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex"),
    ).toBe(digest);
    expect(historyFingerprint(history)).toBe(digest);
    expect(historyFingerprint(structuredClone(history))).toBe(digest);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  },
);
test("D04-R05 specification's provisioned-zero bytes are preserved exactly", () => {
  expect(vectors.find((v) => v.name === "provisioned-zero")!.hex).toBe(
    "010000001071756f74612d686973746f72792d76310100000001700100000006414354495645020000000130020000000130050000000130",
  );
});
test("NULL and METADATA_ABSENT tags are distinct; no separator or payload", () => {
  expect(encodeHistoryField(3, null).toString("hex")).toBe("0300000000");
  expect(encodeHistoryField(4, null).toString("hex")).toBe("0400000000");
  expect(historyFingerprint(vectors[0].history)).not.toBe(
    historyFingerprint(zero()),
  );
});
test("UTF-8 bytes, four-byte Big Endian lengths, no Unicode normalization", () => {
  expect(encodeHistoryField(1, "天気").toString("hex")).toBe(
    "0100000006e5a4a9e6b097",
  );
  expect(
    encodeHistoryField(1, "a".repeat(300)).subarray(0, 5).toString("hex"),
  ).toBe("010000012c");
  expect(vectors.find((v) => v.name === "nfc")!.digest).not.toBe(
    vectors.find((v) => v.name === "nfd")!.digest,
  );
});
test("INTEGER and COUNT use decimal ASCII at zero and the maximum safe value", () => {
  expect(encodeHistoryField(2, 0).toString("hex")).toBe("020000000130");
  expect(
    encodeHistoryField(2, Number.MAX_SAFE_INTEGER)
      .subarray(5)
      .toString("ascii"),
  ).toBe("9007199254740991");
  expect(
    encodeHistoryField(5, Number.MAX_SAFE_INTEGER)
      .subarray(0, 5)
      .toString("hex"),
  ).toBe("0500000010");
});
test.each([
  -1,
  -0,
  0.5,
  NaN,
  Infinity,
  -Infinity,
  Number.MAX_SAFE_INTEGER + 1,
  "1",
  1n,
  null,
  undefined,
])("invalid integer/COUNT %s is not repaired", (value) => {
  expect(() => encodeHistoryField(2, value)).toThrow();
  expect(() => encodeHistoryField(5, value)).toThrow();
});
test.each([
  [3, ""],
  [4, undefined],
  [1, null],
  [2, null],
  [5, null],
  [0, null],
  [6, "x"],
  [1, "\ud800"],
])("invalid field tag/value %j rejected", (tag, value) => {
  expect(() => encodeHistoryField(tag as number, value)).toThrow();
});
test.each([
  { field: "providerKey", value: "" },
  { field: "providerKey", value: null },
  { field: "providerKey", value: "\ud800" },
  { field: "historyStatus", value: "INVALID" },
  { field: "historyStatus", value: null },
  { field: "initializedAtMs", value: -1 },
  { field: "initializedAtMs", value: NaN },
  { field: "initializedAtMs", value: Infinity },
  { field: "initializedAtMs", value: Number.MAX_SAFE_INTEGER },
  { field: "lastSequence", value: 1 },
  { field: "lastSequence", value: null },
])("invalid Metadata $field=$value fails closed", ({ field, value }) => {
  const h = zero();
  Object.assign(h.metadata!, { [field]: value });
  expect(() => historyFingerprint(h)).toThrow(
    /^Invalid quota history fingerprint input$/,
  );
});
test.each([
  {},
  { metadata: undefined, consumptions: [] },
  { metadata: null, consumptions: [{ sequence: 1, reservedAtMs: 0 }] },
  { metadata: null, consumptions: null },
  { metadata: null, consumptions: [], extra: true },
])("invalid Metadata absence or structure %j rejected", (value) =>
  expect(() => historyFingerprint(value as QuotaHistory)).toThrow(),
);
test.each([
  "duplicate",
  "gap",
  "reverse",
  "missing",
  "fraction",
  "unsafe",
  "bad_timestamp",
  "non_date",
])("Consumption %s is never normalized", (fault) => {
  const h = multiple();
  if (fault === "duplicate")
    h.consumptions = [h.consumptions[0], h.consumptions[0]];
  if (fault === "gap")
    h.consumptions = [h.consumptions[0], { sequence: 3, reservedAtMs: 20 }];
  if (fault === "reverse") h.consumptions = [...h.consumptions].reverse();
  if (fault === "missing") h.consumptions = h.consumptions.slice(1);
  if (fault === "fraction")
    h.consumptions = [{ sequence: 0.5, reservedAtMs: 0 }, h.consumptions[1]];
  if (fault === "unsafe")
    h.consumptions = [
      { sequence: Number.MAX_SAFE_INTEGER + 1, reservedAtMs: 0 },
      h.consumptions[1],
    ];
  if (fault === "bad_timestamp")
    h.consumptions = [{ sequence: 1, reservedAtMs: -1 }, h.consumptions[1]];
  if (fault === "non_date")
    h.consumptions = [
      { sequence: 1, reservedAtMs: Number.MAX_SAFE_INTEGER },
      h.consumptions[1],
    ];
  expect(() => historyFingerprint(h)).toThrow();
});
test("approved structure/Trust separation does not weaken existing QuotaGuard", () => {
  const h: QuotaHistory = {
    metadata: {
      providerKey: "tomorrow.io",
      historyStatus: "ACTIVE",
      initializedAtMs: 100,
      lastSequence: 2,
    },
    consumptions: [
      { sequence: 1, reservedAtMs: 20 },
      { sequence: 2, reservedAtMs: 10 },
    ],
  };
  expect(historyFingerprint(h)).toMatch(/^[0-9a-f]{64}$/);
  expect(
    new QuotaGuard().evaluate("tomorrow.io", h, 100, {
      clockTrusted: true,
      historyComplete: true,
      historyTimestampsTrusted: true,
    }),
  ).toMatchObject({ allowed: false, reason: "invalid_history_timestamp" });
});
