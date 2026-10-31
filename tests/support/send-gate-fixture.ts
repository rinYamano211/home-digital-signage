import Database from "better-sqlite3";
import { vi } from "vitest";
import { initializeSchema } from "../../src/backend/storage/schema.js";
import { QuotaRepository } from "../../src/backend/storage/quota-repository.js";
import { TOMORROW_IO } from "../../src/backend/quota/quota-guard.js";
import {
  ProviderSendGate,
  type HttpStartAdapter,
} from "../../src/backend/send/internal/provider-send-gate.js";
import {
  ClockTrustMonitor,
  HistoryTrustMonitor,
} from "../../src/backend/send/internal/trust.js";
export const provider = TOMORROW_IO;
export function fixture() {
  let mono = 100_000_000_000n;
  let wall = 200_000_000;
  let os = true;
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => mono);
  vi.spyOn(Date, "now").mockImplementation(() => wall);
  const time = { wallMs: () => wall, monotonicNs: () => mono };
  const clock = new ClockTrustMonitor(time, () => ({
    confirmed: os,
    checkedAtNs: mono,
  }));
  const history = new HistoryTrustMonitor();
  const otherHistory = new HistoryTrustMonitor();
  const db = new Database(":memory:");
  initializeSchema(db);
  const repo = new QuotaRepository(db);
  repo.provisionProvider(provider, {
    clockTrusted: true,
    pastUseOutsideQuotaPeriodsConfirmed: true,
    safetyMarginConfirmed: true,
    exclusiveKeyUseConfirmed: true,
  });
  let ended: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  let calls = 0;
  let startHook: (() => void) | undefined;
  let response: Promise<unknown> = Promise.resolve("headers");
  const adapter: HttpStartAdapter = {
    start(s, finish) {
      calls++;
      signal = s;
      ended = finish;
      startHook?.();
      return response;
    },
  };
  const gate = new ProviderSendGate(
    new Map([
      [provider, { repository: repo, history }],
      ["other", { repository: repo, history: otherHistory }],
    ]),
    clock,
    time,
    adapter,
  );
  const confirmHistory = () =>
    history.confirm({
      internalConsistent: true,
      timestampsTrusted: true,
      complete: true,
    });
  clock.observe();
  confirmHistory();
  otherHistory.confirm({
    internalConsistent: true,
    timestampsTrusted: true,
    complete: true,
  });
  const advance = (ns: bigint) => {
    mono += ns;
    wall += Number(ns / 1_000_000n);
  };
  function reserve() {
    const attempt = gate.beginAttempt(provider);
    if (!attempt) throw new Error("Gate refused attempt");
    const result = repo.reserve({
      providerKey: provider,
      attempt: attempt.quotaAttempt,
      trust: () => gate.quotaTrust(provider),
    });
    return { ...attempt, result };
  }
  const rows = () =>
    db.prepare("SELECT * FROM provider_quota_consumptions").all();
  const control = () => db.prepare("SELECT * FROM acquisition_control").all();
  return {
    time,
    clock,
    history,
    repo,
    db,
    gate,
    advance,
    reserve,
    rows,
    control,
    confirmHistory,
    setMono: (n: bigint) => {
      mono = n;
    },
    setWall: (n: number) => {
      wall = n;
    },
    setOs: (value: boolean) => {
      os = value;
    },
    setStartHook: (hook: () => void) => {
      startHook = hook;
    },
    setResponse: (p: Promise<unknown>) => {
      response = p;
    },
    finish: () => ended?.(),
    signal: () => signal,
    calls: () => calls,
  };
}
