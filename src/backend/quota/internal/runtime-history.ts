import type Database from "better-sqlite3";
import { validateSchema } from "../../storage/schema.js";
import { ClockTrustMonitor } from "../../send/internal/trust.js";
import {
  QuotaRepository,
  type QuotaAttempt,
  type QuotaReservationResult,
  type QuotaReservationRequest,
} from "../../storage/quota-repository.js";
import { committedStartup } from "../../storage/internal/startup-commit.js";
import { connectionCoordination } from "../../storage/connection-coordination.js";
import {
  inspectProvisioningEvidence,
  type RuntimeProvisioningEvidence,
} from "./history-boundaries.js";
import type { HistoryScope, RuntimeValidFacts } from "../history-evaluation.js";
const owners = new WeakSet<Database.Database>();
interface Trial {
  epoch: bigint;
  checks: number;
  pending: boolean;
}
/** Internal control only; not wired to Runtime Store, Monitor.confirm or Send Gate. */
export class RuntimeHistory {
  private readonly startup;
  private readonly trials = new WeakMap<QuotaAttempt, Trial>();
  private readonly valid = new Map<number, Readonly<RuntimeValidFacts>>();
  private frozen = false;
  private readonly cutoff: number | null;
  constructor(
    private readonly db: Database.Database,
    private readonly repository: QuotaRepository,
    private readonly clock: ClockTrustMonitor,
    provisioning?: RuntimeProvisioningEvidence,
  ) {
    if (owners.has(db)) throw new TypeError("Runtime History already owned");
    owners.add(db);
    this.startup = committedStartup(db);
    this.cutoff = this.startup?.scope.cutoffSequence ?? null;
    if (this.startup && this.cutoff === null && provisioning) {
      const p = inspectProvisioningEvidence(provisioning);
      const s = this.startup.scope;
      if (
        p &&
        p.providerKey === s.providerKey &&
        p.generation === s.generation &&
        p.processInstanceId === s.processInstanceId &&
        p.cutoffSequence === 0
      )
        this.cutoff = 0;
    }
  }
  scope(): HistoryScope | null {
    return this.ready() ? this.startup!.scope : null;
  }
  historyWithinTransaction() {
    if (!this.ready()) throw new Error("Runtime history unavailable");
    return this.repository.historyWithinTransaction(
      this.startup!.scope.providerKey,
    );
  }
  effectiveCutoff(): number | null {
    return this.ready() ? this.cutoff : null;
  }
  belongsToConnection(db: Database.Database): boolean {
    return db === this.db && this.repository.belongsToConnection(db);
  }
  freeze(): void {
    this.frozen = true;
  }
  isFrozen(): boolean {
    return this.frozen;
  }
  facts(): readonly Readonly<RuntimeValidFacts>[] {
    return Object.freeze([...this.valid.values()]);
  }
  reserve(request: QuotaReservationRequest): {
    reservation: QuotaReservationResult;
    registered: boolean;
  } {
    if (
      connectionCoordination(this.db).busy ||
      !this.ready() ||
      this.frozen ||
      this.cutoff === null ||
      request.providerKey !== this.startup!.scope.providerKey ||
      this.clock.state() !== "TRUSTED"
    )
      return {
        reservation: {
          outcome: "quota_blocked",
          reason: "runtime_history_unverified",
        },
        registered: false,
      };
    const trial: Trial = {
      epoch: this.clock.epoch(),
      checks: 0,
      pending: false,
    };
    this.trials.set(request.attempt, trial);
    const reservation = this.repository.reserve({
      ...request,
      trust: () => {
        const supplied = request.trust();
        const trusted =
          this.clock.state() === "TRUSTED" &&
          this.clock.epoch() === trial.epoch &&
          !this.frozen;
        if (trusted) trial.checks++;
        return {
          ...supplied,
          clockTrusted: supplied.clockTrusted === true && trusted,
        };
      },
    });
    trial.pending = reservation.outcome === "unknown";
    return {
      reservation,
      registered: this.register(reservation, request.attempt),
    };
  }
  reconcile(attempt: QuotaAttempt): {
    reservation: QuotaReservationResult;
    registered: boolean;
  } {
    if (
      connectionCoordination(this.db).busy ||
      !this.ready() ||
      this.frozen ||
      this.trials.get(attempt)?.pending !== true
    )
      return {
        reservation: {
          outcome: "unknown",
          scope: "provider",
          reason: "runtime_history_unverified",
        },
        registered: false,
      };
    const reservation = this.repository.reconcile(
      this.startup!.scope.providerKey,
    );
    this.trials.get(attempt)!.pending = reservation.outcome === "unknown";
    return { reservation, registered: this.register(reservation, attempt) };
  }
  register(result: QuotaReservationResult, attempt: QuotaAttempt): boolean {
    try {
      const t = this.trials.get(attempt);
      if (
        connectionCoordination(this.db).busy ||
        !this.ready() ||
        this.frozen ||
        this.cutoff === null ||
        result.outcome !== "saved" ||
        !t ||
        t.checks < 2 ||
        this.clock.state() !== "TRUSTED" ||
        this.clock.epoch() !== t.epoch
      )
        return false;
      const r = this.repository.inspectReservation(result.evidence, attempt);
      if (
        !r ||
        r.providerKey !== this.startup!.scope.providerKey ||
        r.sequence <= this.cutoff ||
        this.valid.has(r.sequence)
      )
        return false;
      const c = connectionCoordination(this.db);
      if (c.busy || this.db.inTransaction !== false) return false;
      validateSchema(this.db, 3);
      const row = this.db
        .prepare(
          "SELECT reserved_at_ms FROM provider_quota_consumptions WHERE provider_key=? AND sequence=?",
        )
        .safeIntegers(true)
        .get(r.providerKey, r.sequence) as
        { reserved_at_ms: unknown } | undefined;
      if (row?.reserved_at_ms !== BigInt(r.reservedAtMs)) return false;
      // No await: final epoch validation, insertion and return are synchronous.
      if (
        this.clock.state() !== "TRUSTED" ||
        this.clock.epoch() !== t.epoch ||
        this.frozen
      )
        return false;
      const ranges = this.db
        .prepare(
          "SELECT 1 FROM history_uncertain_ranges WHERE provider_key=? AND generation=? AND start_sequence<=? AND end_sequence>=?",
        )
        .get(
          r.providerKey,
          this.startup!.scope.generation,
          r.sequence,
          r.sequence,
        );
      if (
        ranges ||
        this.clock.state() !== "TRUSTED" ||
        this.clock.epoch() !== t.epoch ||
        this.frozen
      )
        return false;
      this.valid.set(
        r.sequence,
        Object.freeze({
          ...this.startup!.scope,
          sequence: r.sequence,
          reservedAtMs: r.reservedAtMs,
          reservationOutcome: "saved",
          clockTrustedAtReservation: true,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }
  private ready(): boolean {
    try {
      return (
        !!this.startup &&
        this.repository.belongsToConnection(this.db) &&
        committedStartup(this.db) === this.startup
      );
    } catch {
      return false;
    }
  }
}
