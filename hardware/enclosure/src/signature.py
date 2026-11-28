"""シンボル（Phos Sprout）とロゴ（PHOS）の2Dの形（Issue #20、PR 5b）。

形は「線の中心の道筋＋線幅」で決める。SVG（ブランド用）・プレビューの画像・刻印の形は、
すべてここの道筋から作る。単位はmm、Xは右、Yは上。

- シンボル：茎・地面の線・左右2枚の葉（線画）。下端（地面の線の外側）が Y=0、茎が X=0
- ロゴ：線で組んだ幾何学的な大文字（P・H・O・S）。下端が Y=0

形の管理：
- 正本は「線の中心の道筋＋線幅」。ブランド用のSVG（phos-*.svg）は、これをそのまま線で描く
- 刻印の形は、同じ線に「線と線の間が SIGN_MIN_GAP より狭い所を埋める」処理を足したもの
  （造形のための調整）。SVGとの差は埋めた所だけで、差の面積・か所・線の縁からの最大の距離を表示する
- CADの刻印も、この刻印の形（埋めたあと）に合わせる

使うライブラリ：numpy・scipy・vtk（どれもCadQueryと一緒に入る）。

実行：venvのPythonで `python hardware/enclosure/src/signature.py`
出力：hardware/enclosure/out/phos-symbol.svg、phos-mark.svg、signature-*.png
確認に失敗すると、終了コード1で終わる。
"""

import math
import sys
from contextlib import contextmanager
from pathlib import Path

import numpy as np
import vtk
from scipy import ndimage
from vtk.util import numpy_support

import params as p

OUT_DIR = Path(__file__).resolve().parent.parent / "out"


# --- 道筋の部品 -------------------------------------------------------------
# 1本の線＝("M", 点) で始まり、("L", 点)・("C", 制御点1, 制御点2, 点)・
# ("A", 中心, 半径, 角度0, 角度1) が続く。角度は度、反時計回りが正。
# ("M", 点) だけの線は点（線幅の円）になる。


def _scale(stroke, k, dx=0.0, dy=0.0):
    """線を k 倍して (dx, dy) だけ動かす（線幅は変えない）。"""

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
        else:
            raise ValueError(f"道筋の部品 {kind} はない")
    return np.array(pts)


# --- 寸法の許容範囲 ---------------------------------------------------------
# 設計上許す値の範囲（下限, 上限）。範囲の外の値や、下の組み合わせの条件を満たさない値は、
# 形を作る前に ValueError にする。範囲は、FDM（ノズル0.4）での刻印と、前面の左の余白
# （幅約61）に収まることを目安に決めた。範囲の中でも、最終の確認は inspect() と
# CAD・スライサーのプレビューで行う。
RANGES = {
    "SIGN_SYMBOL_H": (12.0, 24.0),
    "SIGN_SYMBOL_LINE": (0.6, 1.5),
    "SIGN_LETTER_H": (3.5, 6.0),
    "SIGN_LETTER_LINE": (0.5, 1.0),
    "SIGN_LETTER_GAP": (1.0, 5.0),
    "SIGN_STACK_GAP": (3.0, 10.0),
    "SIGN_MIN_GAP": (0.4, 1.0),
}


def validate():
    """params の刻印の値が、許容範囲と組み合わせの条件を満たすか確かめる。満たさなければ ValueError。"""
    errors = []
    for name, (lo, hi) in RANGES.items():
        v = getattr(p, name)
        if not (isinstance(v, (int, float)) and math.isfinite(v) and lo <= v <= hi):
            errors.append(f"{name}={v!r} は範囲 {lo}〜{hi} の外")
    if not errors:
        H, w, g = p.SIGN_LETTER_H, p.SIGN_LETTER_LINE, p.SIGN_MIN_GAP
        span = H - w
        # 文字の中で一番狭い隙間：Sの上下の曲線の間（中心線の間 span/2 から線幅を引く）と、
        # Pの丸い部分の内側（中心線の間 span×比 から線幅を引く）
        s_gap = span / 2 - w
        p_gap = span * _P_BOWL_RATIO - w
        if min(s_gap, p_gap) < g:
            errors.append(
                f"文字の中の隙間（S {s_gap:.2f}・P {p_gap:.2f}）が SIGN_MIN_GAP={g} より狭い。"
                "文字を高くするか、線を細くする"
            )
        if p.SIGN_LETTER_GAP < g:
            errors.append(f"字間 SIGN_LETTER_GAP={p.SIGN_LETTER_GAP} が SIGN_MIN_GAP={g} より狭い")
        if p.SIGN_SYMBOL_LINE < w:
            errors.append("シンボルの線は、文字の線より細くしない（見た目の重さの順）")
    if errors:
        raise ValueError("刻印の寸法が不正：" + "／".join(errors))


# --- シンボル（Phos Sprout） -------------------------------------------------
# 基準の形：高さ18・線幅1.0で描いた線の中心。中心線は Y=0.5（地面の線）〜17.5（右の葉の先）。
# SIGN_SYMBOL_H・SIGN_SYMBOL_LINE が変わっても、線の外側までの高さが SIGN_SYMBOL_H になるよう、
# 中心線の範囲を（高さ−線幅）に合わせて拡大・縮小する（線幅は拡大・縮小しない）。
_SYMBOL_CENTER_Y0 = 0.5
_SYMBOL_CENTER_Y1 = 17.5


def symbol_strokes():
    """シンボルの線（道筋, 線幅）の並び。下端（線の外側）が Y=0、茎が X=0。"""
    validate()
    w = p.SIGN_SYMBOL_LINE
    base = _SYMBOL_CENTER_Y0
    j = (0.0, 8.0)  # 茎と葉の付け根
    right_tip = (8.0, _SYMBOL_CENTER_Y1)  # 右の葉の先（一番高い所）
    left_tip = (-6.6, 13.8)  # 左の葉の先
    strokes = [
        # 地面の線
        [("M", (-2.5, base)), ("L", (2.5, base))],
        # 茎
        [("M", (0.0, base)), ("L", j)],
        # 右の葉（大）：上の縁は茎からまっすぐ立ち上がって右へ、下の縁は付け根から斜め上へ出て先へ
        [("M", j), ("C", (0.0, 13.0), (3.0, 17.3), right_tip)],
        [("M", j), ("C", (2.5, 9.4), (7.5, 11.5), right_tip)],
        # 左の葉（小）
        [("M", j), ("C", (-0.4, 11.5), (-3.0, 13.9), left_tip)],
        [("M", j), ("C", (-2.2, 9.0), (-5.8, 10.2), left_tip)],
    ]
    k = (p.SIGN_SYMBOL_H - w) / (_SYMBOL_CENTER_Y1 - _SYMBOL_CENTER_Y0)
    dy = w / 2 - _SYMBOL_CENTER_Y0 * k
    return [(_scale(s, k, dy=dy), w) for s in strokes]


# --- ロゴ（PHOS） -----------------------------------------------------------
# 文字は、高さ SIGN_LETTER_H・線幅 SIGN_LETTER_LINE から直接作る（拡大・縮小しない）。
# 線の中心を 線幅/2 〜 高さ−線幅/2 に置くので、線の外側までの高さは常に SIGN_LETTER_H。
# 横の寸法は高さに対する比で決める（高さ4.5・線幅0.8で見た目を合わせた比）。
_P_BOWL_REACH = 2.1 / 4.5  # Pの縦の線の中心から、丸い部分の右端の中心まで（高さに対する比）
_P_BOWL_RATIO = 2.0 / 3.7  # Pの丸い部分の高さ（中心線どうし。中心線の高さに対する比）
_H_SPAN = 2.6 / 4.5  # Hの2本の縦の線の中心の間（高さに対する比）
_S_START_DEG = 35  # Sの上の端の向き
_S_END_DEG = -145  # Sの下の端の向き


def letter_strokes(ch):
    """1文字の線の並びと、文字の幅（線の外側まで）。左下（線の外側）が原点。"""
    validate()
    H, w = p.SIGN_LETTER_H, p.SIGN_LETTER_LINE
    h = w / 2
    top, bot, mid = H - h, h, H / 2
    span = top - bot  # 中心線の高さ
    if ch == "P":
        r = span * _P_BOWL_RATIO / 2
        right = h + H * _P_BOWL_REACH  # 丸い部分の右端（中心線）
        return (
            [
                [
                    ("M", (h, bot)),
                    ("L", (h, top)),
                    ("L", (right - r, top)),
                    ("A", (right - r, top - r), r, 90, -90),
                    ("L", (h, top - 2 * r)),
                ]
            ],
            right + h,
        )
    if ch == "H":
        x1 = h + H * _H_SPAN
        return (
            [
                [("M", (h, bot)), ("L", (h, top))],
                [("M", (x1, bot)), ("L", (x1, top))],
                [("M", (h, mid)), ("L", (x1, mid))],
            ],
            x1 + h,
        )
    if ch == "O":
        ro = span / 2
        return [[("M", (h + 2 * ro, mid)), ("A", (h + ro, mid), ro, 0, 360)]], 2 * (h + ro)
    if ch == "S":
        rs = span / 4
        cx = h + rs
        upper, lower = (cx, mid + rs), (cx, mid - rs)
        return (
            [
                [
                    ("M", _arc_point(upper, rs, _S_START_DEG)),
                    ("A", upper, rs, _S_START_DEG, 270),
                    ("A", lower, rs, 90, _S_END_DEG),
                ]
            ],
            cx + rs + h,
        )
    raise ValueError(f"文字 {ch} の形はない")


def wordmark_strokes(text="PHOS"):
    """ロゴの線（道筋, 線幅）の並びと、全体の幅。左下（線の外側）が原点。"""
    strokes, x = [], 0.0
    for i, ch in enumerate(text):
        lines, width = letter_strokes(ch)
        strokes += [(_scale(s, 1.0, dx=x), p.SIGN_LETTER_LINE) for s in lines]
        x += width + (p.SIGN_LETTER_GAP if i < len(text) - 1 else 0.0)
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


@contextmanager
def override(**values):
    """params の値を一時的に変える（比較の画像・テスト用）。"""
    old = {k: getattr(p, k) for k in values}
    try:
        for k, v in values.items():
            setattr(p, k, v)
        yield
    finally:
        for k, v in old.items():
            setattr(p, k, v)


# --- 刻印の形（2D）と確認 ---------------------------------------------------

RES = 0.02  # 計算の細かさ（mm/画素）


def bounds(strokes, margin=0.0):
    """線の外側までの外形（x0, y0, x1, y1）。margin だけ広げる。"""
    xs0, ys0, xs1, ys1 = [], [], [], []
    for s, w in strokes:
        pts = sample(s)
        xs0.append(pts[:, 0].min() - w / 2)
        ys0.append(pts[:, 1].min() - w / 2)
        xs1.append(pts[:, 0].max() + w / 2)
        ys1.append(pts[:, 1].max() + w / 2)
    return min(xs0) - margin, min(ys0) - margin, max(xs1) + margin, max(ys1) + margin


def _distance_field(strokes, x0, y0, nx, ny, reach):
    """各画素（の中心）から、一番近い線の縁までの距離（線の内側は負）。

    計算を軽くするため、線から reach より遠い画素は無限大のままにする。
    長さ0の線（点）は、線幅の円として扱う。
    """
    field = np.full((ny, nx), np.inf)
    for stroke, w in strokes:
        pts = sample(stroke)
        if len(pts) == 1:
            pts = np.vstack([pts, pts])
        span = w / 2 + reach
        for a, b in zip(pts[:-1], pts[1:]):
            ab = b - a
            ll = float(ab @ ab)
            lo = np.minimum(a, b) - span
            hi = np.maximum(a, b) + span
            i0, i1 = max(0, int((lo[0] - x0) / RES)), min(nx, int((hi[0] - x0) / RES) + 2)
            j0, j1 = max(0, int((lo[1] - y0) / RES)), min(ny, int((hi[1] - y0) / RES) + 2)
            if i0 >= i1 or j0 >= j1:
                continue
            gx = x0 + (np.arange(i0, i1) + 0.5) * RES
            gy = y0 + (np.arange(j0, j1) + 0.5) * RES
            gx, gy = np.meshgrid(gx, gy)
            if ll < 1e-12:
                t = 0.0
            else:
                t = np.clip(((gx - a[0]) * ab[0] + (gy - a[1]) * ab[1]) / ll, 0, 1)
            d = np.hypot(gx - (a[0] + t * ab[0]), gy - (a[1] + t * ab[1])) - w / 2
            view = field[j0:j1, i0:i1]
            np.minimum(view, d, out=view)
    return field


def engrave_mask(strokes, min_gap=None):
    """刻印する範囲（画素のTrue。配列の行は下から上）。

    線と線の間が min_gap より狭い所は埋める（「閉じる」処理：min_gap/2 だけ太らせてから、
    同じだけ細らせる）。min_gap=0 なら埋めない。
    戻り値：(mask, lines, field, (x0, y0))。lines は埋める前（線そのもの）、
    field は線の縁からの距離、(x0, y0) は配列の左下の角の位置。
    """
    min_gap = p.SIGN_MIN_GAP if min_gap is None else min_gap
    r = min_gap / 2
    x0, y0, x1, y1 = bounds(strokes, margin=r + 1.0)
    nx, ny = int((x1 - x0) / RES) + 1, int((y1 - y0) / RES) + 1
    field = _distance_field(strokes, x0, y0, nx, ny, reach=r + 0.1)
    lines = field <= 0
    if r <= 0:
        return lines.copy(), lines, field, (x0, y0)
    grown = field <= r
    # 太らせた形の外からの距離が r 以上の所だけ残す（細らせる）
    inside = ndimage.distance_transform_edt(grown) * RES
    closed = (inside >= r - RES / 2) | lines
    return closed, lines, field, (x0, y0)


def narrow_spots(region, width, origin):
    """region（画素のTrue）の中で、直径 width の円が入らない所（局所的に狭い所）。

    region の各点が「region の中に収まる直径 width の円」のどれかに含まれるかを調べる
    （形態学の「開く」処理と同じ考え方）。どの円にも含まれない画素のかたまりを、狭い所とする。
    幅が width より狭い帯・とがった角・細い切れ込みは、どこにあっても見つかる。
    画素の誤差として、1画素分の差は許す。
    戻り値：[(面積mm², 中心のx, 中心のy), ...]（面積の大きい順）
    """
    r = width / 2
    core = ndimage.distance_transform_edt(region) * RES >= r - RES
    covered = ndimage.distance_transform_edt(~core) * RES <= r + RES
    lost = region & ~covered
    labels, n = ndimage.label(lost)
    spots = []
    for k in range(1, n + 1):
        jj, ii = np.nonzero(labels == k)
        spots.append(
            (
                len(jj) * RES * RES,
                origin[0] + (ii.mean() + 0.5) * RES,
                origin[1] + (jj.mean() + 0.5) * RES,
            )
        )
    return sorted(spots, reverse=True)


def inspect(strokes, min_gap=None):
    """刻印の形の確認。結果を辞書で返す。"""
    min_gap = p.SIGN_MIN_GAP if min_gap is None else min_gap
    mask, lines, field, origin = engrave_mask(strokes, min_gap)
    # 埋めた所：元の線の縁から1画素より外の所（縁の1画素は、画素の誤差として数えない）
    filled = mask & ~lines & (field > RES)
    _, n_fill = ndimage.label(filled)
    x0, y0, x1, y1 = bounds(strokes)
    min_line = min(w for _, w in strokes)
    return {
        "size": (x1 - x0, y1 - y0),
        "lines": sorted({w for _, w in strokes}),
        "area": mask.sum() * RES * RES,
        "fill_area": filled.sum() * RES * RES,
        "fill_count": n_fill,
        # 埋めた所が、元の線の縁から最大どれだけ離れているか（SVGとの形の差の大きさ）
        "fill_offset": float(field[filled].max()) if filled.any() else 0.0,
        # 刻印しない所（線と線の間）で、直径 min_gap の円が入らない所
        "narrow_gaps": narrow_spots(~mask, min_gap, origin) if min_gap > 0 else [],
        # 刻印する所（線）で、直径＝一番細い線幅の円が入らない所
        "narrow_lines": narrow_spots(mask, min_line, origin),
        "min_gap": min_gap,
        "min_line": min_line,
    }


def report(name, strokes):
    """確認の結果を表示し、合否を返す。"""
    r = inspect(strokes)
    ok = not r["narrow_gaps"] and not r["narrow_lines"]
    print(
        f"[{'OK' if ok else 'NG'}] {name}：外形 {r['size'][0]:.2f}×{r['size'][1]:.2f}、"
        f"線幅 {r['lines']}、刻印の面積 {r['area']:.1f} mm2"
    )
    print(
        f"    SVGとの差（狭い所を埋めた分）：{r['fill_count']}か所・{r['fill_area']:.2f} mm2、"
        f"元の線の縁から最大 {r['fill_offset']:.2f}"
    )
    print(
        f"    線と線の間に直径{r['min_gap']}の円が入らない所：{len(r['narrow_gaps'])}か所。"
        f"線に直径{r['min_line']}の円が入らない所：{len(r['narrow_lines'])}か所"
    )
    for area, x, y in (r["narrow_gaps"] + r["narrow_lines"])[:5]:
        print(f"    狭い所：({x:.2f}, {y:.2f}) 付近、{area:.3f} mm2")
    return ok


# --- 書き出し ---------------------------------------------------------------


def svg_path(stroke, flip_h):
    """道筋を、SVGのpathのd属性にする（Yを下向きに直す）。"""

    def f(pt):
        return f"{pt[0]:.3f},{flip_h - pt[1]:.3f}"

    d = []
    for seg in stroke:
        kind = seg[0]
        if kind == "M":
            d.append(f"M{f(seg[1])}")
        elif kind == "L":
            d.append(f"L{f(seg[1])}")
        elif kind == "C":
            d.append(f"C{f(seg[1])} {f(seg[2])} {f(seg[3])}")
        elif kind == "A":
            c, r, a0, a1 = seg[1:]
            sweep_total = a1 - a0
            # 360°の円は2つに分ける
            parts = 2 if abs(sweep_total) >= 359.9 else 1
            for i in range(parts):
                end = _arc_point(c, r, a0 + sweep_total * (i + 1) / parts)
                large = 1 if abs(sweep_total / parts) > 180 else 0
                sweep = 0 if sweep_total > 0 else 1  # Yを反転するため向きが逆になる
                d.append(f"A{r:.3f},{r:.3f} 0 {large} {sweep} {f(end)}")
    if len(stroke) == 1:
        d.append("l0,0")  # 点は長さ0の線にする（丸い端で円になる）
    return " ".join(d)


def write_svg(path, strokes, color="#1a1a1a", margin=1.0):
    """ブランド用のSVG（線画。埋める処理の前の形）。"""
    x0, y0, x1, y1 = bounds(strokes, margin=margin)
    w, h = x1 - x0, y1 - y0
    body = []
    for stroke, lw in strokes:
        moved = _scale(stroke, 1.0, dx=-x0, dy=-y0)
        body.append(f'  <path d="{svg_path(moved, h)}" stroke-width="{lw}"/>')
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:.2f}mm" height="{h:.2f}mm" '
        f'viewBox="0 0 {w:.3f} {h:.3f}">\n'
        f'  <g fill="none" stroke="{color}" stroke-linecap="round" stroke-linejoin="round">\n'
        + "\n".join("  " + b for b in body)
        + "\n  </g>\n</svg>\n"
    )
    Path(path).write_text(svg, encoding="utf-8")


def write_png(path, rgb):
    """numpyの画像（高さ×幅×3、0〜255、上の行が先頭）をPNGにする。"""
    img = np.ascontiguousarray(np.clip(rgb[::-1], 0, 255).astype(np.uint8))  # VTKは下の行が先頭
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


def _shrink(mask, step):
    """画素を step×step ごとにまとめ、覆う割合（0〜1）にする（縮小時のギザギザを減らす）。"""
    h, w = (mask.shape[0] // step) * step, (mask.shape[1] // step) * step
    return mask[:h, :w].reshape(h // step, step, w // step, step).mean(axis=(1, 3))


def tile(strokes, scale_px, pad_mm=2.0, show_fill=False, grid=False):
    """刻印の形の画像（上の行が先頭）。"""
    mask, lines, _, _ = engrave_mask(strokes)
    step = max(1, int(round(1 / (RES * scale_px))))
    m = _shrink(mask, step)[..., None]
    f = _shrink(mask & ~lines, step)[..., None]
    pad = int(pad_mm * scale_px)
    h, w = m.shape[:2]
    img = np.zeros((h + 2 * pad, w + 2 * pad, 3)) + SURFACE
    view = img[pad : pad + h, pad : pad + w]
    if grid:
        px_mm = 1 / (RES * step)
        for k in range(0, int(w / px_mm) + 1):
            view[:, min(w - 1, int(k * px_mm))] = SURFACE + 12
        for k in range(0, int(h / px_mm) + 1):
            view[min(h - 1, int(k * px_mm)), :] = SURFACE + 12
    view[:] = view * (1 - m) + GROOVE * m
    if show_fill:
        view[:] = view * (1 - f) + FILL * f
    return img[::-1]


def preview(path, strokes, scale_px=50):
    """刻印の形の拡大プレビュー。1mmの方眼と10mmの目盛り（左下の白線）つき。赤は埋めた所。"""
    img = tile(strokes, scale_px, pad_mm=1.0, show_fill=True, grid=True)
    bar = int(10 * scale_px)
    img = np.vstack([img, np.zeros((40, img.shape[1], 3)) + SURFACE])
    img[-22:-18, int(1.0 * scale_px) : int(1.0 * scale_px) + bar] = (230, 230, 230)
    write_png(path, img)


COMPARE_LETTER_GAPS = (2.6, 2.0, 1.6)  # 字間：今の案・少し詰めた案・さらに詰めた案
COMPARE_STACK_GAPS = (7.0, 5.5, 4.5)  # シンボルとロゴの間：今の案・近づけた案・さらに近づけた案


def compare(path, scale_px=12):
    """字間（横に並べる）とシンボル・ロゴの間（縦に並べる）を変えた案を並べた画像。

    左上が今の案（字間2.6・間7.0）。右へ行くほど字間が狭く、下へ行くほど間が狭い。
    マークは、ロゴの下端と茎をそろえて置く（並べたときに位置の差が分かるように）。
    """
    cell_w, cell_h = int(32 * scale_px), int(38 * scale_px)
    sep = 6
    rows = []
    for stack in COMPARE_STACK_GAPS:
        cells = []
        for gap in COMPARE_LETTER_GAPS:
            with override(SIGN_LETTER_GAP=gap, SIGN_STACK_GAP=stack):
                strokes = mark_strokes()
                x0, y0, _, _ = bounds(strokes, margin=p.SIGN_MIN_GAP / 2 + 1.0)
                img = tile(strokes, scale_px, pad_mm=0.0)
            cell = np.zeros((cell_h, cell_w, 3)) + SURFACE
            # 茎を中央、ロゴの下端を下から5mmに置く
            left = int(cell_w / 2 + x0 * scale_px)
            top = int(cell_h - 5 * scale_px - (img.shape[0] + y0 * scale_px))
            hh, ww = img.shape[:2]
            cell[top : top + hh, left : left + ww] = img
            cells.append(cell)
            cells.append(np.zeros((cell_h, sep, 3)) + 200)
        rows.append(np.hstack(cells[:-1]))
        rows.append(np.zeros((sep, rows[-1].shape[1], 3)) + 200)
    write_png(path, np.vstack(rows[:-1]))


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
        ch.X_FRONT0 + p.FRONT_CHAMFER,
        ch.Y_OUT0 + p.FRONT_CHAMFER,
        ch.X_FRONT1 - p.FRONT_CHAMFER,
        ch.Y_FRONT1 - p.FRONT_CHAMFER,
        p.CORNER_R - p.FRONT_CHAMFER,
    )
    win = rrect(
        p.LIP_LEFT, p.LIP_BOTTOM, p.DISPLAY_W - p.LIP_RIGHT, p.DISPLAY_H - p.LIP_TOP, p.WINDOW_R
    )
    img[outer] = SURFACE - 15
    img[face] = SURFACE
    img[win] = (13, 13, 15)
    mask, _, _, (mx0, my0) = engrave_mask(mark)
    # マークの画素を、前面の画素へ写す（近い画素を取る）
    ix = ((gx - center[0] - mx0) / RES).astype(int)
    iy = ((gy - center[1] - my0) / RES).astype(int)
    ok = (ix >= 0) & (iy >= 0) & (ix < mask.shape[1]) & (iy < mask.shape[0])
    hit = np.zeros_like(ok)
    hit[ok] = mask[iy[ok], ix[ok]]
    img[hit & face] = GROOVE
    write_png(path, img[::-1])


def mark_center():
    """前面でマークを置く位置（マークの原点＝茎のX・ロゴの下端のYを、前面のどこに置くか）。

    マーク全体の外形の中央を、左の余白の中央・窓の高さの中央に合わせる。
    """
    import chassis as ch

    x0, y0, x1, y1 = bounds(mark_strokes())
    face_left = ch.X_FRONT0 + p.FRONT_CHAMFER
    cx = (face_left + p.LIP_LEFT) / 2
    cy = (p.LIP_BOTTOM + p.DISPLAY_H - p.LIP_TOP) / 2
    return cx - (x0 + x1) / 2, cy - (y0 + y1) / 2


def main():
    OUT_DIR.mkdir(exist_ok=True)
    sym = symbol_strokes()
    word, _ = wordmark_strokes()
    mark = mark_strokes()
    write_svg(OUT_DIR / "phos-symbol.svg", sym)
    write_svg(OUT_DIR / "phos-mark.svg", mark)
    ok = all([report("シンボル", sym), report("ロゴ", word), report("マーク", mark)])
    preview(OUT_DIR / "signature-mark.png", mark)
    compare(OUT_DIR / "signature-compare.png")
    center = mark_center()
    print(f"前面の位置（茎のX、ロゴの下端のY）：({center[0]:.1f}, {center[1]:.1f})")
    placement_preview(OUT_DIR / "signature-front.png", mark, center)
    print(f"出力: {OUT_DIR}")
    print("すべてOK" if ok else "NGあり")
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
