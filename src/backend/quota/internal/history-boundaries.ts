import type Database from "better-sqlite3";
import { connectionCoordination } from "../../storage/connection-coordination.js";
import { classifyDatabaseError } from "../../storage/errors.js";
import { validateSchema } from "../../storage/schema.js";
import { committedStartup } from "../../storage/internal/startup-commit.js";
import {
  HistoryRangeRepository,
  inspectConfirmedRange,
  type ConfirmedRangeEvidence,
} from "../../storage/history-range-repository.js";
import type {
  QuotaRepository,
  QuotaReservation,
} from "../../storage/quota-repository.js";
import type { QuotaInspectionResult, QuotaHistory } from "../quota-guard.js";
import { RuntimeHistory, runtimeHistoryMatches } from "./runtime-history.js";
import {
  ProviderSendGate,
  gateHistoryBindingMatches,
  type StopControl,
} from "../../send/internal/provider-send-gate.js";
import type { ClockTrustMonitor } from "../../send/internal/trust.js";
import {
  evaluateHistoryFacts,
  type HistoryEvaluationFacts,
  type ConfirmedRangeFacts,
} from "../history-evaluation.js";
import {
  evaluateConservativeQuota,
  HISTORY_WAIT_MS,
} from "../conservative-quota.js";
import { QUOTA_WINDOWS, quotaWindow } from "./quota-window.js";
import { verifiedWaitReading } from "./wait-clock.js";
import type { HistoryScope } from "../history-evaluation.js";
declare const drainBrand: unique symbol;
declare const waitBrand: unique symbol;
declare const provisioningBrand: unique symbol;
export interface DrainBoundaryEvidence {
  readonly [drainBrand]: true;
}
export interface WindowWaitEvidence {
  readonly [waitBrand]: true;
}
export interface RuntimeProvisioningEvidence {
  readonly [provisioningBrand]: true;
}
export interface DrainBoundary extends HistoryScope {
  readonly startSequence: number;
  readonly endSequence: number;
  readonly lastSequence: number;
}
export interface WindowWait extends HistoryScope {
  readonly rangeId: number | null;
  readonly endSequence: number;
  readonly windowMs: number;
  readonly elapsedNs: bigint;
}

declare const historyBrand: unique symbol;
declare const resumeBrand: unique symbol;
/** Authenticated History input only, never a Send Permit or a quota reservation. */
export interface AuthenticatedHistorySource {
  readonly [historyBrand]: true;
}
export interface HistoryResumeEvidence {
  readonly [resumeBrand]: true;
}
export interface AuthenticatedHistoryAssessment {
  readonly evaluation: "TRUSTED" | "CONSERVATIVE";
  readonly scope: HistoryScope;
}
interface Snapshot {
  facts: HistoryEvaluationFacts;
  ranges: readonly ConfirmedRangeFacts[];
}
interface WaitRecord {
  scope: HistoryScope;
  rangeId: number | null;
  endSequence: number;
  windowMs: number;
  started: bigint;
  continuity: object;
  valid: boolean;
  range?: ConfirmedRangeEvidence;
}
const sources = new WeakMap<AuthenticatedHistorySource, HistoryRecovery>();
const drains = new WeakMap<
  DrainBoundaryEvidence,
  { owner: HistoryRecovery; boundary: DrainBoundary; revision: bigint }
>();
const waits = new WeakMap<
  WindowWaitEvidence,
  { owner: HistoryRecovery; record: WaitRecord }
>();
const provisions = new WeakMap<RuntimeProvisioningEvidence, HistoryRecovery>();
const resumes = new WeakMap<
  HistoryResumeEvidence,
  { owner: HistoryRecovery; revision: bigint }
>();
const opaque = <T>(): T => Object.freeze(Object.create(null)) as T;
const sameScope = (a: HistoryScope, b: HistoryScope) =>
  a.providerKey === b.providerKey &&
  a.generation === b.generation &&
  a.processInstanceId === b.processInstanceId &&
  a.cutoffSequence === b.cutoffSequence;
const safeInteger = (v: unknown): number => {
  if (typeof v !== "bigint" || v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER))
    throw Error("Invalid History integer");
  return Number(v);
};
export function historySourceBelongsTo(
  source: AuthenticatedHistorySource,
  repository: QuotaRepository,
): boolean {
  return sources.get(source)?.repository === repository;
}
/** Pre-BEGIN interlock only; the Quota owner already holds busy here. No
 * classification/allow result is cached, and the Tx must still re-read all rows.
 */
export function authenticatedReservationReady(
  source: AuthenticatedHistorySource,
  repository: QuotaRepository,
): boolean {
  const owner = sources.get(source);
  return owner?.repository === repository && owner.reservationReady();
}
export function inspectAuthenticatedHistory(
  source: AuthenticatedHistorySource,
  repository: QuotaRepository,
  reservation?: QuotaReservation,
): AuthenticatedHistoryAssessment | null {
  const owner = sources.get(source);
  try {
    return owner?.repository === repository
      ? owner.assessForGate(reservation)
      : null;
  } catch {
    return null;
  }
}
/** Called by the existing Tx-Q with the History it just read under BEGIN IMMEDIATE.
 * Source identity is authenticated; the owner re-reads actual Range/Scope/Valid and
 * evaluates every consumption. No cached allow decision or boolean is accepted.
 */
export function evaluateAuthenticatedQuota(
  source: AuthenticatedHistorySource,
  repository: QuotaRepository,
  history: QuotaHistory,
  now: number,
): QuotaInspectionResult {
  const owner = sources.get(source);
  return owner?.repository === repository
    ? owner.assessForReservation(history, now)
    : { allowed: false, reason: "history_source_unverified" };
}
export function inspectDrainEvidence(
  proof: DrainBoundaryEvidence,
): DrainBoundary | null {
  const record = drains.get(proof);
  return record &&
    record.owner.drainStillValid(record.boundary, record.revision)
    ? record.boundary
    : null;
}
export function inspectWaitEvidence(
  proof: WindowWaitEvidence,
): WindowWait | null {
  const record = waits.get(proof);
  return record ? record.owner.inspectWait(record.record) : null;
}
export function inspectProvisioningEvidence(
  proof: RuntimeProvisioningEvidence,
): HistoryScope | null {
  const owner = provisions.get(proof);
  return owner?.provisioningScope() ?? null;
}
export function inspectHistoryResume(
  proof: HistoryResumeEvidence,
  runtime: RuntimeHistory,
): boolean {
  const record = resumes.get(proof);
  resumes.delete(proof); // one attempt, including failed/reentrant consumption
  return (
    !!record &&
    record.owner.runtime === runtime &&
    record.owner.resumeStillValid(record.revision)
  );
}
/** Dedicated 4B-3 internal control. No OS/HTTP/Scheduler/startBackend wiring.
 * All authorities originate here from actual Gate/Connection/Startup/Transaction
 * facts. The old HistoryTrustMonitor is neither modified nor confirmed here.
 */
export class HistoryRecovery {
  readonly source = opaque<AuthenticatedHistorySource>();
  private readonly startup: ReturnType<typeof committedStartup>;
  private readonly stop: StopControl;
  private readonly ranges: HistoryRangeRepository;
  private closed = true;
  private drained = false;
  private revision = 0n;
  private resuming = false;
  private affectedAfter: number;
  private resumeLastSequence = 0;
  private readonly rangeProofs = new Map<number, ConfirmedRangeEvidence>();
  private readonly waitRecords: WaitRecord[] = [];
  private lastMono?: bigint;
  private continuity?: object;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly db: Database.Database,
    readonly repository: QuotaRepository,
    readonly runtime: RuntimeHistory,
    private readonly gate: ProviderSendGate,
    private readonly clock: ClockTrustMonitor,
  ) {
    this.startup = committedStartup(db);
    if (
      !this.startup ||
      !runtimeHistoryMatches(runtime, db, repository, clock) ||
      !gateHistoryBindingMatches(
        gate,
        this.startup.scope.providerKey,
        repository,
        clock,
      )
    )
      throw Error("History Recovery scope unavailable");
    this.affectedAfter = runtime.effectiveCutoff() ?? 0;
    this.stop = gate.stopControl(this.startup.scope.providerKey);
    this.stop.stop();
    runtime.freeze();
    this.ranges = new HistoryRangeRepository(db, runtime);
    sources.set(this.source, this);
    repository.bindHistorySource(this.source);
    gate.bindHistorySource(this.startup.scope.providerKey, this.source);
    this.unsubscribe = clock.subscribe(() => this.suspend());
  }
  suspend(): void {
    // No await: the independent Recovery reason precedes any cleanup/re-entry.
    this.closed = true;
    this.drained = false;
    this.revision++;
    try {
      this.stop.stop();
    } finally {
      this.runtime.freeze();
    }
  }
  dispose(): void {
    this.suspend();
    this.unsubscribe();
  }
  private scope(): HistoryScope | null {
    return committedStartup(this.db) === this.startup &&
      this.runtime.scope() &&
      this.startup
      ? this.startup.scope
      : null;
  }
  /** A DB empty image cannot manufacture F-01 confirmation. Only the existing
   * Repository's private post-COMMIT receipt can establish Runtime cutoff zero.
   */
  provisioningScope(): HistoryScope | null {
    const scope = this.scope();
    return scope?.cutoffSequence === null &&
      this.repository.hasConfirmedProvisioning(scope.providerKey)
      ? { ...scope, cutoffSequence: 0 }
      : null;
  }
  confirmRuntimeProvisioning(): RuntimeProvisioningEvidence | null {
    if (!this.provisioningScope()) return null;
    const proof = opaque<RuntimeProvisioningEvidence>();
    provisions.set(proof, this);
    return this.runtime.acceptProvisioning(proof) ? proof : null;
  }
  private snapshot(history?: QuotaHistory): Snapshot | null {
    const c = connectionCoordination(this.db);
    if (!this.scope() || c.blocked || c.connectionUnresolved || !this.db.open)
      return null;
    const borrowed = c.busy;
    let began = false;
    try {
      if (
        borrowed
          ? this.db.inTransaction !== true
          : this.db.inTransaction !== false
      )
        return null;
      if (!borrowed) {
        c.busy = true;
        this.db.exec("BEGIN");
        began = true;
      }
      validateSchema(this.db, 3);
      const scope = this.scope();
      if (!scope) throw Error("History Scope changed");
      const actual = this.repository.historyWithinTransaction(
        scope.providerKey,
      );
      if (history && JSON.stringify(history) !== JSON.stringify(actual))
        throw Error("History changed");
      for (const table of [
        "provider_quota_metadata",
        "provider_quota_consumptions",
        "startup_provider_boundaries",
        "history_uncertain_ranges",
      ]) {
        const keys = this.db
          .prepare(`SELECT DISTINCT provider_key FROM ${table}`)
          .all() as { provider_key: unknown }[];
        if (keys.some((row) => row.provider_key !== scope.providerKey))
          throw Error("Provider mismatch");
      }
      const rows = this.db
        .prepare(
          "SELECT range_id,start_sequence,end_sequence FROM history_uncertain_ranges WHERE provider_key=? AND generation=? ORDER BY range_id",
        )
        .safeIntegers(true)
        .all(scope.providerKey, scope.generation) as Record<string, unknown>[];
      const ranges = rows.map((row) =>
        Object.freeze({
          ...scope,
          rangeId: safeInteger(row.range_id),
          startSequence: safeInteger(row.start_sequence),
          endSequence: safeInteger(row.end_sequence),
          committed: true,
        }),
      );
      const complete =
        !!actual.metadata &&
        actual.metadata.lastSequence === actual.consumptions.length &&
        actual.consumptions.every((r, i) => r.sequence === i + 1);
      const facts: HistoryEvaluationFacts = {
        scope,
        boundary: {
          ...scope,
          startupOutcome: "committed",
          providerState:
            scope.cutoffSequence === null ? "UNPROVISIONED" : "PROVISIONED",
        },
        history: actual,
        historyComplete: complete,
        valid: this.runtime.facts(),
        ranges,
        ...(scope.cutoffSequence === null &&
        this.runtime.effectiveCutoff() === 0 &&
        this.provisioningScope()
          ? {
              runtimeProvisioning: {
                ...scope,
                cutoffSequence: 0 as const,
                committed: true,
              },
            }
          : {}),
      };
      if (began) {
        this.db.exec("COMMIT");
        began = false;
        if (this.db.inTransaction !== false)
          throw Error("History read unresolved");
      }
      return { facts, ranges };
    } catch (error) {
      if (borrowed) throw error;
      if (!borrowed) {
        let cleanupFailed = false;
        try {
          const active = this.db.inTransaction;
          if (active !== false && active !== true)
            c.connectionUnresolved = true;
          if (active === true) {
            try {
              this.db.exec("ROLLBACK");
            } catch {
              cleanupFailed = true;
            }
          }
          if (this.db.inTransaction !== false) c.connectionUnresolved = true;
        } catch {
          c.connectionUnresolved = true;
        }
        let problem;
        try {
          problem = classifyDatabaseError(error);
        } catch {
          problem = { layer: "L4" as const, reason: "history_read_failed" };
        }
        if (problem.layer === "L3" || problem.layer === "L4")
          c.blocked = {
            scope: "database",
            layer: problem.layer,
            reason: problem.reason,
          };
        if ((cleanupFailed || c.connectionUnresolved) && !c.blocked)
          c.blocked = {
            scope: "database",
            layer: "L4",
            reason: "history_cleanup_failed",
          };
      }
      return null;
    } finally {
      if (!borrowed) c.busy = false;
    }
  }
  drainStillValid(boundary: DrainBoundary, revision: bigint): boolean {
    const c = connectionCoordination(this.db);
    const scope = this.scope();
    if (
      !scope ||
      !sameScope(scope, boundary) ||
      revision !== this.revision ||
      !this.closed ||
      !this.runtime.isFrozen() ||
      !this.repository.isDrained() ||
      c.blocked ||
      c.connectionUnresolved
    )
      return false;
    const flight = this.gate.snapshot(scope.providerKey);
    if (!flight.stopped || flight.phase !== "IDLE" || flight.repositoryFailure)
      return false;
    const snapshot = this.snapshot();
    if (
      !snapshot ||
      revision !== this.revision ||
      snapshot.facts.history.metadata?.lastSequence !== boundary.lastSequence
    )
      return false;
    const structural = evaluateHistoryFacts({
      ...snapshot.facts,
      // The affected facts are about to become uncertain, so only the retained
      // trusted prefix participates in Timestamp validation at this boundary.
      valid: snapshot.facts.valid.filter(
        (r) => r.sequence < boundary.startSequence,
      ),
    });
    return (
      structural.evaluation !== "BLOCKED" ||
      structural.reason === "classification_gap"
    );
  }
  /** Saved/not_saved resolution is independent of Valid registration while frozen. */
  drainAndClassify(): boolean {
    if (
      !this.closed ||
      !this.runtime.isFrozen() ||
      !this.runtime.resolvePending()
    )
      return false;
    const snapshot = this.snapshot();
    const cutoff = this.runtime.effectiveCutoff();
    const last = snapshot?.facts.history.metadata?.lastSequence;
    if (
      !snapshot ||
      cutoff === null ||
      last === undefined ||
      !this.repository.isDrained()
    )
      return false;
    const boundary: DrainBoundary = Object.freeze({
      ...snapshot.facts.scope,
      startSequence: this.affectedAfter + 1,
      endSequence: last,
      lastSequence: last,
    });
    if (!this.drainStillValid(boundary, this.revision)) return false;
    // No last-trusted checkpoint is claimed: conservatively invalidate all
    // current-process Valid facts. Preserve existing immutable Range boundaries.
    const discard = opaque<DrainBoundaryEvidence>();
    drains.set(discard, { owner: this, boundary, revision: this.revision });
    if (!this.runtime.discardAffected(discard)) return false;
    const candidates: {
      rangeId: number;
      startSequence: number;
      endSequence: number;
    }[] = [];
    const remaining = new Set(this.runtime.facts().map((row) => row.sequence));
    for (const range of snapshot.ranges)
      for (let seq = range.startSequence; seq <= range.endSequence; seq++)
        remaining.add(seq);
    let id = snapshot.ranges.at(-1)?.rangeId ?? 0;
    for (let seq = cutoff + 1; seq <= last; seq++) {
      if (remaining.has(seq)) continue;
      const start = seq;
      while (seq < last && !remaining.has(seq + 1)) seq++;
      if (
        start <= this.affectedAfter ||
        start <= (snapshot.ranges.at(-1)?.endSequence ?? cutoff)
      )
        return false;
      candidates.push({
        rangeId: ++id,
        startSequence: start,
        endSequence: seq,
      });
    }
    if (candidates.length) {
      const proofs = candidates.map((candidate) => {
        const proof = opaque<DrainBoundaryEvidence>();
        drains.set(proof, {
          owner: this,
          boundary: Object.freeze({ ...boundary, ...candidate }),
          revision: this.revision,
        });
        return proof;
      });
      // Current recovery interval is a suffix after the previous confirmed
      // recovery checkpoint. Do not merge/rewrite older ranges to fill gaps.
      if (candidates.length !== 1) return false;
      const result = this.ranges.insert(candidates[0], proofs[0]);
      if (result.outcome !== "saved") return false;
      const range = inspectConfirmedRange(result.evidence);
      if (!range) return false;
      this.rangeProofs.set(range.rangeId, result.evidence);
    }
    const current = this.snapshot();
    if (
      !current ||
      evaluateHistoryFacts(current.facts).evaluation === "BLOCKED"
    )
      return false;
    this.drained = true;
    this.startWaits(current);
    return true;
  }
  private monotonic(): { nowNs: bigint; continuity: object } | null {
    try {
      const value = verifiedWaitReading();
      if (
        !value ||
        typeof value.nowNs !== "bigint" ||
        value.nowNs < 0n ||
        !value.continuity ||
        typeof value.continuity !== "object" ||
        (this.continuity &&
          (value.continuity !== this.continuity ||
            (this.lastMono !== undefined && value.nowNs < this.lastMono)))
      )
        throw Error("Wait clock unverified");
      this.lastMono = value.nowNs;
      this.continuity = value.continuity;
      return value;
    } catch {
      for (const record of this.waitRecords) record.valid = false;
      this.lastMono = undefined;
      this.continuity = undefined;
      return null;
    }
  }
  private startWaits(snapshot: Snapshot): void {
    const time = this.monotonic();
    if (!time) return;
    for (let i = this.waitRecords.length - 1; i >= 0; i--)
      if (!this.waitRecords[i].valid) this.waitRecords.splice(i, 1);
    const targets = [
      {
        rangeId: null as number | null,
        endSequence: this.runtime.effectiveCutoff()!,
      },
      ...snapshot.ranges.map((range) => ({
        rangeId: range.rangeId,
        endSequence: range.endSequence,
      })),
    ];
    for (const target of targets)
      for (const window of QUOTA_WINDOWS) {
        if (
          this.waitRecords.some(
            (r) =>
              r.valid &&
              r.rangeId === target.rangeId &&
              r.endSequence === target.endSequence &&
              r.windowMs === window.widthMs,
          )
        )
          continue;
        const range =
          target.rangeId === null
            ? undefined
            : this.rangeProofs.get(target.rangeId);
        if (
          target.rangeId !== null &&
          (!range || !inspectConfirmedRange(range))
        )
          continue;
        this.waitRecords.push({
          ...snapshot.facts.scope,
          scope: snapshot.facts.scope,
          ...target,
          windowMs: window.widthMs,
          started: time.nowNs,
          continuity: time.continuity,
          valid: true,
          range,
        });
      }
  }
  inspectWait(record: WaitRecord): WindowWait | null {
    const time = this.monotonic();
    const scope = this.scope();
    if (
      !time ||
      !scope ||
      !record.valid ||
      !sameScope(scope, record.scope) ||
      time.continuity !== record.continuity ||
      time.nowNs < record.started
    )
      return null;
    if (record.range && !inspectConfirmedRange(record.range)) {
      record.valid = false;
      return null;
    }
    return {
      ...scope,
      rangeId: record.rangeId,
      endSequence: record.endSequence,
      windowMs: record.windowMs,
      elapsedNs: time.nowNs - record.started,
    };
  }
  private waitTokens(snapshot: Snapshot): readonly WindowWaitEvidence[] {
    this.startWaits(snapshot);
    return this.waitRecords
      .filter((r) => r.valid)
      .map((record) => {
        const token = opaque<WindowWaitEvidence>();
        waits.set(token, { owner: this, record });
        return token;
      });
  }
  waitEvidence(): readonly WindowWaitEvidence[] {
    if (!this.drained) return [];
    const snapshot = this.snapshot();
    return snapshot ? this.waitTokens(snapshot) : [];
  }
  private assessment(snapshot: Snapshot, now: number) {
    return evaluateConservativeQuota(
      snapshot.facts,
      now,
      this.drained ? this.waitTokens(snapshot) : [],
    );
  }
  assessForGate(
    reservation?: QuotaReservation,
  ): AuthenticatedHistoryAssessment | null {
    if (
      this.closed ||
      this.runtime.isFrozen() ||
      this.clock.state() !== "TRUSTED"
    )
      return null;
    const revision = this.revision;
    const snapshot = this.snapshot();
    if (!snapshot) return null;
    const model = evaluateHistoryFacts(snapshot.facts);
    if (
      model.evaluation === "BLOCKED" ||
      this.assessment(snapshot, Date.now()).evaluation === "BLOCKED"
    )
      return null;
    if (
      reservation &&
      (!sameScope(snapshot.facts.scope, this.startup!.scope) ||
        reservation.providerKey !== snapshot.facts.scope.providerKey ||
        !snapshot.facts.valid.some(
          (v) =>
            v.sequence === reservation.sequence &&
            v.reservedAtMs === reservation.reservedAtMs,
        ))
    )
      return null;
    if (
      this.clock.state() !== "TRUSTED" ||
      this.closed ||
      this.runtime.isFrozen() ||
      revision !== this.revision
    )
      return null;
    return Object.freeze({
      evaluation: model.evaluation,
      scope: snapshot.facts.scope,
    });
  }
  reservationReady(): boolean {
    return (
      !this.closed &&
      !this.runtime.isFrozen() &&
      !!this.scope() &&
      this.clock.state() === "TRUSTED" &&
      this.gate.historyInterlock(this.startup!.scope.providerKey)
    );
  }
  assessForReservation(
    history: QuotaHistory,
    now: number,
  ): QuotaInspectionResult {
    const c = connectionCoordination(this.db);
    if (
      !c.busy ||
      this.db.inTransaction !== true ||
      this.closed ||
      this.runtime.isFrozen() ||
      this.clock.state() !== "TRUSTED" ||
      !this.gate.historyInterlock(this.startup!.scope.providerKey)
    )
      return { allowed: false, reason: "history_or_recovery_unverified" };
    const snapshot = this.snapshot(history);
    if (!snapshot || history.metadata?.lastSequence === Number.MAX_SAFE_INTEGER)
      return { allowed: false, reason: "history_unverified" };
    const result = this.assessment(snapshot, now);
    if (result.evaluation === "BLOCKED")
      return { allowed: false, reason: result.reason };
    if (result.evaluation === "WITHIN_LIMIT")
      return this.reservationReady()
        ? { allowed: true, reason: "authenticated_history_available" }
        : { allowed: false, reason: "history_or_recovery_unverified" };
    // A uses only trusted Valid expiry while retaining the full conservative
    // contribution. If that contribution alone exhausts a Window, use B/C.
    const model = evaluateHistoryFacts(snapshot.facts);
    if (model.evaluation === "BLOCKED")
      return { allowed: false, reason: model.reason };
    let recheckAtMs = 0;
    for (const w of QUOTA_WINDOWS) {
      const count = result.windows.find((x) => x.widthMs === w.widthMs)!.count;
      const valid = quotaWindow(model.classification.newValid, now, w);
      if (count >= w.limit) {
        const usage = quotaWindow(
          model.classification.newValid,
          now,
          w,
          count - valid.count,
        );
        if (usage.releaseAtMs === undefined)
          return { allowed: false, reason: "conservative_quota_exhausted" };
        recheckAtMs = Math.max(recheckAtMs, usage.releaseAtMs);
      }
    }
    return {
      allowed: false,
      reason: "quota_exhausted",
      ...(recheckAtMs ? { recheckAtMs } : {}),
    };
  }
  resumeStillValid(revision = this.revision): boolean {
    if (
      revision !== this.revision ||
      !this.resuming ||
      !this.closed ||
      !this.drained ||
      !this.repository.isDrained() ||
      this.clock.state() !== "TRUSTED"
    )
      return false;
    const snapshot = this.snapshot();
    if (!snapshot) return false;
    if (this.assessment(snapshot, Date.now()).evaluation !== "WITHIN_LIMIT")
      return false;
    this.resumeLastSequence = snapshot.facts.history.metadata!.lastSequence;
    return (
      this.clock.state() === "TRUSTED" &&
      revision === this.revision &&
      this.closed &&
      this.drained
    );
  }
  /** Recovery candidate only; every independent Gate/Tx-Q condition still applies.
   * In particular, no old Monitor TRUSTED value is synthesized for CONSERVATIVE.
   */
  recover(): boolean {
    if (!this.closed) return this.assessForGate() !== null;
    if (!this.drained && !this.drainAndClassify()) return false;
    const revision = this.revision;
    this.resuming = true;
    try {
      if (!this.resumeStillValid()) return false;
      const proof = opaque<HistoryResumeEvidence>();
      resumes.set(proof, { owner: this, revision });
      if (!this.runtime.resumeAfterRecovery(proof)) return false;
      // No await. A synchronous Clock recheck may suspend/freeze us again.
      if (
        this.clock.state() !== "TRUSTED" ||
        this.runtime.isFrozen() ||
        revision !== this.revision
      )
        return false;
      this.affectedAfter = this.resumeLastSequence;
      this.closed = false;
      this.stop.release();
      return true;
    } finally {
      this.resuming = false;
    }
  }
  /** Only the History portion of CLEAN eligibility; never permission to update
   * Lifecycle. CONSERVATIVE remains ineligible even when sending is possible.
   */
  historyCleanEligible(): boolean {
    return this.assessForGate()?.evaluation === "TRUSTED";
  }
  /** C is intentionally supplied by internal integration, never defaulted to 5m.
   * This hint schedules assessment only. It cannot start a Tx-Q or HTTP request.
   */
  recheckHint(): { waitAtNs?: bigint; periodicRequired: boolean } {
    if (!this.drained) return { periodicRequired: true };
    const snapshot = this.snapshot();
    if (!snapshot) return { periodicRequired: true };
    this.startWaits(snapshot);
    const time = this.monotonic();
    if (!time) return { periodicRequired: true };
    const deadlines = this.waitRecords
      .filter((r) => r.valid)
      .map(
        (r) =>
          r.started +
          BigInt(HISTORY_WAIT_MS[r.windowMs as keyof typeof HISTORY_WAIT_MS]) *
            1000000n,
      )
      .filter((t) => t > time.nowNs);
    return deadlines.length
      ? {
          waitAtNs: deadlines.reduce((a, b) => (a < b ? a : b)),
          periodicRequired: false,
        }
      : { periodicRequired: true };
  }
}
