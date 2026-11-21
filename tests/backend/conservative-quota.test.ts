import { expect, test } from "vitest";
import { evaluateConservativeQuota } from "../../src/backend/quota/conservative-quota.js";
import {
  QUOTA_WINDOWS,
  QUOTA_MARGIN_MS,
  TOMORROW_IO,
  QuotaGuard,
} from "../../src/backend/quota/quota-guard.js";
import { quotaWindow } from "../../src/backend/quota/internal/quota-window.js";
import type { HistoryEvaluationFacts } from "../../src/backend/quota/history-evaluation.js";
// Q-01 (technology-stack, Issue #117): every Consumption is counted by its
// Timestamp with the symmetric Window |now - t| <= width + 2s. No Wait.
const now = 200000000;
function model(
  times: readonly number[],
  kind: "old" | "valid" | "uncertain" = "old",
): HistoryEvaluationFacts {
  const n = times.length;
  const scope = {
    providerKey: TOMORROW_IO,
    generation: 2,
    processInstanceId: "test-process",
    cutoffSequence: kind === "old" ? n : 0,
  };
  return {
    scope,
    boundary: {
      ...scope,
      startupOutcome: "committed",
      providerState: "PROVISIONED",
    },
    historyComplete: true,
    history: {
      metadata: {
        providerKey: TOMORROW_IO,
        historyStatus: "ACTIVE",
        initializedAtMs: 0,
        lastSequence: n,
      },
      consumptions: times.map((t, i) => ({ sequence: i + 1, reservedAtMs: t })),
    },
    valid:
      kind === "valid"
        ? times.map((t, i) => ({
            ...scope,
            sequence: i + 1,
            reservedAtMs: t,
            reservationOutcome: "saved",
            clockTrustedAtReservation: true,
          }))
        : [],
    ranges:
      kind === "uncertain" && n
        ? [
            {
              ...scope,
              rangeId: 1,
              startSequence: 1,
              endSequence: n,
              committed: true,
            },
          ]
        : [],
  };
}
const counts = (f: HistoryEvaluationFacts, at = now) => {
  const r = evaluateConservativeQuota(f, at);
  if (r.evaluation === "BLOCKED") throw Error(r.reason);
  return r.windows.map((w) => w.count);
};
const repeat = (n: number, t: number) => Array.from({ length: n }, () => t);

test("Issue #117: 400+ old rows older than 24h do not block (no 25h wait)", () => {
  const f = model(repeat(450, now - 86400000 - QUOTA_MARGIN_MS - 1));
  const r = evaluateConservativeQuota(f, now);
  expect(r).toMatchObject({
    evaluation: "WITHIN_LIMIT",
    windows: QUOTA_WINDOWS.map((w) => ({
      widthMs: w.widthMs,
      count: 0,
      limit: w.limit,
    })),
  });
  expect(r).not.toHaveProperty("allowed");
});
for (const kind of ["old", "valid", "uncertain"] as const)
  test(`${kind} rows are counted by Timestamp in every Window`, () => {
    const f = model([now - 5000, now - 500, 1], kind);
    // 24h: 2, 60min: 2, 1s: 1 (the ancient row is outside every Window).
    expect(counts(f)).toEqual([2, 2, 1]);
  });
test("Three classes are combined without double counting", () => {
  const base = model([1, now - 5000, now, now]);
  const f: HistoryEvaluationFacts = {
    ...base,
    scope: { ...base.scope, cutoffSequence: 1 },
    boundary: { ...base.boundary, cutoffSequence: 1 },
    valid: [
      {
        ...base.scope,
        cutoffSequence: 1,
        sequence: 2,
        reservedAtMs: now - 5000,
        reservationOutcome: "saved",
        clockTrustedAtReservation: true,
      },
    ],
    ranges: [3, 4].map((seq, i) => ({
      ...base.scope,
      cutoffSequence: 1,
      rangeId: i + 1,
      startSequence: seq,
      endSequence: seq,
      committed: true,
    })),
  };
  expect(counts(f)).toEqual([3, 3, 2]);
});
for (const w of QUOTA_WINDOWS) {
  const reach = w.widthMs + QUOTA_MARGIN_MS;
  test(`${w.widthMs} Window: symmetric inclusive bounds for past and future rows`, () => {
    const index = QUOTA_WINDOWS.indexOf(w);
    for (const [t, counted] of [
      [now - reach, 1],
      [now - reach - 1, 0],
      [now + reach, 1],
      [now + reach + 1, 0],
    ] as const)
      expect(counts(model([t]))[index]).toBe(counted);
  });
  test(`${w.widthMs} Window at the limit is QUOTA_BLOCKED and the legacy Guard agrees for past rows`, () => {
    const f = model(repeat(w.limit, now - reach), "valid");
    const r = evaluateConservativeQuota(f, now);
    expect(r.evaluation).toBe("QUOTA_BLOCKED");
    if (r.evaluation === "BLOCKED") return;
    const window = r.windows.find((v) => v.widthMs === w.widthMs)!;
    expect(window.count).toBe(w.limit);
    expect(window.releaseAtMs).toBe(now + 1);
    expect(counts(f, now + 1)[QUOTA_WINDOWS.indexOf(w)]).toBe(0);
    const guard = new QuotaGuard().evaluate(TOMORROW_IO, f.history, now, {
      clockTrusted: true,
      historyTimestampsTrusted: true,
      historyComplete: true,
    });
    expect(guard.allowed).toBe(false);
  });
}
test("One future row blocks the 1s Window only for about 2 x (1s + 2s)", () => {
  const t = now + 10000;
  const f = model([t]);
  const oneSecond = (at: number) => counts(f, at)[2];
  expect(oneSecond(now)).toBe(0);
  expect(oneSecond(t - 3001)).toBe(0);
  expect(oneSecond(t - 3000)).toBe(1);
  expect(oneSecond(t + 3000)).toBe(1);
  expect(oneSecond(t + 3001)).toBe(0);
});
test("Future and reversed Timestamps are not BLOCKED for any class", () => {
  for (const kind of ["old", "valid", "uncertain"] as const) {
    expect(
      evaluateConservativeQuota(model([now + 1, now + 2], kind), now)
        .evaluation,
    ).toBe("QUOTA_BLOCKED");
    expect(
      evaluateConservativeQuota(model([now - 2, now - 1500], kind), now)
        .evaluation,
    ).toBe("QUOTA_BLOCKED");
  }
});
test("releaseAtMs orders by Timestamp, not Sequence", () => {
  const w = QUOTA_WINDOWS[2]; // 1s, limit 1
  const rows = [
    { sequence: 1, reservedAtMs: now - 500 },
    { sequence: 2, reservedAtMs: now - 1500 },
  ];
  // Two counted rows: the later (now - 500) must leave for the count to drop.
  expect(quotaWindow(rows, now, w)).toEqual({
    count: 2,
    releaseAtMs: now - 500 + 1000 + QUOTA_MARGIN_MS + 1,
  });
});
test("releaseAtMs is a lower bound when a future row enters afterwards", () => {
  const w = QUOTA_WINDOWS[1]; // 60min, limit 20
  const reach = w.widthMs + QUOTA_MARGIN_MS;
  const rows = [
    ...repeat(20, now - reach + 10000).map((t, i) => ({
      sequence: i + 1,
      reservedAtMs: t,
    })),
    { sequence: 21, reservedAtMs: now + reach + 5000 }, // enters at now + 5s
  ];
  const first = quotaWindow(rows, now, w);
  expect(first.count).toBe(20);
  expect(first.releaseAtMs).toBe(now + 10001);
  // At the hint the old rows have left but the future row has entered.
  expect(quotaWindow(rows, first.releaseAtMs!, w).count).toBe(1);
  // A Window that refills only moves the next hint later, never earlier.
  const refill = [
    ...rows,
    ...repeat(19, now + reach + 5000).map((t, i) => ({
      sequence: 22 + i,
      reservedAtMs: t,
    })),
  ];
  const later = quotaWindow(refill, first.releaseAtMs!, w);
  expect(later.count).toBe(20);
  expect(later.releaseAtMs!).toBeGreaterThan(first.releaseAtMs!);
});
test("releaseAtMs beyond the valid Timestamp range is omitted (caller fails closed)", () => {
  const max = 8_640_000_000_000_000; // largest valid Date and Quota Timestamp
  const r = evaluateConservativeQuota(model([max]), max);
  expect(r.evaluation).toBe("QUOTA_BLOCKED");
  if (r.evaluation === "BLOCKED") return;
  expect(r.windows.map((w) => w.count)).toEqual([1, 1, 1]);
  for (const w of r.windows) expect(w).not.toHaveProperty("releaseAtMs");
  // In range the same row still yields a valid hint.
  const ok = evaluateConservativeQuota(model([now]), now);
  if (ok.evaluation === "BLOCKED") throw Error();
  expect(ok.windows[2].releaseAtMs).toBe(now + 1000 + QUOTA_MARGIN_MS + 1);
});
for (const value of [NaN, -1, Number.MAX_SAFE_INTEGER])
  test(`Invalid now ${value} fails closed`, () =>
    expect(evaluateConservativeQuota(model([1]), value).evaluation).toBe(
      "BLOCKED",
    ));
test("Structural problems still fail closed", () => {
  const f = model([now]);
  expect(
    evaluateConservativeQuota(
      {
        ...f,
        history: {
          ...f.history,
          consumptions: [{ sequence: 2, reservedAtMs: now }],
        },
      },
      now,
    ).evaluation,
  ).toBe("BLOCKED");
  expect(
    evaluateConservativeQuota({ ...f, historyComplete: false }, now).evaluation,
  ).toBe("BLOCKED");
});
