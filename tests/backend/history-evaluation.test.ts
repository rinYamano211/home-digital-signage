import { expect, test } from "vitest";
import {
  evaluateHistoryFacts,
  type HistoryEvaluationFacts,
  type RuntimeValidFacts,
  type HistoryScope,
} from "../../src/backend/quota/history-evaluation.js";
import {
  TOMORROW_IO,
  QuotaGuard,
} from "../../src/backend/quota/quota-guard.js";
import {
  ClockTrustMonitor,
  HistoryTrustMonitor,
} from "../../src/backend/send/internal/trust.js";

// Declarative TEST facts, not production Startup/Tx-Q/Range evidence. No factory
// or validator that authenticates evidence is introduced by this unit.
function model(cutoff = 2): HistoryEvaluationFacts {
  const scope: HistoryScope = {
    providerKey: TOMORROW_IO,
    generation: 2,
    processInstanceId: "test-process-current",
    cutoffSequence: cutoff,
  };
  const valid = (sequence: number): RuntimeValidFacts => ({
    ...scope,
    sequence,
    reservedAtMs: sequence * 10,
    reservationOutcome: "saved",
    clockTrustedAtReservation: true,
  });
  return {
    scope,
    boundary: {
      ...scope,
      startupOutcome: "committed",
      providerState: "PROVISIONED",
    },
    historyComplete: true,
    history: {
      metadata: {
        providerKey: TOMORROW_IO,
        historyStatus: "ACTIVE",
        initializedAtMs: 0,
        lastSequence: 4,
      },
      consumptions: [1, 2, 3, 4].map((sequence) => ({
        sequence,
        reservedAtMs: sequence * 10,
      })),
    },
    valid:
      cutoff === 0 ? [1, 2, 3, 4].map(valid) : cutoff === 4 ? [] : [valid(3)],
    ranges:
      cutoff === 2
        ? [
            {
              ...scope,
              rangeId: 1,
              startSequence: 4,
              endSequence: 4,
              committed: true,
            },
          ]
        : [],
  };
}
const deny = (facts: unknown) =>
  expect(evaluateHistoryFacts(facts as HistoryEvaluationFacts).evaluation).toBe(
    "BLOCKED",
  );

test("D03/U02 old, new Valid and confirmed Range form an exact disjoint partition", () => {
  const f = model();
  const result = evaluateHistoryFacts(f);
  expect(result.evaluation).toBe("CONSERVATIVE");
  if (result.evaluation === "BLOCKED") throw Error("unexpected");
  expect(result.classification.old.map((r) => r.sequence)).toEqual([1, 2]);
  expect(result.classification.newValid.map((r) => r.sequence)).toEqual([3]);
  expect(result.classification.newUncertain).toEqual([
    { rangeId: 1, consumptions: [{ sequence: 4, reservedAtMs: 40 }] },
  ]);
  expect(result).not.toHaveProperty("allowed");
  expect(result).not.toHaveProperty("clockTrusted");
  expect(result).not.toHaveProperty("historyComplete");
});
test("Only current-process confirmed Valid facts with complete history yield model TRUSTED", () => {
  const result = evaluateHistoryFacts(model(0));
  expect(result.evaluation).toBe("TRUSTED");
  if (result.evaluation === "BLOCKED") return;
  expect(result.classification.old).toEqual([]);
  expect(result.classification.newUncertain).toEqual([]);
  expect(result.classification.newValid).toHaveLength(4);
});
test("All old history is CONSERVATIVE, not automatically TRUSTED on Clock recovery", () => {
  const clock = new ClockTrustMonitor(
    { wallMs: () => 1000, monotonicNs: () => 0n },
    () => ({ confirmed: true, checkedAtNs: 0n }),
  );
  clock.observe();
  expect(clock.state()).toBe("TRUSTED");
  const result = evaluateHistoryFacts(model(4));
  expect(result.evaluation).toBe("CONSERVATIVE");
});
test("Assessment never changes existing History Monitor or provides compatible QuotaTrust", () => {
  const monitor = new HistoryTrustMonitor();
  expect(monitor.state()).toBe("UNVERIFIED");
  const f = model(0);
  const result = evaluateHistoryFacts(f);
  expect(result.evaluation).toBe("TRUSTED");
  expect(monitor.state()).toBe("UNVERIFIED");
  expect(
    new QuotaGuard().evaluate(TOMORROW_IO, f.history, 1000, result as never)
      .allowed,
  ).toBe(false);
  monitor.suspend();
  evaluateHistoryFacts(f);
  expect(monitor.state()).toBe("SUSPENDED");
});
for (const outcome of ["unknown", "rejected", "database_error"] as const)
  test(`Startup ${outcome} facts cannot classify Valid`, () => {
    const f = model(0);
    deny({ ...f, boundary: { ...f.boundary, startupOutcome: outcome } });
  });
for (const outcome of ["unknown", "not_saved", "quota_blocked"] as const)
  test(`Tx-Q ${outcome} facts cannot be Runtime Valid`, () => {
    const f = model(0);
    deny({
      ...f,
      valid: [
        { ...f.valid[0], reservationOutcome: outcome },
        ...f.valid.slice(1),
      ],
    });
  });
test("Clock unconfirmed at reservation cannot become Valid from a later normal Clock", () => {
  const f = model(0);
  deny({
    ...f,
    valid: [
      { ...f.valid[0], clockTrustedAtReservation: false },
      ...f.valid.slice(1),
    ],
  });
});
test("No implicit completeness from existing rows/ACTIVE or empty history", () => {
  deny({ ...model(), historyComplete: false });
  const f = model(0);
  deny({
    ...f,
    historyComplete: false,
    history: {
      ...f.history,
      metadata: { ...f.history.metadata!, lastSequence: 0 },
      consumptions: [],
    },
    valid: [],
  });
});
test("Missing Valid facts and missing Range both leave classification gaps", () => {
  const f = model();
  deny({ ...f, valid: [] });
  deny({ ...f, ranges: [] });
});
for (const key of [
  "providerKey",
  "generation",
  "processInstanceId",
  "cutoffSequence",
] as const) {
  for (const target of ["boundary", "valid", "ranges"] as const)
    test(`${target} ${key} mismatch refuses stale or cross-scope input`, () => {
      const f = model();
      const value =
        key === "providerKey"
          ? "unknown"
          : key === "generation"
            ? 3
            : key === "processInstanceId"
              ? "previous-process"
              : 1;
      if (target === "boundary")
        deny({ ...f, boundary: { ...f.boundary, [key]: value } });
      else deny({ ...f, [target]: [{ ...f[target][0], [key]: value }] });
    });
}
test("Prior Process facts cannot be reused even if OS/Generation otherwise unchanged", () => {
  const f = model();
  deny({
    ...f,
    valid: [{ ...f.valid[0], processInstanceId: "prior-process" }],
  });
});
test("Duplicate Valid sequence is refused, not deduplicated", () => {
  const f = model();
  deny({ ...f, valid: [...f.valid, ...f.valid] });
});
test("Valid Timestamp must match the exact persisted Consumption", () => {
  const f = model();
  deny({ ...f, valid: [{ ...f.valid[0], reservedAtMs: 31 }] });
});
test("Valid record in old history is not reclassified or counted twice", () => {
  const f = model();
  deny({ ...f, valid: [{ ...f.valid[0], sequence: 2, reservedAtMs: 20 }] });
});
for (const range of [
  { rangeId: 0 },
  { rangeId: 1.5 },
  { startSequence: 2 },
  { startSequence: 5 },
  { startSequence: 5, endSequence: 4 },
  { endSequence: 5 },
  { endSequence: Number.MAX_SAFE_INTEGER + 1 },
  { committed: false },
])
  test(`Invalid/uncommitted Range ${JSON.stringify(range)} is refused`, () => {
    const f = model();
    deny({ ...f, ranges: [{ ...f.ranges[0], ...range }] });
  });
test("Overlapping Ranges are refused without merge", () => {
  const f = model();
  deny({ ...f, ranges: [...f.ranges, { ...f.ranges[0], rangeId: 2 }] });
});
test("Valid and uncertain overlap is refused", () => {
  const f = model();
  deny({ ...f, ranges: [{ ...f.ranges[0], startSequence: 3 }] });
});
test("Multiple distinct Ranges preserve their identity; gaps in range IDs are not repaired", () => {
  const f = model(0);
  const r = (rangeId: number, startSequence: number, endSequence: number) => ({
    ...f.scope,
    rangeId,
    startSequence,
    endSequence,
    committed: true,
  });
  const result = evaluateHistoryFacts({
    ...f,
    valid: [f.valid[0], f.valid[2]],
    ranges: [r(1, 2, 2), r(3, 4, 4)],
  });
  expect(result.evaluation).toBe("CONSERVATIVE");
  if (result.evaluation === "BLOCKED") return;
  expect(result.classification.newUncertain.map((r) => r.rangeId)).toEqual([
    1, 3,
  ]);
});
test("Reused/reversed Range IDs are refused; input is not sorted into validity", () => {
  const f = model(0);
  const r = (rangeId: number, startSequence: number) => ({
    ...f.scope,
    rangeId,
    startSequence,
    endSequence: startSequence,
    committed: true,
  });
  deny({ ...f, valid: [f.valid[0], f.valid[2]], ranges: [r(2, 2), r(1, 4)] });
  deny({ ...f, valid: [f.valid[0], f.valid[2]], ranges: [r(1, 4), r(2, 2)] });
});
for (const rows of [
  [1, 3, 4],
  [1, 2, 2, 4],
  [2, 1, 3, 4],
])
  test(`Missing/duplicate/reversed Consumption ${rows} cannot be repaired`, () => {
    const f = model();
    deny({
      ...f,
      history: {
        ...f.history,
        consumptions: rows.map((sequence) => ({
          sequence,
          reservedAtMs: sequence * 10,
        })),
      },
    });
  });
for (const timestamp of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER, "30"])
  test(`Invalid Timestamp ${timestamp} blocks`, () => {
    const f = model();
    deny({
      ...f,
      history: {
        ...f.history,
        consumptions: f.history.consumptions.map((r, i) =>
          i === 2 ? { ...r, reservedAtMs: timestamp } : r,
        ),
      },
    });
  });
for (const cutoff of [-1, NaN, 1.5, 5, "2"])
  test(`Invalid Cutoff ${cutoff} blocks`, () => {
    const f = model();
    deny({
      ...f,
      scope: { ...f.scope, cutoffSequence: cutoff },
      boundary: { ...f.boundary, cutoffSequence: cutoff },
    });
  });
test("UNPROVISIONED NULL is not PROVISIONED zero; missing Runtime Provisioning remains BLOCKED", () => {
  const f = model(0);
  const scope = { ...f.scope, cutoffSequence: null };
  const boundary = {
    ...scope,
    startupOutcome: "committed" as const,
    providerState: "UNPROVISIONED" as const,
  };
  deny({
    ...f,
    scope,
    boundary,
    valid: f.valid.map((r) => ({ ...r, cutoffSequence: null })),
  });
  deny({
    ...f,
    scope,
    boundary,
    history: { metadata: null, consumptions: [] },
    valid: [],
  });
});
test("Confirmed F-01 model facts supply Runtime cutoff 0 without changing stored NULL Boundary", () => {
  const f = model(0);
  const scope = { ...f.scope, cutoffSequence: null };
  const boundary = {
    ...scope,
    startupOutcome: "committed" as const,
    providerState: "UNPROVISIONED" as const,
  };
  const input = {
    ...f,
    scope,
    boundary,
    valid: f.valid.map((r) => ({ ...r, cutoffSequence: null })),
    runtimeProvisioning: {
      ...scope,
      cutoffSequence: 0 as const,
      committed: true,
    },
  };
  const result = evaluateHistoryFacts(input);
  expect(result.evaluation).toBe("TRUSTED");
  expect(input.boundary.cutoffSequence).toBeNull();
  for (const wrong of [
    { committed: false },
    { processInstanceId: "prior" },
    { generation: 3 },
    { cutoffSequence: 1 },
  ])
    deny({
      ...input,
      runtimeProvisioning: { ...input.runtimeProvisioning, ...wrong },
    });
});
test("PROVISIONED NULL / UNPROVISIONED zero reject invalid state-cutoff combinations", () => {
  const f = model(0);
  deny({
    ...f,
    scope: { ...f.scope, cutoffSequence: null },
    boundary: { ...f.boundary, cutoffSequence: null },
  });
  deny({ ...f, boundary: { ...f.boundary, providerState: "UNPROVISIONED" } });
});
test("Metadata provider/missing/status/lastSequence errors fail closed", () => {
  const f = model();
  for (const metadata of [
    null,
    { ...f.history.metadata!, providerKey: "unknown" },
    { ...f.history.metadata!, historyStatus: "INVALID" },
    { ...f.history.metadata!, lastSequence: 3 },
  ])
    deny({ ...f, history: { ...f.history, metadata } });
});
for (const input of [
  null,
  {},
  { scope: null },
  {
    get scope() {
      throw Error("secret credential");
    },
  },
])
  test("Malformed or throwing inputs return sanitized BLOCKED without partial classification", () => {
    const result = evaluateHistoryFacts(
      input as unknown as HistoryEvaluationFacts,
    );
    expect(result.evaluation).toBe("BLOCKED");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result).not.toHaveProperty("classification");
  });
test("Assessment copies/freezes classification and never mutates or persists facts", () => {
  const f = model();
  const before = JSON.stringify(f);
  const result = evaluateHistoryFacts(f);
  expect(JSON.stringify(f)).toBe(before);
  if (result.evaluation === "BLOCKED") throw Error();
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.classification.old)).toBe(true);
  expect(
    Object.isFrozen(result.classification.newUncertain[0].consumptions),
  ).toBe(true);
  expect(result.classification.old[0]).not.toBe(f.history.consumptions[0]);
  expect(Object.isFrozen(result.classification.old[0])).toBe(true);
});

for (const generation of [0, 1, -1, 2.5, Number.MAX_SAFE_INTEGER + 1])
  test(`Invalid current Generation ${generation} fails closed`, () => {
    const f = model();
    deny({ ...f, scope: { ...f.scope, generation } });
  });
test("Runtime cutoff negative zero cannot masquerade as confirmed zero", () => {
  const f = model(0);
  const scope = { ...f.scope, cutoffSequence: null };
  deny({
    ...f,
    scope,
    boundary: {
      ...scope,
      startupOutcome: "committed",
      providerState: "UNPROVISIONED",
    },
    valid: f.valid.map((r) => ({ ...r, cutoffSequence: null })),
    runtimeProvisioning: { ...scope, committed: true, cutoffSequence: -0 },
  });
});
test("History assessment does not erase independent SUSPENDED Provider status", () => {
  const f = model(0);
  const input = {
    ...f,
    history: {
      ...f.history,
      metadata: { ...f.history.metadata!, historyStatus: "SUSPENDED" as const },
    },
  };
  expect(evaluateHistoryFacts(input).evaluation).toBe("TRUSTED");
  expect(input.history.metadata.historyStatus).toBe("SUSPENDED");
  const result = new QuotaGuard().evaluate(TOMORROW_IO, input.history, 1000, {
    clockTrusted: true,
    historyTimestampsTrusted: true,
    historyComplete: true,
  });
  expect(result).toMatchObject({
    allowed: false,
    reason: "provider_suspended",
  });
});

test("Consumption before Metadata initialization is BLOCKED", () => {
  const f = model();
  const result = evaluateHistoryFacts({
    ...f,
    history: {
      ...f.history,
      metadata: { ...f.history.metadata!, initializedAtMs: 11 },
    },
  });
  expect(result).toEqual({
    evaluation: "BLOCKED",
    reason: "invalid_history_timestamp",
  });
});
for (const cutoff of [0, 2, 4])
  test(`Timestamp reversal in Sequence order is BLOCKED (cutoff ${cutoff})`, () => {
    const f = model(cutoff);
    const result = evaluateHistoryFacts({
      ...f,
      history: {
        ...f.history,
        consumptions: f.history.consumptions.map((r) =>
          r.sequence === 4 ? { ...r, reservedAtMs: 25 } : r,
        ),
      },
      valid: f.valid.map((r) =>
        r.sequence === 4 ? { ...r, reservedAtMs: 25 } : r,
      ),
    });
    expect(result).toEqual({
      evaluation: "BLOCKED",
      reason: "invalid_history_timestamp",
    });
  });
test("Timestamp equal to initialization or preceding Consumption is accepted", () => {
  const f = model();
  const result = evaluateHistoryFacts({
    ...f,
    history: {
      metadata: { ...f.history.metadata!, initializedAtMs: 10 },
      consumptions: f.history.consumptions.map((r) =>
        r.sequence === 2 ? { ...r, reservedAtMs: 10 } : r,
      ),
    },
  });
  expect(result.evaluation).toBe("CONSERVATIVE");
});
