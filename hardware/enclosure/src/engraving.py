"""シンボル・ロゴ・背面の文字の凹刻印（CAD）と、意匠確認用のテストピース（Issue #20、PR 5b）。

刻印の形は signature.py の「刻印の形（埋めたあと）」の輪郭から作る（ブランド用SVGの線画に、
線と線の間が狭い所を埋める調整を足した形）。座標は params.py と同じ（X右・Y上・Z＝奥行き）。

- 前面：マーク（シンボル＋PHOS）を、前面の左の余白に深さ SIGN_DEPTH で凹刻印する
- 背面：「PHOS／OBJECT 001／2026」を、リアカバーの背面の下寄り（通気口の下）に凹刻印する。
  背面から見て読めるよう、左右を反転して置く
- どちらも、刻印の面を下にして印刷する（前面の板・リアカバーの背面が床側）
"""

import cadquery as cq

import chassis as ch
import params as p
import signature as sg

OUTSIDE = 0.5  # 刻印の型を、面の外へ長く出す量（面がちょうど重なる引き算の失敗を避ける）


_CACHE = {}


def _sign_values():
    """刻印の形に効く値（変わったら作り直す）。"""
    return tuple((k, repr(getattr(p, k))) for k in sorted(dir(p)) if k.startswith("SIGN_"))


def _cached(kind, make):
    """輪郭の計算は重いため、同じ値なら作った面を使い回す。"""
    key = (kind, _sign_values())
    if key not in _CACHE:
        _CACHE[key] = make()
    return _CACHE[key]


def _faces(strokes, place):
    """刻印の輪郭を、奥行き0の平面の面（Face）の並びにする。place(x, y) → (X, Y)。"""
    faces = []
    for outer, holes in sg.outlines(strokes):

        def wire(loop):
            pts = [cq.Vector(*place(x, y), 0.0) for x, y in loop]
            return cq.Wire.makePolygon(pts, close=True)

        faces.append(cq.Face.makeFromWires(wire(outer), [wire(h) for h in holes]))
    return faces


def _tool(faces, z0, z1):
    """面を、奥行き z0〜z1 に押し出した型（1つの形にまとめる）。"""
    solids = [cq.Solid.extrudeLinear(f, cq.Vector(0, 0, z1 - z0)).translate(cq.Vector(0, 0, z0)) for f in faces]
    return cq.Workplane().add(cq.Compound.makeCompound(solids))


# --- 前面 -------------------------------------------------------------------


def front_place():
    """マークの座標 → 前面の座標（正面から見たまま。反転しない）。"""
    dx, dy = sg.mark_center()
    return lambda x, y: (x + dx, y + dy)


def front_faces():
    return _cached("front", lambda: _faces(sg.mark_strokes(), front_place()))


def front_tool(depth=None, z_from=None):
    """前面の刻印の型。既定は、前面の外 OUTSIDE から 深さ SIGN_DEPTH まで。"""
    depth = p.SIGN_DEPTH if depth is None else depth
    z0 = ch.Z_FRONT - OUTSIDE if z_from is None else z_from
    return _tool(front_faces(), z0, ch.Z_FRONT + depth)


# --- 背面 -------------------------------------------------------------------


def back_surface():
    import rear_cover

    return rear_cover.Z1


def back_place():
    """文字の座標 → 背面の座標。背面から見て読めるよう、X を反転する。"""
    cx, cy = p.SIGN_BACK_CENTER
    return lambda x, y: (cx - x, cy + y)


def back_faces():
    return _cached("back", lambda: _faces(sg.back_text_strokes(), back_place()))


def back_tool(depth=None):
    """背面の刻印の型。背面の外 OUTSIDE から 深さ SIGN_DEPTH まで（奥行きは前へ向かって小さくなる）。"""
    depth = p.SIGN_DEPTH if depth is None else depth
    z1 = back_surface()
    return _tool(back_faces(), z1 - depth, z1 + OUTSIDE)


# --- テストピース -------------------------------------------------------------

TEST_T = p.FRONT_T  # 前面の板と同じ厚み（刻印の残りの厚みも同じになる）
TEST_MARGIN = 6.0  # 刻印の外形から板の縁まで
TEST_GAP = 8.0  # マークと文字の間


def test_piece_layout():
    """テストピースの大きさと、マーク・文字を置く位置。"""
    mx0, my0, mx1, my1 = sg.bounds(sg.mark_strokes())
    tx0, ty0, tx1, ty1 = sg.bounds(sg.back_text_strokes())
    width = TEST_MARGIN * 2 + (mx1 - mx0) + TEST_GAP + (tx1 - tx0)
    height = TEST_MARGIN * 2 + max(my1 - my0, ty1 - ty0)
    mark_dx = TEST_MARGIN - mx0
    mark_dy = height / 2 - (my0 + my1) / 2
    text_dx = TEST_MARGIN + (mx1 - mx0) + TEST_GAP - tx0
    text_dy = height / 2 - (ty0 + ty1) / 2
    return width, height, (mark_dx, mark_dy), (text_dx, text_dy)


def test_piece():
    """意匠確認用のテストピース。前面の板と同じ厚みの板に、マークと背面の文字を同じ深さで刻印する。

    刻印の面（奥行き0）を下にして印刷する。文字は刻印の面から見て読める向き（反転しない）。
    """
    width, height, (mdx, mdy), (tdx, tdy) = test_piece_layout()
    plate = ch.rounded_rect_solid(0, 0, width, height, 0, TEST_T, p.CORNER_R)
    faces = _faces(sg.mark_strokes(), lambda x, y: (x + mdx, y + mdy))
    faces += _faces(sg.back_text_strokes(), lambda x, y: (x + tdx, y + tdy))
    return plate.cut(_tool(faces, -OUTSIDE, p.SIGN_DEPTH))


def main():
    """テストピースのSTLを書き出す。"""
    from reference import to_cad

    sg.OUT_DIR.mkdir(exist_ok=True)
    piece = test_piece()
    path = sg.OUT_DIR / "test-piece-signature.stl"
    # 実物の向き（to_cad）にしてから、刻印の面が床（Z=0）に着くよう、X軸の周りに180°回す
    printable = to_cad(piece).rotate((0, 0, 0), (1, 0, 0), 180)
    cq.exporters.export(printable, str(path), tolerance=0.01, angularTolerance=0.1)
    w, h, _, _ = test_piece_layout()
    print(f"テストピース：{w:.1f}×{h:.1f}×{TEST_T}、刻印の深さ {p.SIGN_DEPTH}")
    print(f"STL: {path}")


if __name__ == "__main__":
    main()
