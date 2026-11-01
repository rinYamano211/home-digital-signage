import type { HttpStartAdapter } from "../../send/internal/provider-send-gate.js";
import {
  ABSOLUTE_MAX_BODY_BYTES,
  type HttpAdapterConfig,
  type HttpMetadata,
  type HttpOutcome,
} from "../outcome.js";

/** Internal dependency boundary for fault injection; never exposed by the
 * production factory. No injected success/Trust/Provider policy in production.
 */
export interface HttpRuntime {
  fetch: typeof globalThis.fetch;
  timeout(ms: number): AbortSignal;
  combine(signals: AbortSignal[]): AbortSignal;
}
type Settled = { ok: true } | { ok: false; error: unknown };
function settled(p: Promise<unknown>): Promise<Settled> {
  return p.then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );
}
const pending = <T>(): Promise<T> => new Promise(() => {});
const violation = () => new Error("HTTP adapter contract failure");

/** Owns native Headers Promise, Body reader and cancellation. start is
 * intentionally synchronous through fetch(); only Body handling is async.
 */
export class NativeHttpAdapter implements HttpStartAdapter {
  private readonly url: string;
  private readonly headers: Headers;
  private readonly limit: number;
  constructor(
    config: HttpAdapterConfig,
    private readonly runtime: HttpRuntime,
  ) {
    try {
      const url = new URL(config.url);
      const limit = config.maxBodyBytes;
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        !Number.isSafeInteger(limit) ||
        limit < 0 ||
        limit > ABSOLUTE_MAX_BODY_BYTES
      )
        throw violation();
      this.url = url.href;
      this.headers = new Headers(config.headers);
      this.limit = limit;
    } catch {
      throw new TypeError("Invalid HTTP adapter configuration");
    }
  }
  start(
    gateSignal: AbortSignal,
    lifecycleEnded: () => void,
  ): Promise<HttpOutcome> {
    let timeout: AbortSignal;
    let signal: AbortSignal;
    try {
      timeout = this.runtime.timeout(10_000);
      signal = this.runtime.combine([gateSignal, timeout]);
    } catch {
      // Proven before fetch: no HTTP/body work exists. Gate's STARTING guard
      // remains occupied until this synchronous call returns/throws.
      try {
        lifecycleEnded();
      } catch {
        throw violation();
      }
      throw new Error("HTTP preparation failed before start");
    }
    let headers: Promise<Response>;
    try {
      headers = this.runtime.fetch(this.url, { headers: this.headers, signal });
      if (!(headers instanceof Promise)) throw violation();
    } catch {
      // fetch may have partially started. No Promise/ownership proof: do not
      // notify completion or guess that the Request never started.
      throw new Error("HTTP start outcome unconfirmed");
    }
    return new Promise<HttpOutcome>((resolve, reject) => {
      void this.collect(headers, signal, gateSignal, timeout).then(
        (outcome) => {
          // collect only returns when all owned operations have terminated.
          // Freeze result/metadata BEFORE the one notification. No await or extra
          // callback between notification and result delivery.
          try {
            lifecycleEnded();
            resolve(outcome);
          } catch {
            reject(violation());
          }
        },
        () => reject(violation()),
      ); // never leak original URL/error/credentials
    });
  }
  private async collect(
    headers: Promise<Response>,
    signal: AbortSignal,
    gate: AbortSignal,
    timeout: AbortSignal,
  ): Promise<HttpOutcome> {
    let response: Response;
    try {
      response = await headers;
    } catch (error) {
      return Object.freeze({
        kind: this.failureKind(error, signal, gate, timeout, "network_error"),
      });
    }
    const http: HttpMetadata = Object.freeze({
      status: response.status,
      ...(response.headers.get("retry-after") === null
        ? {}
        : { retryAfter: response.headers.get("retry-after")! }),
    });
    if (!response.body)
      return Object.freeze({ kind: "response", http, body: new Uint8Array() });
    const reader = response.body.getReader();
    // Capture native closed BEFORE any releaseLock; artificial rejection from
    // releasing a reader must never be counted as transport completion.
    const closed = settled(reader.closed);
    const chunks: Uint8Array[] = [];
    let size = 0;
    const rawLength = response.headers.get("content-length");
    const encoding = response.headers.get("content-encoding");
    const tooLong =
      (!encoding || encoding.toLowerCase() === "identity") &&
      rawLength !== null &&
      /^\d+$/.test(rawLength) &&
      Number(rawLength) > this.limit;
    const tooLarge = async (): Promise<HttpOutcome> => {
      // Terminal classification/metadata precedes cleanup. A subsequent
      // Timeout/Abort during cancel must not overwrite body_too_large.
      const outcome = Object.freeze({ kind: "body_too_large" as const, http });
      let cancellation: Settled;
      try {
        cancellation = await settled(reader.cancel());
      } catch (error) {
        cancellation = { ok: false, error };
      }
      const stream = await closed;
      // Cancel rejection alone is not proof. Only a matching actual Stream
      // error (without releasing the lock) can establish the errored path.
      if (
        !cancellation.ok &&
        (stream.ok || stream.error !== cancellation.error)
      )
        return pending();
      reader.releaseLock();
      return outcome;
    };
    if (tooLong) return tooLarge();
    while (true) {
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch (error) {
        const outcome: HttpOutcome = Object.freeze({
          kind: this.failureKind(error, signal, gate, timeout, "body_error"),
          http,
        });
        const stream = await closed;
        if (stream.ok || stream.error !== error) return pending();
        reader.releaseLock();
        return outcome;
      }
      if (read.done) {
        const stream = await closed;
        if (!stream.ok) return pending();
        const body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const outcome = Object.freeze({
          kind: "response" as const,
          http,
          body,
        });
        reader.releaseLock();
        return outcome;
      }
      if (!(read.value instanceof Uint8Array)) throw violation();
      const length = read.value.byteLength;
      if (size + length > this.limit) return tooLarge(); // never retain excess chunk
      chunks.push(read.value.slice()); // snapshot; Stream may reuse its buffer
      size += length;
    }
  }
  private failureKind<T extends "network_error" | "body_error">(
    error: unknown,
    signal: AbortSignal,
    gate: AbortSignal,
    timeout: AbortSignal,
    fallback: T,
  ): "timeout" | "aborted" | T {
    // Identity provides causal evidence. A later unrelated TypeError is not
    // reclassified merely because a signal happens to have expired.
    if (signal.aborted && error === signal.reason) {
      if (timeout.aborted && signal.reason === timeout.reason) return "timeout";
      if (gate.aborted && signal.reason === gate.reason) return "aborted";
    }
    return fallback;
  }
}
