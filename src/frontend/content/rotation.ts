// コンテンツの切替（ContentSwitcher）の判断。Reactに依存しない純粋なロジックとして持つ
// （docs/frontend-development.md 10.2 S1、docs/architecture.md 6.2）。
// どのコンテンツを表示できるか・時刻を利用できるかは外から受け取る（10.5 S5）。
import type { TimeAvailability } from "../clock/availability";

/** 切替の対象。配列の順が巡回の順序になる。 */
export type RotationEntry = {
  readonly id: string;
  /** 表示時間（ミリ秒）。 */
  readonly durationMs: number;
};

/** その時点の外部の状態。 */
export type RotationInput = {
  /** 現在表示できるコンテンツのid。 */
  readonly displayable: ReadonlySet<string>;
  readonly time: TimeAvailability;
};

/** コンテンツ領域に表示するもの。 */
export type RotationView =
  | { readonly kind: "content"; readonly id: string }
  /** 時刻未同期の1枚表示（UI設計 6.3）。巡回を止める。 */
  | { readonly kind: "timeUnavailable" }
  /** 表示できるコンテンツが0件の1枚表示（UI設計 6.2）。巡回を止める。 */
  | { readonly kind: "noContent" };

const TIME_UNAVAILABLE: RotationView = { kind: "timeUnavailable" };
const NO_CONTENT: RotationView = { kind: "noContent" };

/** 同じ表示を指しているか。同じなら切替（アニメーション）を行わない。 */
export function sameView(a: RotationView, b: RotationView): boolean {
  if (a.kind === "content" && b.kind === "content") {
    return a.id === b.id;
  }
  return a.kind === b.kind;
}

/** `start`の位置から順に探し、最初に表示できるコンテンツを返す。末尾の次は先頭に戻る。 */
function findDisplayable(
  entries: readonly RotationEntry[],
  displayable: ReadonlySet<string>,
  start: number,
): RotationView | null {
  for (let offset = 0; offset < entries.length; offset++) {
    const entry = entries[(start + offset) % entries.length];
    if (entry !== undefined && displayable.has(entry.id)) {
      return { kind: "content", id: entry.id };
    }
  }
  return null;
}

/** 巡回を止める1枚表示が必要なら、その表示を返す。 */
function stoppedView(
  entries: readonly RotationEntry[],
  input: RotationInput,
): RotationView | null {
  if (input.time === "unavailable") {
    return TIME_UNAVAILABLE;
  }
  if (findDisplayable(entries, input.displayable, 0) === null) {
    return NO_CONTENT;
  }
  return null;
}

/** 起動時の表示。先頭（今日の予定）から順に、表示できる最初のコンテンツ。 */
export function initialView(
  entries: readonly RotationEntry[],
  input: RotationInput,
): RotationView {
  return (
    stoppedView(entries, input) ??
    findDisplayable(entries, input.displayable, 0) ??
    NO_CONTENT
  );
}

/**
 * 外部の状態が変わったときの表示（10.6）。
 * - 表示中のコンテンツが引き続き表示できるなら、中断せずにそのまま（3）。
 * - 表示中のコンテンツが表示できなくなったら、すぐ次の表示できるコンテンツへ（2）。
 * - 1枚表示から戻るときは、先頭から順に表示できる最初のコンテンツへ（5）。
 */
export function reconcileView(
  entries: readonly RotationEntry[],
  current: RotationView,
  input: RotationInput,
): RotationView {
  const stopped = stoppedView(entries, input);
  if (stopped !== null) {
    return stopped;
  }
  if (current.kind !== "content") {
    return initialView(entries, input);
  }
  if (input.displayable.has(current.id)) {
    return current;
  }
  return nextAfter(entries, current.id, input.displayable);
}

/**
 * 表示時間が経過したときの表示。現在の次から順に、表示できる最初のコンテンツ。
 * 表示できるものが現在のコンテンツだけなら、同じコンテンツを返す（10.6 4）。
 */
export function advanceView(
  entries: readonly RotationEntry[],
  current: RotationView,
  input: RotationInput,
): RotationView {
  const stopped = stoppedView(entries, input);
  if (stopped !== null) {
    return stopped;
  }
  if (current.kind !== "content") {
    return initialView(entries, input);
  }
  return nextAfter(entries, current.id, input.displayable);
}

function nextAfter(
  entries: readonly RotationEntry[],
  id: string,
  displayable: ReadonlySet<string>,
): RotationView {
  const index = entries.findIndex((entry) => entry.id === id);
  return findDisplayable(entries, displayable, index + 1) ?? NO_CONTENT;
}

/** 表示時間。1枚表示は巡回を止めるので、Timerを設定しない（`null`）。 */
export function dwellMs(
  entries: readonly RotationEntry[],
  view: RotationView,
): number | null {
  if (view.kind !== "content") {
    return null;
  }
  return entries.find((entry) => entry.id === view.id)?.durationMs ?? null;
}

/** Timerの関数。テストではFake Timerに差し替えられるよう外から渡せる。 */
export type RotationTimers = {
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
};

const defaultTimers: RotationTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * 表示時間の管理。表示が変わった時点から数え、コンテンツごとにTimerを設定し直す（10.6 1）。
 * 一定周期のTimerは使わない。表示が変わったときだけ`onChange`を呼ぶ。
 */
export class ContentRotation {
  #view: RotationView;
  #input: RotationInput;
  #timer: unknown = null;
  #disposed = false;
  readonly #entries: readonly RotationEntry[];
  readonly #onChange: (view: RotationView) => void;
  readonly #timers: RotationTimers;

  constructor(
    entries: readonly RotationEntry[],
    input: RotationInput,
    onChange: (view: RotationView) => void,
    timers: RotationTimers = defaultTimers,
  ) {
    this.#entries = entries;
    this.#input = input;
    this.#onChange = onChange;
    this.#timers = timers;
    this.#view = initialView(entries, input);
    this.#schedule();
  }

  get view(): RotationView {
    return this.#view;
  }

  /** 外部の状態（表示できるコンテンツ・時刻の利用可否）を反映する。 */
  update(input: RotationInput): void {
    if (this.#disposed) {
      return;
    }
    this.#input = input;
    const next = reconcileView(this.#entries, this.#view, input);
    // 表示が変わらないときは、表示中のTimerをそのまま続ける（中断しない）。
    if (!sameView(next, this.#view)) {
      this.#show(next);
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#clear();
  }

  #show(view: RotationView): void {
    this.#view = view;
    this.#schedule();
    this.#onChange(view);
  }

  #schedule(): void {
    this.#clear();
    const ms = dwellMs(this.#entries, this.#view);
    if (ms === null) {
      return;
    }
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = null;
      this.#advance();
    }, ms);
  }

  #advance(): void {
    if (this.#disposed) {
      return;
    }
    const next = advanceView(this.#entries, this.#view, this.#input);
    if (sameView(next, this.#view)) {
      // 表示できるのが1つだけ：同じものを表示し続け、アニメーションを繰り返さない。
      this.#schedule();
      return;
    }
    this.#show(next);
  }

  #clear(): void {
    if (this.#timer !== null) {
      this.#timers.clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}
