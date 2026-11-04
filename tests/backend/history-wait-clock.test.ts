import { afterEach, expect, test, vi } from "vitest";
import { verifiedWaitReading } from "../../src/backend/quota/internal/wait-clock.js";
afterEach(() => vi.restoreAllMocks());
test("production Wait reading is monotonic hrtime with one per-process continuity", () => {
  const first = verifiedWaitReading()!;
  const second = verifiedWaitReading()!;
  expect(typeof first.nowNs).toBe("bigint");
  expect(second.nowNs >= first.nowNs).toBe(true);
  expect(second.continuity).toBe(first.continuity);
  expect(Object.isFrozen(first.continuity)).toBe(true);
});
test("an unreadable or invalid monotonic clock yields no Wait reading", () => {
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => {
    throw Error("clock");
  });
  expect(verifiedWaitReading()).toBeNull();
  vi.mocked(process.hrtime.bigint).mockImplementation(() => -1n);
  expect(verifiedWaitReading()).toBeNull();
});
