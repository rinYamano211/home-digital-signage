import { NativeHttpAdapter } from "./internal/native-http-adapter.js";
import type { HttpAdapterConfig } from "./outcome.js";

/** Native Node.js 24 Adapter. Provider URL/headers/body-limit selection belongs
 * to the caller. Not connected to production Gate/Trust/Coordinator in 5A.
 * The factory exposes no fetch/Signal/test-double injection options.
 */
export function createHttpAdapter(
  config: HttpAdapterConfig,
): NativeHttpAdapter {
  return new NativeHttpAdapter(config, {
    fetch: (input, init) => globalThis.fetch(input, init),
    timeout: (ms) => AbortSignal.timeout(ms),
    combine: (signals) => AbortSignal.any(signals),
  });
}
