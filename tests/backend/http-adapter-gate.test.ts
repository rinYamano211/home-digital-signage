import { afterEach, expect, test, vi } from "vitest";
import {
  ProviderSendGate,
  type HttpStartAdapter,
} from "../../src/backend/send/internal/provider-send-gate.js";
import { PermitRegistry } from "../../src/backend/send/internal/permits.js";
import type { HttpOutcome } from "../../src/backend/http/outcome.js";
import {
  adapterFixture,
  controlledBody,
  checkpoint,
  deferred,
} from "../support/http-adapter-fixture.js";
import { fixture, provider } from "../support/send-gate-fixture.js";
const owned: { f: ReturnType<typeof fixture>; gate: ProviderSendGate }[] = [];
function harness(adapter: HttpStartAdapter) {
  const f = fixture();
  const gate = new ProviderSendGate(
    new Map([[provider, { repository: f.repo, history: f.history }]]),
    f.clock,
    f.time,
    adapter,
  );
  owned.push({ f, gate });
  return { f, gate };
}
function reserve(h: ReturnType<typeof harness>) {
  const a = h.gate.beginAttempt(provider)!;
  const result = h.f.repo.reserve({
    providerKey: provider,
    attempt: a.quotaAttempt,
    trust: () => h.gate.quotaTrust(provider),
  });
  expect(result.outcome).toBe("saved");
  return { ...a, result };
}
afterEach(() => {
  for (const { f, gate } of owned.splice(0)) {
    gate.dispose();
    f.gate.dispose();
    f.db.close();
  }
  vi.restoreAllMocks();
});
test("I01/I02 real Adapter invokes fetch during Gate STARTING, synchronous re-entry blocked", async () => {
  const a = adapterFixture(new Response("ok"));
  const fetch = a.runtime.fetch;
  let observed = "";
  a.runtime.fetch = (i, init) => {
    observed = h.gate.snapshot(provider).phase;
    expect(h.gate.beginAttempt(provider)).toBeNull();
    expect(h.gate.start(r.attempt, r.result).kind).toBe("blocked");
    return fetch(i, init);
  };
  const h: ReturnType<typeof harness> = harness(a.adapter);
  const r = reserve(h);
  const result = h.gate.start(r.attempt, r.result);
  expect(a.calls()).toBe(1);
  expect(observed).toBe("STARTING");
  if (result.kind !== "started") throw new Error();
  expect(((await result.response) as HttpOutcome).kind).toBe("response");
  expect(h.gate.snapshot(provider).phase).toBe("IDLE");
});
test("I03 proven pre-fetch failure finishes synchronously; Gate keeps STARTING through notification re-entry", () => {
  const a = adapterFixture(new Response());
  a.runtime.timeout = () => {
    throw new Error();
  };
  let phase = "";
  const adapter = {
    start: (s: AbortSignal, end: () => void) =>
      a.adapter.start(s, () => {
        end();
        phase = h.gate.snapshot(provider).phase;
        expect(h.gate.beginAttempt(provider)).toBeNull();
      }),
  };
  const h: ReturnType<typeof harness> = harness(adapter);
  const r = reserve(h);
  expect(h.gate.start(r.attempt, r.result)).toMatchObject({
    kind: "blocked",
    reason: "http_start_failed",
  });
  expect(phase).toBe("STARTING");
  expect(h.gate.snapshot(provider).phase).toBe("IDLE");
  expect(a.calls()).toBe(0);
  expect(h.f.rows()).toHaveLength(1);
});
test("I03 uncertain synchronous fetch throw retains ABORT_REQUESTED and consumption", () => {
  const a = adapterFixture(new Response());
  a.runtime.fetch = () => {
    throw new Error("partially started");
  };
  const h = harness(a.adapter);
  const r = reserve(h);
  expect(h.gate.start(r.attempt, r.result)).toMatchObject({
    kind: "blocked",
    reason: "http_start_failed",
  });
  expect(h.gate.snapshot(provider).phase).toBe("ABORT_REQUESTED");
  expect(h.f.rows()).toHaveLength(1);
  expect(h.f.control()).toEqual([]);
});
test("I05/I08 Timeout while read remains unresolved preserves result Pending and Flight", async () => {
  const body = controlledBody();
  const a = adapterFixture(new Response(body.stream, { status: 429 }));
  const h = harness(a.adapter);
  const r = reserve(h);
  const started = h.gate.start(r.attempt, r.result);
  if (started.kind !== "started") throw new Error();
  let delivered = false;
  void started.response.then(() => {
    delivered = true;
  });
  await checkpoint();
  a.timeout.abort(new DOMException("", "TimeoutError"));
  await checkpoint();
  expect(h.gate.snapshot(provider).phase).toBe("IN_FLIGHT");
  expect(delivered).toBe(false);
  expect(h.gate.beginAttempt(provider)).toBeNull();
  body.controller().error(a.signal().reason);
  expect(await started.response).toMatchObject({ kind: "timeout" });
  expect(h.gate.snapshot(provider).phase).toBe("IDLE");
  expect(h.f.rows()).toHaveLength(1);
});
test("I05/I08 delayed cancel with Abort re-entry retains occupancy until actual cancel settles", async () => {
  const cancel = deferred<void>();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(5));
    },
    cancel() {
      expect(h.gate.beginAttempt(provider)).toBeNull();
      return cancel.promise;
    },
  });
  const a = adapterFixture(new Response(stream), 4);
  const h: ReturnType<typeof harness> = harness(a.adapter);
  const r = reserve(h);
  const result = h.gate.start(r.attempt, r.result);
  if (result.kind !== "started") throw new Error();
  await checkpoint();
  const signal = a.signal();
  signal.addEventListener("abort", () =>
    expect(h.gate.beginAttempt(provider)).toBeNull(),
  );
  h.gate.stopControl(provider).stop();
  expect(h.gate.snapshot(provider).phase).toBe("ABORT_REQUESTED");
  let delivered = false;
  void result.response.then(() => {
    delivered = true;
  });
  await checkpoint();
  expect(delivered).toBe(false);
  cancel.resolve();
  expect(await result.response).toMatchObject({ kind: "body_too_large" });
  expect(h.gate.snapshot(provider).phase).toBe("IDLE");
  expect(h.f.rows()).toHaveLength(1);
});
test("I07 lifecycle notification before Promise delivery permits another distinct attempt, not old result authorization", async () => {
  const first = adapterFixture(new Response("first"));
  const next = deferred<Response>();
  let count = 0;
  first.runtime.fetch = () => {
    count++;
    return count === 1 ? Promise.resolve(new Response("first")) : next.promise;
  };
  const events: string[] = [];
  let once = false;
  let nextResult: ReturnType<ProviderSendGate["start"]> | undefined;
  const wrapped = {
    start: (s: AbortSignal, end: () => void) =>
      first.adapter.start(s, () => {
        end();
        if (!once) {
          once = true;
          events.push("finish");
          h.f.advance(4_000_000_000n);
          const a = reserve(h);
          nextResult = h.gate.start(a.attempt, a.result);
          events.push("next-start");
        }
      }),
  };
  const h: ReturnType<typeof harness> = harness(wrapped);
  const r = reserve(h);
  const result = h.gate.start(r.attempt, r.result);
  if (result.kind !== "started") throw new Error();
  await result.response.then(() => events.push("delivery"));
  expect(events).toEqual(["finish", "next-start", "delivery"]);
  expect(h.gate.snapshot(provider).phase).toBe("IN_FLIGHT");
  expect(h.f.rows()).toHaveLength(2);
  expect(h.f.control()).toEqual([]);
  next.resolve(new Response("next"));
  if (nextResult?.kind === "started") await nextResult.response;
  expect(h.gate.snapshot(provider).phase).toBe("IDLE");
});
test("I07 Stop after notification but before Promise delivery never rewrites fixed HTTP result", async () => {
  const a = adapterFixture(
    new Response("ok", { status: 429, headers: { "retry-after": "12" } }),
  );
  const events: string[] = [];
  const h: ReturnType<typeof harness> = harness({
    start: (s, end) =>
      a.adapter.start(s, () => {
        end();
        events.push("finish");
        h.gate.stopControl(provider).stop();
        events.push("stop");
      }),
  });
  const r = reserve(h);
  const result = h.gate.start(r.attempt, r.result);
  if (result.kind !== "started") throw new Error();
  const outcome = await result.response.then((o) => {
    events.push("delivery");
    return o;
  });
  expect(outcome).toMatchObject({
    kind: "response",
    http: { status: 429, retryAfter: "12" },
  });
  expect(events).toEqual(["finish", "stop", "delivery"]);
  expect(h.gate.snapshot(provider).stopped).toBe(true);
  expect(h.f.control()).toEqual([]);
});
test("I06 legitimate finish followed by internal throw rejects once and cannot replay permit", async () => {
  const a = adapterFixture(new Response("ok"));
  let ends = 0;
  const h = harness({
    start: (s, end) =>
      a.adapter.start(s, () => {
        end();
        ends++;
        throw new Error("synthetic-private");
      }),
  });
  const r = reserve(h);
  const result = h.gate.start(r.attempt, r.result);
  if (result.kind !== "started") throw new Error();
  await expect(result.response).rejects.toThrow(
    "HTTP adapter contract failure",
  );
  expect(ends).toBe(1);
  expect(h.gate.snapshot(provider).phase).toBe("IDLE");
  expect(h.gate.start(r.attempt, r.result).kind).toBe("blocked");
  expect(h.f.rows()).toHaveLength(1);
});
test("I07/I11 cleanup exception at notification leaves Provider stopped but safely delivers result", async () => {
  const a = adapterFixture(new Response("ok"));
  const h = harness(a.adapter);
  const r = reserve(h);
  vi.spyOn(h.f.repo, "endAttempt").mockImplementation(() => {
    throw new Error();
  });
  const result = h.gate.start(r.attempt, r.result);
  if (result.kind !== "started") throw new Error();
  expect(((await result.response) as HttpOutcome).kind).toBe("response");
  expect(h.gate.snapshot(provider)).toMatchObject({
    phase: "IDLE",
    stopped: true,
    repositoryFailure: "attempt_cleanup_failed",
  });
  expect(h.f.rows()).toHaveLength(1);
  expect(h.f.control()).toEqual([]);
});

test("I02 Permit consumption, fetch invocation and Gate return precede queued microtasks", async () => {
  const a = adapterFixture(new Response("ok"));
  const order: string[] = [];
  const original = PermitRegistry.prototype.consume;
  vi.spyOn(PermitRegistry.prototype, "consume").mockImplementation(function (
    this: PermitRegistry,
    p,
    b,
  ) {
    order.push("consume");
    return original.call(this, p, b);
  });
  const fetch = a.runtime.fetch;
  a.runtime.fetch = (i, init) => {
    order.push("fetch");
    return fetch(i, init);
  };
  const h = harness(a.adapter),
    r = reserve(h);
  queueMicrotask(() => order.push("microtask"));
  const result = h.gate.start(r.attempt, r.result);
  order.push("return");
  expect(order).toEqual(["consume", "fetch", "return"]);
  if (result.kind !== "started") throw new Error();
  await result.response;
  expect(order).toEqual(["consume", "fetch", "return", "microtask"]);
});
test("I08 Stop while actual owned read is Pending keeps ABORT_REQUESTED until read and closed settle", async () => {
  const body = controlledBody(),
    a = adapterFixture(new Response(body.stream));
  const h = harness(a.adapter),
    r = reserve(h);
  const result = h.gate.start(r.attempt, r.result);
  if (result.kind !== "started") throw new Error();
  let delivered = false;
  void result.response.then(() => {
    delivered = true;
  });
  await checkpoint();
  h.gate.stopControl(provider).stop();
  await checkpoint();
  expect(h.gate.snapshot(provider).phase).toBe("ABORT_REQUESTED");
  expect(delivered).toBe(false);
  expect(h.gate.beginAttempt(provider)).toBeNull();
  body.controller().error(a.signal().reason);
  expect(await result.response).toMatchObject({ kind: "aborted" });
  expect(h.gate.snapshot(provider).phase).toBe("IDLE");
  expect(h.f.rows()).toHaveLength(1);
});
