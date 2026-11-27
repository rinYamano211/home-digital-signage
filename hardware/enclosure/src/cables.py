"""卓上スタンドで置いたときの、下面から出るケーブルの簡易モデル（Issue #20、PR 5a）。

ケーブルは配線口の中心から本体の下面に垂直に出て、半径 CABLE_BEND_R（中心線）で曲がり、
机の上を後ろへ伸びる、と仮定する。実物のケーブルの硬さ・形は再現しない。

傾けた状態の座標（stand.world）で道筋を作り、Displayの座標に戻して形にする。
W＝後ろへの水平距離、U＝上への高さ。
"""

import math

import cadquery as cq

import chassis as ch
import params as p
import stand
from reference import to_cad

S, C = stand.S, stand.C


def cable_specs():
    """（名前, X, 出る所の奥行き, 外径）"""
    return [
        ("Pi電源", p.PI_POWER_X, p.CABLE_EXIT_DEPTH_PI, p.CABLE_D_PI),
        ("Display電源", -p.PORT_PLUG_OUT / 2, p.CABLE_EXIT_DEPTH_DISPLAY, p.CABLE_D_DISPLAY),
    ]


def bend_budget(depth, d, r=None):
    """出る所の奥行き depth で、曲げに使える高さと必要な高さ。

    下面に垂直（傾けた状態では下へ、前へ θ）に出て、後ろ向きの水平まで（90°＋θ）曲がる。
    円の中心は出る点から R だけ横（後ろ・下へ θ）にあり、一番低い点は出る点より R(1＋sinθ) 下。
    机に載る中心線の高さは 外径/2。よって必要な高さ＝R(1＋sinθ)＋外径/2。
    """
    r = p.CABLE_BEND_R if r is None else r
    _, u_exit = stand.world(stand.Y_BOTTOM, depth)
    _, u_desk = stand.world(*stand.FRONT_POINT)
    available = u_exit - u_desk
    needed = r * (1 + S) + d / 2
    return available, needed


def path_world(depth, r=None, step_deg=7.5):
    """ケーブルの中心線の点（W, U）の並び。配線口の内側の床から、後ろの支点の後ろまで。"""
    r = p.CABLE_BEND_R if r is None else r
    w0, u0 = stand.world(ch.Y_IN0 + 0.5, depth)  # 床の内側（穴の中）
    wp, up = stand.world(stand.Y_BOTTOM, depth)  # 下面に出る点
    pts = [(w0, u0), (wp, up)]
    # 円弧：向き −(90°＋θ) から 0° へ、反時計回り
    cw, cu = wp + r * C, up - r * S  # 円の中心（出る向きの左手側）
    phi0 = -(90.0 + p.STAND_TILT_DEG)
    n = max(2, int(abs(phi0) / step_deg))
    for i in range(1, n + 1):
        phi = math.radians(phi0 + (0 - phi0) * i / n)
        pts.append((cw + r * math.sin(phi), cu - r * math.cos(phi)))
    # 机の上を後ろへ
    (_, cy, cz), _ = stand.center_of_mass()
    w_back, _ = stand.world(*stand.back_point((cy, cz)))
    pts.append((w_back + p.CABLE_RUN_BEHIND, pts[-1][1]))
    return pts


def tube(points_xyz, d):
    """点の並びを、太さ d の管にする（短い円柱と球をつないだ簡易な形）。"""
    result = None
    for a, b in zip(points_xyz, points_xyz[1:]):
        va, vb = cq.Vector(*a), cq.Vector(*b)
        length = (vb - va).Length
        if length < 1e-6:
            continue
        seg = cq.Solid.makeCylinder(d / 2, length, va, (vb - va).normalized())
        ball = cq.Solid.makeSphere(d / 2, va, angleDegrees1=-90, angleDegrees2=90)
        part = cq.Workplane().add(seg).union(cq.Workplane().add(ball))
        result = part if result is None else result.union(part)
    return result


def cables_raw():
    """ケーブルの形（Displayの座標、傾ける前）。名前→形。"""
    shapes = {}
    for name, x, depth, d in cable_specs():
        pts = [stand.local(w, u) for w, u in path_world(depth)]
        shapes[name] = tube([(x, y, z) for y, z in pts], d)
    return shapes


def cables():
    """ケーブルの形（CADの座標）。"""
    return {name: to_cad(shape) for name, shape in cables_raw().items()}
