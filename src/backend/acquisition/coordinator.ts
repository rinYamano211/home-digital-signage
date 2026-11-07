import { TOMORROW_IO } from "../quota/quota-guard.js";
import { createHttpAdapter } from "../http/native-http-adapter.js";
import type { HttpAdapterConfig, HttpOutcome } from "../http/outcome.js";
import type { HttpStartAdapter } from "../send/internal/provider-send-gate.js";
import type { RuntimeSend } from "../send/provider-send-gate.js";
import type { RuntimeStoreAccess } from "../storage/store.js";
import type { StateKey } from "../storage/published-state-repository.js";
import type {
  AcquisitionCoordinator,
  RunOnceResult,
} from "../scheduler/state-scheduler.js";
import {
  publishedStateValidator,
  type PublishedState,
} from "../published-state-api.js";
import {
  ConservativeControlWait,
  nextControlState,
  type AcquisitionControlState,
  type AcquisitionOutcome,
} from "./control-state.js";
import { utcInstant } from "../time/utc-instant.js";

/** Domain-owned acquisition definition (Weather / Schedule Services).
 * `quota` is true only for Tomorrow.io: it then goes through the Send Gate and
 * Tx-Q, and its `http` configuration is bound to the Gate's adapter.
 */
interface ProviderTiming {
  readonly stateKey: StateKey;
  readonly periodMs: number;
  /** Optional success period from the attempt start (epoch ms), e.g. capped at
   * the next JST midnight (technology-stack 18.7). Only a smaller positive
   * integer than `periodMs` takes effect; Backoff is never changed.
   */
  nextPeriodMs?(startedAtMs: number): number;
}
/** Single-HTTP Provider: one fixed GET, then `parse()`. */
export interface StateProvider extends ProviderTiming {
  readonly quota: boolean;
  readonly http: HttpAdapterConfig;
  parse(
    outcome: HttpOutcome,
  ):
    | { kind: "success"; data: Record<string, unknown>; expiresAt: string }
    | { kind: "failure" };
}
export interface AcquireContext {
  /** Attempt start (UTC RFC 3339), fixed before any HTTP. */
  readonly startedAt: string;
  /** Aborted at Shutdown; checked by the Provider after every await. */
  readonly signal: AbortSignal;
  /** All HTTP goes through the common Adapter (Timeout / Body limit). */
  http(config: HttpAdapterConfig): Promise<HttpOutcome>;
}
export type AcquireResult =
  | { kind: "success"; data: Record<string, unknown>; expiresAt: string }
  /** Status / Retry-After of the failing Request feed the 429 Backoff. */
  | { kind: "failure"; httpStatus?: number; retryAfter?: string }
  /** Result is not adopted (e.g. the target date rolled forward): no Tx-A /
   * Tx-P, the Control State is unchanged, and the Coordinator re-evaluates.
   */
  | { kind: "discard" };
/** Multi-HTTP Provider (Issue #10): owns one whole attempt (authentication,
 * paging). Quota Providers are excluded: the Send Gate allows one HTTP per
 * reservation. It never touches the DB.
 */
export interface MultiHttpProvider extends ProviderTiming {
  readonly quota: false;
  acquire(context: AcquireContext): Promise<AcquireResult>;
}
export type AcquisitionProvider = StateProvider | MultiHttpProvider;
const isMulti = (p: AcquisitionProvider): p is MultiHttpProvider =>
  "acquire" in p;
const NO_PROVIDER_RECHECK_MS = 60 * 60 * 1000;
const SUPPRESSED_RECHECK_MS = 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const scheduled = (atMs: number): RunOnceResult => ({
  kind: "scheduled",
  recheckAt: iso(Math.max(atMs, Date.now() + 1000)),
});
/** Success period: `nextPeriodMs` may only shorten `periodMs` (18.7). */
function period(provider: ProviderTiming, startedAtMs: number): number {
  let value: number;
  try {
    value = provider.nextPeriodMs?.(startedAtMs) ?? provider.periodMs;
  } catch {
    return provider.periodMs;
  }
  return Number.isSafeInteger(value) && value > 0 && value < provider.periodMs
    ? value
    : provider.periodMs;
}
const unresolved = (scope: "state" | "global"): RunOnceResult => ({
  kind: "suspended",
  scope,
  reason: "storage_unresolved",
});
const databaseFailure = (layer?: string): RunOnceResult =>
  layer === "L1" || layer === "L2"
    ? { kind: "suspended", scope: "global", reason: "database_unavailable" }
    : { kind: "blocked", scope: "global", reason: "integrity_error" };
type SaveOutcome =
  | { outcome: "saved" | "unchanged" }
  | { outcome: "not_saved"; scope: string; layer?: string }
  | { outcome: "unknown"; scope: "state" | "database" };
/** Shared mapping for Tx-A / Tx-P results; null means persisted. */
function saveFailure(result: SaveOutcome): RunOnceResult | null {
  if (result.outcome === "unknown")
    return unresolved(result.scope === "state" ? "state" : "global");
  if (result.outcome !== "not_saved") return null;
  return result.scope === "database"
    ? databaseFailure(result.layer)
    : { kind: "blocked", scope: "state", reason: "integrity_error" };
}

/** C-Impl-5C MVP: one evaluation cycle per State (technology-stack PR-C
 * completion plan). Control read → period/Backoff → Tomorrow.io Gate/Tx-Q or
 * direct HTTP → classification → Tx-A → normal Tx-P. Pending, Tx-C and full
 * commit-unknown reconciliation belong to PR-D; repairs belong to PR-E.
 */
export class StateAcquisitionCoordinator implements AcquisitionCoordinator {
  private readonly providers = new Map<StateKey, AcquisitionProvider>();
  private readonly adapters = new Map<StateKey, HttpStartAdapter>();
  private readonly wait = new ConservativeControlWait();
  private readonly stopping = new AbortController();
  constructor(
    private readonly store: RuntimeStoreAccess,
    private readonly send: RuntimeSend | null,
    providers: readonly AcquisitionProvider[],
  ) {
    for (const provider of providers) {
      if (this.providers.has(provider.stateKey))
        throw new TypeError("Duplicate State Provider");
      if (isMulti(provider) && provider.quota !== false)
        throw new TypeError("Quota Providers must be single-HTTP");
      this.providers.set(provider.stateKey, provider);
    }
  }
  /** Shutdown: abort in-flight non-quota HTTP before the Scheduler is awaited
   * (technology-stack 18.7). Aborted attempts save nothing and are final.
   */
  abort(): void {
    this.stopping.abort();
  }
  async runOnce(stateKey: StateKey): Promise<RunOnceResult> {
    // After abort() the Scheduler is stopping and ignores results; holding is
    // the fail-closed answer if it were not.
    if (this.stopping.signal.aborted) return unresolved("global");
    const provider = this.providers.get(stateKey);
    if (!provider) return scheduled(Date.now() + NO_PROVIDER_RECHECK_MS);
    const control = this.store.acquisitionControl;
    let attempt;
    try {
      attempt = control.context.beginAttempt(stateKey);
    } catch {
      return unresolved("global"); // Shutdown or blocked writes
    }
    try {
      return await this.cycle(provider, stateKey);
    } finally {
      control.context.endAttempt(attempt);
    }
  }
  private async cycle(
    provider: AcquisitionProvider,
    key: StateKey,
  ): Promise<RunOnceResult> {
    const control = this.store.acquisitionControl;
    const read = control.read(key);
    if (read.outcome === "pending") return unresolved("state");
    if (read.outcome === "database_error") return databaseFailure(read.layer);
    // Simplification approved for the MVP: hold the State at once (PR-E repairs).
    if (read.outcome === "invalid")
      return { kind: "blocked", scope: "state", reason: "integrity_error" };
    // Before any HTTP: an unreadable Snapshot is never treated as "no data".
    const published = this.published(key);
    if (!("existing" in published)) return published;
    const existing = published.existing;
    const now = Date.now();
    let previous: AcquisitionControlState;
    let eligibility:
      | {
          kind: "confirmed_new";
          pastRecordsAbsent: true;
          outsideInitialization: true;
          inputsComplete: true;
          newnessConfirmed: true;
        }
      | { kind: "conservative_wait_complete"; waitCompleted: true }
      | undefined;
    if (read.outcome === "found") {
      const at = utcInstant(read.state.nextAttemptAt)!;
      if (now < at) return scheduled(at);
      previous = read.state;
    } else {
      if (published.isNew)
        eligibility = {
          kind: "confirmed_new",
          pastRecordsAbsent: true,
          outsideInitialization: true,
          inputsComplete: true,
          newnessConfirmed: true,
        };
      else {
        // Valid past records exist without a Control Row: wait first. Each
        // cycle re-reads them above, so wait completion proves no validity.
        const wait = this.wait.check(key, provider.periodMs);
        if (!wait.readyForRecheck) return scheduled(now + wait.remainingMs);
        eligibility = {
          kind: "conservative_wait_complete",
          waitCompleted: true,
        };
      }
      previous = { consecutiveFailures: 0, nextAttemptAt: iso(now) };
    }
    const startedAtMs = Date.now();
    const startedAt = iso(startedAtMs);
    let parsed: AcquireResult;
    if (isMulti(provider)) {
      parsed = await this.acquireMulti(provider, startedAt);
    } else {
      const http = await this.acquire(provider, key);
      if (http === "suppressed")
        return scheduled(Date.now() + SUPPRESSED_RECHECK_MS);
      try {
        parsed = provider.parse(http);
      } catch {
        parsed = { kind: "failure" };
      }
      if (parsed.kind === "failure" && http.http)
        parsed = {
          kind: "failure",
          httpStatus: http.http.status,
          ...(http.http.retryAfter !== undefined
            ? { retryAfter: http.http.retryAfter }
            : {}),
        };
    }
    // An aborted attempt is not a Provider failure: no Tx-A / Tx-P (18.7).
    // The Tomorrow.io Gate path is unchanged (its Abort is confirmed in #9).
    const abortable = isMulti(provider) || !provider.quota;
    if (abortable && this.stopping.signal.aborted) return unresolved("global");
    // Re-evaluation only: the next cycle re-reads the Control State (18.7).
    if (parsed.kind === "discard") return scheduled(Date.now());
    const completedAt = iso(Date.now());
    let snapshot: PublishedState | null =
      parsed.kind === "success"
        ? {
            data: parsed.data,
            meta: {
              dataUpdatedAt: completedAt,
              expiresAt: parsed.expiresAt,
              lastAttemptAt: startedAt,
              lastAttemptResult: "success",
              publishedAt: completedAt,
              dataSource: "externalApi",
            },
          }
        : null;
    if (snapshot && !this.valid(snapshot)) snapshot = null; // invalid Provider data
    const succeeded = snapshot !== null;
    if (!snapshot)
      snapshot = existing
        ? {
            data: existing.data,
            meta: {
              ...existing.meta,
              lastAttemptAt: startedAt,
              lastAttemptResult: "failure",
              publishedAt: completedAt,
            },
          }
        : {
            data: null,
            meta: {
              dataUpdatedAt: null,
              expiresAt: null,
              lastAttemptAt: startedAt,
              lastAttemptResult: "failure",
              publishedAt: completedAt,
              dataSource: null,
            },
          };
    const failure = parsed.kind === "failure" ? parsed : undefined;
    const outcome: AcquisitionOutcome = succeeded
      ? { kind: "success", startedAt, periodMs: period(provider, startedAtMs) }
      : {
          kind: "failure",
          completedAt,
          ...(failure?.httpStatus !== undefined
            ? { httpStatus: failure.httpStatus }
            : {}),
          ...(failure?.retryAfter !== undefined
            ? { retryAfter: failure.retryAfter }
            : {}),
        };
    const next = nextControlState(previous, outcome);
    // Tx-A: re-read immediately before saving and use that Evidence.
    const again = control.read(key);
    if (again.outcome === "pending") return unresolved("state");
    if (again.outcome === "database_error") return databaseFailure(again.layer);
    if (again.outcome === "invalid" || again.outcome !== read.outcome)
      return { kind: "blocked", scope: "state", reason: "integrity_error" };
    let txA;
    if (again.outcome === "found")
      txA = control.saveConditionally({
        stateKey: key,
        evidence: again.evidence,
        nextState: next,
        mode: "update",
      });
    else {
      const authorization = control.context.authorizeInitial(again.evidence, {
        httpResult: outcome.kind,
        nextState: next,
        databaseHealthy: true,
        acquisitionConditionsSatisfied: true,
        eligibility: eligibility!,
      });
      if (!authorization) return unresolved("state");
      txA = control.saveConditionally({
        stateKey: key,
        evidence: again.evidence,
        nextState: next,
        mode: "initialize",
        authorization,
      });
    }
    const txAFailure = saveFailure(txA);
    if (txAFailure) return txAFailure;
    this.wait.clear(key);
    // Normal Tx-P after a persisted Tx-A (PR-D owns Pending / Tx-C).
    const txPFailure = saveFailure(
      this.store.publishedStates.save(key, JSON.stringify(snapshot)),
    );
    if (txPFailure) return txPFailure;
    return scheduled(utcInstant(next.nextAttemptAt)!);
  }
  private valid(snapshot: PublishedState): boolean {
    const schema = publishedStateValidator.schema(snapshot);
    return schema.valid && publishedStateValidator.semantic(schema.value).valid;
  }
  /** latest / previous are existing data and empty is "none" (keeping its
   * kind for newness). isolated / validator_error hold the State; the
   * Snapshot is neither replaced nor repaired here (PR-E).
   */
  private published(
    key: StateKey,
  ): RunOnceResult | { existing: PublishedState | null; isNew: boolean } {
    const read = this.store.publishedStates.read(key, publishedStateValidator);
    switch (read.outcome) {
      case "latest":
      case "previous":
        return { existing: read.snapshot, isNew: false };
      case "empty":
        return { existing: null, isNew: read.kind === "new" };
      case "database_error":
        return databaseFailure(read.layer);
      default:
        return { kind: "blocked", scope: "state", reason: "integrity_error" };
    }
  }
  /** One whole multi-HTTP attempt. Provider exceptions are failures; every
   * Request uses a fresh common Adapter bound to the Shutdown signal.
   */
  private async acquireMulti(
    provider: MultiHttpProvider,
    startedAt: string,
  ): Promise<AcquireResult> {
    const signal = this.stopping.signal;
    const http = async (config: HttpAdapterConfig): Promise<HttpOutcome> => {
      if (signal.aborted) return { kind: "aborted" };
      try {
        return (await createHttpAdapter(config).start(
          signal,
          () => {},
        )) as HttpOutcome;
      } catch {
        return { kind: "network_error" };
      }
    };
    try {
      const result = await provider.acquire({ startedAt, signal, http });
      return result.kind === "success" ||
        result.kind === "failure" ||
        result.kind === "discard"
        ? result
        : { kind: "failure" };
    } catch {
      return { kind: "failure" };
    }
  }
  /** HTTP never runs inside a Transaction. Gate/Tx-Q refusal is suppression:
   * the Control State stays unchanged and the State is re-evaluated later.
   */
  private async acquire(
    provider: StateProvider,
    key: StateKey,
  ): Promise<HttpOutcome | "suppressed"> {
    if (provider.quota) {
      const send = this.send;
      if (!send) return "suppressed";
      const gate = send.beginAttempt(TOMORROW_IO);
      if (!gate) return "suppressed";
      try {
        const reserved = send.reserve({
          providerKey: TOMORROW_IO,
          attempt: gate.quotaAttempt,
          trust: () => send.quotaTrust(TOMORROW_IO),
        });
        if (!reserved.registered) return "suppressed";
        const started = send.start(gate.attempt, reserved.reservation);
        if (started.kind !== "started") return "suppressed";
        return await (started.response as Promise<HttpOutcome>).catch(
          (): HttpOutcome => ({ kind: "network_error" }),
        );
      } finally {
        send.endAttempt(gate.attempt);
      }
    }
    let adapter = this.adapters.get(key);
    if (!adapter) {
      adapter = createHttpAdapter(provider.http);
      this.adapters.set(key, adapter);
    }
    try {
      return (await adapter.start(
        this.stopping.signal,
        () => {},
      )) as HttpOutcome;
    } catch {
      return { kind: "network_error" };
    }
  }
}

/** Production registry. Empty until the Domain Services define Providers:
 * every State is then re-evaluated hourly with no HTTP or DB writes.
 */
export const PRODUCTION_PROVIDERS: readonly AcquisitionProvider[] =
  Object.freeze([]);
