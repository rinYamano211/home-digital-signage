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
