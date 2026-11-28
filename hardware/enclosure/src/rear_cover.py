"""リアカバー（背面の部品）の形（Issue #20）。

メインシャーシの背面（奥行き CHASSIS_DEPTH）に載る板。寸法は params.py。
座標は params.py と同じ（X右・Y上・Z＝奥行き）で作り、最後に reference.to_cad で
CADの座標に直す。背面を下にして印刷する前提（内側の形は床から積み上がる）。

構成：
- 背面の板：メインシャーシと同じ外形。6本のネジでシャーシのボスに留める
- 補助の通気口：Piの後ろにスリット
- キーホール2つ：壁のネジ・ピンの頭を丸い穴に通し、上へずらして掛ける。
  板の内側に、頭が入る空間を囲む台を付ける
- ワイヤーを通す穴の組2つ：ピクチャーレールのフックに掛けるワイヤー・ひもを、
  外から入れて内側の溝を通し、外へ出して結ぶ

荷重の流れ（壁掛け）：壁のネジ・ピン（またはワイヤー）→ キーホールの台（またはワイヤーの穴の組）
→ 背面の板 → 6本のネジ → シャーシのボス → シャーシ → 前面の縁・押さえ板・上部ストッパー → Display。
強度は実機で確かめていない。
"""

import cadquery as cq

import chassis as ch
import params as p
from reference import to_cad

Z0 = ch.Z_BACK  # 板の内側の面（シャーシの背面）
Z1 = Z0 + p.COVER_T  # 板の外側の面（壁の側）


def screw_points():
    """シャーシのボスと同じ位置。"""
    return ch.COVER_BOSSES_FULL + [(cx, ch.Y_IN1 - 3.0) for cx in ch.COVER_BOSSES_TOP]


def plate():
    """背面の板。シャーシの背面の外形より SHADOW_INSET 小さく（シャドーライン）、
    角は CORNER_R に合わせて丸め、壁の側の外周を C COVER_BACK_CHAMFER で面取りする。"""
    i = p.SHADOW_INSET
    c = p.COVER_BACK_CHAMFER
    x0, y0, x1, y1 = ch.X_OUT0 + i, ch.Y_OUT0 + i, ch.X_OUT1 - i, ch.Y_OUT1 - i
    r = p.CORNER_R - i
    wires = [
        ch.rounded_rect_wire(x0, y0, x1, y1, Z0, r),
        ch.rounded_rect_wire(x0, y0, x1, y1, Z1 - c, r),
        ch.rounded_rect_wire(x0 + c, y0 + c, x1 - c, y1 - c, Z1, r - c),
    ]
    return cq.Workplane().add(cq.Solid.makeLoft(wires, True))


def screw_holes():
    result = None
    for cx, cy in screw_points():
        hole = ch.cylinder_z(cx, cy, Z0 - 0.5, Z1 + 0.5, p.COVER_SCREW_CLEAR_D)
        result = hole if result is None else result.union(hole)
    return result


def vents():
    """Piの後ろの補助の通気口（縦のスリット）。"""
    result = None
    for x in range(64, 141, 6):
        s = ch.box(x - 1.25, 30.0, Z0 - 0.5, x + 1.25, 75.0, Z1 + 0.5)
        result = s if result is None else result.union(s)
    return result


def stadium_z(cx, y0, y1, w, z0, z1):
    """奥行き方向に抜く、上下に長い長穴（Y y0〜y1、幅 w。端は丸い）。"""
    r = w / 2
    core = ch.box(cx - r, y0 + r, z0, cx + r, y1 - r, z1)
    ends = ch.cylinder_z(cx, y0 + r, z0, z1, w).union(ch.cylinder_z(cx, y1 - r, z0, z1, w))
    return core.union(ends)


def keyhole_parts(cx):
    """1つのキーホールの台・空間・穴を返す。"""
    entry = p.KEYHOLE_ENTRY_Y
    top = entry + p.KEYHOLE_SLOT_LEN  # 掛かったときのネジの軸の中心
    head_r = p.KEYHOLE_HEAD_D / 2
    # 頭が入る空間：丸い穴から上の端まで、頭の径の長穴（板の内側、深さ POCKET_H）
    pocket = stadium_z(
        cx, entry - head_r, top + head_r, p.KEYHOLE_HEAD_D, Z0 - p.KEYHOLE_POCKET_H, Z0
    )
    # 台：空間の周りに壁、内側に屋根
    wall = p.KEYHOLE_WALL
    block = ch.box(
        cx - head_r - wall,
        entry - head_r - wall,
        Z0 - p.KEYHOLE_POCKET_H - wall,
        cx + head_r + wall,
        top + head_r + wall,
        Z0,
    )
    # 板を貫く穴：頭を通す丸い穴＋上へずらす溝
    # 内側は頭の空間とつながるため、面をそろえたまま（重ねると形の計算が失敗する）。外側だけ長く抜く
    entry_hole = ch.cylinder_z(cx, entry, Z0, Z1 + 0.5, p.KEYHOLE_HEAD_D)
    slot = stadium_z(
        cx,
        entry - p.KEYHOLE_SLOT_W / 2,
        top + p.KEYHOLE_SLOT_W / 2,
        p.KEYHOLE_SLOT_W,
        Z0,
        Z1 + 0.5,
    )
    return block, pocket, entry_hole.union(slot)


def wire_anchor_parts(cx):
    """ワイヤーを通す穴の組：外→穴A→内側の溝→穴B→外。溝は台で囲む。"""
    half = p.WIRE_HOLE_PITCH / 2
    r = p.WIRE_HOLE_D / 2
    y = p.WIRE_ANCHOR_Y
    channel_h = p.WIRE_HOLE_D  # 溝の深さ（板の内側）
    wall = p.KEYHOLE_WALL
    block = ch.box(
        cx - half - r - wall,
        y - r - wall,
        Z0 - channel_h - wall,
        cx + half + r + wall,
        y + r + wall,
        Z0,
    )
    channel = ch.box(cx - half - r, y - r, Z0 - channel_h, cx + half + r, y + r, Z0)
    holes = ch.cylinder_z(cx - half, y, Z0, Z1 + 0.5, p.WIRE_HOLE_D).union(
        ch.cylinder_z(cx + half, y, Z0, Z1 + 0.5, p.WIRE_HOLE_D)
    )
    return block, channel, holes


def rear_cover_raw(engrave=True):
    """Displayの座標（Z＝奥行き）のままの形。engrave=False なら背面の刻印なし（確認用）。"""
    body = plate()
    cuts = screw_holes().union(vents())
    for cx in p.KEYHOLE_X:
        block, pocket, through = keyhole_parts(cx)
        body = body.union(block)
        cuts = cuts.union(pocket).union(through)
        a_block, a_channel, a_holes = wire_anchor_parts(cx)
        body = body.union(a_block)
        cuts = cuts.union(a_channel).union(a_holes)
    body = body.cut(cuts)
    return body.cut(back_engraving()) if engrave else body


def back_engraving():
    """背面の文字の凹刻印の型（engraving.py。PR 5b）。"""
    import engraving  # engraving が rear_cover を使うため、ここで読み込む

    return engraving.back_tool()


def rear_cover():
    """CADの座標（Z＝正面へ正）の形。"""
    return to_cad(rear_cover_raw())


OUTER_DEPTH = (ch.Z_FRONT, Z1)  # 組み立てたときの全体の奥行き
