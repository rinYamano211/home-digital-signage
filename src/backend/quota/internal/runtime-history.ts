import type Database from "better-sqlite3";
import { validateSchema } from "../../storage/schema.js";
import { ClockTrustMonitor } from "../../send/internal/trust.js";
import {
  QuotaRepository,
  quotaRepositoryOwnsConnection,
  type QuotaAttempt,
  type QuotaReservationResult,
  type QuotaReservationRequest,
} from "../../storage/quota-repository.js";
import { committedStartup } from "../../storage/internal/startup-commit.js";
import { connectionCoordination } from "../../storage/connection-coordination.js";
import {
  inspectProvisioningEvidence,
  inspectDrainEvidence,
  inspectHistoryResume,
  type DrainBoundaryEvidence,
  type HistoryResumeEvidence,
  type RuntimeProvisioningEvidence,
} from "./history-boundaries.js";
import type { HistoryScope, RuntimeValidFacts } from "../history-evaluation.js";
const owners = new WeakSet<Database.Database>();
const identities = new WeakMap<
  RuntimeHistory,
  {
    db: Database.Database;
    repository: QuotaRepository;
    clock: ClockTrustMonitor;
  }
>();
export function runtimeHistoryMatches(
  runtime: RuntimeHistory,
  db: Database.Database,
  repository: QuotaRepository,
  clock: ClockTrustMonitor,
): boolean {
  const r = identities.get(runtime);
  return !!r && r.db === db && r.repository === repository && r.clock === clock;
}
interface Trial {
  epoch: bigint;
  registrationGeneration: bigint;
  checks: number;
  pending: boolean;
}
/** Internal control only; not wired to Runtime Store, Monitor.confirm or Send Gate. */
export class RuntimeHistory {
  private readonly startup;
  private readonly trials = new WeakMap<QuotaAttempt, Trial>();
  private readonly valid = new Map<number, Readonly<RuntimeValidFacts>>();
  private frozen = false;
  private registrationGeneration = 0n;
  private cutoff: number | null;
  private readonly pendingAttempts = new Set<QuotaAttempt>();
  constructor(
    private readonly db: Database.Database,
    private readonly repository: QuotaRepository,
    private readonly clock: ClockTrustMonitor,
    provisioning?: RuntimeProvisioningEvidence,
  ) {
    if (!quotaRepositoryOwnsConnection(repository, db))
      throw new TypeError("Runtime History Connection mismatch");
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
    identities.set(this, { db, repository, clock });
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
    this.registrationGeneration++;
    this.frozen = true;
  }
  isFrozen(): boolean {
    return this.frozen;
  }
  facts(): readonly Readonly<RuntimeValidFacts>[] {
    return Object.freeze([...this.valid.values()]);
  }
  /** Tx-Q persistence and Runtime Valid registration are independent results.
   * saved && !registered establishes no Runtime Valid evidence or send
   * authorization. Never cancel the saved Consumption or blindly reserve again.
   * Neither saved nor registered grants History Trust or permission to send.
   */
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
      this.trials.has(request.attempt) ||
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
      registrationGeneration: this.registrationGeneration,
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
          !this.frozen &&
          trial.registrationGeneration === this.registrationGeneration;
        if (trusted) trial.checks++;
        return {
          ...supplied,
          clockTrusted: supplied.clockTrusted === true && trusted,
        };
      },
    });
    trial.pending =
      reservation.outcome === "unknown" &&
      this.repository.ownsPending(request.attempt);
    if (trial.pending) this.pendingAttempts.add(request.attempt);
    return {
      reservation,
      registered: this.register(reservation, request.attempt),
    };
  }
  /** Freeze prevents registration, not read-only resolution of persisted Tx-Q.
   * A resolved result still grants no authority and never unfreezes this owner.
   * Read-only Tx-Q reconciliation may return saved while registration fails.
   * The same two-result contract as reserve applies; persisted consumption stays.
   */
  reconcile(attempt: QuotaAttempt): {
    reservation: QuotaReservationResult;
    registered: boolean;
  } {
    if (
      connectionCoordination(this.db).busy ||
      !this.ready() ||
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
    if (reservation.outcome !== "unknown") this.pendingAttempts.delete(attempt);
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
        t.registrationGeneration !== this.registrationGeneration ||
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
  /** Only actual owned pending reservations are reconciled; no retry/write. */
  resolvePending(): boolean {
    for (const attempt of this.pendingAttempts) {
      const result = this.reconcile(attempt).reservation;
      if (result.outcome !== "saved" && result.outcome !== "not_saved")
        return false;
    }
    return this.pendingAttempts.size === 0;
  }
  acceptProvisioning(proof: RuntimeProvisioningEvidence): boolean {
    const p = inspectProvisioningEvidence(proof);
    const s = this.scope();
    if (
      !s ||
      s.cutoffSequence !== null ||
      !p ||
      p.cutoffSequence !== 0 ||
      p.providerKey !== s.providerKey ||
      p.generation !== s.generation ||
      p.processInstanceId !== s.processInstanceId
    )
      return false;
    this.cutoff = 0;
    return true;
  }
  discardAffected(proof: DrainBoundaryEvidence): boolean {
    const p = inspectDrainEvidence(proof);
    const s = this.scope();
    if (
      !this.frozen ||
      !p ||
      !s ||
      p.providerKey !== s.providerKey ||
      p.generation !== s.generation ||
      p.processInstanceId !== s.processInstanceId ||
      p.cutoffSequence !== s.cutoffSequence
    )
      return false;
    for (const seq of this.valid.keys())
      if (seq >= p.startSequence && seq <= p.endSequence)
        this.valid.delete(seq);
    return true;
  }
  resumeAfterRecovery(proof: HistoryResumeEvidence): boolean {
    if (!this.frozen || !this.ready() || !inspectHistoryResume(proof, this))
      return false;
    this.frozen = false;
    return true;
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
