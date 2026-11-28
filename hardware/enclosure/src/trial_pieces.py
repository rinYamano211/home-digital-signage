"""仮印刷用のテストピース（Issue #21）。

印刷当日、本印刷の前に小さく短時間で印刷し、寸法・合わせ・造形の具合を確かめる
（docs/enclosure-design.md 8章）。ユーザーが選んだ4つ（2026-11-28）：

- 刻印：前面の板と同じ厚みの板に、マークと背面の文字（engraving.test_piece）
- ネジの下穴：シャーシのボスと同じ形（外径7）に、下穴の径を5通り（2.3〜2.7）
- 前面の角：メインシャーシの右下の角を切り出したもの（角R4・正面の縁C1・窓の角R2・前面の縁）
- キーホール：リアカバーの左のキーホールの周りを切り出したもの

前面の角とキーホールは、本物のCAD（chassis_raw・rear_cover_raw）から箱の範囲を切り出すため、
本印刷と同じ形になる。座標は params.py と同じ（X右・Y上・Z＝奥行き）で作り、CADの座標
（reference.to_cad）にして返す。印刷の向きは export_print.py で決める。
"""

import cadquery as cq

import chassis as ch
import engraving
import params as p
import rear_cover
from reference import to_cad

# ネジの下穴のテストピース
PILOT_DIAMETERS = (2.3, 2.4, 2.5, 2.6, 2.7)  # 試す下穴の径（今の設計は2.5）
PILOT_PITCH = 11.0  # ボスの間隔
PILOT_PLATE_T = p.FRONT_T  # 土台の板の厚み（前面の板と同じ）
PILOT_BOSS_H = 12.0  # ボスの高さ（土台の上）。下穴の深さ COVER_SCREW_DEPTH＋2
DOT_D = 1.2  # 目印の点（下穴の順番を数で示す）の径
DOT_PITCH = 2.0
DOT_DEPTH = 0.4

# 切り出す範囲（Displayの座標）
FRONT_CORNER_BOX = (
    p.DISPLAY_W - p.LIP_RIGHT - 12.0,  # X：窓の右下の角から左へ12
    ch.Y_OUT0 - 1.0,
    ch.Z_FRONT - 1.0,
    ch.X_FRONT1 + 1.0,
    p.LIP_BOTTOM + 12.0,  # Y：窓の下の縁から上へ12
    ch.Z_FRONT + 8.0,  # 奥行き：前面の板と、壁の始まり6
)
KEYHOLE_MARGIN = 5.0  # キーホールの台の周りに取る幅


def single(shape, name):
    """1つのつながった立体であることを確かめて返す。"""
    solids = shape.solids().vals()
    if len(solids) != 1 or not solids[0].isValid():
        raise ValueError(f"{name}：1つの正しい立体にならない（{len(solids)}個）")
    return cq.Workplane().add(solids[0])


def engraving_piece():
    """刻印のテストピース（CADの座標）。"""
    return to_cad(engraving.test_piece())


def pilot_piece():
    """ネジの下穴のテストピース（CADの座標）。土台の板の上にボスが並ぶ。

    下穴は左から PILOT_DIAMETERS の順。各ボスの手前に、順番の数だけ点を彫る（1点＝2.3）。
    """
    n = len(PILOT_DIAMETERS)
    width = PILOT_PITCH * n
    depth = p.COVER_BOSS_D + 7.0
    plate = cq.Workplane().box(width, depth, PILOT_PLATE_T, centered=(False, False, False))
    for i, d in enumerate(PILOT_DIAMETERS):
        cx = PILOT_PITCH * (i + 0.5)
        cy = depth - p.COVER_BOSS_D / 2 - 1.0
        top = PILOT_PLATE_T + PILOT_BOSS_H
        boss = cq.Workplane().add(
            cq.Solid.makeCylinder(p.COVER_BOSS_D / 2, PILOT_BOSS_H, cq.Vector(cx, cy, PILOT_PLATE_T))
        )
        hole = cq.Workplane().add(
            cq.Solid.makeCylinder(d / 2, p.COVER_SCREW_DEPTH + 0.5, cq.Vector(cx, cy, top - p.COVER_SCREW_DEPTH))
        )
        plate = plate.union(boss).cut(hole)
        for k in range(i + 1):
            x = cx + (k - i / 2) * DOT_PITCH
            dot = cq.Workplane().add(
                cq.Solid.makeCylinder(DOT_D / 2, DOT_DEPTH + 0.5, cq.Vector(x, 2.5, PILOT_PLATE_T - DOT_DEPTH))
            )
            plate = plate.cut(dot)
    return single(plate, "ネジの下穴")


def crop(shape, box, name):
    """形を箱の範囲で切り出す（Displayの座標）。"""
    x0, y0, z0, x1, y1, z1 = box
    region = ch.box(x0, y0, z0, x1, y1, z1)
    return single(shape.intersect(region), name)


def front_corner_piece():
    """前面の右下の角（CADの座標）。"""
    return to_cad(crop(ch.chassis_raw(), FRONT_CORNER_BOX, "前面の角"))


def keyhole_box(cx=None):
    """キーホールの台（内側）の周りに KEYHOLE_MARGIN を足した範囲。下のワイヤーの穴の台は含めない。"""
    cx = p.KEYHOLE_X[0] if cx is None else cx
    block, _, _ = rear_cover.keyhole_parts(cx)
    bb = block.val().BoundingBox()
    anchor, _, _ = rear_cover.wire_anchor_parts(cx)
    anchor_top = anchor.val().BoundingBox().ymax
    m = KEYHOLE_MARGIN
    y0 = max(bb.ymin - m, anchor_top + 1.0)
    return (bb.xmin - m, y0, bb.zmin - 1.0, bb.xmax + m, bb.ymax + m, rear_cover.Z1 + 1.0)


def keyhole_piece():
    """リアカバーの左のキーホールの周り（CADの座標）。"""
    return to_cad(crop(rear_cover.rear_cover_raw(), keyhole_box(), "キーホール"))
