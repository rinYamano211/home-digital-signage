import { TOMORROW_IO } from "../quota/quota-guard.js";
import type { QuotaRepository } from "../storage/quota-repository.js";
import { BackendStore, type StartupStoreAccess } from "../storage/store.js";
import { HistoryRecheck } from "../quota/internal/history-recheck.js";
import { systemTime } from "../time/source.js";
import { OsSyncReader } from "./internal/os-sync.js";
import { ClockTrustMonitor, HistoryTrustMonitor } from "./internal/trust.js";
import { ProviderSendGate } from "./internal/provider-send-gate.js";
import { createHttpAdapter } from "../http/native-http-adapter.js";
import type { HttpAdapterConfig } from "../http/outcome.js";

/** Periodic recheck C (PR-C completion plan, provisional). Assessment only. */
const RECHECK_PERIOD_MS = 5 * 60 * 1000;

/** Production boundary. No injectable Trust values, OS success stub, or HTTP
 * callback. OS verification, History management and real HTTP wiring are pending.
 * Therefore this instance cannot send. No startup/lifecycle integration yet.
 */
export function createProviderSendGate(repository: QuotaRepository) {
  const clock = new ClockTrustMonitor(systemTime, () => null);
  const history = new HistoryTrustMonitor();
  const gate = new ProviderSendGate(
    new Map([[TOMORROW_IO, { repository, history }]]),
    clock,
    systemTime,
  );
  return Object.freeze({
    reservationStatus: gate.reservationStatus.bind(gate),
    quotaTrust: gate.quotaTrust.bind(gate),
    beginAttempt: gate.beginAttempt.bind(gate),
    endAttempt: gate.endAttempt.bind(gate),
    start: gate.start.bind(gate),
    stopControl: gate.stopControl.bind(gate),
    snapshot: gate.snapshot.bind(gate),
    dispose: gate.dispose.bind(gate),
  });
}

/** 5B production Trust wiring on the committed Runtime Store: OS sync (5B-1)
 * feeds the existing ClockTrustMonitor, and the single authenticated
 * HistoryRecovery (5B-R2B) owns History for the Gate. Recovery starts closed
 * and reopens only through its own recover() on B/C rechecks. The HTTP adapter
 * is attached only when the Tomorrow.io Provider supplies its configuration.
 */
export function createRuntimeSend(
  startup: StartupStoreAccess,
  http?: HttpAdapterConfig,
) {
  const runtime = BackendStore.activateRuntime(startup);
  if (!runtime) return null;
  const reader = new OsSyncReader();
  const clock = new ClockTrustMonitor(systemTime, () => reader.current());
  const history = BackendStore.createRuntimeHistory(startup, clock);
  if (!history) return null;
  const gate = new ProviderSendGate(
    new Map([
      [
        TOMORROW_IO,
        { repository: runtime.quota, history: new HistoryTrustMonitor() },
      ],
    ]),
    clock,
    systemTime,
    // Tomorrow.io only, from the Provider definition (C-Impl-5C).
    http ? createHttpAdapter(http) : undefined,
  );
  const recovery = BackendStore.createHistoryRecovery(startup, gate, clock);
  if (!recovery) {
    gate.dispose();
    return null;
  }
  const recheck = new HistoryRecheck(
    systemTime,
    () => {
      const hint = recovery.recheckHint();
      return hint.waitAtNs === undefined ? {} : { waitAtNs: hint.waitAtNs };
    },
    () => {
      recovery.recover();
    },
    RECHECK_PERIOD_MS,
  );
  let state: "created" | "running" | "stopped" = "created";
  return Object.freeze({
    startMonitoring(): void {
      if (state !== "created") return;
      state = "running";
      reader.start();
      clock.start();
      recheck.start();
    },
    /** Before DB Close: stop rechecks, close Recovery and the Gate. Idempotent. */
    stopMonitoring(): void {
      if (state === "stopped") return;
      state = "stopped";
      recheck.stop();
      try {
        recovery.dispose();
      } finally {
        clock.stop();
        reader.stop();
        gate.dispose();
      }
    },
    reservationStatus: gate.reservationStatus.bind(gate),
    quotaTrust: gate.quotaTrust.bind(gate),
    beginAttempt: gate.beginAttempt.bind(gate),
    endAttempt: gate.endAttempt.bind(gate),
    /** Tx-Q with Runtime Valid registration; neither result permits HTTP. */
    reserve: history.history.reserve.bind(history.history),
    start: gate.start.bind(gate),
    stopControl: gate.stopControl.bind(gate),
    snapshot: gate.snapshot.bind(gate),
  });
}
export type RuntimeSend = NonNullable<ReturnType<typeof createRuntimeSend>>;
