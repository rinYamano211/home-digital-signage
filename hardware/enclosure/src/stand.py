"""卓上スタンド（Issue #20、PR 4）。

左右2個のL字のブラケット。リアカバーは変えずに、キーホールを使って取り付ける。

使い方：
1. 各ブラケットの下穴にネジ（M3タッピング等、頭の径6〜8・軸4以下）をねじ込み、
   頭の下を STAND_SCREW_STANDOFF（約2.9）浮かせる。壁のネジと同じ役目。
2. 2個のブラケットを机に置き、本体のキーホールをネジの頭に合わせて、本体を下へずらして掛ける。
3. 本体の下面がブラケットの足に載り、背面がブラケットの当たり面に当たる。

形（ブラケットの横から見た輪郭。Displayの座標、Y上・Z奥行き）：
- 足：本体の下面の下に入り、本体を STAND_LIFT 持ち上げる。前に縁を立て、前へ滑るのを止める
- 当たり面：リアカバーの背面の上の方（Y 100〜138）に当たる。キーホール用のネジの下穴がある
- それより下は背面から STAND_RECESS 離す（リアカバーのネジの頭を避ける）
- 後ろの支点：重さの中心より STAND_BACK_REACH 後ろで机に着く
- 机に着く辺は、本体を STAND_TILT_DEG 後ろへ傾けたときに水平になる直線

傾けた状態の座標（机の上の向き）：
  W（後ろへの水平距離）＝ y·sinθ ＋ z·cosθ、U（上への高さ）＝ y·cosθ − z·sinθ
"""

import math

import cadquery as cq

import chassis as ch
import params as p
import rear_cover as rc
import reference
from reference import to_cad

THETA = math.radians(p.STAND_TILT_DEG)
S, C = math.sin(THETA), math.cos(THETA)


def world(y, z):
    """Displayの座標 (y, 奥行きz) → 傾けた状態の (W 後ろ, U 上)。"""
    return y * S + z * C, y * C - z * S


def local(w, u):
    """傾けた状態の (W, U) → Displayの座標 (y, z)。"""
    return u * C + w * S, -u * S + w * C


def case_parts_raw():
    """本体の部品（Displayの座標）と、その重さ g。"""
    parts = [("メインシャーシ", ch.chassis_raw())]
    parts += [(f"押さえ板{i}", s) for i, s in enumerate(ch.clamp_plates_raw(), 1)]
    parts += [(f"上部ストッパー{i}", s) for i, s in enumerate(ch.top_stoppers_raw(), 1)]
    parts.append(("リアカバー", rc.rear_cover_raw()))
    result = []
    for name, shape in parts:
        mass = shape.val().Volume() / 1000.0 * p.PETG_DENSITY
        result.append((name, shape, mass))
    return result


def center_of_mass(enclosure_ratio=1.0):
    """本体（Display・Pi・筐体）の重さの中心と、合計の重さ。

    Display・Piは参照モデルの形の中心に重さがあると仮定する。筐体の重さは、
    充填100%（中身を詰めた）の重さに enclosure_ratio を掛ける。
    スタンドの形（後ろの支点）は、enclosure_ratio＝1.0 の中心から決める。
    """
    items = [
        (reference.display(), p.DISPLAY_MASS),
        (reference.pi_envelope(), p.PI_MASS),
    ]
    items += [(shape, mass * enclosure_ratio) for _, shape, mass in case_parts_raw()]
    total = sum(m for _, m in items)
    x = y = z = 0.0
    for shape, mass in items:
        c = shape.val().Center()
        x += c.x * mass
        y += c.y * mass
        z += c.z * mass
    return (x / total, y / total, z / total), total


Y_BOTTOM = ch.Y_OUT0  # 本体の下面
Z_FRONT = ch.Z_FRONT  # 本体の前面
Z_BACK = rc.Z1  # リアカバーの外側（背面）
FRONT_POINT = (Y_BOTTOM - p.STAND_LIFT, Z_FRONT - p.STAND_LIP)  # 前の支点（机）


def back_point(cg_yz):
    """後ろの支点（机）：重さの中心より STAND_BACK_REACH 後ろで、前の支点と同じ高さ。"""
    w_cg, _ = world(*cg_yz)
    _, u_desk = world(*FRONT_POINT)
    return local(w_cg + p.STAND_BACK_REACH, u_desk)


def profile(cg_yz):
    """ブラケットの横から見た輪郭（y, z）の点の並び。"""
    y_a, z_a = FRONT_POINT
    y_b, z_b = back_point(cg_yz)
    lip_top = Y_BOTTOM + p.STAND_LIP
    pad0, pad1 = p.STAND_PAD_Y
    return [
        (y_a, z_a),  # 前の支点
        (lip_top, z_a),  # 縁の上・前
        (lip_top, Z_FRONT),  # 縁の上・後ろ（本体の前面）
        (Y_BOTTOM, Z_FRONT),  # 本体の前の下端
        (Y_BOTTOM, Z_BACK),  # 本体の後ろの下端
        (Y_BOTTOM, Z_BACK + p.STAND_RECESS),
        (pad0, Z_BACK + p.STAND_RECESS),
        (pad0, Z_BACK),  # 当たり面の下
        (pad1, Z_BACK),  # 当たり面の上
        (pad1, Z_BACK + p.STAND_PAD_T),
        (y_b, z_b),  # 後ろの支点
    ]


def brackets_raw(cg_yz=None):
    """ブラケット2個（Displayの座標）。"""
    if cg_yz is None:
        (_, cy, cz), _ = center_of_mass()
        cg_yz = (cy, cz)
    pts = profile(cg_yz)
    screw_y = p.KEYHOLE_ENTRY_Y + p.KEYHOLE_SLOT_LEN  # 掛かったときのネジの位置
    result = []
    for cx in p.KEYHOLE_X:
        body = (
            cq.Workplane("YZ")
            .polyline(pts)
            .close()
            .extrude(p.STAND_W)
            .translate((cx - p.STAND_W / 2, 0, 0))
        )
        pilot = ch.cylinder_z(
            cx, screw_y, Z_BACK, Z_BACK + p.STAND_SCREW_DEPTH, p.STAND_SCREW_PILOT_D
        )
        result.append(body.cut(pilot))
    return result


def brackets():
    """ブラケット2個（CADの座標）。"""
    return [to_cad(b) for b in brackets_raw()]
