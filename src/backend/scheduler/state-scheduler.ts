import type { Logger } from "pino";
import { createLogger } from "../logging/logger.js";
import {
  STATE_KEYS,
  type StateKey,
} from "../storage/published-state-repository.js";
import { utcInstant } from "../time/utc-instant.js";

export type RunOnceResult =
  | { kind: "scheduled"; recheckAt: string }
  | {
      kind: "suspended";
      scope: "state" | "global";
      reason: "database_unavailable" | "storage_unresolved";
    }
  | {
      kind: "blocked";
      scope: "state" | "global";
      reason:
        | "invalid_recheck_at"
        | "integrity_error"
        | "schema_incompatible"
        | "unexpected_error";
    };

export interface AcquisitionCoordinator {
  runOnce(stateKey: StateKey): Promise<RunOnceResult>;
}

interface Slot {
  generation: number;
  timer?: ReturnType<typeof setTimeout>;
  inFlight?: Promise<void>;
  recheck: boolean;
  held: boolean;
}
const maximumDelay = 2 ** 31 - 1;

/** Only schedules evaluation. Owns no Provider, DB, signal handler or recovery.
 * Held states cannot be resumed by start/requestRecheck; safe resume is PR-E.
 */
export class StateScheduler {
  private readonly slots = new Map<StateKey, Slot>(
    STATE_KEYS.map((key) => [
      key,
      { generation: 0, recheck: false, held: false },
    ]),
  );
  private started = false;
  private stopping = false;
  private globalHeld = false;
  private stopped?: Promise<void>;

  constructor(
    private readonly coordinator: AcquisitionCoordinator,
    private readonly logger: Pick<Logger, "warn" | "error"> = createLogger(
      "info",
    ),
  ) {}

  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    for (const [key, slot] of this.slots) this.arm(key, slot, 0);
  }

  requestRecheck(stateKey: StateKey): void {
    const slot = this.slots.get(stateKey);
    if (!slot) throw new TypeError("Unknown State Key");
    if (!this.canRun(slot)) return;
    if (slot.inFlight) slot.recheck = true;
    else this.arm(stateKey, slot, 0);
  }

  stop(): Promise<void> {
    if (this.stopped) return this.stopped;
    // Synchronously close the scheduling gate before awaiting any Task.
    this.stopping = true;
    for (const slot of this.slots.values()) this.cancel(slot);
    this.stopped = Promise.all(
      [...this.slots.values()].map((slot) => slot.inFlight),
    ).then(() => undefined);
    return this.stopped;
  }

  private canRun(slot: Slot): boolean {
    return this.started && !this.stopping && !this.globalHeld && !slot.held;
  }

  private cancel(slot: Slot): void {
    slot.generation++;
    if (slot.timer !== undefined) clearTimeout(slot.timer);
    slot.timer = undefined;
    slot.recheck = false;
  }

  private arm(key: StateKey, slot: Slot, delay: number): void {
    this.cancel(slot);
    if (!this.canRun(slot)) return;
    const generation = slot.generation;
    slot.timer = setTimeout(
      () => {
        if (generation !== slot.generation || !this.canRun(slot)) return;
        // Consume this callback even if an already-queued callback runs twice.
        slot.timer = undefined;
        slot.generation++;
        if (slot.inFlight) return;
        // Defer invocation so even a synchronous/reentrant Coordinator observes
        // inFlight. A shutdown between timer firing and invocation wins.
        slot.inFlight = Promise.resolve().then(() => this.run(key, slot));
      },
      Math.min(maximumDelay, Math.max(0, Math.ceil(delay))),
    );
  }

  private async run(key: StateKey, slot: Slot): Promise<void> {
    try {
      if (!this.canRun(slot)) return;
      const result = await this.coordinator.runOnce(key);
      if (!this.canRun(slot)) return;
      if (result.kind === "scheduled") {
        const at = utcInstant(result.recheckAt);
        const now = Date.now();
        if (at === null || !Number.isFinite(now) || at <= now) {
          this.hold(key, slot, "state", "invalid_recheck_at");
          return;
        }
        // A coalesced request asks the Coordinator to evaluate again; it never
        // grants acquisition permission. Validate even when a request is queued.
        const delay = slot.recheck ? 0 : at - now;
        this.arm(key, slot, delay);
      } else if (
        (result.kind === "suspended" &&
          ["database_unavailable", "storage_unresolved"].includes(
            result.reason,
          )) ||
        (result.kind === "blocked" &&
          [
            "invalid_recheck_at",
            "integrity_error",
            "schema_incompatible",
            "unexpected_error",
          ].includes(result.reason))
      ) {
        if (result.scope !== "state" && result.scope !== "global")
          throw new Error("Invalid Coordinator scope");
        // Shared Connection / schema failures cannot be localized by a caller.
        if (
          result.scope === "state" &&
          ["database_unavailable", "schema_incompatible"].includes(
            result.reason,
          )
        )
          throw new Error("Invalid Coordinator failure scope");
        this.hold(key, slot, result.scope, result.reason);
      } else {
        throw new Error("Invalid Coordinator result");
      }
    } catch {
      this.hold(key, slot, "global", "unexpected_error");
    } finally {
      slot.inFlight = undefined;
    }
  }

  private hold(
    key: StateKey,
    slot: Slot,
    scope: "state" | "global",
    reason: string,
  ): void {
    if (scope === "global") {
      this.globalHeld = true;
      for (const current of this.slots.values()) this.cancel(current);
    } else {
      slot.held = true;
      this.cancel(slot);
    }
    // Do not log thrown errors, Provider payloads or untrusted recheckAt values.
    // A broken logging destination must not undo the scheduling stop gate.
    try {
      this.logger[scope === "global" ? "error" : "warn"](
        { event: "scheduler_held", stateKey: key, scope, reason },
        "State Scheduler held",
      );
    } catch {
      /* Observability failure does not reopen a held Scheduler. */
    }
  }
}
