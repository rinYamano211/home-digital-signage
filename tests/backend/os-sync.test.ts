import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  OsSyncReader,
  readNtpSynchronized,
} from "../../src/backend/send/internal/os-sync.js";
import { ClockTrustMonitor } from "../../src/backend/send/internal/trust.js";
const exec = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => {
    exec.calls.push(args);
    (args.at(-1) as (e: Error | null, out: string) => void)(null, "yes\n");
  },
}));
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  exec.calls.length = 0;
});
function fixture() {
  let mono = 1_000_000_000n,
    wall = 200_000_000;
  const time = { wallMs: () => wall, monotonicNs: () => mono };
  const pending: {
    resolve: (out: string) => void;
    reject: (e: Error) => void;
    signal: AbortSignal;
  }[] = [];
  const command = vi.fn(
    (signal: AbortSignal) =>
      new Promise<string>((resolve, reject) =>
        pending.push({ resolve, reject, signal }),
      ),
  );
  const reader = new OsSyncReader(time, command);
  // Fake time moves both clocks; Timers fire through the async Fake Timer API.
  const advance = async (ms: number) => {
    mono += BigInt(ms) * 1_000_000n;
    wall += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };
  const settle = async (i: number, out: string | Error) => {
    if (out instanceof Error) pending[i].reject(out);
    else pending[i].resolve(out);
    await vi.advanceTimersByTimeAsync(0);
  };
  const stall = (ms: number) => {
    mono += BigInt(ms) * 1_000_000n;
  };
  return {
    reader,
    command,
    pending,
    advance,
    settle,
    stall,
    time,
    mono: () => mono,
  };
}
test("OS-01 no observation before the first check completes", () => {
  const f = fixture();
  expect(f.reader.current()).toBeNull();
  f.reader.start();
  expect(f.command).toHaveBeenCalledTimes(1);
  expect(f.reader.current()).toBeNull();
  f.reader.stop();
});
test("OS-02/03 yes confirms; no is an unconfirmed observation replacing success", async () => {
  const f = fixture();
  f.reader.start();
  await f.settle(0, "yes\n");
  expect(f.reader.current()).toEqual({
    confirmed: true,
    checkedAtNs: f.mono(),
  });
  await f.advance(5000);
  await f.settle(1, "no\n");
  expect(f.reader.current()).toEqual({
    confirmed: false,
    checkedAtNs: f.mono(),
  });
  f.reader.stop();
});
test.each(["", "yes", "YES\n", " yes\n", "yes\n\n", "1\n", "no\nyes\n"])(
  "OS-04 output %j other than exact yes/no discards the earlier success",
  async (out) => {
    const f = fixture();
    f.reader.start();
    await f.settle(0, "yes\n");
    await f.advance(5000);
    await f.settle(1, out);
    expect(f.reader.current()).toBeNull();
    f.reader.stop();
  },
);
test("OS-05 command failure, including a synchronous throw, discards success", async () => {
  const f = fixture();
  f.reader.start();
  await f.settle(0, "yes\n");
  await f.advance(5000);
  await f.settle(1, Error("exit 1"));
  expect(f.reader.current()).toBeNull();
  const throwing = new OsSyncReader(f.time, () => {
    throw Error("spawn failed");
  });
  throwing.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(throwing.current()).toBeNull();
  throwing.stop();
  f.reader.stop();
});
test("OS-06 Timeout aborts the child, drops success and ignores its late output", async () => {
  const f = fixture();
  f.reader.start();
  await f.settle(0, "yes\n");
  await f.advance(5000);
  expect(f.reader.current()).not.toBeNull();
  await f.advance(3000);
  expect(f.pending[1].signal.aborted).toBe(true);
  expect(f.reader.current()).toBeNull();
  await f.settle(1, "yes\n");
  expect(f.reader.current()).toBeNull();
  f.reader.stop();
});
test("OS-07 an observation older than 15 seconds is not returned", async () => {
  const f = fixture();
  f.reader.start();
  await f.settle(0, "yes\n");
  // Event-loop stall: monotonic time passes without any Timer running.
  f.stall(15000);
  expect(f.reader.current()).not.toBeNull();
  f.stall(1);
  expect(f.reader.current()).toBeNull();
  f.stall(-20000);
  expect(f.reader.current()).toBeNull();
  f.reader.stop();
});
test("OS-08 a slow check is never overlapped by the next period", async () => {
  const f = fixture();
  f.reader.start();
  await f.advance(2999);
  await f.advance(10000);
  // Aborted on Timeout, but unsettled: no second child is started meanwhile.
  expect(f.command).toHaveBeenCalledTimes(1);
  await f.settle(0, Error("aborted"));
  await f.advance(5000);
  expect(f.command).toHaveBeenCalledTimes(2);
  f.reader.stop();
});
test("OS-09 stop aborts the in-flight child and discards its late result", async () => {
  const f = fixture();
  f.reader.start();
  await f.settle(0, "yes\n");
  await f.advance(5000);
  f.reader.stop();
  expect(f.pending[1].signal.aborted).toBe(true);
  expect(f.reader.current()).toBeNull();
  await f.settle(1, "yes\n");
  expect(f.reader.current()).toBeNull();
  await f.advance(20000);
  expect(f.command).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
test("OS-10 restart never reuses a pre-stop result and waits for the old child", async () => {
  const f = fixture();
  f.reader.start();
  f.reader.stop();
  f.reader.start();
  expect(f.command).toHaveBeenCalledTimes(1);
  await f.settle(0, "yes\n");
  expect(f.reader.current()).toBeNull();
  await f.advance(5000);
  expect(f.command).toHaveBeenCalledTimes(2);
  await f.settle(1, "yes\n");
  expect(f.reader.current()).toEqual({
    confirmed: true,
    checkedAtNs: f.mono(),
  });
  f.reader.stop();
});
test("OS-11 after a failure only a new successful check is adopted", async () => {
  const f = fixture();
  f.reader.start();
  await f.settle(0, Error("exit 1"));
  expect(f.reader.current()).toBeNull();
  await f.advance(5000);
  await f.settle(1, "yes\n");
  expect(f.reader.current()).toEqual({
    confirmed: true,
    checkedAtNs: f.mono(),
  });
  f.reader.stop();
});
test("OS-12 current() is the existing ClockTrustMonitor synchronous callback", async () => {
  const f = fixture();
  const clock = new ClockTrustMonitor(f.time, () => f.reader.current());
  clock.observe();
  expect(clock.state()).toBe("SUSPENDED");
  f.reader.start();
  await f.settle(0, "yes\n");
  const epoch = clock.epoch();
  clock.observe();
  expect(clock.state()).toBe("SUSPENDED"); // existing 60s recovery is unchanged
  expect(clock.epoch()).toBe(epoch);
  await f.advance(5000);
  await f.settle(1, "no\n");
  clock.observe();
  expect(clock.state()).toBe("SUSPENDED");
  expect(clock.epoch()).toBe(epoch + 1n);
  f.reader.stop();
});
test("production command runs timedatectl without a shell or overrides", async () => {
  await expect(readNtpSynchronized(new AbortController().signal)).resolves.toBe(
    "yes\n",
  );
  const [file, args, options] = exec.calls[0] as [
    string,
    string[],
    Record<string, unknown>,
  ];
  expect(file).toBe("timedatectl");
  expect(args).toEqual(["show", "-p", "NTPSynchronized", "--value"]);
  expect(options).toEqual(
    expect.objectContaining({ timeout: 3000, windowsHide: true }),
  );
  expect(options.shell).toBeUndefined();
  expect(options.env).toBeUndefined();
});
