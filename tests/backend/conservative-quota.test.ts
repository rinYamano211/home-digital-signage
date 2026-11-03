import { expect, test, vi } from "vitest";
import {
  evaluateConservativeQuota,
  HISTORY_WAIT_MS,
} from "../../src/backend/quota/conservative-quota.js";
import {
  QUOTA_WINDOWS,
  QUOTA_MARGIN_MS,
  TOMORROW_IO,
  QuotaGuard,
} from "../../src/backend/quota/quota-guard.js";
import type { HistoryEvaluationFacts } from "../../src/backend/quota/history-evaluation.js";
import type { WindowWaitEvidence } from "../../src/backend/quota/internal/history-boundaries.js";
const authority = vi.hoisted(() => new WeakMap<object, unknown>());
// Internal test-only wait authority. No production wait issuance or timer exists.
vi.mock("../../src/backend/quota/internal/history-boundaries.js", () => ({
  inspectWaitEvidence: (p: object) => authority.get(p) ?? null,
}));
const now = 200000000;
function model(
  n = 1,
  kind: "old" | "valid" | "uncertain" = "old",
): HistoryEvaluationFacts {
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
      consumptions: Array.from({ length: n }, (_, i) => ({
        sequence: i + 1,
        reservedAtMs: 1,
      })),
    },
    valid:
      kind === "valid"
        ? Array.from({ length: n }, (_, i) => ({
            ...scope,
            sequence: i + 1,
            reservedAtMs: 1,
            reservationOutcome: "saved",
            clockTrustedAtReservation: true,
          }))
        : [],
    ranges:
      kind === "uncertain"
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
function wait(
  f: HistoryEvaluationFacts,
  widthMs: number,
  rangeId: number | null = null,
  elapsedNs = BigInt(HISTORY_WAIT_MS[widthMs as keyof typeof HISTORY_WAIT_MS]) *
    1000000n,
): WindowWaitEvidence {
  const token = Object.freeze({});
  authority.set(token, {
    ...f.scope,
    windowMs: widthMs,
    rangeId,
    endSequence: f.history.metadata!.lastSequence,
    elapsedNs,
  });
  return token as WindowWaitEvidence;
}
test("Old history is fully counted in all Windows without wait proof, despite ancient Timestamp", () => {
  const r = evaluateConservativeQuota(model(), now);
  expect(r).toMatchObject({
    evaluation: "QUOTA_BLOCKED",
    windows: QUOTA_WINDOWS.map((w) => ({
      widthMs: w.widthMs,
      count: 1,
      limit: w.limit,
    })),
  });
  expect(r).not.toHaveProperty("allowed");
});
test("Confirmed uncertain Range is fully counted independently of Timestamp", () => {
  const r = evaluateConservativeQuota(model(2, "uncertain"), now);
  expect(r).toMatchObject({
    windows: QUOTA_WINDOWS.map((w) => ({
      count: 2,
      widthMs: w.widthMs,
      limit: w.limit,
    })),
  });
});
test("Missing/forged wait evidence never removes history", () => {
  const f = model();
  expect(
    evaluateConservativeQuota(f, now, [{ complete: true } as never]),
  ).toEqual(evaluateConservativeQuota(f, now));
});
for (const w of QUOTA_WINDOWS)
  test(`Authenticated ${w.widthMs} wait affects only its Window at exact threshold`, () => {
    const f = model();
    const r = evaluateConservativeQuota(f, now, [wait(f, w.widthMs)]);
    if (r.evaluation === "BLOCKED") throw Error();
    expect(r.windows.find((v) => v.widthMs === w.widthMs)?.count).toBe(0);
    expect(
      r.windows
        .filter((v) => v.widthMs !== w.widthMs)
        .every((v) => v.count === 1),
    ).toBe(true);
    const before = evaluateConservativeQuota(f, now, [
      wait(
        f,
        w.widthMs,
        null,
        BigInt(HISTORY_WAIT_MS[w.widthMs as keyof typeof HISTORY_WAIT_MS]) *
          1000000n -
          1n,
      ),
    ]);
    expect(before).toEqual(evaluateConservativeQuota(f, now));
  });
test("Wait for old history does not remove uncertain range and vice versa", () => {
  const f = model(2, "uncertain");
  expect(evaluateConservativeQuota(f, now, [wait(f, 1000, null)])).toEqual(
    evaluateConservativeQuota(f, now),
  );
  const r = evaluateConservativeQuota(f, now, [wait(f, 1000, 1)]);
  if (r.evaluation === "BLOCKED") throw Error();
  expect(r.windows.find((w) => w.widthMs === 1000)?.count).toBe(0);
});
for (const change of [
  { generation: 3 },
  { processInstanceId: "old" },
  { cutoffSequence: 0 },
  { providerKey: "other" },
  { endSequence: 2 },
])
  test(`Mismatched wait binding ${JSON.stringify(change)} cannot exclude`, () => {
    const f = model();
    const token = wait(f, 1000);
    authority.set(token, {
      ...f.scope,
      windowMs: 1000,
      rangeId: null,
      endSequence: 1,
      elapsedNs: 60000000000n,
      ...change,
    });
    expect(evaluateConservativeQuota(f, now, [token])).toEqual(
      evaluateConservativeQuota(f, now),
    );
  });
for (const w of QUOTA_WINDOWS)
  test(`Valid timestamps preserve ${w.widthMs} inclusive margin and existing Guard limit`, () => {
    const f = model(w.limit, "valid");
    const at = now - w.widthMs - QUOTA_MARGIN_MS;
    const history = {
      ...f.history,
      consumptions: f.history.consumptions.map((r) => ({
        ...r,
        reservedAtMs: at,
      })),
    };
    const valid = f.valid.map((r) => ({ ...r, reservedAtMs: at }));
    const input = { ...f, history, valid };
    const r = evaluateConservativeQuota(input, now);
    expect(r.evaluation).toBe("QUOTA_BLOCKED");
    if (r.evaluation === "BLOCKED") return;
    expect(r.windows.find((v) => v.widthMs === w.widthMs)?.count).toBe(w.limit);
    const after = evaluateConservativeQuota(input, now + 1);
    if (after.evaluation === "BLOCKED") throw Error();
    expect(after.windows.find((v) => v.widthMs === w.widthMs)?.count).toBe(0);
    const guard = new QuotaGuard().evaluate(TOMORROW_IO, history, now, {
      clockTrusted: true,
      historyTimestampsTrusted: true,
      historyComplete: true,
    });
    expect(guard.allowed).toBe(false);
  });
test("Three Windows combine old + recent Valid + each uncertain Range without double counting", () => {
  const base = model(4);
  const f: HistoryEvaluationFacts = {
    ...base,
    scope: { ...base.scope, cutoffSequence: 1 },
    boundary: { ...base.boundary, cutoffSequence: 1 },
    history: {
      ...base.history,
      consumptions: base.history.consumptions.map((r, i) => ({
        ...r,
        reservedAtMs: i === 1 ? now - 5000 : i > 1 ? now : 1,
      })),
    },
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
    ranges: [
      {
        ...base.scope,
        cutoffSequence: 1,
        rangeId: 1,
        startSequence: 3,
        endSequence: 3,
        committed: true,
      },
      {
        ...base.scope,
        cutoffSequence: 1,
        rangeId: 2,
        startSequence: 4,
        endSequence: 4,
        committed: true,
      },
    ],
  };
  const r = evaluateConservativeQuota(f, now);
  expect(r).toMatchObject({
    windows: [{ count: 4 }, { count: 4 }, { count: 3 }],
  });
});
for (const value of [NaN, -1, Number.MAX_SAFE_INTEGER])
  test(`Invalid now ${value} fails closed`, () =>
    expect(evaluateConservativeQuota(model(), value).evaluation).toBe(
      "BLOCKED",
    ));
test("Future timestamps and timestamp inversion remain BLOCKED, not relaxed for uncertain history", () => {
  const f = model(2, "uncertain");
  expect(
    evaluateConservativeQuota(
      {
        ...f,
        history: {
          ...f.history,
          consumptions: [
            { sequence: 1, reservedAtMs: now + 1 },
            { sequence: 2, reservedAtMs: now + 2 },
          ],
        },
      },
      now,
    ).evaluation,
  ).toBe("BLOCKED");
  expect(
    evaluateConservativeQuota(
      {
        ...f,
        history: {
          ...f.history,
          consumptions: [
            { sequence: 1, reservedAtMs: 2 },
            { sequence: 2, reservedAtMs: 1 },
          ],
        },
      },
      now,
    ).evaluation,
  ).toBe("BLOCKED");
});
