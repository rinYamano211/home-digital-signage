// コンテンツ領域の切替アニメーションの状態（UI設計 4.2・第7章）。
// 新しい表示が入り、前の表示が抜けていく間だけ、両方を重ねて描画する。
import { sameView, type RotationView } from "./rotation";

/** 切替アニメーションの長さ。CSSの`--fade-duration`と同じ値にする。 */
export const CONTENT_TRANSITION_MS = 600;

export type PanelState = {
  readonly current: RotationView;
  /** 抜けていく途中の前の表示。アニメーションが終わったら`null`。 */
  readonly leaving: RotationView | null;
  /** 現在の表示を、アニメーション付きで表示するか。起動直後の最初の表示は動かさない。 */
  readonly animate: boolean;
};

export function initialPanels(view: RotationView): PanelState {
  return { current: view, leaving: null, animate: false };
}

/** 表示が変わったときの状態。同じ表示なら何もしない（アニメーションを繰り返さない）。 */
export function startTransition(
  state: PanelState,
  view: RotationView,
): PanelState {
  if (sameView(state.current, view)) {
    return state;
  }
  return { current: view, leaving: state.current, animate: true };
}

/** 前の表示が抜け終わったときの状態。 */
export function finishTransition(state: PanelState): PanelState {
  return state.leaving === null ? state : { ...state, leaving: null };
}

export type RenderedPanel = {
  readonly key: string;
  readonly view: RotationView;
  readonly className: string;
};

/**
 * 描画するパネル。重ねるのは「抜けていく前の表示」と「現在の表示」の最大2枚。
 * アニメーション中にさらに表示が変わった場合は、それまで抜けていた表示を即座に外し、
 * 直前まで現在だった表示を新しく抜けていく表示にする（3枚以上は重ねない）。
 */
export function renderedPanels(state: PanelState): readonly RenderedPanel[] {
  const current: RenderedPanel = {
    key: viewKey(state.current),
    view: state.current,
    className: state.animate ? "content-panel content-enter" : "content-panel",
  };
  if (state.leaving === null) {
    return [current];
  }
  return [
    {
      key: viewKey(state.leaving),
      view: state.leaving,
      className: "content-panel content-exit",
    },
    current,
  ];
}

/** Reactのkeyに使う、表示ごとの識別子。 */
export function viewKey(view: RotationView): string {
  return view.kind === "content" ? `content:${view.id}` : view.kind;
}
