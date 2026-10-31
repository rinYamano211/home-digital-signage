import { afterEach, expect, test, vi } from "vitest";
import {
  controlState,
  nextControlState,
  retryAfterAt,
  ConservativeControlWait,
} from "../../src/backend/acquisition/control-state.js";
const base = "2026-01-01T00:00:00Z";
const previous = (n = 0) => ({ consecutiveFailures: n, nextAttemptAt: base });
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
test.each([
  [0, 1],
  [1, 2],
  [2, 4],
  [3, 8],
  [4, 16],
  [5, 30],
  [6, 30],
  [1000, 30],
])("C2-22 failures %i -> %i minute deterministic Backoff", (n, minutes) => {
  const outcome = { kind: "failure" as const, completedAt: base };
  const result = nextControlState(previous(n), outcome);
  expect(result).toEqual({
    consecutiveFailures: n + 1,
    nextAttemptAt: new Date(Date.parse(base) + minutes * 60000).toISOString(),
  });
  expect(nextControlState(previous(n), outcome)).toEqual(result);
});
test("C2-22 success uses HTTP start, resets failures even if completion is delayed", () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-01-02T00:00:00Z");
  expect(
    nextControlState(previous(4), {
      kind: "success",
      startedAt: base,
      periodMs: 300000,
    }),
  ).toEqual({
    consecutiveFailures: 0,
    nextAttemptAt: "2026-01-01T00:05:00.000Z",
  });
});
test.each([0, -1, NaN, Infinity, 0.5])(
  "invalid success period %s is not repaired",
  (periodMs) => {
    expect(() =>
      nextControlState(previous(), {
        kind: "success",
        startedAt: base,
        periodMs,
      }),
    ).toThrow(TypeError);
  },
);
test("failure counter exhaustion and timestamp range fail closed", () => {
  expect(() =>
    nextControlState(previous(Number.MAX_SAFE_INTEGER), {
      kind: "failure",
      completedAt: base,
    }),
  ).toThrow(RangeError);
  expect(() =>
    nextControlState(previous(), {
      kind: "success",
      startedAt: "9999-12-31T23:59:59Z",
      periodMs: 10000,
    }),
  ).toThrow(RangeError);
  expect(() =>
    nextControlState(previous(), { kind: "failure", completedAt: "garbage" }),
  ).toThrow(TypeError);
});
test.each([
  ["0", 1],
  ["30", 1],
  ["60", 1],
  ["3600", 60],
  ["86400", 1440],
])("C2-22 429 delta %s respects later %i minutes", (retryAfter, minutes) => {
  expect(
    nextControlState(previous(), {
      kind: "failure",
      completedAt: base,
      httpStatus: 429,
      retryAfter,
    }).nextAttemptAt,
  ).toBe(new Date(Date.parse(base) + minutes * 60000).toISOString());
});
test.each([
  undefined,
  "",
  "-10",
  "1.5",
  "+60",
  "1e3",
  "Infinity",
  "999999999999999999999",
  "2026-01-01",
  "Thu, 30 Feb 2026 00:00:00 GMT",
  "Fri, 01 Jan 2026 01:00:00 GMT",
])("invalid Retry-After %s leaves normal Backoff", (retryAfter) => {
  expect(retryAfterAt(retryAfter, base)).toBeNull();
  expect(
    nextControlState(previous(), {
      kind: "failure",
      completedAt: base,
      httpStatus: 429,
      retryAfter,
    }).nextAttemptAt,
  ).toBe("2026-01-01T00:01:00.000Z");
});
test.each([
  "Thu, 01 Jan 2026 02:00:00 GMT",
  "Thursday, 01-Jan-26 02:00:00 GMT",
  "Thu Jan  1 02:00:00 2026",
])("HTTP-date %s is respected beyond 30-minute cap", (retryAfter) => {
  expect(
    nextControlState(previous(6), {
      kind: "failure",
      completedAt: base,
      httpStatus: 429,
      retryAfter,
    }).nextAttemptAt,
  ).toBe("2026-01-01T02:00:00.000Z");
});
test("past HTTP date is valid but cannot shorten Backoff; non-429 ignores header", () => {
  const retryAfter = "Wed, 31 Dec 2025 23:59:00 GMT";
  expect(retryAfterAt(retryAfter, base)).toBe(
    Date.parse("2025-12-31T23:59:00Z"),
  );
  expect(
    nextControlState(previous(), {
      kind: "failure",
      completedAt: base,
      httpStatus: 429,
      retryAfter,
    }).nextAttemptAt,
  ).toBe("2026-01-01T00:01:00.000Z");
  expect(
    nextControlState(previous(), {
      kind: "failure",
      completedAt: base,
      httpStatus: 500,
      retryAfter: "3600",
    }).nextAttemptAt,
  ).toBe("2026-01-01T00:01:00.000Z");
});
test("C2-23 Quota suppression preserves both fields and leaves original immutable", () => {
  const p = Object.freeze(previous(4));
  expect(nextControlState(p, { kind: "quota_suppressed" })).toEqual(p);
  expect(p).toEqual(previous(4));
});
test("C2-11 monotonic wait ignores wall clock; ready requires a fresh Read, not send", () => {
  let now = 100;
  const wait = new ConservativeControlWait(() => now);
  expect(wait.check("schedule", 600000)).toEqual({
    readyForRecheck: false,
    remainingMs: 300000,
  });
  vi.useFakeTimers();
  vi.setSystemTime("2099-01-01");
  now = 300099;
  expect(wait.check("schedule", 600000)).toEqual({
    readyForRecheck: false,
    remainingMs: 1,
  });
  now = 300100;
  expect(wait.check("schedule", 600000)).toEqual({
    readyForRecheck: true,
    remainingMs: 0,
  });
  expect(wait.check("rainForecast", 300000).readyForRecheck).toBe(false);
});
test("short period caps wait and new instance restarts startup evaluation", () => {
  let now = 0;
  const wait = new ConservativeControlWait(() => now);
  wait.check("schedule", 60000);
  now = 60000;
  expect(wait.check("schedule", 60000).readyForRecheck).toBe(true);
  const restarted = new ConservativeControlWait(() => now);
  expect(restarted.check("schedule", 60000).readyForRecheck).toBe(false);
  wait.clear("schedule");
  expect(wait.check("schedule", 60000).readyForRecheck).toBe(false);
});
test("unknown or regressed monotonic time never completes an early wait", () => {
  let now = 100;
  const wait = new ConservativeControlWait(() => now);
  wait.check("schedule", 300000);
  now = 0;
  expect(wait.check("schedule", 300000).remainingMs).toBe(300000);
  now = NaN;
  expect(() => wait.check("schedule", 300000)).toThrow();
});
test.each([0, -1, Infinity, NaN])(
  "invalid wait period %s rejected",
  (period) => {
    expect(() =>
      new ConservativeControlWait().check("schedule", period),
    ).toThrow();
  },
);
test("Control State common validation rejects extra/inherited fields", () => {
  expect(controlState({ ...previous(), extra: 1 })).toBeNull();
  expect(controlState(Object.create(previous()))).toBeNull();
  expect(controlState(previous())).toEqual(previous());
});
