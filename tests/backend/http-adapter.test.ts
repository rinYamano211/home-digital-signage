import { NativeHttpAdapter } from "../../src/backend/http/internal/native-http-adapter.js";
import { afterEach, expect, test, vi } from "vitest";
import { createHttpAdapter } from "../../src/backend/http/native-http-adapter.js";
import {
  adapterFixture,
  controlledBody,
  deferred,
  checkpoint,
} from "../support/http-adapter-fixture.js";
afterEach(() => vi.restoreAllMocks());

test.each([-1, NaN, Infinity, 0.5, 1_048_577])(
  "I10 invalid limit %s rejected at construction",
  (limit) => {
    expect(() =>
      createHttpAdapter({
        url: "https://fixture.invalid",
        maxBodyBytes: limit,
      }),
    ).toThrow("Invalid HTTP adapter configuration");
  },
);
test.each([0, 262144, 1048576])("I10 valid limit %s accepted", (limit) => {
  expect(() =>
    createHttpAdapter({ url: "https://fixture.invalid", maxBodyBytes: limit }),
  ).not.toThrow();
});
test.each([
  "bad-url?apiKey=synthetic-private",
  "file:///private",
  "https://user:synthetic-private@fixture.invalid",
])("I12 invalid URL never leaks credentials", (url) => {
  let error: unknown;
  try {
    createHttpAdapter({ url, maxBodyBytes: 1 });
  } catch (e) {
    error = e;
  }
  expect((error as Error).message).toBe("Invalid HTTP adapter configuration");
  expect(JSON.stringify(error)).not.toContain("synthetic-private");
});
test("I01/I02 fetch called synchronously before start returns; native Headers Promise is not returned", async () => {
  const headers = deferred<Response>();
  const f = adapterFixture(headers.promise);
  const ended = vi.fn();
  const p = f.adapter.start(f.gate.signal, ended);
  expect(f.calls()).toBe(1);
  expect(p).not.toBe(headers.promise);
  expect(ended).not.toHaveBeenCalled();
  headers.resolve(new Response("ok"));
  expect(await p).toMatchObject({
    kind: "response",
    body: new Uint8Array([111, 107]),
  });
  expect(ended).toHaveBeenCalledTimes(1);
});
test("I03 proven preparation failure notifies once before throwing sanitized error", () => {
  const f = adapterFixture(new Response());
  f.runtime.timeout = () => {
    throw new Error("synthetic-private");
  };
  const ended = vi.fn();
  expect(() => f.adapter.start(f.gate.signal, ended)).toThrow(
    "HTTP preparation failed before start",
  );
  expect(ended).toHaveBeenCalledTimes(1);
  expect(f.calls()).toBe(0);
});
test("I03 preparation notification throw is sanitized without another notification", () => {
  const f = adapterFixture(new Response());
  f.runtime.combine = () => {
    throw new Error();
  };
  const ended = vi.fn(() => {
    throw new Error("synthetic-private");
  });
  expect(() => f.adapter.start(f.gate.signal, ended)).toThrow(
    "HTTP adapter contract failure",
  );
  expect(ended).toHaveBeenCalledTimes(1);
});
test("I03 fetch synchronous throw never proves completion", () => {
  const f = adapterFixture(new Response());
  f.runtime.fetch = () => {
    throw new Error("synthetic-private");
  };
  const ended = vi.fn();
  expect(() => f.adapter.start(f.gate.signal, ended)).toThrow(
    "HTTP start outcome unconfirmed",
  );
  expect(ended).not.toHaveBeenCalled();
});
test("I03 non-Promise fetch return is an uncertain internal contract violation", () => {
  const f = adapterFixture(new Response());
  f.runtime.fetch = (() => ({})) as unknown as typeof fetch;
  const ended = vi.fn();
  expect(() => f.adapter.start(f.gate.signal, ended)).toThrow(
    "HTTP start outcome unconfirmed",
  );
  expect(ended).not.toHaveBeenCalled();
});
test("I09/I12 native fetch rejection is sanitized network_error, not a thrown Provider exception", async () => {
  const f = adapterFixture(Promise.reject(new Error("synthetic-private")));
  const ended = vi.fn();
  expect(await f.adapter.start(f.gate.signal, ended)).toEqual({
    kind: "network_error",
  });
  expect(ended).toHaveBeenCalledTimes(1);
});
test.each(["gate", "timeout"] as const)(
  "I08/I09 proven %s fetch rejection",
  async (source) => {
    const headers = deferred<Response>();
    const f = adapterFixture(headers.promise);
    const ended = vi.fn();
    const p = f.adapter.start(f.gate.signal, ended);
    const reason = new DOMException(
      "synthetic-private",
      source === "timeout" ? "TimeoutError" : "AbortError",
    );
    f[source].abort(reason);
    headers.reject(reason);
    expect(await p).toEqual({
      kind: source === "timeout" ? "timeout" : "aborted",
    });
    expect(ended).toHaveBeenCalledTimes(1);
  },
);
test("I09 unrelated failure after Signal expiration is not attributed to Timeout", async () => {
  const headers = deferred<Response>();
  const f = adapterFixture(headers.promise);
  const p = f.adapter.start(f.gate.signal, () => {});
  f.timeout.abort(new DOMException("", "TimeoutError"));
  headers.reject(new TypeError("unrelated"));
  expect(await p).toEqual({ kind: "network_error" });
});
test.each([204, 205, 304])("I04/I05 Body-less %s Response", async (status) => {
  const f = adapterFixture(new Response(null, { status }));
  const ended = vi.fn();
  expect(await f.adapter.start(f.gate.signal, ended)).toEqual({
    kind: "response",
    http: { status },
    body: new Uint8Array(),
  });
  expect(ended).toHaveBeenCalledTimes(1);
});
test.each([200, 429, 500])(
  "I09 HTTP %s remains response with uninterpreted metadata",
  async (status) => {
    const f = adapterFixture(
      new Response("ok", {
        status,
        headers: {
          "retry-after": "Wed, 21 Oct 2030 07:28:00 GMT",
          "x-secret": "synthetic-private",
        },
      }),
    );
    const outcome = await f.adapter.start(f.gate.signal, () => {});
    expect(outcome).toMatchObject({
      kind: "response",
      http: { status, retryAfter: "Wed, 21 Oct 2030 07:28:00 GMT" },
    });
    expect(Object.keys(outcome).sort()).toEqual(["body", "http", "kind"]);
    expect(JSON.stringify(outcome)).not.toContain("synthetic-private");
  },
);
test("I04 Body/reader single ownership without clone or tee", async () => {
  const response = new Response("body");
  const get = vi.spyOn(response.body!, "getReader"),
    clone = vi.spyOn(response, "clone"),
    tee = vi.spyOn(response.body!, "tee");
  const f = adapterFixture(response);
  await f.adapter.start(f.gate.signal, () => {});
  expect(get).toHaveBeenCalledTimes(1);
  expect(clone).not.toHaveBeenCalled();
  expect(tee).not.toHaveBeenCalled();
  expect(response.bodyUsed).toBe(true);
});
test("I05/I08 Headers and expired Signals alone leave result pending", async () => {
  const body = controlledBody();
  const f = adapterFixture(new Response(body.stream, { status: 429 }));
  const ended = vi.fn();
  let delivered = false;
  const p = f.adapter.start(f.gate.signal, ended);
  void p.then(() => {
    delivered = true;
  });
  await checkpoint();
  f.timeout.abort(new DOMException("", "TimeoutError"));
  await checkpoint();
  expect(delivered).toBe(false);
  expect(ended).not.toHaveBeenCalled();
  body.controller().error(f.signal().reason);
  expect(await p).toEqual({ kind: "timeout", http: { status: 429 } });
  expect(ended).toHaveBeenCalledTimes(1);
});
test.each([429, 500])(
  "I09 %s Body error retains HttpMetadata",
  async (status) => {
    const body = controlledBody();
    const f = adapterFixture(
      new Response(body.stream, { status, headers: { "retry-after": "12" } }),
    );
    const p = f.adapter.start(f.gate.signal, () => {});
    await checkpoint();
    body.controller().error(new Error("synthetic-private"));
    expect(await p).toEqual({
      kind: "body_error",
      http: { status, retryAfter: "12" },
    });
  },
);
test.each(["gate", "timeout"] as const)(
  "I09 429 %s actual ending takes priority over 429 retry",
  async (source) => {
    const body = controlledBody();
    const f = adapterFixture(
      new Response(body.stream, {
        status: 429,
        headers: { "retry-after": "12" },
      }),
    );
    const p = f.adapter.start(f.gate.signal, () => {});
    await checkpoint();
    f[source].abort(
      new DOMException(
        "",
        source === "timeout" ? "TimeoutError" : "AbortError",
      ),
    );
    body.controller().error(f.signal().reason);
    expect(await p).toEqual({
      kind: source === "timeout" ? "timeout" : "aborted",
      http: { status: 429, retryAfter: "12" },
    });
  },
);
test("I09 first composite Signal cause survives the other Signal expiring later", async () => {
  const body = controlledBody();
  const f = adapterFixture(new Response(body.stream, { status: 429 }));
  const p = f.adapter.start(f.gate.signal, () => {});
  await checkpoint();
  f.gate.abort(new DOMException("", "AbortError"));
  f.timeout.abort(new DOMException("", "TimeoutError"));
  body.controller().error(f.signal().reason);
  expect(await p).toMatchObject({ kind: "aborted" });
});
test.each([262143, 262144, 262145, 1048575, 1048576, 1048577])(
  "I10 real Byte boundary %s",
  async (length) => {
    const limit = length > 300000 ? 1048576 : 262144;
    const f = adapterFixture(new Response(new Uint8Array(length)), limit);
    const outcome = await f.adapter.start(f.gate.signal, () => {});
    expect(outcome.kind).toBe(length > limit ? "body_too_large" : "response");
    if (outcome.kind === "response")
      expect(outcome.body.byteLength).toBe(length);
  },
);
test.each([null, "invalid", "-1", "3.5", "0", "1", "999999"])(
  "I10 Content-Length %s is a hint, never replaces Byte checking",
  async (length) => {
    const headers = new Headers();
    if (length !== null) headers.set("content-length", length);
    const f = adapterFixture(new Response(new Uint8Array(5), { headers }), 4);
    expect((await f.adapter.start(f.gate.signal, () => {})).kind).toBe(
      "body_too_large",
    );
  },
);
test("I10 valid oversized Content-Length cancels before reading", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  const response = new Response(body, { headers: { "content-length": "100" } });
  const get = body.getReader.bind(body);
  let readCount = 0;
  vi.spyOn(body, "getReader").mockImplementation((...args: []) => {
    const r = get(...args);
    const read = r.read.bind(r);
    r.read = () => {
      readCount++;
      return read();
    };
    return r;
  });
  const f = adapterFixture(response, 4);
  expect((await f.adapter.start(f.gate.signal, () => {})).kind).toBe(
    "body_too_large",
  );
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(readCount).toBe(0);
});
test("I10 chunks accumulate and oversized chunk is not adopted", async () => {
  const body = controlledBody();
  const f = adapterFixture(new Response(body.stream), 4);
  const p = f.adapter.start(f.gate.signal, () => {});
  body.controller().enqueue(new Uint8Array([1, 2]));
  body.controller().enqueue(new Uint8Array([3, 4]));
  body.controller().enqueue(new Uint8Array([5]));
  expect(await p).toEqual({ kind: "body_too_large", http: { status: 200 } });
});
test("I05/I09/I10 size terminal survives Abort during delayed cancel; no finish before cancel completion", async () => {
  const cancel = deferred<void>();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(5));
    },
    cancel() {
      cancelled = true;
      return cancel.promise;
    },
  });
  const f = adapterFixture(
    new Response(stream, { status: 429, headers: { "retry-after": "12" } }),
    4,
  );
  const ended = vi.fn();
  let delivered = false;
  const p = f.adapter.start(f.gate.signal, ended);
  void p.then(() => {
    delivered = true;
  });
  await checkpoint();
  expect(cancelled).toBe(true);
  expect(ended).not.toHaveBeenCalled();
  expect(delivered).toBe(false);
  f.gate.abort();
  f.timeout.abort();
  cancel.resolve();
  expect(await p).toEqual({
    kind: "body_too_large",
    http: { status: 429, retryAfter: "12" },
  });
  expect(ended).toHaveBeenCalledTimes(1);
});
test("I05/I08 cancel rejection without actual Stream error is not completion", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(5));
    },
    cancel() {
      return Promise.reject(new Error("synthetic-private"));
    },
  });
  const f = adapterFixture(new Response(stream), 4);
  const ended = vi.fn();
  let delivered = false;
  void f.adapter.start(f.gate.signal, ended).then(() => {
    delivered = true;
  });
  await checkpoint();
  expect(ended).not.toHaveBeenCalled();
  expect(delivered).toBe(false);
});
test("I06/I07 late Abort in notification cannot change fixed response or notify twice", async () => {
  const f = adapterFixture(new Response("ok"));
  const events: string[] = [];
  const ended = vi.fn(() => {
    events.push("finish");
    f.gate.abort();
    f.timeout.abort();
  });
  const p = f.adapter.start(f.gate.signal, ended).then((o) => {
    events.push("delivery");
    return o;
  });
  expect((await p).kind).toBe("response");
  expect(events).toEqual(["finish", "delivery"]);
  expect(ended).toHaveBeenCalledTimes(1);
});
test("I06/I12 exception after legitimate finish rejects sanitized without another notification", async () => {
  const f = adapterFixture(new Response("ok"));
  const ended = vi.fn(() => {
    throw new Error("synthetic-private");
  });
  await expect(f.adapter.start(f.gate.signal, ended)).rejects.toThrow(
    "HTTP adapter contract failure",
  );
  expect(ended).toHaveBeenCalledTimes(1);
});
test("I12 unexpected internal Body contract failure is sanitized and does not assert completion", async () => {
  const body = new ReadableStream({
    start(c) {
      c.enqueue("synthetic-private");
      c.close();
    },
  });
  const f = adapterFixture(new Response(body as ReadableStream<Uint8Array>));
  const ended = vi.fn();
  await expect(f.adapter.start(f.gate.signal, ended)).rejects.toThrow(
    "HTTP adapter contract failure",
  );
  expect(ended).not.toHaveBeenCalled();
});

test("I05 read rejection without native closed proof remains Pending and does not releaseLock", async () => {
  const response = new Response("unused"),
    read = deferred<ReadableStreamReadResult<Uint8Array>>(),
    closed = deferred<void>();
  const releaseLock = vi.fn();
  const reader = {
    read: () => read.promise,
    closed: closed.promise,
    releaseLock,
    cancel: () => Promise.resolve(),
  };
  vi.spyOn(response.body!, "getReader").mockReturnValue(
    reader as ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>,
  );
  const f = adapterFixture(response);
  const end = vi.fn();
  let delivered = false;
  const failure = new TypeError("synthetic-private");
  const p = f.adapter.start(f.gate.signal, end);
  void p.then(() => {
    delivered = true;
  });
  await checkpoint();
  read.reject(failure);
  await checkpoint();
  expect(delivered).toBe(false);
  expect(end).not.toHaveBeenCalled();
  expect(releaseLock).not.toHaveBeenCalled();
  closed.reject(failure);
  expect(await p).toMatchObject({ kind: "body_error" });
  expect(releaseLock).toHaveBeenCalledTimes(1);
  expect(end).toHaveBeenCalledTimes(1);
});
test("I05 Cancel rejection can only complete with matching actual Stream error", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.error(new TypeError("synthetic-private"));
    },
  });
  const f = adapterFixture(
    new Response(stream, {
      status: 429,
      headers: { "content-length": "99", "retry-after": "12" },
    }),
    4,
  );
  const end = vi.fn();
  expect(await f.adapter.start(f.gate.signal, end)).toEqual({
    kind: "body_too_large",
    http: { status: 429, retryAfter: "12" },
  });
  expect(end).toHaveBeenCalledTimes(1);
});
test("I09 Body error is not retroactively overwritten by later Timeout", async () => {
  const body = controlledBody();
  const f = adapterFixture(
    new Response(body.stream, {
      status: 429,
      headers: { "retry-after": "12" },
    }),
  );
  const p = f.adapter.start(f.gate.signal, () => {
    f.timeout.abort();
  });
  await checkpoint();
  body.controller().error(new TypeError("body"));
  expect(await p).toEqual({
    kind: "body_error",
    http: { status: 429, retryAfter: "12" },
  });
});

test("I10 configuration limit is snapshotted once so a changing getter cannot bypass cap", async () => {
  const f = adapterFixture(new Response(new Uint8Array(2)));
  let reads = 0;
  const adapter = new NativeHttpAdapter(
    {
      url: "https://fixture.invalid",
      get maxBodyBytes() {
        reads++;
        return reads === 1 ? 1 : 100_000_000;
      },
    },
    f.runtime,
  );
  expect(reads).toBe(1);
  expect((await adapter.start(f.gate.signal, () => {})).kind).toBe(
    "body_too_large",
  );
  expect(reads).toBe(1);
});
