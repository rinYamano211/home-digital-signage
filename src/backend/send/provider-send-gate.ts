import { TOMORROW_IO } from "../quota/quota-guard.js";
import type { QuotaRepository } from "../storage/quota-repository.js";
import { systemTime } from "../time/source.js";
import { ClockTrustMonitor, HistoryTrustMonitor } from "./internal/trust.js";
import { ProviderSendGate } from "./internal/provider-send-gate.js";

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
