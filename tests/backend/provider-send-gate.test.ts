import { afterEach, expect, test, vi } from "vitest";
import { fixture, provider } from "../support/send-gate-fixture.js";
import { createProviderSendGate } from "../../src/backend/send/provider-send-gate.js";
import {
  ProviderSendGate,
  type GateAttempt,
} from "../../src/backend/send/internal/provider-send-gate.js";
import { connectionCoordination } from "../../src/backend/storage/connection-coordination.js";
import type {
  QuotaReservationEvidence,
  QuotaReservationResult,
} from "../../src/backend/storage/quota-repository.js";
const fixtures: ReturnType<typeof fixture>[] = [];
function setup() {
  const f = fixture();
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.gate.dispose();
    if (f.db.open) f.db.close();
  }
  vi.restoreAllMocks();
});
function saved(f: ReturnType<typeof setup>) {
  const r = f.reserve();
  expect(r.result.outcome).toBe("saved");
  return r;
}

test("T2 trusted adapter starts synchronously; headers Promise does not release Body lifecycle", async () => {
  const f = setup();
  const r = saved(f);
  f.setStartHook(() =>
    expect(f.gate.snapshot(provider).phase).toBe("STARTING"),
  );
  const result = f.gate.start(r.attempt, r.result);
  expect(f.calls()).toBe(1);
  expect(result.kind).toBe("started");
  if (result.kind === "started") await result.response;
  expect(f.gate.snapshot(provider).phase).toBe("IN_FLIGHT");
  expect(f.gate.reservationStatus(provider).reason).toBe("provider_in_flight");
  f.finish();
  expect(f.gate.snapshot(provider).phase).toBe("IDLE");
  expect(f.gate.start(r.attempt, r.result).kind).toBe("blocked");
});
test.each(["quota_blocked", "not_saved", "unknown"] as const)(
  "T1 non-saved %s never starts HTTP or changes DB",
  (outcome) => {
    const f = setup();
    const r = saved(f);
    const before = f.rows();
    const result =
      outcome === "quota_blocked"
        ? { outcome, reason: "test" }
        : { outcome, reason: "test", scope: "provider" as const };
    expect(f.gate.start(r.attempt, result).kind).toBe("blocked");
    expect(f.calls()).toBe(0);
    expect(f.rows()).toEqual(before);
    expect(f.control()).toEqual([]);
  },
);
test("T1 forged attempt, copied token and Evidence-as-attempt are rejected", () => {
  const f = setup();
  const r = saved(f);
  for (const attempt of [
    {},
    { ...r.attempt },
    r.result.outcome === "saved" ? r.result.evidence : {},
  ])
    expect(f.gate.start(attempt as GateAttempt, r.result).kind).toBe("blocked");
  expect(f.calls()).toBe(0);
});
test.each([{}, Object.freeze(Object.create(null))])(
  "T1 forged evidence rejected without quota cancellation",
  (evidence) => {
    const f = setup();
    const r = saved(f);
    expect(
      f.gate.start(r.attempt, {
        outcome: "saved",
        evidence: evidence as QuotaReservationEvidence,
        reconciled: false,
      }).kind,
    ).toBe("blocked");
    expect(f.rows()).toHaveLength(1);
    expect(f.calls()).toBe(0);
  },
);
test("T1 another Attempt's Evidence and Sequence cannot be reused", () => {
  const f = setup();
  const first = saved(f);
  f.gate.endAttempt(first.attempt);
  f.advance(4_000_000_000n);
  const second = saved(f);
  expect(f.gate.start(second.attempt, first.result).kind).toBe("blocked");
  expect(f.calls()).toBe(0);
  expect(f.rows()).toHaveLength(2);
});
test("T1 another Gate cannot use the same token", () => {
  const f = setup();
  const r = saved(f);
  const other = new ProviderSendGate(
    new Map([[provider, { repository: f.repo, history: f.history }]]),
    f.clock,
    f.time,
  );
  expect(other.start(r.attempt, r.result).kind).toBe("blocked");
  other.dispose();
});
test.each(["close", "unresolved", "blocked"])(
  "T1 Connection %s invalidates reservation",
  (fault) => {
    const f = setup();
    const r = saved(f);
    if (fault === "close") f.db.close();
    else if (fault === "unresolved")
      connectionCoordination(f.db).connectionUnresolved = true;
    else
      connectionCoordination(f.db).blocked = {
        scope: "database",
        layer: "L3",
        reason: "schema_incompatible",
      };
    expect(f.gate.start(r.attempt, r.result).kind).toBe("blocked");
    expect(f.calls()).toBe(0);
  },
);
test("T2 stop precedes start; Resume never revives old Attempt", () => {
  const f = setup();
  const r = saved(f);
  const stop = f.gate.stopControl(provider);
  const epoch = f.gate.snapshot(provider).epoch;
  stop.stop();
  expect(f.gate.snapshot(provider).epoch).toBeGreaterThan(epoch);
  stop.release();
  expect(f.gate.start(r.attempt, r.result).kind).toBe("blocked");
  expect(f.calls()).toBe(0);
  expect(f.rows()).toHaveLength(1);
});
test("T2 fetch first: stop requests Abort and retains occupancy through Resume", () => {
  const f = setup();
  const r = saved(f);
  f.gate.start(r.attempt, r.result);
  const stop = f.gate.stopControl("global");
  stop.stop();
  stop.release();
  expect(f.signal()?.aborted).toBe(true);
  expect(f.gate.snapshot(provider).phase).toBe("ABORT_REQUESTED");
  expect(f.gate.beginAttempt(provider)).toBeNull();
  expect(f.rows()).toHaveLength(1);
  f.finish();
  expect(f.gate.snapshot(provider).phase).toBe("IDLE");
});
test("T2 synchronous re-entry cannot create a second Request", () => {
  const f = setup();
  const r = saved(f);
  f.setStartHook(() => {
    expect(f.gate.start(r.attempt, r.result).kind).toBe("blocked");
    expect(f.gate.beginAttempt(provider)).toBeNull();
  });
  expect(f.gate.start(r.attempt, r.result).kind).toBe("started");
  expect(f.calls()).toBe(1);
});
test("T2 synchronous stop after start inside trusted adapter keeps ABORT_REQUESTED", () => {
  const f = setup();
  const r = saved(f);
  const stop = f.gate.stopControl(provider);
  f.setStartHook(() => stop.stop());
  f.gate.start(r.attempt, r.result);
  expect(f.gate.snapshot(provider).phase).toBe("ABORT_REQUESTED");
  expect(f.signal()?.aborted).toBe(true);
  f.finish();
  expect(f.gate.snapshot(provider).phase).toBe("IDLE");
});
test("T2 synchronous exception consumes authority, aborts and awaits explicit lifecycle end", () => {
  const f = setup();
  const r = saved(f);
  f.setStartHook(() => {
    throw new Error("fake");
  });
  expect(f.gate.start(r.attempt, r.result)).toMatchObject({
    kind: "blocked",
    reason: "http_start_failed",
  });
  expect(f.signal()?.aborted).toBe(true);
  expect(f.gate.start(r.attempt, r.result).kind).toBe("blocked");
  expect(f.gate.snapshot(provider).phase).toBe("ABORT_REQUESTED");
  expect(f.rows()).toHaveLength(1);
  f.finish();
  expect(f.gate.snapshot(provider).phase).toBe("IDLE");
});
test("T2 rejected HTTP Promise is not lifecycle completion or automatic Cooldown", async () => {
  const f = setup();
  const r = saved(f);
  f.setResponse(Promise.reject(new Error("fake network")));
  const result = f.gate.start(r.attempt, r.result);
  if (result.kind === "started")
    await expect(result.response).rejects.toThrow();
  expect(f.gate.snapshot(provider).phase).toBe("IN_FLIGHT");
  expect(f.gate.snapshot(provider).cooldownUntil).toBeUndefined();
  f.finish();
  expect(f.rows()).toHaveLength(1);
});
test("T3 Global and Provider reason owners cannot clear each other", () => {
  const f = setup();
  const a = f.gate.stopControl("global"),
    b = f.gate.stopControl(provider),
    c = f.gate.stopControl(provider);
  a.stop();
  b.stop();
  c.stop();
  a.release();
  b.release();
  expect(f.gate.reservationStatus(provider).allowed).toBe(false);
  c.release();
  expect(f.gate.reservationStatus(provider).allowed).toBe(true);
});
test.each(["clock", "history"])(
  "T3 %s revocation synchronously closes Gate, updates Epoch and aborts",
  (kind) => {
    const f = setup();
    const r = saved(f);
    f.gate.start(r.attempt, r.result);
    const epoch = f.gate.snapshot(provider).epoch;
    if (kind === "clock") {
      f.setOs(false);
      f.clock.observe();
    } else f.history.suspend();
    expect(f.gate.snapshot(provider).epoch).toBeGreaterThan(epoch);
    expect(f.signal()?.aborted).toBe(true);
    expect(f.gate.snapshot(provider).phase).toBe("ABORT_REQUESTED");
    expect(f.rows()).toHaveLength(1);
  },
);
test("T3 final check detects missed observation and invalidates before start", () => {
  const f = setup();
  const r = saved(f);
  const epoch = f.gate.snapshot(provider).epoch;
  f.advance(15_000_000_001n);
  expect(f.gate.start(r.attempt, r.result).kind).toBe("blocked");
  expect(f.gate.snapshot(provider).epoch).toBeGreaterThan(epoch);
  expect(f.calls()).toBe(0);
});
test("T3 Clock recovery does not recover History or old Attempts; other owner remains", () => {
  const f = setup();
  const r = saved(f);
  const stop = f.gate.stopControl(provider);
  stop.stop();
  f.history.suspend();
  f.setOs(false);
  f.clock.observe();
  f.setOs(true);
  for (let i = 0; i < 13; i++) {
    f.advance(5_000_000_000n);
    f.clock.observe();
  }
  expect(f.clock.state()).toBe("TRUSTED");
  expect(f.history.state()).toBe("SUSPENDED");
  f.confirmHistory();
  expect(f.gate.reservationStatus(provider).allowed).toBe(false);
  stop.release();
  expect(f.gate.start(r.attempt, r.result).kind).toBe("blocked");
});
test.each([0n, 999_999_999n, 1_000_000_000n])(
  "T4 elapsed %s ns accepted inclusively",
  (elapsed) => {
    const f = setup();
    const r = saved(f);
    f.advance(elapsed);
    expect(f.gate.start(r.attempt, r.result).kind).toBe("started");
    expect(f.calls()).toBe(1);
  },
);
test.each([1_000_000_001n, 2_000_000_000n])(
  "T4 elapsed %s ns rejects and enters Provider cooldown",
  (elapsed) => {
    const f = setup();
    const r = saved(f);
    f.advance(elapsed);
    expect(f.gate.start(r.attempt, r.result)).toMatchObject({
      kind: "blocked",
      reason: "delay_exceeded",
    });
    expect(f.calls()).toBe(0);
    expect(f.rows()).toHaveLength(1);
    expect(f.control()).toEqual([]);
    expect(f.gate.reservationStatus(provider).reason).toBe("cooldown");
    expect(f.gate.reservationStatus("other").allowed).toBe(true);
    expect(f.gate.beginAttempt(provider)).toBeNull();
    f.advance(4_999_999_999n);
    expect(f.gate.reservationStatus(provider).reason).toBe("cooldown");
    f.advance(1n);
    expect(f.gate.reservationStatus(provider).allowed).toBe(true);
    expect(f.gate.start(r.attempt, r.result).kind).toBe("blocked");
  },
);
test("T4 negative or invalid measurement never starts", () => {
  const f = setup();
  const r = saved(f);
  const real = f.repo.inspectReservation.bind(f.repo);
  vi.spyOn(f.repo, "inspectReservation").mockImplementation((e, a) => {
    const value = real(e, a)!;
    return { ...value, measurementStartedNs: f.time.monotonicNs() + 1n };
  });
  expect(f.gate.start(r.attempt, r.result).kind).toBe("blocked");
  expect(f.calls()).toBe(0);
});
test.each([NaN, undefined, "100", -1n])(
  "T4 malformed monotonic reading %s rejects",
  (value) => {
    const f = setup();
    const r = saved(f);
    vi.spyOn(f.time, "monotonicNs").mockReturnValue(value as bigint);
    expect(f.gate.start(r.attempt, r.result).kind).toBe("blocked");
    expect(f.calls()).toBe(0);
    expect(f.rows()).toHaveLength(1);
  },
);
test("T4 clock read failure is Fail Closed", () => {
  const f = setup();
  const r = saved(f);
  vi.spyOn(f.time, "monotonicNs").mockImplementation(() => {
    throw new Error();
  });
  expect(f.gate.start(r.attempt, r.result).kind).toBe("blocked");
  expect(f.calls()).toBe(0);
});
test("T4 new Gate has no restored cooldown but does not restore old Attempt", () => {
  const f = setup();
  const r = saved(f);
  f.advance(1_000_000_001n);
  f.gate.start(r.attempt, r.result);
  const fresh = new ProviderSendGate(
    new Map([[provider, { repository: f.repo, history: f.history }]]),
    f.clock,
    f.time,
  );
  expect(fresh.snapshot(provider).cooldownUntil).toBeUndefined();
  expect(fresh.start(r.attempt, r.result).kind).toBe("blocked");
  fresh.dispose();
});
test("T4 expired Cooldown cannot override management stop or History failure", () => {
  const f = setup();
  const r = saved(f);
  f.advance(1_000_000_001n);
  f.gate.start(r.attempt, r.result);
  const stop = f.gate.stopControl(provider);
  stop.stop();
  f.history.suspend();
  f.advance(5_000_000_000n);
  stop.release();
  expect(f.gate.reservationStatus(provider).allowed).toBe(false);
});
test("T5 quota_blocked remains a repository result, no automatic cooldown or new reservation", () => {
  const f = setup();
  const r = saved(f);
  f.gate.endAttempt(r.attempt);
  const next = f.reserve();
  expect(next.result.outcome).toBe("quota_blocked");
  f.gate.start(next.attempt, next.result);
  expect(f.rows()).toHaveLength(1);
  expect(f.gate.snapshot(provider).cooldownUntil).toBeUndefined();
});
test("T1/T5 evidence from closed old Connection is not usable on a new Gate", () => {
  const f = setup();
  const r = saved(f);
  const replacement = setup();
  const n = saved(replacement);
  expect(replacement.gate.start(n.attempt, r.result).kind).toBe("blocked");
  expect(replacement.calls()).toBe(0);
});
test("production factory has no Trust/HTTP injection and stays Fail Closed", () => {
  const f = setup();
  const prod = createProviderSendGate(f.repo);
  expect(prod.beginAttempt(provider)).toBeNull();
  expect(prod.quotaTrust(provider)).toEqual({
    clockTrusted: false,
    historyTimestampsTrusted: false,
    historyComplete: false,
  });
  expect(prod.reservationStatus(provider).allowed).toBe(false);
  expect(prod.start({} as GateAttempt, {} as QuotaReservationResult).kind).toBe(
    "blocked",
  );
  prod.dispose();
  expect(f.calls()).toBe(0);
});
test("internal Gate with confirmed Trust but no Adapter cannot send", () => {
  const f = setup();
  const gate = new ProviderSendGate(
    new Map([[provider, { repository: f.repo, history: f.history }]]),
    f.clock,
    f.time,
  );
  const a = gate.beginAttempt(provider)!;
  const result = f.repo.reserve({
    providerKey: provider,
    attempt: a.quotaAttempt,
    trust: () => gate.quotaTrust(provider),
  });
  expect(gate.start(a.attempt, result)).toMatchObject({
    kind: "blocked",
    reason: "http_adapter_unavailable",
  });
  gate.dispose();
  expect(f.rows()).toHaveLength(1);
});

test.each([undefined, NaN, "0", -1n])(
  "T4 invalid persisted handoff measurement %s is rejected",
  (value) => {
    const f = setup();
    const r = saved(f);
    const original = f.repo.inspectReservation.bind(f.repo);
    vi.spyOn(f.repo, "inspectReservation").mockImplementation((e, a) => ({
      ...original(e, a)!,
      measurementStartedNs: value as bigint,
    }));
    expect(f.gate.start(r.attempt, r.result).kind).toBe("blocked");
    expect(f.calls()).toBe(0);
    expect(f.rows()).toHaveLength(1);
  },
);
test("T4 same Provider shares cooldown across attempted State callers", () => {
  const f = setup();
  const first = saved(f);
  f.advance(1_000_000_001n);
  f.gate.start(first.attempt, first.result);
  // Gate intentionally has no State parameter: two State callers see the same Provider slot.
  const callers = {
    rainForecast: () => f.gate.beginAttempt(provider),
    hourlyWeather: () => f.gate.beginAttempt(provider),
  };
  expect([callers.rainForecast(), callers.hourlyWeather()]).toEqual([
    null,
    null,
  ]);
  expect(f.gate.snapshot("other").cooldownUntil).toBeUndefined();
  expect(f.rows()).toHaveLength(1);
});
test("T3 final freshness check aborts an in-flight Request after observation expiry", () => {
  const f = setup();
  const r = saved(f);
  f.gate.start(r.attempt, r.result);
  const epoch = f.gate.snapshot(provider).epoch;
  f.advance(15_000_000_001n);
  expect(f.gate.reservationStatus(provider).allowed).toBe(false);
  expect(f.gate.snapshot(provider).epoch).toBeGreaterThan(epoch);
  expect(f.signal()?.aborted).toBe(true);
  expect(f.gate.snapshot(provider).phase).toBe("ABORT_REQUESTED");
});
test("T2 Abort listener re-entry sees closed reasons and occupied Provider", () => {
  const f = setup();
  const r = saved(f);
  f.gate.start(r.attempt, r.result);
  const control = f.gate.stopControl(provider);
  f.signal()!.addEventListener("abort", () => {
    expect(f.gate.beginAttempt(provider)).toBeNull();
    expect(f.gate.start(r.attempt, r.result).kind).toBe("blocked");
  });
  control.stop();
  expect(f.calls()).toBe(1);
  expect(f.rows()).toHaveLength(1);
  f.finish();
});
test("T2 malformed asynchronous Adapter is absent from production's configurable surface", () => {
  const f = setup();
  const prod = createProviderSendGate(f.repo);
  expect(Object.keys(prod).sort()).toEqual(
    [
      "reservationStatus",
      "quotaTrust",
      "beginAttempt",
      "endAttempt",
      "start",
      "stopControl",
      "snapshot",
      "dispose",
    ].sort(),
  );
  expect("adapter" in prod).toBe(false);
  expect("setTrust" in prod).toBe(false);
  prod.dispose();
});
