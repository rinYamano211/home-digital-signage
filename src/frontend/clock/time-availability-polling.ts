// 表示用時刻の利用可否の取得（docs/frontend-development.md 第13章、technology-stack 25.4）。
// Reactに依存しない。Timer・fetch・単調時計は差し替えられるようにし、Fake Timerでテストする。
// Pollingは取得の結果を伝えるだけとし、60秒の期限は別の期限Timerで管理する（13.3）。
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { PollingRuntime } from "../published-state/polling";
import type { TimeAvailability } from "./availability";

export const TIME_AVAILABILITY_PATH = "/api/time-availability";
/** 前回のRequestの完了から次のRequestまで。 */
export const TIME_POLLING_INTERVAL_MS = 10_000;
export const TIME_POLLING_TIMEOUT_MS = 3_000;
/** 最後に取得に成功してから、この時間で`unavailable`にする（暫定）。 */
export const TIME_AVAILABILITY_EXPIRY_MS = 60_000;

export type TimeAvailabilityRuntime = PollingRuntime & {
  /** 単調時計（ms）。System Timeの補正の影響を受けない。 */
  readonly now: () => number;
};

const browserRuntime = (): TimeAvailabilityRuntime => ({
  fetch: (input, init) => globalThis.fetch(input, init),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => performance.now(),
});

const ResponseSchema = Type.Object(
  {
    availability: Type.Union([
      Type.Literal("available"),
      Type.Literal("unavailable"),
    ]),
  },
  { additionalProperties: false },
);

/** Responseの検証。未知の項目があれば不正（null）とする（13.3）。 */
export function parseTimeAvailability(value: unknown): TimeAvailability | null {
  return Value.Check(ResponseSchema, value) ? value.availability : null;
}

/** 1回のRequest。成功なら値、取得の失敗ならnull。 */
async function requestOnce(
  runtime: PollingRuntime,
  signal: AbortSignal,
): Promise<TimeAvailability | null> {
  try {
    const response = await runtime.fetch(TIME_AVAILABILITY_PATH, {
      signal,
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (response.status !== 200) return null;
    return parseTimeAvailability(await response.json());
  } catch {
    return null; // 通信失敗・Timeout・JSONとして読めない
  }
}

/**
 * Pollingを開始し、停止関数を返す。初回は即時、以降は前回の完了から10秒後。
 * 同時に実行するRequestは最大1件。即時Retry・Backoffはしない。
 * 結果（成功なら値、失敗ならnull）を`onResult`へ伝えるだけで、状態は持たない。
 */
export function pollTimeAvailability(
  onResult: (value: TimeAvailability | null) => void,
  runtime: PollingRuntime,
): () => void {
  let stopped = false;
  let timer: unknown;
  let inFlight: AbortController | null = null;

  const run = async () => {
    timer = undefined;
    if (stopped) return;
    const controller = new AbortController();
    inFlight = controller;
    let timeout: unknown;
    // 3秒で通信を中止し、このRequestを失敗として終える。遅れて届いた結果は採用しない。
    const timedOut = new Promise<null>((resolve) => {
      timeout = runtime.setTimeout(() => {
        controller.abort();
        resolve(null);
      }, TIME_POLLING_TIMEOUT_MS);
    });
    const value = await Promise.race([
      requestOnce(runtime, controller.signal),
      timedOut,
    ]);
    runtime.clearTimeout(timeout);
    inFlight = null;
    if (stopped) return;
    onResult(value);
    timer = runtime.setTimeout(() => void run(), TIME_POLLING_INTERVAL_MS);
  };

  void run();
  return () => {
    stopped = true;
    if (timer !== undefined) runtime.clearTimeout(timer);
    inFlight?.abort();
  };
}

/**
 * 取得の結果から表示に渡す値を決める（13.3）。
 * - 最初は`unavailable`（呼び出し側の初期値）。成功したら受け取った値にする。
 * - 失敗では最後の値を保ち、期限も延長しない。
 * - 最後の成功から60秒の期限に達したら、最後の値が`available`なら`unavailable`にする。
 */
export function createTimeAvailabilityExpiry(
  onChange: (value: TimeAvailability) => void,
  runtime: Pick<TimeAvailabilityRuntime, "setTimeout" | "clearTimeout" | "now">,
) {
  let value: TimeAvailability = "unavailable";
  let lastSuccessAt = 0;
  let timer: unknown;
  let disposed = false;

  const set = (next: TimeAvailability) => {
    if (next === value) return;
    value = next;
    onChange(next);
  };
  const schedule = (ms: number) => {
    if (timer !== undefined) runtime.clearTimeout(timer);
    timer = runtime.setTimeout(expire, ms);
  };
  // Timerが早く発火しても、単調時計で60秒の経過を確かめてから移す。
  function expire() {
    timer = undefined;
    if (disposed) return;
    const remaining =
      lastSuccessAt + TIME_AVAILABILITY_EXPIRY_MS - runtime.now();
    if (remaining > 0) {
      schedule(remaining);
      return;
    }
    if (value === "available") set("unavailable");
  }

  return {
    result(next: TimeAvailability | null): void {
      if (disposed || next === null) return;
      lastSuccessAt = runtime.now();
      schedule(TIME_AVAILABILITY_EXPIRY_MS);
      set(next);
    },
    dispose(): void {
      disposed = true;
      if (timer !== undefined) runtime.clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** Pollingと期限Timerをつなぎ、停止関数を返す。停止後は値を伝えない。 */
export function startTimeAvailability(
  onChange: (value: TimeAvailability) => void,
  runtime: TimeAvailabilityRuntime = browserRuntime(),
): () => void {
  const expiry = createTimeAvailabilityExpiry(onChange, runtime);
  const stop = pollTimeAvailability((value) => expiry.result(value), runtime);
  return () => {
    stop();
    expiry.dispose();
  };
}
