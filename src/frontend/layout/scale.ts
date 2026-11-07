// 画面は1280×800のpx固定で作り、開発PCの小さなウィンドウでは全体を比例縮小する（D10、
// docs/frontend-development.md 5.1）。Responsiveレイアウトやブレークポイントは設けない。

export const SCREEN_WIDTH = 1280;
export const SCREEN_HEIGHT = 800;

export type ScreenFit = {
  readonly scale: number;
  /** 余白が出る場合に画面を中央へ置くための左上の位置（px）。 */
  readonly offsetX: number;
  readonly offsetY: number;
};

/** `scale = min(viewportWidth / 1280, viewportHeight / 800, 1)`。拡大はしない。 */
export function fitScreen(
  viewportWidth: number,
  viewportHeight: number,
): ScreenFit {
  const scale = Math.max(
    0,
    Math.min(viewportWidth / SCREEN_WIDTH, viewportHeight / SCREEN_HEIGHT, 1),
  );
  return {
    scale,
    offsetX: Math.max(0, (viewportWidth - SCREEN_WIDTH * scale) / 2),
    offsetY: Math.max(0, (viewportHeight - SCREEN_HEIGHT * scale) / 2),
  };
}
