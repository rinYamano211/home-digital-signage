import {
  NativeHttpAdapter,
  type HttpRuntime,
} from "../../src/backend/http/internal/native-http-adapter.js";
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export const checkpoint = () =>
  new Promise<void>((resolve) => setImmediate(resolve));
export function adapterFixture(
  response: Response | Promise<Response>,
  limit = 262144,
) {
  const timeout = new AbortController();
  const gate = new AbortController();
  let signal!: AbortSignal;
  let calls = 0;
  const runtime: HttpRuntime = {
    fetch: (_input, init) => {
      calls++;
      signal = init!.signal!;
      return Promise.resolve(response);
    },
    timeout: () => timeout.signal,
    combine: (signals) => AbortSignal.any(signals),
  };
  const adapter = new NativeHttpAdapter(
    {
      url: "https://fixture.invalid/?apiKey=synthetic-private",
      maxBodyBytes: limit,
    },
    runtime,
  );
  return {
    adapter,
    runtime,
    timeout,
    gate,
    signal: () => signal,
    calls: () => calls,
  };
}
export function controlledBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return { stream, controller: () => controller };
}

export type ReleaseRoute = "normal" | "body_error" | "size_cancel";
export type ReleaseFault =
  "before" | "after" | "no_release" | "relock" | "relock_microtask";
export function releaseFaultFixture(route: ReleaseRoute, fault: ReleaseFault) {
  const secret = "synthetic-private-release-error";
  let cancelCalls = 0;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      if (route === "body_error")
        c.error(new Error("synthetic-private-body-error"));
      else {
        c.enqueue(new Uint8Array(route === "size_cancel" ? 5 : 2));
        if (route === "normal") c.close();
      }
    },
    cancel() {
      cancelCalls++;
    },
  });
  const response = new Response(body, {
    status: 429,
    headers: { "retry-after": "12" },
  });
  const originalGet = body.getReader.bind(body);
  const nativeLocked = Object.getOwnPropertyDescriptor(
    ReadableStream.prototype,
    "locked",
  )!.get!;
  let releaseCalls = 0,
    closedSettled = false;
  let releaseOriginal: (() => void) | undefined;
  let extra: ReadableStreamDefaultReader<Uint8Array> | undefined;
  body.getReader = (() => {
    const reader = originalGet();
    void reader.closed.then(
      () => {
        closedSettled = true;
      },
      () => {
        closedSettled = true;
      },
    );
    releaseOriginal = reader.releaseLock.bind(reader);
    reader.releaseLock = () => {
      releaseCalls++;
      if (fault !== "before" && fault !== "no_release") releaseOriginal!();
      if (fault === "relock") {
        extra = originalGet();
        void extra.closed.catch(() => undefined);
      }
      if (fault === "relock_microtask")
        queueMicrotask(() => {
          extra = originalGet();
          void extra.closed.catch(() => undefined);
        });
      if (fault !== "no_release") throw new Error(secret);
    };
    return reader;
  }) as typeof body.getReader;
  const f = adapterFixture(response, 4);
  return {
    ...f,
    body,
    secret,
    closedSettled: () => closedSettled,
    releaseCalls: () => releaseCalls,
    cancelCalls: () => cancelCalls,
    locked: () => nativeLocked.call(body) as boolean,
    cleanup: () => {
      if (extra) extra.releaseLock();
      else releaseOriginal?.();
    },
  };
}
