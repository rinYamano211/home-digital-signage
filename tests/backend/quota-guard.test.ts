import { expect, test } from "vitest";
import {
  QuotaGuard,
  TOMORROW_IO,
  QUOTA_WINDOWS,
  QUOTA_MARGIN_MS,
  type QuotaHistory,
  type QuotaTrust,
} from "../../src/backend/quota/quota-guard.js";
const now = 200000000;
const guard = new QuotaGuard();
const trust: QuotaTrust = {
  clockTrusted: true,
  historyTimestampsTrusted: true,
  historyComplete: true,
};
function history(times: number[]): QuotaHistory {
  return {
    metadata: {
      providerKey: TOMORROW_IO,
      historyStatus: "ACTIVE",
      initializedAtMs: 0,
      lastSequence: times.length,
    },
    consumptions: times.map((reservedAtMs, i) => ({
      sequence: i + 1,
      reservedAtMs,
    })),
  };
}
test.each(QUOTA_WINDOWS)(
  "QH-05 $limit / $widthMs inclusive window plus margin",
  (w) => {
    const at = now - w.widthMs - QUOTA_MARGIN_MS;
    const times = Array(w.limit).fill(at);
    const h = history(times);
    const blocked = guard.evaluate(TOMORROW_IO, h, now, trust);
    expect(blocked).toMatchObject({
      allowed: false,
      reason: "quota_exhausted",
    });
    // Other narrower windows cannot include these old entries at the broad boundary.
    expect(blocked.recheckAtMs).toBe(now + 1);
    expect(guard.evaluate(TOMORROW_IO, h, now + 1, trust).allowed).toBe(true);
    expect(
      guard.evaluate(
        TOMORROW_IO,
        history(Array(w.limit).fill(at + 1)),
        now,
        trust,
      ).allowed,
    ).toBe(false);
  },
);
test.each(QUOTA_WINDOWS)(
  "$limit window rejects at original boundary, keeping two-second margin",
  (w) => {
    const h = history(Array(w.limit).fill(now - w.widthMs));
    expect(guard.evaluate(TOMORROW_IO, h, now, trust)).toMatchObject({
      allowed: false,
      recheckAtMs: now + 2001,
    });
  },
);
test("all windows apply and the latest release is a hint, not permission", () => {
  // Spread 400 records across the day; also fill the hour and the second.
  const times = [
    ...Array.from({ length: 380 }, (_, i) => now - 80000000 + i * 100000),
    ...Array.from({ length: 19 }, (_, i) => now - 3000000 + i * 10000),
    now,
  ].sort((a, b) => a - b);
  const h = history(times);
  const result = guard.evaluate(TOMORROW_IO, h, now, trust);
  const releases = QUOTA_WINDOWS.map((w) => {
    const r = times.filter((t) => now - t <= w.widthMs + 2000);
    return r.length >= w.limit ? r[r.length - w.limit] + w.widthMs + 2001 : 0;
  });
  expect(result.recheckAtMs).toBe(Math.max(...releases));
  expect(
    guard.evaluate(TOMORROW_IO, h, result.recheckAtMs!, trust).allowed,
  ).toBe(true);
  const changed = history([...times, result.recheckAtMs!]);
  expect(
    guard.evaluate(TOMORROW_IO, changed, result.recheckAtMs!, trust).allowed,
  ).toBe(false);
});
test.each([
  "clockTrusted",
  "historyTimestampsTrusted",
  "historyComplete",
] as const)("CLK-03 independent %s untrusted is fail closed", (field) => {
  expect(
    guard.evaluate(TOMORROW_IO, history([]), now, { ...trust, [field]: false })
      .allowed,
  ).toBe(false);
});
test("ACTIVE and empty alone do not establish external history completeness", () => {
  expect(
    guard.evaluate(TOMORROW_IO, history([]), now, {
      ...trust,
      historyComplete: false,
    }),
  ).toMatchObject({ allowed: false, reason: "history_incomplete" });
});
test.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER])(
  "invalid current Timestamp %s",
  (at) => {
    expect(guard.evaluate(TOMORROW_IO, history([]), at, trust).allowed).toBe(
      false,
    );
  },
);
test("QH-01 missing, suspended or wrong Provider is not usable", () => {
  expect(
    guard.evaluate(
      TOMORROW_IO,
      { metadata: null, consumptions: [] },
      now,
      trust,
    ).allowed,
  ).toBe(false);
  const h = history([]);
  h.metadata!.historyStatus = "SUSPENDED";
  expect(guard.evaluate(TOMORROW_IO, h, now, trust).reason).toBe(
    "provider_suspended",
  );
  h.metadata!.providerKey = "other";
  expect(guard.evaluate(TOMORROW_IO, h, now, trust).allowed).toBe(false);
  expect(guard.evaluate("unknown", history([]), now, trust).allowed).toBe(
    false,
  );
});
test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "QH-02 invalid Sequence %s",
  (seq) => {
    const h = history([now]);
    h.consumptions[0].sequence = seq;
    expect(guard.evaluate(TOMORROW_IO, h, now, trust).allowed).toBe(false);
  },
);
test("QH-02 gaps/duplicates/count mismatch rejected, never repaired", () => {
  const h = history([now - 4000, now]);
  h.consumptions[1].sequence = 3;
  expect(guard.evaluate(TOMORROW_IO, h, now, trust).allowed).toBe(false);
  h.consumptions[1].sequence = 1;
  expect(guard.evaluate(TOMORROW_IO, h, now, trust).allowed).toBe(false);
  h.metadata!.lastSequence = 0;
  expect(guard.evaluate(TOMORROW_IO, h, now, trust).allowed).toBe(false);
});
test.each([-1, NaN, Infinity, 0.5, now + 1])(
  "QH-03 invalid/future stored Timestamp %s",
  (at) => {
    expect(guard.evaluate(TOMORROW_IO, history([at]), now, trust).allowed).toBe(
      false,
    );
  },
);
test("Timestamp regression and pre-initialization/future Metadata rejected", () => {
  expect(
    guard.evaluate(TOMORROW_IO, history([now, now - 1]), now, trust).allowed,
  ).toBe(false);
  const h = history([now - 4000]);
  h.metadata!.initializedAtMs = now;
  expect(guard.evaluate(TOMORROW_IO, h, now, trust).allowed).toBe(false);
  h.metadata!.initializedAtMs = now + 1;
  expect(guard.evaluate(TOMORROW_IO, h, now, trust).allowed).toBe(false);
});
