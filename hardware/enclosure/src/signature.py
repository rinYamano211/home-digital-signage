"""シンボル（Phos Sprout）とロゴ（PHOS）の2Dの形（Issue #20、PR 5b）。

形は「線の中心の道筋＋線幅」で決める。SVG（ブランド用）・プレビューの画像・刻印の形は、
すべてここの道筋から作る。単位はmm、Xは右、Yは上。

- シンボル：茎・地面の線・左右2枚の葉（線画）。下端（地面の線の外側）が Y=0、茎が X=0
- ロゴ：線で組んだ幾何学的な大文字（P・H・O・S）。下端が Y=0

実行：venvのPythonで `python hardware/enclosure/src/signature.py`
出力：hardware/enclosure/out/phos-symbol.svg、phos-mark.svg、signature-*.png
"""

import math
from pathlib import Path

import numpy as np
import vtk
from scipy import ndimage
from vtk.util import numpy_support

import params as p

OUT_DIR = Path(__file__).resolve().parent.parent / "out"

# シンボルは高さ18で描いた形を、SIGN_SYMBOL_H に合わせて拡大・縮小する（線幅は変えない）
_SYMBOL_BASE_H = 18.0
# ロゴは高さ4.5で描いた形を、SIGN_LETTER_H に合わせる
_LETTER_BASE_H = 4.5


# --- 道筋の部品 -------------------------------------------------------------
# 1本の線＝("M", 点) で始まり、("L", 点)・("C", 制御点1, 制御点2, 点)・
# ("A", 中心, 半径, 角度0, 角度1) が続く。角度は度、反時計回りが正。


def _scale(stroke, k, dx=0.0, dy=0.0):
    def t(pt):
        return (pt[0] * k + dx, pt[1] * k + dy)

    out = []
    for seg in stroke:
        if seg[0] == "A":
            out.append(("A", t(seg[1]), seg[2] * k, seg[3], seg[4]))
        else:
            out.append((seg[0], *[t(q) for q in seg[1:]]))
    return out


def _arc_point(c, r, deg):
    a = math.radians(deg)
    return (c[0] + r * math.cos(a), c[1] + r * math.sin(a))


def sample(stroke, step=0.05):
    """線の中心の道筋を、細かい点の並び（折れ線）にする。"""
    pts = []
    cur = None
    for seg in stroke:
        kind = seg[0]
        if kind == "M":
            cur = seg[1]
            pts.append(cur)
        elif kind == "L":
            a, b = np.array(cur), np.array(seg[1])
            n = max(1, int(np.linalg.norm(b - a) / step))
            pts += [tuple(a + (b - a) * i / n) for i in range(1, n + 1)]
            cur = seg[1]
        elif kind == "C":
            p0, p1, p2, p3 = (np.array(q) for q in (cur, *seg[1:]))
            length = (
                np.linalg.norm(p1 - p0) + np.linalg.norm(p2 - p1) + np.linalg.norm(p3 - p2)
            )
            n = max(4, int(length / step))
            for i in range(1, n + 1):
                t = i / n
                q = (
                    (1 - t) ** 3 * p0
                    + 3 * (1 - t) ** 2 * t * p1
                    + 3 * (1 - t) * t**2 * p2
                    + t**3 * p3
                )
                pts.append(tuple(q))
            cur = seg[3]
        elif kind == "A":
            c, r, a0, a1 = seg[1:]
            n = max(4, int(abs(math.radians(a1 - a0)) * r / step))
            pts += [_arc_point(c, r, a0 + (a1 - a0) * i / n) for i in range(1, n + 1)]
            cur = _arc_point(c, r, a1)
    return np.array(pts)


# --- シンボル（Phos Sprout） -------------------------------------------------


def symbol_strokes():
    """シンボルの線（道筋, 線幅）の並び。下端 Y=0、茎 X=0。"""
    w = p.SIGN_SYMBOL_LINE
    h = w / 2
    base_y = h  # 地面の線の中心
    j = (0.0, 8.0)  # 茎と葉の付け根
    right_tip = (8.0, _SYMBOL_BASE_H - h)  # 右の葉の先（上の端が高さ18）
    left_tip = (-6.6, 13.8)  # 左の葉の先
    strokes = [
        # 地面の線
        [("M", (-2.5, base_y)), ("L", (2.5, base_y))],
        # 茎
        [("M", (0.0, base_y)), ("L", j)],
        # 右の葉（大）：上の縁は茎からまっすぐ立ち上がって右へ、下の縁は付け根から斜め上へ出て先へ
        [("M", j), ("C", (0.0, 13.0), (3.0, 17.3), right_tip)],
        [("M", j), ("C", (2.5, 9.4), (7.5, 11.5), right_tip)],
        # 左の葉（小）
        [("M", j), ("C", (-0.4, 11.5), (-3.0, 13.9), left_tip)],
        [("M", j), ("C", (-2.2, 9.0), (-5.8, 10.2), left_tip)],
    ]
    k = p.SIGN_SYMBOL_H / _SYMBOL_BASE_H
    if k != 1.0:
        strokes = [_scale(s, k) for s in strokes]
    return [(s, w) for s in strokes]


# --- ロゴ（PHOS） -----------------------------------------------------------


def _letters():
    """高さ4.5・線幅0.8で描いた文字の線と、文字の幅（線の外側まで）。左下が原点。"""
    h = 0.4  # 線幅の半分
    top, bot, mid = 4.5 - h, h, 2.25
    letters = {}
    # P：縦の線と、上半分の丸い部分
    r = (top - 2.1) / 2
    letters["P"] = (
        [[("M", (h, bot)), ("L", (h, top)), ("L", (2.5 - r, top)),
          ("A", (2.5 - r, top - r), r, 90, -90), ("L", (h, top - 2 * r))]],
        2.5 + h,
    )
    # H：2本の縦の線と横の線
    letters["H"] = (
        [[("M", (h, bot)), ("L", (h, top))],
         [("M", (3.0, bot)), ("L", (3.0, top))],
         [("M", (h, mid)), ("L", (3.0, mid))]],
        3.0 + h,
    )
    # O：円
    ro = (top - bot) / 2
    letters["O"] = ([[("M", (h + ro + ro, mid)), ("A", (h + ro, mid), ro, 0, 360)]], 2 * (h + ro))
    # S：上下2つの円弧をつなぐ
    rs = (top - bot) / 4
    cx = h + rs
    upper, lower = (cx, mid + rs), (cx, mid - rs)
    start = _arc_point(upper, rs, 35)
    letters["S"] = (
        [[("M", start), ("A", upper, rs, 35, 270), ("A", lower, rs, 90, -145)]],
        cx + rs + h,
    )
    return letters


def wordmark_strokes(text="PHOS"):
    """ロゴの線（道筋, 線幅）の並びと、全体の幅。左下が原点。"""
    k = p.SIGN_LETTER_H / _LETTER_BASE_H
    letters = _letters()
    strokes, x = [], 0.0
    for i, ch in enumerate(text):
        lines, width = letters[ch]
        strokes += [(_scale(s, k, dx=x), p.SIGN_LETTER_LINE) for s in lines]
        x += width * k + (p.SIGN_LETTER_GAP if i < len(text) - 1 else 0.0)
    return strokes, x


def mark_strokes():
    """シンボルとロゴを縦に並べた形（マーク）。茎を X=0、ロゴの下端を Y=0 とする。

    ロゴは茎の真下を中心にする（シンボルは左右非対称のため、外形の中心ではなく茎に合わせる）。
    """
    word, word_w = wordmark_strokes()
    y_sym = p.SIGN_LETTER_H + p.SIGN_STACK_GAP
    out = [(_scale(s, 1.0, dx=-word_w / 2), w) for s, w in word]
    out += [(_scale(s, 1.0, dy=y_sym), w) for s, w in symbol_strokes()]
    return out


# --- 刻印の形（2D）と確認 ---------------------------------------------------

RES = 0.02  # 計算の細かさ（mm/画素）


def bounds(strokes, margin=0.0):
    pts = np.vstack([sample(s) for s, _ in strokes])
    half = max(w for _, w in strokes) / 2 + margin
    return pts[:, 0].min() - half, pts[:, 1].min() - half, pts[:, 0].max() + half, pts[:, 1].max() + half


def _distance_field(strokes, x0, y0, nx, ny, reach):
    """各画素から、一番近い線の縁までの距離（線の内側は負）。

    計算を軽くするため、線から reach より遠い画素は無限大のままにする。
    """
    field = np.full((ny, nx), np.inf)
    for stroke, w in strokes:
        pts = sample(stroke)
        a, b = pts[:-1], pts[1:]
        span = w / 2 + reach
        for i in range(len(a)):
            ab = b[i] - a[i]
            ll = float(ab @ ab)
            if ll < 1e-12:
                continue
            lo = np.minimum(a[i], b[i]) - span
            hi = np.maximum(a[i], b[i]) + span
            i0, i1 = max(0, int((lo[0] - x0) / RES)), min(nx, int((hi[0] - x0) / RES) + 2)
            j0, j1 = max(0, int((lo[1] - y0) / RES)), min(ny, int((hi[1] - y0) / RES) + 2)
            gx = x0 + (np.arange(i0, i1) + 0.5) * RES
            gy = y0 + (np.arange(j0, j1) + 0.5) * RES
            gx, gy = np.meshgrid(gx, gy)
            t = np.clip(((gx - a[i][0]) * ab[0] + (gy - a[i][1]) * ab[1]) / ll, 0, 1)
            d = np.hypot(gx - (a[i][0] + t * ab[0]), gy - (a[i][1] + t * ab[1])) - w / 2
            view = field[j0:j1, i0:i1]
            np.minimum(view, d, out=view)
    return field


def engrave_mask(strokes, min_gap=None):
    """刻印する範囲（画素のTrue）。線と線の間が min_gap より狭い所は埋める。

    戻り値：(mask, lines, (x0, y0))。lines は埋める前（線そのもの）。
    埋める処理は「閉じる」処理：min_gap/2 だけ太らせてから、同じだけ細らせる。
    """
    min_gap = p.SIGN_MIN_GAP if min_gap is None else min_gap
    r = min_gap / 2
    x0, y0, x1, y1 = bounds(strokes, margin=r + 1.0)
    nx, ny = int((x1 - x0) / RES) + 1, int((y1 - y0) / RES) + 1
    field = _distance_field(strokes, x0, y0, nx, ny, reach=r + 0.1)
    lines = field <= 0
    grown = field <= r
    # 太らせた形の外からの距離が r 以上の所だけ残す（細らせる）
    inside = ndimage.distance_transform_edt(grown) * RES
    closed = (inside >= r - RES / 2) | lines
    return closed, lines, (x0, y0)


def narrowest_gap(mask):
    """刻印しない所（線と線の間）の、一番狭い幅の目安（mm）。外周は除く。

    刻印しない所を、幅 g の円で塗れない所が出るかを g を変えて調べる。
    """
    raised = ~mask
    # 外とつながる所（外周）は、狭くならないため除かない。中の空き（葉の内側・文字の中）も含めて見る
    for g in np.arange(0.2, 3.0, 0.05):
        r = g / 2
        dist = ndimage.distance_transform_edt(raised) * RES
        core = dist >= r - RES / 2
        opened = ndimage.distance_transform_edt(~core) * RES <= r + RES / 2
        lost = raised & ~opened
        if lost.sum() * RES * RES > 0.02:  # 0.02 mm² を超えて塗れない所が出たら、そこが一番狭い
            return round(g - 0.05, 2)
    return None


def report(name, strokes):
    mask, lines, _ = engrave_mask(strokes)
    filled = (mask & ~lines).sum() * RES * RES
    x0, y0, x1, y1 = bounds(strokes)
    gap = narrowest_gap(mask)
    print(
        f"{name}: 外形 {x1 - x0:.1f}×{y1 - y0:.1f}、線幅 "
        f"{sorted({w for _, w in strokes})}、刻印の面積 {mask.sum() * RES * RES:.1f} mm2"
        f"（狭い所を埋めた分 {filled:.2f}）、線と線の間の最小 {gap}"
    )
    return mask


# --- 書き出し ---------------------------------------------------------------


def svg_path(stroke, flip_h):
    """道筋を、SVGのpathのd属性にする（Yを下向きに直す）。"""

    def f(pt):
        return f"{pt[0]:.3f},{flip_h - pt[1]:.3f}"

    d, cur = [], None
    for seg in stroke:
        kind = seg[0]
        if kind == "M":
            d.append(f"M{f(seg[1])}")
            cur = seg[1]
        elif kind == "L":
            d.append(f"L{f(seg[1])}")
            cur = seg[1]
        elif kind == "C":
            d.append(f"C{f(seg[1])} {f(seg[2])} {f(seg[3])}")
            cur = seg[3]
        elif kind == "A":
            c, r, a0, a1 = seg[1:]
            sweep_total = a1 - a0
            # 360°の円は2つに分ける
            parts = 2 if abs(sweep_total) >= 359.9 else 1
            for i in range(parts):
                b = a0 + sweep_total * (i + 1) / parts
                end = _arc_point(c, r, b)
                large = 1 if abs(sweep_total / parts) > 180 else 0
                sweep = 0 if sweep_total > 0 else 1  # Yを反転するため向きが逆になる
                d.append(f"A{r:.3f},{r:.3f} 0 {large} {sweep} {f(end)}")
                cur = end
    return " ".join(d)


def write_svg(path, strokes, color="#1a1a1a", margin=1.0):
    x0, y0, x1, y1 = bounds(strokes, margin=margin)
    w, h = x1 - x0, y1 - y0
    body = []
    for stroke, lw in strokes:
        moved = _scale(stroke, 1.0, dx=-x0, dy=-y0)
        body.append(
            f'  <path d="{svg_path(moved, h)}" stroke-width="{lw}"/>'
        )
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:.2f}mm" height="{h:.2f}mm" '
        f'viewBox="0 0 {w:.3f} {h:.3f}">\n'
        f'  <g fill="none" stroke="{color}" stroke-linecap="round" stroke-linejoin="round">\n'
        + "\n".join("  " + b for b in body)
        + "\n  </g>\n</svg>\n"
    )
    Path(path).write_text(svg, encoding="utf-8")


def write_png(path, rgb):
    """numpyの画像（高さ×幅×3、0〜255、上が先頭）をPNGにする。"""
    img = np.ascontiguousarray(rgb[::-1].astype(np.uint8))  # VTKは下の行が先頭
    data = vtk.vtkImageData()
    data.SetDimensions(img.shape[1], img.shape[0], 1)
    arr = numpy_support.numpy_to_vtk(img.reshape(-1, 3), deep=True)
    arr.SetNumberOfComponents(3)
    data.GetPointData().SetScalars(arr)
    writer = vtk.vtkPNGWriter()
    writer.SetFileName(str(path))
    writer.SetInputData(data)
    writer.Write()


SURFACE = np.array([77, 77, 79])  # 仮の色（ダークチャコール）
GROOVE = np.array([38, 38, 40])  # 凹んだ所（影で暗く見える想定）
FILL = np.array([150, 60, 60])  # 狭い所を埋めた分（確認用に色を変える）


def preview(path, strokes, scale_px=40, show_fill=True, grid=True):
    """刻印の形の拡大プレビュー。1mmの方眼と10mmの目盛りつき。"""
    mask, lines, _ = engrave_mask(strokes)
    step = max(1, int(round(1 / (RES * scale_px))))
    m, ln = mask[::step, ::step], lines[::step, ::step]
    pad = 40
    h, w = m.shape
    img = np.zeros((h + 2 * pad, w + 2 * pad, 3)) + SURFACE
    view = img[pad:pad + h, pad:pad + w]
    if grid:
        px_mm = 1 / (RES * step)
        for k in range(0, int(w / px_mm) + 1):
            view[:, min(w - 1, int(k * px_mm))] = SURFACE + 12
        for k in range(0, int(h / px_mm) + 1):
            view[min(h - 1, int(k * px_mm)), :] = SURFACE + 12
    view[m] = GROOVE
    if show_fill:
        view[m & ~ln] = FILL
    # 下が先頭の配列（Yが上）なので、上下を返して画像にする
    img[pad:pad + h, pad:pad + w] = view
    img = img[::-1]
    # 10mmの目盛り（左下）
    bar = int(10 / (RES * step))
    img[-pad // 2 - 2:-pad // 2 + 2, pad:pad + bar] = (230, 230, 230)
    write_png(path, img)


def placement_preview(path, mark, center, scale_px=5):
    """前面全体に置いたときの見え方（正面）。外形・面取り・窓とマーク。"""
    import chassis as ch

    res = 1 / scale_px
    x0, y0 = ch.X_FRONT0 - 5, ch.Y_OUT0 - 5
    x1, y1 = ch.X_FRONT1 + 5, ch.Y_FRONT1 + 5
    nx, ny = int((x1 - x0) / res), int((y1 - y0) / res)
    xs = x0 + (np.arange(nx) + 0.5) * res
    ys = y0 + (np.arange(ny) + 0.5) * res
    gx, gy = np.meshgrid(xs, ys)

    def rrect(ax0, ay0, ax1, ay1, r):
        dx = np.maximum(np.maximum(ax0 + r - gx, gx - (ax1 - r)), 0)
        dy = np.maximum(np.maximum(ay0 + r - gy, gy - (ay1 - r)), 0)
        return np.hypot(dx, dy) <= r

    img = np.zeros((ny, nx, 3)) + (225, 223, 219)  # 壁
    outer = rrect(ch.X_FRONT0, ch.Y_OUT0, ch.X_FRONT1, ch.Y_FRONT1, p.CORNER_R)
    face = rrect(
        ch.X_FRONT0 + p.FRONT_CHAMFER, ch.Y_OUT0 + p.FRONT_CHAMFER,
        ch.X_FRONT1 - p.FRONT_CHAMFER, ch.Y_FRONT1 - p.FRONT_CHAMFER,
        p.CORNER_R - p.FRONT_CHAMFER,
    )
    win = rrect(p.LIP_LEFT, p.LIP_BOTTOM, p.DISPLAY_W - p.LIP_RIGHT, p.DISPLAY_H - p.LIP_TOP, p.WINDOW_R)
    img[outer] = SURFACE - 15
    img[face] = SURFACE
    img[win] = (13, 13, 15)
    mask, _, (mx0, my0) = engrave_mask(mark)
    # マークの画素を、前面の画素へ写す（近い画素を取る）
    ix = ((gx - center[0] - mx0) / RES).astype(int)
    iy = ((gy - center[1] - my0) / RES).astype(int)
    ok = (ix >= 0) & (iy >= 0) & (ix < mask.shape[1]) & (iy < mask.shape[0])
    hit = np.zeros_like(ok)
    hit[ok] = mask[iy[ok], ix[ok]]
    img[hit & face] = GROOVE
    write_png(path, img[::-1])


def mark_center():
    """前面でのマークの位置（茎の X、ロゴの下端の Y）。左の余白の中央、窓の高さの中央。"""
    import chassis as ch

    x0, y0, x1, y1 = bounds(mark_strokes())
    face_left = ch.X_FRONT0 + p.FRONT_CHAMFER
    cx = (face_left + p.LIP_LEFT) / 2  # 左の余白の中央に、マーク全体の外形の中央を置く
    cy = (p.LIP_BOTTOM + p.DISPLAY_H - p.LIP_TOP) / 2  # 窓の高さの中央に、マークの中央を置く
    return cx - (x0 + x1) / 2, cy - (y0 + y1) / 2


def main():
    OUT_DIR.mkdir(exist_ok=True)
    sym = symbol_strokes()
    word, _ = wordmark_strokes()
    mark = mark_strokes()
    write_svg(OUT_DIR / "phos-symbol.svg", sym)
    write_svg(OUT_DIR / "phos-mark.svg", mark)
    report("シンボル", sym)
    report("ロゴ", word)
    report("マーク", mark)
    preview(OUT_DIR / "signature-mark.png", mark, scale_px=40)
    center = mark_center()
    print(f"前面の位置（茎のX、ロゴの下端のY）：({center[0]:.1f}, {center[1]:.1f})")
    placement_preview(OUT_DIR / "signature-front.png", mark, center)
    print(f"出力: {OUT_DIR}")


if __name__ == "__main__":
    main()
