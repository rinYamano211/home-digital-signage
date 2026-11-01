import type { TimeSource } from "../../time/source.js";
import { TOMORROW_IO, type QuotaTrust } from "../../quota/quota-guard.js";
import type {
  QuotaAttempt,
  QuotaRepository,
  QuotaReservationResult,
} from "../../storage/quota-repository.js";
import { ClockTrustMonitor, HistoryTrustMonitor } from "./trust.js";
import { PermitRegistry } from "./permits.js";

/** Internal trusted wiring only. Production has no HTTP adapter in C-Impl-4.
 * start must call fetch synchronously and return the Adapter result Promise
 * (after Body/Lifecycle processing), not the native Headers Promise. lifecycleEnded is
 * called only after the entire Request (including Body/cancellation) has ended.
 * A Promise resolution/rejection alone is NOT lifecycle completion.
 */
export interface HttpStartAdapter {
  start(signal: AbortSignal, lifecycleEnded: () => void): Promise<unknown>;
}
export interface ProviderBinding {
  repository: QuotaRepository;
  history: HistoryTrustMonitor;
}
export type ProviderPhase =
  "IDLE" | "STARTING" | "IN_FLIGHT" | "ABORT_REQUESTED";
declare const gateAttemptBrand: unique symbol;
export interface GateAttempt {
  readonly [gateAttemptBrand]: true;
}
interface Attempt {
  provider: string;
  quotaAttempt: QuotaAttempt;
  repository: QuotaRepository;
  epoch: bigint;
  used: boolean;
  cleanupAttempted: boolean;
}
interface Flight {
  abort: AbortController;
  phase: ProviderPhase;
  finished: boolean;
  starting: boolean;
}
interface Slot {
  binding: ProviderBinding;
  epoch: bigint;
  reasons: Set<object>;
  historyReason: object;
  failureReason: object;
  repositoryFailure?: "begin_attempt_failed" | "attempt_cleanup_failed";
  cooldownUntil?: bigint;
  flight?: Flight;
  attempts: Set<Attempt>;
}
export type GateStartResult =
  | { kind: "started"; response: Promise<unknown> }
  | { kind: "blocked"; reason: string };
export interface StopControl {
  stop(): void;
  release(): void;
}

/** Independent control core. Import the production factory, not this internal
 * constructor, for production wiring. No arbitrary callback on public start().
 */
export class ProviderSendGate {
  private readonly slots = new Map<string, Slot>();
  private readonly attempts = new WeakMap<GateAttempt, Attempt>();
  private readonly globalReasons = new Set<object>();
  private readonly clockReason = Object.freeze({});
  private readonly permits = new PermitRegistry();
  private readonly unsubscribe: (() => void)[] = [];
  constructor(
    bindings: ReadonlyMap<string, ProviderBinding>,
    private readonly clock: ClockTrustMonitor,
    private readonly time: TimeSource,
    private readonly adapter?: HttpStartAdapter,
  ) {
    this.globalReasons.add(this.clockReason);
    for (const [provider, binding] of bindings) {
      const historyReason = Object.freeze({});
      this.slots.set(provider, {
        binding,
        epoch: 0n,
        reasons: new Set([historyReason]),
        historyReason,
        failureReason: Object.freeze({}),
        attempts: new Set(),
      });
      this.unsubscribe.push(
        binding.history.subscribe(() => this.close(provider, historyReason)),
      );
    }
    this.unsubscribe.push(
      clock.subscribe(() => this.close("global", this.clockReason)),
    );
  }
  /** Authority is in this closure; another owner cannot remove its reason. */
  stopControl(scope: "global" | string): StopControl {
    if (scope !== "global" && !this.slots.has(scope))
      throw new TypeError("Unknown Provider");
    const owner = Object.freeze({});
    return Object.freeze({
      stop: () => this.close(scope, owner),
      release: () => {
        if (scope === "global") this.globalReasons.delete(owner);
        else this.slots.get(scope)!.reasons.delete(owner);
      },
    });
  }
  /** Explicit pre-Tx-Q hint for the future Coordinator, not a send permission. */
  reservationStatus(provider: string): {
    allowed: boolean;
    reason: string;
    recheckAtNs?: bigint;
  } {
    const slot = this.slots.get(provider);
    if (!slot) return { allowed: false, reason: "unsupported_provider" };
    this.refreshTrust(slot);
    if (this.globalReasons.size || slot.reasons.size)
      return { allowed: false, reason: "stopped_or_untrusted" };
    if (slot.flight) return { allowed: false, reason: "provider_in_flight" };
    try {
      const now = this.now();
      if (slot.cooldownUntil !== undefined && now < slot.cooldownUntil)
        return {
          allowed: false,
          reason: "cooldown",
          recheckAtNs: slot.cooldownUntil,
        };
    } catch {
      return { allowed: false, reason: "invalid_monotonic_time" };
    }
    return { allowed: true, reason: "ready_for_recheck" };
  }
  /** Caller supplies this function to the existing Tx-Q, without changing it. */
  quotaTrust(provider: string): QuotaTrust {
    const slot = this.slots.get(provider);
    if (!slot)
      return {
        clockTrusted: false,
        historyTimestampsTrusted: false,
        historyComplete: false,
      };
    this.refreshTrust(slot);
    const history = slot.binding.history.state() === "TRUSTED";
    return {
      clockTrusted: this.clock.state() === "TRUSTED",
      historyTimestampsTrusted: history,
      historyComplete: history,
    };
  }
  beginAttempt(
    provider: string,
  ): { attempt: GateAttempt; quotaAttempt: QuotaAttempt } | null {
    const slot = this.slots.get(provider);
    if (
      !slot ||
      provider !== TOMORROW_IO ||
      !this.reservationStatus(provider).allowed
    )
      return null;
    // Gate-owned duplicates can be rejected without asking storage.
    if (slot.attempts.size) return null;
    let quotaAttempt: QuotaAttempt;
    try {
      quotaAttempt = slot.binding.repository.beginAttempt(provider);
    } catch (error) {
      // Verified against the current Repository: for the allowlisted Provider,
      // this exact rejection is the active-attempt guard, not every TypeError.
      if (
        error instanceof TypeError &&
        error.message === "Quota attempt unavailable"
      )
        return null;
      slot.repositoryFailure = "begin_attempt_failed";
      this.close(provider, slot.failureReason);
      throw error; // unexpected storage failure is not ordinary unavailability
    }
    const record: Attempt = {
      provider,
      quotaAttempt,
      repository: slot.binding.repository,
      epoch: slot.epoch,
      used: false,
      cleanupAttempted: false,
    };
    const attempt = Object.freeze(Object.create(null)) as GateAttempt;
    this.attempts.set(attempt, record);
    slot.attempts.add(record);
    return { attempt, quotaAttempt };
  }
  endAttempt(attempt: GateAttempt): void {
    const record = this.attempts.get(attempt);
    if (record) this.invalidate(record);
  }
  start(attempt: GateAttempt, result: QuotaReservationResult): GateStartResult {
    const record = this.attempts.get(attempt);
    if (!record || record.used)
      return { kind: "blocked", reason: "invalid_attempt" };
    const slot = this.slots.get(record.provider)!;
    const deny = (reason: string): GateStartResult => {
      this.invalidate(record);
      return { kind: "blocked", reason };
    };
    try {
      const status = this.reservationStatus(record.provider);
      if (!status.allowed) return deny(status.reason);
      if (record.used || record.epoch !== slot.epoch) return deny("old_epoch");
      if (result.outcome !== "saved") return deny("reservation_not_saved");
      const reservation = record.repository.inspectReservation(
        result.evidence,
        record.quotaAttempt,
      );
      if (!reservation || reservation.providerKey !== record.provider)
        return deny("invalid_evidence");
      const now = this.now();
      if (
        typeof reservation.measurementStartedNs !== "bigint" ||
        reservation.measurementStartedNs < 0n
      )
        return deny("invalid_measurement");
      const elapsed = now - reservation.measurementStartedNs;
      if (elapsed < 0n) return deny("invalid_measurement");
      if (elapsed > 1_000_000_000n) {
        slot.cooldownUntil = now + 5_000_000_000n;
        return deny("delay_exceeded");
      }
      if (!this.adapter) return deny("http_adapter_unavailable");
      const binding = {
        provider: record.provider,
        attempt: record.quotaAttempt,
        repository: record.repository,
        sequence: reservation.sequence,
        epoch: slot.epoch,
      };
      const permit = this.permits.issue(binding);
      // No await or user-supplied callback between final checks, consume and start.
      if (!this.permits.consume(permit, binding)) return deny("invalid_permit");
      record.used = true;
      const flight: Flight = {
        abort: new AbortController(),
        phase: "STARTING",
        finished: false,
        starting: true,
      };
      slot.flight = flight; // before invoking trusted adapter: synchronous re-entry stays occupied
      const finish = () => {
        flight.finished = true;
        if (!flight.starting && slot.flight === flight) {
          slot.flight = undefined;
          this.invalidate(record);
        }
      };
      try {
        const response = this.adapter.start(flight.abort.signal, finish);
        if (!(response instanceof Promise))
          throw new TypeError("Invalid HTTP adapter");
        // Prevent unhandled rejection if owner shuts down; still return original result.
        void response.catch(() => undefined);
        flight.starting = false;
        if (flight.phase === "STARTING") flight.phase = "IN_FLIGHT";
        if (flight.finished) finish();
        return { kind: "started", response };
      } catch {
        // Start may have partially happened. Do not guess Body/Lifecycle completion.
        flight.starting = false;
        flight.phase = "ABORT_REQUESTED";
        flight.abort.abort();
        this.invalidate(record);
        if (flight.finished) finish();
        return { kind: "blocked", reason: "http_start_failed" };
      }
    } catch {
      return deny("invalid_start_input_or_clock");
    }
  }
  snapshot(provider: string): {
    phase: ProviderPhase;
    epoch: bigint;
    stopped: boolean;
    repositoryFailure?: "begin_attempt_failed" | "attempt_cleanup_failed";
    cooldownUntil?: bigint;
  } {
    const slot = this.slots.get(provider);
    if (!slot) throw new TypeError("Unknown Provider");
    this.refreshTrust(slot);
    return {
      phase: slot.flight?.phase ?? "IDLE",
      epoch: slot.epoch,
      stopped: !!(this.globalReasons.size || slot.reasons.size),
      repositoryFailure: slot.repositoryFailure,
      cooldownUntil: slot.cooldownUntil,
    };
  }
  dispose(): void {
    this.close("global", this); // irreversible for this instance
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
  }
  private refreshTrust(slot: Slot): void {
    if (this.clock.state() !== "TRUSTED") {
      if (!this.globalReasons.has(this.clockReason))
        this.close("global", this.clockReason);
    } else this.globalReasons.delete(this.clockReason);
    if (slot.binding.history.state() !== "TRUSTED") {
      if (!slot.reasons.has(slot.historyReason))
        this.close(this.providerOf(slot), slot.historyReason);
    } else slot.reasons.delete(slot.historyReason);
  }
  private providerOf(slot: Slot): string {
    for (const [key, value] of this.slots) if (value === slot) return key;
    throw new TypeError("Unknown Provider");
  }
  private close(scope: string, owner: object): void {
    if (scope === "global") this.globalReasons.add(owner);
    const targets = [...this.slots].filter(
      ([provider]) => scope === "global" || scope === provider,
    );
    const cleanup: Attempt[] = [];
    // Close every affected slot and invalidate local authority BEFORE invoking
    // Abort listeners or Repository cleanup, either of which can re-enter.
    for (const [, slot] of targets) {
      if (scope !== "global") slot.reasons.add(owner);
      slot.epoch++;
      for (const record of [...slot.attempts]) {
        this.invalidateLocally(record);
        cleanup.push(record);
      }
    }
    for (const [, slot] of targets) {
      const flight = slot.flight;
      if (flight) {
        flight.phase = "ABORT_REQUESTED";
        flight.abort.abort();
      }
    }
    // Abort is independent of cleanup success; one failure never skips another.
    for (const record of cleanup) this.cleanupAttempt(record);
  }
  private invalidateLocally(record: Attempt): void {
    record.used = true;
    this.slots.get(record.provider)?.attempts.delete(record);
  }
  private invalidate(record: Attempt): void {
    this.invalidateLocally(record);
    this.cleanupAttempt(record);
  }
  private cleanupAttempt(record: Attempt): void {
    if (record.cleanupAttempted) return;
    record.cleanupAttempted = true;
    try {
      record.repository.endAttempt(record.quotaAttempt);
    } catch {
      const slot = this.slots.get(record.provider)!;
      slot.repositoryFailure = "attempt_cleanup_failed";
      slot.reasons.add(slot.failureReason); // sticky, not cleared by Resume/Trust
      // Sanitized diagnostic is exposed in snapshot; no raw exception/Secret.
      // Do not retry cleanup or make an uncertain Repository attempt reusable.
    }
  }
  private now(): bigint {
    const now = this.time.monotonicNs();
    if (typeof now !== "bigint" || now < 0n)
      throw new TypeError("Invalid monotonic time");
    return now;
  }
}
