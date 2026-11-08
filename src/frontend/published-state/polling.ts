// 表示用APIのPolling（docs/technology-stack.md 7.3、docs/frontend-development.md 11.3）。
// Reactに依存しない。Timer・fetchは差し替えられるようにし、Fake Timerでテストする。
import { parsePublishedStates, type PublishedStates } from "./schema";

export const PUBLISHED_STATES_PATH = "/api/published-states";
/** 前回のRequestの完了から次のRequestまで。 */
export const POLLING_INTERVAL_MS = 30_000;
export const POLLING_TIMEOUT_MS = 5_000;

/**
 * - `waiting`：最初の応答を待っている（UI設計 6.5）
 * - `received`：一度以上、正常に取得した
 * - `neverReceived`：一度も正常取得できないまま、最初のPollingが失敗した
 */
export type PollingStatus = "waiting" | "received" | "neverReceived";

export type PollingSnapshot = {
  readonly status: PollingStatus;
  /** 最後に正常取得した`states`。HTTP取得の失敗では保持したままにする。 */
  readonly states: PublishedStates;
  /** このSnapshotを作った時刻（ms）。表示の再評価の基準に使う。 */
  readonly at: number;
};

export const INITIAL_SNAPSHOT: PollingSnapshot = Object.freeze({
  status: "waiting",
  states: Object.freeze({}),
  at: 0,
});

export type PollingRuntime = {
  readonly fetch: typeof globalThis.fetch;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
};

const browserRuntime = (): PollingRuntime => ({
  fetch: (input, init) => globalThis.fetch(input, init),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
});

/** 1回のRequest。成功なら`states`、HTTP取得の失敗ならnull。 */
async function requestOnce(
  runtime: PollingRuntime,
  signal: AbortSignal,
): Promise<PublishedStates | null> {
  try {
    const response = await runtime.fetch(PUBLISHED_STATES_PATH, {
      signal,
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (response.status !== 200) return null; // 503を含む
    return parsePublishedStates(await response.json());
  } catch {
    return null; // 通信失敗・Timeout・JSONとして読めない
  }
}

/**
 * Pollingを開始し、停止関数を返す。初回は即時、以降は前回の完了から30秒後。
 * 同時に実行するRequestは最大1件。即時Retry・Backoffはしない。
 */
export function startPolling(
  onSnapshot: (snapshot: PollingSnapshot) => void,
  runtime: PollingRuntime = browserRuntime(),
): () => void {
  let snapshot = INITIAL_SNAPSHOT;
  let stopped = false;
  let timer: unknown;
  let inFlight: AbortController | null = null;

  const run = async () => {
    timer = undefined;
    if (stopped) return;
    const controller = new AbortController();
    inFlight = controller;
    const timeout = runtime.setTimeout(
      () => controller.abort(),
      POLLING_TIMEOUT_MS,
    );
    const states = await requestOnce(runtime, controller.signal);
    runtime.clearTimeout(timeout);
    inFlight = null;
    if (stopped) return;
    if (states !== null) {
      snapshot = { status: "received", states, at: Date.now() };
      onSnapshot(snapshot);
    } else if (snapshot.status === "waiting") {
      snapshot = {
        status: "neverReceived",
        states: snapshot.states,
        at: Date.now(),
      };
      onSnapshot(snapshot);
    }
    timer = runtime.setTimeout(() => void run(), POLLING_INTERVAL_MS);
  };

  void run();
  return () => {
    stopped = true;
    if (timer !== undefined) runtime.clearTimeout(timer);
    inFlight?.abort();
  };
}
