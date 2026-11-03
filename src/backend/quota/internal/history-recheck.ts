import type { TimeSource } from "../../time/source.js";
export interface HistoryRecheckPlan {
  wallAtMs?: number;
  waitAtNs?: bigint;
}
const maxDelay = 2 ** 31 - 1;
/** A/B/C assessment notification only, never Scheduler resume or send authority.
 * C has no production default: integration must supply its chosen period. It
 * also preserves re-evaluation opportunities if a notification is lost/throws.
 */
export class HistoryRecheck {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private started = false;
  private wallDelivered?: number;
  private monoDelivered?: bigint;
  constructor(
    private readonly time: TimeSource,
    private readonly plan: () => HistoryRecheckPlan,
    private readonly notify: () => void,
    private readonly fallbackIntervalMs: number,
  ) {
    if (
      !Number.isSafeInteger(fallbackIntervalMs) ||
      fallbackIntervalMs <= 0 ||
      fallbackIntervalMs > maxDelay
    )
      throw new TypeError("Recheck period required");
  }
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.arm(false);
  }
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private arm(fired: boolean): void {
    if (this.stopped) return;
    let delay = this.fallbackIntervalMs;
    let due = false;
    try {
      const p = this.plan(),
        wall = this.time.wallMs(),
        mono = this.time.monotonicNs();
      if (
        !Number.isSafeInteger(wall) ||
        wall < 0 ||
        typeof mono !== "bigint" ||
        mono < 0n
      )
        throw Error("Invalid recheck clock");
      if (p.wallAtMs !== undefined) {
        if (!Number.isSafeInteger(p.wallAtMs) || p.wallAtMs < 0)
          throw Error("Invalid wall deadline");
        if (p.wallAtMs !== this.wallDelivered) {
          if (p.wallAtMs <= wall) {
            due = true;
            this.wallDelivered = p.wallAtMs;
          } else delay = Math.min(delay, p.wallAtMs - wall);
        }
      }
      if (p.waitAtNs !== undefined) {
        if (typeof p.waitAtNs !== "bigint" || p.waitAtNs < 0n)
          throw Error("Invalid wait deadline");
        if (p.waitAtNs !== this.monoDelivered) {
          if (p.waitAtNs <= mono) {
            due = true;
            this.monoDelivered = p.waitAtNs;
          } else
            delay = Math.min(
              delay,
              Number(
                (p.waitAtNs - mono + 999999n) / 1000000n > BigInt(maxDelay)
                  ? BigInt(maxDelay)
                  : (p.waitAtNs - mono + 999999n) / 1000000n,
              ),
            );
        }
      }
    } catch {
      due = true;
    }
    if (fired || due) {
      try {
        this.notify();
      } catch {
        /* A notification is not a successful recovery. */
      }
    }
    if (this.stopped) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.arm(true);
      },
      Math.max(1, Math.min(maxDelay, Math.ceil(delay))),
    );
  }
}
