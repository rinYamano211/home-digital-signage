"""メインシャーシ（前面側の部品）の形（Issue #20）。

docs/enclosure-requirements.md 4章の要件に沿って作る。寸法は params.py。
座標は params.py と同じ（X右・Y上・Z＝奥行き）で作り、最後に reference.to_cad で
CADの座標に直す。

構成：
- 前面の板と、ガラスに被せる縁（表示領域より外側だけ）
- 外周の壁。左側は、Displayの端子とプラグを収める左サイドカバー
- 下フレーム：固定耳を前から受ける台2つ、押さえ板用のボス2つ、配線口2つ、
  結束バンドを通す穴の組2つ、吸気のスリット
- 上の壁：排気のスリット
- 左の位置決めリブ（左サイドカバーの側は壁がないため）
- リアカバーを留めるネジボス6つ

- 上の壁：上部ストッパーを留める台2つ（下に45度の支え）

別の部品：
- 固定耳の押さえ板2枚（clamp_plates）。耳の後ろに当て、押さえ板用のボスにネジで留める
- 上部ストッパー2個（top_stoppers）。L字。台に背面からネジで留め、Displayの上側が
  後ろへ倒れるのを止める（リアカバーがなくても効く）

まだ作っていないもの（後のPRで扱う）：
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


CUT_EXTRA = 0.5  # 貫く穴を、壁の面より長く抜く量


def slot_y(cx, cz, length_x, length_z, y0, y1):
    """上下方向に壁を貫く長穴（端が丸い）。長い向きは length_x と length_z の大きい方。"""
    # 長穴の2D（XY平面）を作り、X軸まわりに90度回してXZ平面に置き、Y方向に押し出す。
    # 箱と円柱を足し合わせる作り方だと、背面テーパーの面との引き算が失敗することがあった。
    width = min(length_x, length_z)
    centers = max(length_x, length_z) - width  # 両端の円の中心の間隔
    angle = 0 if length_x >= length_z else 90
    if centers > 1e-6:
        sketch = cq.Sketch().slot(centers, width, angle)
    else:
        sketch = cq.Sketch().circle(width / 2)
    face = sketch._faces.Faces()[0]
    face = face.rotate(cq.Vector(0, 0, 0), cq.Vector(1, 0, 0), 90).translate(
        cq.Vector(cx, y0, cz)
    )
    return cq.Workplane().add(cq.Solid.extrudeLinear(face, cq.Vector(0, y1 - y0, 0)))


def rounded_rect_wire(x0, y0, x1, y1, z, r):
    """角を半径 r で丸めた長方形の輪郭（奥行き z の平面上）。"""
    sketch = cq.Sketch().rect(x1 - x0, y1 - y0).vertices().fillet(r)
    face = sketch._faces.Faces()[0]
    return face.outerWire().translate(cq.Vector((x0 + x1) / 2, (y0 + y1) / 2, z))


def rounded_rect_solid(x0, y0, x1, y1, z0, z1, r):
    """角を丸めた長方形を、奥行き z0〜z1 に押し出した形。"""
    w0 = rounded_rect_wire(x0, y0, x1, y1, z0, r)
    w1 = rounded_rect_wire(x0, y0, x1, y1, z1, r)
    return cq.Workplane().add(cq.Solid.makeLoft([w0, w1], True))


# 前面の外形（背面テーパーのため、上・左・右に FRONT_FLARE 広い。下は同じ）
X_FRONT0 = X_OUT0 - p.FRONT_FLARE
X_FRONT1 = X_OUT1 + p.FRONT_FLARE
Y_FRONT1 = Y_OUT1 + p.FRONT_FLARE


def outer_body():
    """外側の形：前面の外形から背面の外形へ絞る（背面テーパー）。下面は平ら。

    正面から見た4隅は CORNER_R で丸める。正面の外周の縁は C FRONT_CHAMFER、
    背面の外周の縁は C SHADOW_CHAMFER（リアカバーとの境界のシャドーライン）。
    内側の形（Displayの入る空間）は変えない。
    """
    # 面取りは、輪郭を4段に分けた直線の押し出し（ロフト）で作る：
    # 前面（面取りの分だけ小さい）→ 面取りの奥 → 背面の面取りの手前 → 背面（面取りの分だけ小さい）
    def section(z, inset):
        t = (z - Z_FRONT) / (Z_BACK - Z_FRONT)  # 0＝前面、1＝背面
        x0 = X_FRONT0 + (X_OUT0 - X_FRONT0) * t
        x1 = X_FRONT1 + (X_OUT1 - X_FRONT1) * t
        y1 = Y_FRONT1 + (Y_OUT1 - Y_FRONT1) * t
        return rounded_rect_wire(
            x0 + inset, Y_OUT0 + inset, x1 - inset, y1 - inset, z, p.CORNER_R - inset
        )

    wires = [
        section(Z_FRONT, p.FRONT_CHAMFER),
        section(Z_FRONT + p.FRONT_CHAMFER, 0.0),
        section(Z_BACK - p.SHADOW_CHAMFER, 0.0),
        section(Z_BACK, p.SHADOW_CHAMFER),
    ]
    return cq.Workplane().add(cq.Solid.makeLoft(wires, True))


def window():
    """前面の窓。4隅を WINDOW_R で丸める。"""
    return rounded_rect_solid(
        p.LIP_LEFT,
        p.LIP_BOTTOM,
        p.DISPLAY_W - p.LIP_RIGHT,
        p.DISPLAY_H - p.LIP_TOP,
        Z_FRONT - 0.5,
        0.01,
        p.WINDOW_R,
    )


def shell():
    """外周の壁と前面の板（Displayの入る空間と、前面の窓を抜く）。"""
    inner = box(X_IN0, Y_IN0, 0, X_IN1, Y_IN1, Z_BACK + 0.5)
    return outer_body().cut(inner).cut(window())


def left_ribs():
    """Displayの左端の位置決め。端子とプラグの範囲（Y 27〜62）を避ける。

    前面の板から立ち上がる（前面を下にした印刷で、床から積み上がる）。
    右の壁との間でDisplayを左右に±CLEARの範囲に収める。厚みは壁と同じ。
    """
    x0, x1 = -p.CLEAR - p.WALL, -p.CLEAR
    ribs = box(x0, 5.0, 0, x1, 20.0, 8.0)
    return ribs.union(box(x0, 75.0, 0, x1, 140.0, 8.0))


def tab_bosses():
    """固定耳を前から受ける台。ネジは通さない（耳は押さえ板で後ろから挟む）。

    円柱だけだと、前面の板との接続は円柱の底面（約38mm²）だけになる。台を
    下フレームの床（壁）まで伸ばし、前面の板と床の壁の2面につなぐ。
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


# 押さえ板用のボス：耳の内側の隣に立てる。上面は耳の背面より CLAMP_PRELOAD 低い。
CLAMP_BOSS_TOP = p.TAB_Z1 - p.CLAMP_PRELOAD
CLAMP_Y_TOP = -p.CLAMP_Y_MARGIN  # 押さえ板とボスの上端（Displayの下端より下）


def clamp_boss_x():
    """左右の押さえ板用ボスの中心のX。"""
    left = p.TAB_W + p.CLAMP_GAP_X + p.CLAMP_BOSS_W / 2
    return (left, p.DISPLAY_W - left)


def clamp_bosses():
    """押さえ板用のボス。前面の板から立ち上がり、床の壁にもつなぐ。"""
    half = p.CLAMP_BOSS_W / 2
    result = None
    for cx in clamp_boss_x():
        boss = box(cx - half, Y_IN0 - 0.5, 0, cx + half, CLAMP_Y_TOP, CLAMP_BOSS_TOP)
        result = boss if result is None else result.union(boss)
    return result


def clamp_pilots():
    """押さえ板のネジの下穴（M3タッピング）。"""
    result = None
    for cx in clamp_boss_x():
        hole = cylinder_z(
            cx,
            p.TAB_HOLE_CY,
            CLAMP_BOSS_TOP - p.CLAMP_SCREW_DEPTH,
            CLAMP_BOSS_TOP,
            p.SCREW_PILOT_D,
        )
        result = hole if result is None else result.union(hole)
    return result


def clamp_plates_raw():
    """固定耳の押さえ板2枚（Displayの座標）。耳の背面（奥行き9.0）に当たる。

    耳の外側の端から CLAMP_EDGE 内側から、ボスの内側の端まで。上端はDisplayの
    下端より下。耳の位置が左右に数mmずれても、板が耳に掛かる。
    """
    z0 = p.TAB_Z1
    z1 = z0 + p.CLAMP_T
    half = p.CLAMP_BOSS_W / 2
    y0 = -p.TAB_DROP + 0.4
    plates = []
    for side, cx in zip(("left", "right"), clamp_boss_x()):
        if side == "left":
            x0, x1 = p.CLAMP_EDGE, cx + half
        else:
            x0, x1 = cx - half, p.DISPLAY_W - p.CLAMP_EDGE
        plate = box(x0, y0, z0, x1, CLAMP_Y_TOP, z1)
        hole = cylinder_z(cx, p.TAB_HOLE_CY, z0, z1, p.CLAMP_SCREW_CLEAR_D)
        plates.append(plate.cut(hole))
    return plates


def clamp_plates():
    """押さえ板2枚（CADの座標）。"""
    return [to_cad(plate) for plate in clamp_plates_raw()]


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
    # 穴は壁の両側の面より0.5ずつ長く抜く（面がちょうど重なると、形の計算が失敗することがある）
    y0, y1 = Y_OUT0 - CUT_EXTRA, Y_IN0 + CUT_EXTRA
    # Pi用：中央下。プラグ（26×12×7、Micro HDMIは14.7×6.9）が通る幅18。
    # プラグの奥行きの位置は測っていないため、奥行き方向に長くする（15〜35）。
    pi_hole = slot_y(p.PI_POWER_X, 25.0, 18.0, 20.0, y0, y1)
    # Display用：正面から見て左下（左サイドカバーの床）。プラグ23×11×6.8が通る幅14。
    # 端子のZは基準面が未確認のため、奥行き方向に長くする（3〜19）。
    display_hole = slot_y(-p.PORT_PLUG_OUT / 2, 11.0, 14.0, 16.0, y0, y1)
    return pi_hole.union(display_hole)


def top_stop_blocks():
    """上部ストッパーを留める台。上の壁から吊り、下（正面の側）に45度の支えを付ける。

    前面を下にした印刷で、支えから積み上がるためサポートが要らない。支えは
    Displayの上端（Y 148.6、奥行き4.4まで）と重ならないよう、奥行き TOP_STOP_GUSSET_Z0 から始める。
    """
    half = p.TOP_STOP_W / 2
    reach = Y_IN1 - p.TOP_STOP_BLOCK_Y0
    z0 = p.TOP_STOP_GUSSET_Z0 + reach  # 台の下面
    result = None
    for cx in p.TOP_STOP_X:
        block = box(cx - half, p.TOP_STOP_BLOCK_Y0, z0, cx + half, Y_IN1 + 0.5, p.TOP_STOP_BLOCK_Z1)
        gusset = (
            cq.Workplane("YZ")
            .polyline([(Y_IN1, z0), (Y_IN1 - reach, z0), (Y_IN1, p.TOP_STOP_GUSSET_Z0)])
            .close()
            .extrude(p.TOP_STOP_W)
            .translate((cx - half, 0, 0))
        )
        part = block.union(gusset)
        result = part if result is None else result.union(part)
    return result


TOP_STOP_SCREW_Y = (p.TOP_STOP_BLOCK_Y0 + Y_IN1) / 2  # 台の中央のY


def top_stop_pilots():
    result = None
    for cx in p.TOP_STOP_X:
        hole = cylinder_z(
            cx,
            TOP_STOP_SCREW_Y,
            p.TOP_STOP_BLOCK_Z1 - p.TOP_STOP_SCREW_DEPTH,
            p.TOP_STOP_BLOCK_Z1,
            p.SCREW_PILOT_D,
        )
        result = hole if result is None else result.union(hole)
    return result


def top_stoppers_raw():
    """上部ストッパー2個（Displayの座標）。L字：台に載る板＋正面の側へ伸びる脚。

    脚の先は、Displayの上側（基板がない薄い部分）の背面に TOP_STOP_GAP の隙間で向き合う。
    リアカバーとは関係なく、シャーシだけでDisplayの上側が後ろへ倒れるのを止める。
    """
    half = p.TOP_STOP_W / 2
    leg_y1 = p.TOP_STOP_BLOCK_Y0 - p.TOP_STOP_LEG_GAP
    leg_y0 = leg_y1 - p.TOP_STOP_LEG_T
    z_tip = p.DISPLAY_T_THIN + p.TOP_STOP_GAP
    z_plate0 = p.TOP_STOP_BLOCK_Z1
    z_plate1 = z_plate0 + p.TOP_STOP_PLATE_T
    parts = []
    for cx in p.TOP_STOP_X:
        plate = box(cx - half, leg_y0, z_plate0, cx + half, Y_IN1 - 0.3, z_plate1)
        leg = box(cx - half, leg_y0, z_tip, cx + half, leg_y1, z_plate0)
        hole = cylinder_z(cx, TOP_STOP_SCREW_Y, z_plate0, z_plate1, p.CLAMP_SCREW_CLEAR_D)
        parts.append(plate.union(leg).cut(hole))
    return parts


def top_stoppers():
    """上部ストッパー2個（CADの座標）。"""
    return [to_cad(part) for part in top_stoppers_raw()]


def tie_slots():
    """結束バンドを通す穴の組（下フレームの床）。配線口の横で、ケーブルを床に留める。

    ケーブルを引っ張っても端子に力がかからないよう、端子と配線口の間で留める。
    """
    w, d = p.TIE_SLOT
    result = None
    for cx, cz in (p.TIE_PI, p.TIE_DISPLAY):
        for dx in (-p.TIE_PITCH / 2, p.TIE_PITCH / 2):
            x = cx + dx
            slot = box(
                x - w / 2, Y_OUT0 - CUT_EXTRA, cz - d / 2, x + w / 2, Y_IN0 + CUT_EXTRA, cz + d / 2
            )
            result = slot if result is None else result.union(slot)
    return result


def vents():
    """吸気（下）と排気（上）のスリット。幅2.5、奥行き方向に長い。"""
    result = None
    for x in range(64, 121, 6):  # 下：Piの下、Pi用の配線口より左
        s = slot_y(float(x), 26.0, 2.5, 28.0, Y_OUT0 - CUT_EXTRA, Y_IN0 + CUT_EXTRA)
        result = s if result is None else result.union(s)
    for x in range(62, 143, 6):  # 上：Piの上あたり
        result = result.union(
            slot_y(float(x), 28.0, 2.5, 28.0, Y_IN1 - CUT_EXTRA, Y_FRONT1 + 1.0)
        )
    return result


def chassis_raw(engrave=True):
    """Displayの座標（Z＝奥行き）のままの形。engrave=False なら前面の刻印なし（確認用）。"""
    body = (
        shell()
        .union(left_ribs())
        .union(tab_bosses())
        .union(clamp_bosses())
        .union(top_stop_blocks())
        .union(cover_bosses())
    )
    result = (
        body.cut(clamp_pilots())
        .cut(top_stop_pilots())
        .cut(cover_pilots())
        .cut(cable_holes())
        .cut(tie_slots())
        .cut(vents())
    )
    return result.cut(front_engraving()) if engrave else result


def front_engraving():
    """前面のシンボル・ロゴの凹刻印の型（engraving.py。PR 5b）。"""
    import engraving  # engraving が chassis を使うため、ここで読み込む

    return engraving.front_tool()


def chassis():
    """CADの座標（Z＝正面へ正）の形。"""
    return to_cad(chassis_raw())


# check.py と export.py で使う値
OUTER = {
    "x": (X_FRONT0, X_FRONT1),  # 前面の外形（一番大きい所）
    "y": (Y_OUT0, Y_FRONT1),
    "depth": (Z_FRONT, Z_BACK),
}
