import { getEventListeners } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApp, registerRoutes } from "../../src/backend/app.js";
import { createLogger } from "../../src/backend/logging/logger.js";
import {
  CHECK_PERIOD_MS,
  READ_TIMEOUT_MS,
  RTC_FLOOR_EPOCH_SECONDS,
  TimeAvailabilityMonitor,
  evaluateTimeAvailability,
  parseNtpSynchronized,
  parseRtcSinceEpoch,
  type NtpEvidence,
  type RtcEvidence,
  type TimeAvailability,
} from "../../src/backend/time/display-time-availability.js";

// Issue #65 / technology-stack 25. OS reads are replaced; nothing here runs
// timedatectl or reads /sys.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const VALID_RTC = `${RTC_FLOOR_EPOCH_SECONDS + 27_000_000}\n`; // 2026-11

test("TA-01 NTPSynchronized: only exact yes/no lines are evidence", () => {
  expect(parseNtpSynchronized("yes\n")).toBe("synchronized");
  expect(parseNtpSynchronized("no\n")).toBe("unsynchronized");
  for (const out of ["", "yes", "YES\n", " yes\n", "yes\n\n", "1\n"])
    expect(parseNtpSynchronized(out)).toBe("failed");
});

test.each([
  [`${RTC_FLOOR_EPOCH_SECONDS}\n`, "valid"],
  [VALID_RTC, "valid"],
  [`${RTC_FLOOR_EPOCH_SECONDS}`, "valid"],
  [`${RTC_FLOOR_EPOCH_SECONDS - 1}\n`, "invalid"],
  ["73\n", "invalid"], // Pi 5 RTC after a full power loss without battery (25.1)
  ["0\n", "invalid"],
  ["", "failed"],
  ["-1\n", "failed"],
  ["1.5\n", "failed"],
  ["abc\n", "failed"],
  [" 1794658329\n", "failed"],
  ["1794658329\n\n", "failed"],
  ["9".repeat(30) + "\n", "failed"],
] as const)("TA-02 RTC since_epoch %j is %s", (text, expected) => {
  expect(parseRtcSinceEpoch(text)).toBe(expected);
});

const ntps: NtpEvidence[] = ["synchronized", "unsynchronized", "failed"];
const rtcs: RtcEvidence[] = ["valid", "invalid", "failed"];
test.each(ntps.flatMap((ntp) => rtcs.map((rtc) => [ntp, rtc] as const)))(
  "TA-03 evaluation NTP=%s RTC=%s",
  (ntp, rtc) => {
    const result = evaluateTimeAvailability(ntp, rtc);
    if (ntp === "synchronized")
      expect(result).toEqual({ availability: "available", reason: "ntp" });
    else if (rtc === "valid")
      expect(result).toEqual({ availability: "available", reason: "rtc" });
    else
      expect(result).toEqual({ availability: "unavailable", reason: "none" });
  },
);

type Pending = {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
};
function fixture() {
  const ntp: Pending[] = [];
  const rtc: Pending[] = [];
  const queue = (list: Pending[]) =>
    vi.fn(
      (signal: AbortSignal) =>
        new Promise<string>((resolve, reject) =>
          list.push({ resolve, reject, signal }),
        ),
    );
  const sources = { ntp: queue(ntp), rtc: queue(rtc) };
  const order: string[] = [];
  const record = (entry: { event: string }) => order.push(entry.event);
  const logger = { info: vi.fn(record), warn: vi.fn(record) };
  const monitor = new TimeAvailabilityMonitor(logger as never, sources);
  const settle = async (i: number, n: string | Error, r: string | Error) => {
    for (const [list, value] of [
      [ntp, n],
      [rtc, r],
    ] as const) {
      if (value instanceof Error) list[i].reject(value);
      else list[i].resolve(value);
    }
    await vi.advanceTimersByTimeAsync(0);
  };
  const events = () => [...order];
  return { monitor, sources, ntp, rtc, logger, settle, events };
}

test("TA-04 unavailable until the first read completes; reads start at once", async () => {
  const f = fixture();
  expect(f.monitor.current()).toBe("unavailable");
  f.monitor.start();
  expect(f.sources.ntp).toHaveBeenCalledTimes(1);
  expect(f.sources.rtc).toHaveBeenCalledTimes(1);
  expect(f.monitor.current()).toBe("unavailable");
  await f.settle(0, "yes\n", VALID_RTC);
  expect(f.monitor.current()).toBe("available");
  f.monitor.stop();
});

test("TA-05 offline reboot: NTP no but valid RTC keeps the time available", async () => {
  const f = fixture();
  f.monitor.start();
  await f.settle(0, "no\n", VALID_RTC);
  expect(f.monitor.current()).toBe("available");
  expect(f.logger.info).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "time_availability_changed",
      availability: "available",
      reason: "rtc",
      ntp: "unsynchronized",
      rtc: "valid",
    }),
    expect.any(String),
  );
  f.monitor.stop();
});

test("TA-06 power loss without battery, then NTP recovers within one period", async () => {
  const f = fixture();
  f.monitor.start();
  await f.settle(0, "no\n", "73\n");
  expect(f.monitor.current()).toBe("unavailable");
  await vi.advanceTimersByTimeAsync(CHECK_PERIOD_MS);
  expect(f.sources.ntp).toHaveBeenCalledTimes(2);
  await f.settle(1, "yes\n", "120\n");
  expect(f.monitor.current()).toBe("available");
  f.monitor.stop();
});

test("TA-07 one failed source does not hide the other evidence", async () => {
  const f = fixture();
  f.monitor.start();
  await f.settle(0, new Error("ENOENT"), VALID_RTC);
  expect(f.monitor.current()).toBe("available");
  await vi.advanceTimersByTimeAsync(CHECK_PERIOD_MS);
  await f.settle(1, "yes\n", new Error("EINVAL"));
  expect(f.monitor.current()).toBe("available");
  await vi.advanceTimersByTimeAsync(CHECK_PERIOD_MS);
  await f.settle(2, new Error("ENOENT"), new Error("EINVAL"));
  expect(f.monitor.current()).toBe("unavailable"); // Fail Closed
  f.monitor.stop();
});

test("TA-08 an available time becomes unavailable when the evidence is lost", async () => {
  const f = fixture();
  f.monitor.start();
  await f.settle(0, "yes\n", VALID_RTC);
  await vi.advanceTimersByTimeAsync(CHECK_PERIOD_MS);
  await f.settle(1, "no\n", "5\n");
  expect(f.monitor.current()).toBe("unavailable");
  f.monitor.stop();
});

test("TA-09 a read that does not finish within 3 seconds is aborted as failed", async () => {
  const f = fixture();
  f.monitor.start();
  await f.settle(0, "yes\n", VALID_RTC);
  await vi.advanceTimersByTimeAsync(CHECK_PERIOD_MS);
  // NTP never answers; RTC reports a reset clock.
  f.rtc[1].resolve("10\n");
  await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
  expect(f.ntp[1].signal.aborted).toBe(true);
  f.ntp[1].resolve("yes\n"); // too late: the aborted read stays failed
  await vi.advanceTimersByTimeAsync(0);
  expect(f.monitor.current()).toBe("unavailable");
  f.monitor.stop();
});

test("TA-10 at most one read at a time; a slow read skips the next period", async () => {
  const f = fixture();
  f.monitor.start();
  f.rtc[0].resolve(VALID_RTC);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(f.sources.ntp).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(CHECK_PERIOD_MS); // the timeout ends read 0
  expect(f.sources.ntp).toHaveBeenCalledTimes(2);
  f.monitor.stop();
});

test("TA-11 logs changes and source failures once, not on every read", async () => {
  const f = fixture();
  f.monitor.start();
  await f.settle(0, new Error("ENOENT"), "73\n");
  for (let i = 1; i <= 3; i++) {
    await vi.advanceTimersByTimeAsync(CHECK_PERIOD_MS);
    await f.settle(i, new Error("ENOENT"), "73\n");
  }
  expect(f.events()).toEqual([
    "time_evidence_unavailable",
    "time_availability_changed", // first evaluation: unavailable / none
  ]);
  await vi.advanceTimersByTimeAsync(CHECK_PERIOD_MS);
  await f.settle(4, "yes\n", "73\n");
  expect(f.events()).toEqual([
    "time_evidence_unavailable",
    "time_availability_changed",
    "time_evidence_recovered",
    "time_availability_changed", // available / ntp
  ]);
  const warned = f.logger.warn.mock.calls[0][0] as Record<string, unknown>;
  expect(warned).toEqual({ event: "time_evidence_unavailable", source: "ntp" });
  f.monitor.stop();
});

test("TA-12 stop() returns to unavailable and ignores a read that settles later", async () => {
  const f = fixture();
  f.monitor.start();
  await f.settle(0, "yes\n", VALID_RTC);
  await vi.advanceTimersByTimeAsync(CHECK_PERIOD_MS);
  f.monitor.stop();
  expect(f.ntp[1].signal.aborted).toBe(true);
  expect(f.monitor.current()).toBe("unavailable");
  await f.settle(1, "yes\n", VALID_RTC);
  expect(f.monitor.current()).toBe("unavailable");
  await vi.advanceTimersByTimeAsync(CHECK_PERIOD_MS * 3);
  expect(f.sources.ntp).toHaveBeenCalledTimes(2);
});

test("TA-13 a source that throws synchronously is a failed read", async () => {
  const logger = { info: vi.fn(), warn: vi.fn() };
  let signal: AbortSignal | undefined;
  const monitor = new TimeAvailabilityMonitor(logger as never, {
    ntp: (s) => {
      signal = s;
      throw new Error("spawn failed");
    },
    rtc: () => Promise.resolve(VALID_RTC),
  });
  monitor.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(monitor.current()).toBe("available");
  expect(getEventListeners(signal!, "abort")).toHaveLength(0);
  monitor.stop();
});

test.each([
  ["NTP times out, RTC valid", "ntp", VALID_RTC, "available"],
  ["RTC times out, NTP yes", "rtc", "yes\n", "available"],
] as const)(
  "TA-17 %s: the evidence that arrived is used (one timeout hides nothing)",
  async (_name, hanging, value, expected) => {
    const f = fixture();
    f.monitor.start();
    const answered = hanging === "ntp" ? f.rtc : f.ntp;
    const stalled = hanging === "ntp" ? f.ntp : f.rtc;
    answered[0].resolve(value);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    expect(stalled[0].signal.aborted).toBe(true);
    expect(f.monitor.current()).toBe(expected);
    // A late value after the timeout does not change the settled result.
    stalled[0].resolve(hanging === "ntp" ? "no\n" : "5\n");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.monitor.current()).toBe(expected);
    expect(f.logger.warn).toHaveBeenCalledWith(
      { event: "time_evidence_unavailable", source: hanging },
      expect.any(String),
    );
    f.monitor.stop();
  },
);

test("TA-18 both time out: unavailable, and late values do not override it", async () => {
  const f = fixture();
  f.monitor.start();
  await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
  expect(f.monitor.current()).toBe("unavailable");
  f.ntp[0].resolve("yes\n");
  f.rtc[0].resolve(VALID_RTC);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.monitor.current()).toBe("unavailable");
  f.monitor.stop();
});

test("TA-19 abort listeners are removed after success, failure and timeout", async () => {
  const f = fixture();
  f.monitor.start();
  await f.settle(0, "yes\n", new Error("EINVAL"));
  expect(getEventListeners(f.ntp[0].signal, "abort")).toHaveLength(0);
  expect(getEventListeners(f.rtc[0].signal, "abort")).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(CHECK_PERIOD_MS + READ_TIMEOUT_MS);
  expect(getEventListeners(f.ntp[1].signal, "abort")).toHaveLength(0);
  f.monitor.stop();
});

test("TA-20 stop then start behaves like a new monitor", async () => {
  const f = fixture();
  f.monitor.start();
  f.monitor.start(); // no second Timer
  expect(f.sources.ntp).toHaveBeenCalledTimes(1);
  await f.settle(0, new Error("ENOENT"), VALID_RTC);
  expect(f.monitor.current()).toBe("available");
  await vi.advanceTimersByTimeAsync(CHECK_PERIOD_MS); // read 1 is pending
  f.monitor.stop();
  f.monitor.start();
  // A new read starts at once although read 1 has not settled.
  expect(f.sources.ntp).toHaveBeenCalledTimes(3);
  expect(f.monitor.current()).toBe("unavailable");
  await f.settle(1, "yes\n", VALID_RTC); // the stale read is ignored
  expect(f.monitor.current()).toBe("unavailable");
  await f.settle(2, new Error("ENOENT"), "73\n");
  expect(f.monitor.current()).toBe("unavailable");
  // First log and the failure log are emitted again after the restart.
  expect(f.events()).toEqual([
    "time_evidence_unavailable",
    "time_availability_changed",
    "time_evidence_unavailable",
    "time_availability_changed",
  ]);
  await vi.advanceTimersByTimeAsync(CHECK_PERIOD_MS);
  expect(f.sources.ntp).toHaveBeenCalledTimes(4); // one Timer only
  f.monitor.stop();
});

async function getTime(current?: () => TimeAvailability) {
  const app = buildApp(createLogger("silent"), false);
  registerRoutes(app, undefined, current);
  try {
    const r = await app.inject({ url: "/api/time-availability" });
    return {
      status: r.statusCode,
      cache: r.headers["cache-control"],
      body: r.json() as unknown,
    };
  } finally {
    await app.close();
  }
}

test.each(["available", "unavailable"] as const)(
  "TA-14 GET /api/time-availability returns %s with no-store",
  async (availability) => {
    expect(await getTime(() => availability)).toEqual({
      status: 200,
      cache: "no-store",
      body: { availability },
    });
  },
);

test("TA-15 the route answers even while the DB is unavailable (503 elsewhere)", async () => {
  const app = buildApp(createLogger("silent"), false);
  registerRoutes(app, undefined, () => "available");
  try {
    expect(
      (await app.inject({ url: "/api/published-states" })).statusCode,
    ).toBe(503);
    const r = await app.inject({ url: "/api/time-availability" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ availability: "available" });
  } finally {
    await app.close();
  }
});

test("TA-16 no source, an error or an unexpected value answers unavailable", async () => {
  expect((await getTime()).body).toEqual({ availability: "unavailable" });
  const thrown = await getTime(() => {
    throw new Error("broken");
  });
  expect(thrown).toEqual({
    status: 200,
    cache: "no-store",
    body: { availability: "unavailable" },
  });
  expect(
    (await getTime(() => "yes" as unknown as TimeAvailability)).body,
  ).toEqual({ availability: "unavailable" });
});
