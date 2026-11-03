import { execFile } from "node:child_process";
import { systemTime, type TimeSource } from "../../time/source.js";
import type { OsSyncObservation } from "./trust.js";

const periodMs = 5000;
const timeoutMs = 3000;
const fresh = 15_000_000_000n;
export type OsSyncCommand = (signal: AbortSignal) => Promise<string>;
/** C-Impl-5B-1: no shell, fixed arguments, no Config override. */
export const readNtpSynchronized: OsSyncCommand = (signal) =>
  new Promise((resolve, reject) => {
    execFile(
      "timedatectl",
      ["show", "-p", "NTPSynchronized", "--value"],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 1024,
        signal,
        windowsHide: true,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
/** Supplies ClockTrustMonitor's synchronous OS callback via current(). It only
 * acquires and holds observations; Clock/History Trust and Quota decisions stay
 * in their owners. `yes` alone confirms; any failure yields null (Fail Closed).
 */
export class OsSyncReader {
  private snapshot?: OsSyncObservation;
  private timer?: ReturnType<typeof setInterval>;
  private running?: { generation: number; abort: AbortController };
  private generation = 0;
  constructor(
    private readonly time: TimeSource = systemTime,
    private readonly command: OsSyncCommand = readNtpSynchronized,
  ) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), periodMs);
    this.check();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.generation++;
    this.snapshot = undefined;
    this.running?.abort.abort();
  }
  current(): OsSyncObservation | null {
    const s = this.snapshot;
    if (!s) return null;
    try {
      const now = this.time.monotonicNs();
      if (
        typeof now === "bigint" &&
        now >= s.checkedAtNs &&
        now - s.checkedAtNs <= fresh
      )
        return { confirmed: s.confirmed, checkedAtNs: s.checkedAtNs };
    } catch {
      /* An unreadable clock cannot prove freshness. */
    }
    this.snapshot = undefined;
    return null;
  }
  private check(): void {
    // One child at a time, even across stop/start while an aborted one settles.
    if (this.running || !this.timer) return;
    const run = { generation: this.generation, abort: new AbortController() };
    this.running = run;
    const timeout = setTimeout(() => {
      if (run.generation === this.generation) this.snapshot = undefined;
      run.abort.abort();
    }, timeoutMs);
    let result: Promise<string>;
    try {
      result = this.command(run.abort.signal);
    } catch (error) {
      result = Promise.reject(error);
    }
    result
      .then(
        (out) => {
          if (run.abort.signal.aborted) return undefined;
          // `--value` prints exactly one line; anything else is unverified.
          return out === "yes\n" ? true : out === "no\n" ? false : undefined;
        },
        () => undefined,
      )
      .then((confirmed) => {
        clearTimeout(timeout);
        this.running = undefined;
        if (run.generation !== this.generation) return;
        this.snapshot = undefined;
        if (confirmed === undefined) return;
        const checkedAtNs = this.time.monotonicNs();
        if (typeof checkedAtNs === "bigint" && checkedAtNs >= 0n)
          this.snapshot = { confirmed, checkedAtNs };
      })
      .catch(() => {
        this.snapshot = undefined;
      });
  }
}
