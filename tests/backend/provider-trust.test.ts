import { afterEach, expect, test, vi } from "vitest";
import {
  ClockTrustMonitor,
  HistoryTrustMonitor,
} from "../../src/backend/send/internal/trust.js";
import {
  PermitRegistry,
  type PermitBinding,
  type SendPermit,
} from "../../src/backend/send/internal/permits.js";
import type {
  QuotaAttempt,
  QuotaRepository,
} from "../../src/backend/storage/quota-repository.js";
afterEach(() => vi.useRealTimers());
function clockFixture() {
  let mono = 0n,
    wall = 200_000_000,
    confirmed = true,
    checked = 0n;
  const time = { wallMs: () => wall, monotonicNs: () => mono };
  const monitor = new ClockTrustMonitor(time, () => ({
    confirmed,
    checkedAtNs: checked,
  }));
  const advance = (ns: bigint) => {
    mono += ns;
    wall += Number(ns / 1_000_000n);
    checked = mono;
  };
  return {
    monitor,
    time,
    advance,
    setMono: (n: bigint) => {
      mono = n;
    },
    setWall: (n: number) => {
      wall = n;
    },
    setOs: (v: boolean) => {
      confirmed = v;
    },
    setChecked: (n: bigint) => {
      checked = n;
    },
  };
}
test("T3 initial UNVERIFIED needs verified OS evidence", () => {
  const f = clockFixture();
  expect(f.monitor.state()).toBe("UNVERIFIED");
  f.setOs(false);
  f.monitor.observe();
  expect(f.monitor.state()).toBe("SUSPENDED");
});
test("T3 fresh confirmed OS observation can establish initial Clock Trust", () => {
  const f = clockFixture();
  f.monitor.observe();
  expect(f.monitor.state()).toBe("TRUSTED");
});
test.each([1_000_000_000n, -1_000_000_000n])(
  "T3 forward/backward wall jump %s revokes synchronously",
  (jump) => {
    const f = clockFixture();
    f.monitor.observe();
    const listener = vi.fn();
    f.monitor.subscribe(listener);
    f.advance(5_000_000_000n);
    f.setWall(f.time.wallMs() + Number(jump / 1_000_000n));
    f.monitor.observe();
    expect(f.monitor.state()).toBe("SUSPENDED");
    expect(listener).toHaveBeenCalledTimes(1);
  },
);
test.each([15_000_000_000n, 15_000_000_001n])(
  "T3 observation freshness boundary %s",
  (gap) => {
    const f = clockFixture();
    f.monitor.observe();
    f.advance(gap);
    expect(f.monitor.state()).toBe(
      gap === 15_000_000_000n ? "TRUSTED" : "SUSPENDED",
    );
  },
);
test("T3 sample after missed interval cannot silently restore Trust", () => {
  const f = clockFixture();
  f.monitor.observe();
  f.advance(16_000_000_000n);
  f.monitor.observe();
  expect(f.monitor.state()).toBe("SUSPENDED");
});
test("T3 stale OS confirmation is checked separately from fresh clock sampling", () => {
  const f = clockFixture();
  f.monitor.observe();
  for (let i = 0; i < 4; i++) {
    f.advance(5_000_000_000n);
    f.setChecked(0n);
    f.monitor.observe();
  }
  expect(f.monitor.state()).toBe("SUSPENDED");
});
test.each([-1n, 100_000_000_000n])(
  "T3 invalid/future OS confirmation %s",
  (checked) => {
    const f = clockFixture();
    f.setChecked(checked);
    f.monitor.observe();
    expect(f.monitor.state()).toBe("SUSPENDED");
  },
);
test("T3 recovery requires full 60 seconds of stable observations", () => {
  const f = clockFixture();
  f.monitor.observe();
  f.setOs(false);
  f.monitor.observe();
  f.setOs(true);
  f.advance(5_000_000_000n);
  f.monitor.observe();
  for (let i = 0; i < 11; i++) {
    f.advance(5_000_000_000n);
    f.monitor.observe();
  }
  expect(f.monitor.state()).toBe("SUSPENDED");
  f.advance(4_999_999_999n);
  f.monitor.observe();
  expect(f.monitor.state()).toBe("SUSPENDED");
  f.advance(1n);
  f.monitor.observe();
  expect(f.monitor.state()).toBe("TRUSTED");
});
test("T3 new failure resets stable recovery interval", () => {
  const f = clockFixture();
  f.setOs(false);
  f.monitor.observe();
  f.setOs(true);
  for (let i = 0; i < 10; i++) {
    f.advance(5_000_000_000n);
    f.monitor.observe();
  }
  f.setOs(false);
  f.monitor.observe();
  f.setOs(true);
  f.advance(5_000_000_000n);
  f.monitor.observe();
  expect(f.monitor.state()).toBe("SUSPENDED");
});
test("T3 negative monotonic delta revokes trust", () => {
  const f = clockFixture();
  f.monitor.observe();
  f.setMono(-1n);
  f.monitor.observe();
  expect(f.monitor.state()).toBe("SUSPENDED");
});
test.each([NaN, Infinity, -1, 0.5])(
  "T3 invalid wall sample %s fails closed",
  (wall) => {
    const f = clockFixture();
    f.setWall(wall);
    f.monitor.observe();
    expect(f.monitor.state()).toBe("SUSPENDED");
  },
);
test("T3 OS getter failure fails closed", () => {
  const monitor = new ClockTrustMonitor(
    { wallMs: () => 0, monotonicNs: () => 0n },
    () => {
      throw new Error();
    },
  );
  monitor.observe();
  expect(monitor.state()).toBe("SUSPENDED");
});
test("T3 timer samples every 5 seconds; stop cancels and revokes", () => {
  vi.useFakeTimers();
  const f = clockFixture();
  const observe = vi.spyOn(f.monitor, "observe");
  f.monitor.start();
  f.monitor.start();
  expect(observe).toHaveBeenCalledTimes(1);
  f.advance(5_000_000_000n);
  vi.advanceTimersByTime(5000);
  expect(observe).toHaveBeenCalledTimes(2);
  f.monitor.stop();
  f.monitor.stop();
  vi.advanceTimersByTime(20000);
  expect(observe).toHaveBeenCalledTimes(2);
  expect(f.monitor.state()).toBe("SUSPENDED");
});
test("T3 unsubscribe prevents stale notifications", () => {
  const f = clockFixture();
  const fn = vi.fn();
  const unsubscribe = f.monitor.subscribe(fn);
  unsubscribe();
  f.setOs(false);
  f.monitor.observe();
  expect(fn).not.toHaveBeenCalled();
});
test.each(["internalConsistent", "timestampsTrusted", "complete"] as const)(
  "T3 History %s false independently denies Trust",
  (key) => {
    const h = new HistoryTrustMonitor();
    expect(h.state()).toBe("UNVERIFIED");
    const fn = vi.fn();
    h.subscribe(fn);
    h.confirm({
      internalConsistent: true,
      timestampsTrusted: true,
      complete: true,
    });
    expect(h.state()).toBe("TRUSTED");
    h.confirm({
      internalConsistent: true,
      timestampsTrusted: true,
      complete: true,
      [key]: false,
    });
    expect(h.state()).toBe("SUSPENDED");
    expect(fn).toHaveBeenCalledTimes(1);
  },
);
test("T3 Clock recovery never mutates History", () => {
  const h = new HistoryTrustMonitor();
  const f = clockFixture();
  f.monitor.observe();
  expect(f.monitor.state()).toBe("TRUSTED");
  expect(h.state()).toBe("UNVERIFIED");
  h.suspend();
  f.monitor.observe();
  expect(h.state()).toBe("SUSPENDED");
});
function binding(): PermitBinding {
  return {
    provider: "tomorrow.io",
    attempt: {} as QuotaAttempt,
    repository: {} as QuotaRepository,
    sequence: 1,
    epoch: 0n,
  };
}
test("T1 opaque Permit exactly once; Evidence cannot substitute", () => {
  const p = new PermitRegistry(),
    b = binding(),
    token = p.issue(b);
  expect(Object.keys(token)).toEqual([]);
  expect(p.consume({} as SendPermit, b)).toBe(false);
  expect(p.consume({ ...token }, b)).toBe(false);
  expect(p.consume(token, b)).toBe(true);
  expect(p.consume(token, b)).toBe(false);
});
test.each(["provider", "attempt", "repository", "sequence", "epoch"] as const)(
  "T1 Permit %s mismatch consumes invalid token",
  (key) => {
    const p = new PermitRegistry(),
      b = binding(),
      token = p.issue(b);
    const other = {
      ...b,
      [key]:
        key === "provider"
          ? "other"
          : key === "sequence"
            ? 2
            : key === "epoch"
              ? 1n
              : {},
    } as PermitBinding;
    expect(p.consume(token, other)).toBe(false);
    expect(p.consume(token, b)).toBe(false);
  },
);
test("T1 another Process-local registry cannot consume Permit", () => {
  const a = new PermitRegistry(),
    b = new PermitRegistry(),
    value = binding(),
    token = a.issue(value);
  expect(b.consume(token, value)).toBe(false);
});
