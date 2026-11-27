"""メインシャーシ（前面側の部品）の形（Issue #20）。

docs/enclosure-requirements.md 4章の要件に沿って作る。寸法は params.py。
座標は params.py と同じ（X右・Y上・Z＝奥行き）で作り、最後に reference.to_cad で
CADの座標に直す。

構成：
- 前面の板と、ガラスに被せる縁（表示領域より外側だけ）
- 外周の壁。左側は、Displayの端子とプラグを収める左サイドカバー
- 下フレーム：固定耳を受けるボス2つ、配線口2つ、吸気のスリット
- 上の壁：排気のスリット
- 左の位置決めリブ（左サイドカバーの側は壁がないため）
- リアカバーを留めるネジボス6つ

まだ作っていないもの（後のPRで扱う）：
- Displayの上側を後ろから押さえる部品（今はリアカバーを外すと、下の2本のネジと
  前面の縁だけで支える）
- 配線口の縁の丸め（今は端を丸めた長穴だけ）
"""

import cadquery as cq

import params as p
from reference import to_cad

# 外形（Displayの座標で）
X_IN0 = -p.SIDE_SPACE  # 内側の左端（左サイドカバーの内側）
X_IN1 = p.DISPLAY_W + p.CLEAR  # 内側の右端
Y_IN0 = -p.BOTTOM_SPACE  # 内側の床（下フレーム）
Y_IN1 = p.DISPLAY_H + p.CLEAR  # 内側の天井
X_OUT0 = X_IN0 - p.WALL
X_OUT1 = X_IN1 + p.WALL
Y_OUT0 = Y_IN0 - p.WALL
Y_OUT1 = Y_IN1 + p.WALL
Z_FRONT = -p.FRONT_T  # 前面の板の表
Z_BACK = p.CHASSIS_DEPTH  # リアカバーが載る面


def box(x0, y0, z0, x1, y1, z1):
    """2つの角の座標から箱を作る。"""
    return cq.Workplane().add(
        cq.Solid.makeBox(x1 - x0, y1 - y0, z1 - z0, cq.Vector(x0, y0, z0))
    )


def cylinder_z(cx, cy, z0, z1, d):
    """奥行き方向の円柱。"""
    return cq.Workplane().add(
        cq.Solid.makeCylinder(d / 2, z1 - z0, cq.Vector(cx, cy, z0), cq.Vector(0, 0, 1))
    )


def slot_y(cx, cz, length_x, length_z, y0, y1):
    """上下方向に壁を貫く長穴（端が丸い）。長い向きは length_x と length_z の大きい方。"""
    r = min(length_x, length_z) / 2
    if length_x >= length_z:
        core = box(cx - length_x / 2 + r, y0, cz - r, cx + length_x / 2 - r, y1, cz + r)
        ends = [(cx - length_x / 2 + r, cz), (cx + length_x / 2 - r, cz)]
    else:
        core = box(cx - r, y0, cz - length_z / 2 + r, cx + r, y1, cz + length_z / 2 - r)
        ends = [(cx, cz - length_z / 2 + r), (cx, cz + length_z / 2 - r)]
    for ex, ez in ends:
        cyl = cq.Solid.makeCylinder(
            r, y1 - y0, cq.Vector(ex, y0, ez), cq.Vector(0, 1, 0)
        )
        core = core.union(cq.Workplane().add(cyl))
    return core


def shell():
    """外周の壁と前面の板（Displayの入る空間と、前面の窓を抜く）。"""
    outer = box(X_OUT0, Y_OUT0, Z_FRONT, X_OUT1, Y_OUT1, Z_BACK)
    inner = box(X_IN0, Y_IN0, 0, X_IN1, Y_IN1, Z_BACK)
    window = box(
        p.LIP_LEFT,
        p.LIP_BOTTOM,
        Z_FRONT,
        p.DISPLAY_W - p.LIP_RIGHT,
        p.DISPLAY_H - p.LIP_TOP,
        0,
    )
    return outer.cut(inner).cut(window)


def left_ribs():
    """Displayの左端の位置決め。端子とプラグの範囲（Y 27〜62）を避ける。

    前面の板から立ち上がる（前面を下にした印刷で、床から積み上がる）。
    右の壁との間でDisplayを左右に±CLEARの範囲に収める。厚みは壁と同じ。
    """
    x0, x1 = -p.CLEAR - p.WALL, -p.CLEAR
    ribs = box(x0, 5.0, 0, x1, 20.0, 8.0)
    return ribs.union(box(x0, 75.0, 0, x1, 140.0, 8.0))


def tab_bosses():
    """固定耳を前から受けるボス。ネジは背面から耳の穴を通してねじ込む。

    円柱だけだと、前面の板との接続は円柱の底面（約38mm²）だけになる。ボスから
    下フレームの床（壁）まで台を伸ばし、前面の板と床の壁の2面につなぐ。
    台は奥行き0〜z1（耳の前面の手前）で、Display（Y≥0）と耳には入らない。
    """
    z1 = p.TAB_Z0 - p.TAB_BOSS_GAP
    r = p.TAB_BOSS_D / 2
    result = None
    for cx in (p.TAB_HOLE_CX, p.DISPLAY_W - p.TAB_HOLE_CX):
        boss = cylinder_z(cx, p.TAB_HOLE_CY, 0, z1, p.TAB_BOSS_D)
        pad = box(cx - r, Y_IN0 - 0.5, 0, cx + r, p.TAB_HOLE_CY, z1)
        boss = boss.union(pad)
        result = boss if result is None else result.union(boss)
    return result


def tab_pilots():
    """固定耳のネジの下穴。前面の板を貫かないよう、表から1.0残す。"""
    z1 = p.TAB_Z0 - p.TAB_BOSS_GAP
    result = None
    for cx in (p.TAB_HOLE_CX, p.DISPLAY_W - p.TAB_HOLE_CX):
        hole = cylinder_z(cx, p.TAB_HOLE_CY, Z_FRONT + 1.0, z1, p.TAB_SCREW_PILOT_D)
        result = hole if result is None else result.union(hole)
    return result


# リアカバー用のネジボスの位置
# 床から立ち上がるボス（Displayの外側。前面の板から背面まで通す）
COVER_BOSSES_FULL = [
    (X_IN0 + 3.0, Y_IN1 - 3.0),  # 左サイドカバーの上
    (X_IN0 + 3.0, Y_IN0 + 3.0),  # 左サイドカバーの下
    (40.0, Y_IN0 + 3.0),  # 下フレームの左寄り（Piのプラグの範囲より左）
    (180.0, Y_IN0 + 3.0),  # 下フレームの右寄り
]
# 上の壁から吊るボス（Displayの後ろ。下に45度の支えを付け、サポートなしで印刷できる形）
COVER_BOSSES_TOP = [40.0, 188.0]
TOP_BOSS_Z0 = 12.0  # 設計。ボスの円柱が始まる奥行き（支えはここから7手前まで）


def cover_bosses():
    r = p.COVER_BOSS_D / 2
    result = None
    for cx, cy in COVER_BOSSES_FULL:
        boss = cylinder_z(cx, cy, 0, Z_BACK, p.COVER_BOSS_D)
        result = boss if result is None else result.union(boss)
    cy = Y_IN1 - 3.0
    for cx in COVER_BOSSES_TOP:
        boss = cylinder_z(cx, cy, TOP_BOSS_Z0, Z_BACK, p.COVER_BOSS_D)
        # 45度の支え：YZ平面の三角形をX方向に押し出す（局所座標は (Y, Z)）
        reach = Y_IN1 - (cy - r)  # 壁からボスの下端まで
        gusset = (
            cq.Workplane("YZ")
            .polyline(
                [
                    (Y_IN1, TOP_BOSS_Z0),
                    (Y_IN1 - reach, TOP_BOSS_Z0),
                    (Y_IN1, TOP_BOSS_Z0 - reach),
                ]
            )
            .close()
            .extrude(p.COVER_BOSS_D)
            .translate((cx - r, 0, 0))
        )
        result = result.union(boss).union(gusset)
    return result


def cover_pilots():
    result = None
    points = COVER_BOSSES_FULL + [(cx, Y_IN1 - 3.0) for cx in COVER_BOSSES_TOP]
    for cx, cy in points:
        hole = cylinder_z(
            cx, cy, Z_BACK - p.COVER_SCREW_DEPTH, Z_BACK, p.SCREW_PILOT_D
        )
        result = hole if result is None else result.union(hole)
    return result


def cable_holes():
    """下面の配線口2つ。プラグが通る大きさ（Micro HDMIを外へ出す例外も含む）。"""
    y0, y1 = Y_OUT0, Y_IN0
    # Pi用：中央下。プラグ（26×12×7、Micro HDMIは14.7×6.9）が通る幅18。
    # プラグの奥行きの位置は測っていないため、奥行き方向に長くする（15〜35）。
    pi_hole = slot_y(p.PI_POWER_X, 25.0, 18.0, 20.0, y0, y1)
    # Display用：正面から見て左下（左サイドカバーの床）。プラグ23×11×6.8が通る幅14。
    # 端子のZは基準面が未確認のため、奥行き方向に長くする（3〜19）。
    display_hole = slot_y(-p.PORT_PLUG_OUT / 2, 11.0, 14.0, 16.0, y0, y1)
    return pi_hole.union(display_hole)


def vents():
    """吸気（下）と排気（上）のスリット。幅2.5、奥行き方向に長い。"""
    result = None
    for x in range(64, 121, 6):  # 下：Piの下、Pi用の配線口より左
        s = slot_y(float(x), 26.0, 2.5, 28.0, Y_OUT0, Y_IN0)
        result = s if result is None else result.union(s)
    for x in range(62, 143, 6):  # 上：Piの上あたり
        result = result.union(slot_y(float(x), 28.0, 2.5, 28.0, Y_IN1, Y_OUT1))
    return result


def chassis_raw():
    """Displayの座標（Z＝奥行き）のままの形。"""
    body = shell().union(left_ribs()).union(tab_bosses()).union(cover_bosses())
    return body.cut(tab_pilots()).cut(cover_pilots()).cut(cable_holes()).cut(vents())


def chassis():
    """CADの座標（Z＝正面へ正）の形。"""
    return to_cad(chassis_raw())


# check.py と export.py で使う値
OUTER = {
    "x": (X_OUT0, X_OUT1),
    "y": (Y_OUT0, Y_OUT1),
    "depth": (Z_FRONT, Z_BACK),
}
