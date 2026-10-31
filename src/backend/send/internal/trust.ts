import type { TimeSource } from "../../time/source.js";

export type TrustState = "UNVERIFIED" | "TRUSTED" | "SUSPENDED";
export interface OsSyncObservation {
  confirmed: boolean;
  checkedAtNs: bigint;
}
const second = 1_000_000_000n;
const fresh = 15n * second;
export class ClockTrustMonitor {
  private current: TrustState = "UNVERIFIED";
  private last?: { wall: number; mono: bigint };
  private os?: OsSyncObservation;
  private recovering = false;
  private stableSince?: bigint;
  private timer?: ReturnType<typeof setInterval>;
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly time: TimeSource,
    private readonly readOsSync: () => OsSyncObservation | null,
  ) {}
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  start(): void {
    if (this.timer) return;
    this.observe();
    this.timer = setInterval(() => this.observe(), 5000);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.fail();
  }
  observe(): void {
    try {
      const mono = this.time.monotonicNs();
      const wall = this.time.wallMs();
      const os = this.readOsSync();
      if (!this.validMono(mono) || !Number.isSafeInteger(wall) || wall < 0)
        return this.fail();
      const prior = this.last;
      this.last = { wall, mono };
      this.os = os
        ? { confirmed: os.confirmed, checkedAtNs: os.checkedAtNs }
        : undefined;
      if (prior) {
        const delta = mono - prior.mono;
        const discrepancy = BigInt(wall - prior.wall) * 1_000_000n - delta;
        if (
          delta < 0n ||
          delta > fresh ||
          discrepancy >= second ||
          discrepancy <= -second
        )
          return this.fail();
      }
      if (!this.osFresh(mono)) return this.fail();
      if (this.recovering) {
        this.stableSince ??= mono;
        if (mono - this.stableSince < 60n * second) return;
      }
      this.recovering = false;
      this.current = "TRUSTED";
    } catch {
      this.fail();
    }
  }
  state(): TrustState {
    try {
      const now = this.time.monotonicNs();
      if (
        this.current === "TRUSTED" &&
        (!this.validMono(now) ||
          !this.last ||
          now < this.last.mono ||
          now - this.last.mono > fresh ||
          !this.osFresh(now))
      )
        this.fail();
    } catch {
      this.fail();
    }
    return this.current;
  }
  private validMono(n: unknown): n is bigint {
    return typeof n === "bigint" && n >= 0n;
  }
  private osFresh(now: bigint): boolean {
    return (
      this.os?.confirmed === true &&
      this.validMono(this.os.checkedAtNs) &&
      now >= this.os.checkedAtNs &&
      now - this.os.checkedAtNs <= fresh
    );
  }
  private fail(): void {
    const changed = this.current !== "SUSPENDED";
    this.current = "SUSPENDED";
    this.recovering = true;
    this.stableSince = undefined;
    if (changed) for (const listener of this.listeners) listener();
  }
}
export interface HistoryFacts {
  internalConsistent: boolean;
  timestampsTrusted: boolean;
  complete: boolean;
}
/** Internal confirmation boundary. No production management recovery policy yet. */
export class HistoryTrustMonitor {
  private current: TrustState = "UNVERIFIED";
  private facts: HistoryFacts = {
    internalConsistent: false,
    timestampsTrusted: false,
    complete: false,
  };
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  confirm(facts: HistoryFacts): void {
    try {
      this.facts = {
        internalConsistent: facts.internalConsistent === true,
        timestampsTrusted: facts.timestampsTrusted === true,
        complete: facts.complete === true,
      };
    } catch {
      return this.suspend();
    }
    if (
      !this.facts.internalConsistent ||
      !this.facts.timestampsTrusted ||
      !this.facts.complete
    )
      return this.suspend();
    this.current = "TRUSTED";
  }
  suspend(): void {
    const changed = this.current !== "SUSPENDED";
    this.current = "SUSPENDED";
    this.facts = {
      internalConsistent: false,
      timestampsTrusted: false,
      complete: false,
    };
    if (changed) for (const listener of this.listeners) listener();
  }
  state(): TrustState {
    return this.current;
  }
}
