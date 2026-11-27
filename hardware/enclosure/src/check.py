"""筐体の確認（Issue #20）。

確認すること：
- 形状：各部品が正しい立体（isValid）で、1つのつながった塊か
- 干渉：各部品と参照モデル（reference.py）、部品どうしが重なる体積が0か
- 接触：押さえ板・上部ストッパー・リアカバーが、決めた相手に当たる・載るか
  （部品を相手の側へ少し動かすと重なる＝接している、で確かめる）
- ネジ：リアカバーの6か所で、カバーの通し穴・シャーシのボスの上面・下穴がそろっているか
- 保持：リアカバーがなくても、Displayの下（押さえ板）と上（上部ストッパー）が押さえられるか
- 前面の縁：ガラスに被る幅が、表示領域にかからないか（LIP_MIN_GAP以上の余裕）
- 造形範囲：各部品がプリンタの造形範囲（余裕込み）に収まるか
- 卓上スタンド：CADを傾けたときの実際の接地点から、重さの中心（筐体の重さを変えた3通り）が
  前後・左右の支点の内側に余裕をもってあるか、本体と机の間に隙間があるか、
  取り付けの動き（押し込み・10下ろす）の途中で重ならないか

実行：venvのPythonで `python hardware/enclosure/src/check.py`
1つでも満たさなければ、終了コード1で終わる。

この確認がすべてOKでも、実機での組立適合性・保持力・強度・冷却性能は保証しない。
参照モデルは暫定の範囲で、実物の細かい形ではない。
"""

import math
import sys

import cadquery as cq

import chassis
import params as p
import rear_cover
import reference
import cables
import stand
from reference import to_cad

TOLERANCE = 1e-3  # 体積の許容（mm³）。計算の誤差だけを許す
TOWARD_FRONT = (0, 0, 1)  # CADのZは正面へ正


def overlap(a, b):
    """重なりの体積。重なりが複数の離れた塊になっても、すべて合計する。"""
    return sum(s.Volume() for s in a.intersect(b).solids().vals())


def report(ok, text):
    print(f"[{'OK' if ok else 'NG'}] {text}")
    return ok


def check_solid(name, body):
    """形が正しい立体で、1つのつながった塊か（ボスやリブが浮いていないか）。"""
    solids = body.solids().vals()
    valid = all(s.isValid() for s in solids)
    ok = report(valid, f"形状 {name}：isValid={valid}")
    ok &= report(len(solids) == 1, f"ソリッドの数 {name}：{len(solids)}（1であること）")
    return ok


def check_interference(name, body, others):
    """参照モデルと、ほかの部品（others：名前→形）に重ならないか。"""
    ok = True
    targets = list(reference.parts().items()) + list(others.items())
    for other_name, other in targets:
        volume = overlap(body, other)
        ok &= report(volume <= TOLERANCE, f"干渉 {name} × {other_name}: {volume:.3f} mm3")
    return ok


def check_contact(name, body, target_name, target, distance, gap=0.0):
    """body を正面の側へ distance 動かすと target と重なる＝向き合って接している。

    gap は、もともとある隙間。重なりの厚みは distance − gap になるため、それで割って面積にする。
    """
    moved = body.translate(tuple(distance * v for v in TOWARD_FRONT))
    area = overlap(moved, target) / (distance - gap)
    return report(area > TOLERANCE, f"接触 {name} → {target_name}：{area:.1f} mm2")


def check_print_size(name, body):
    limit = p.PRINT_BED - p.PRINT_MARGIN
    bb = body.val().BoundingBox()
    sizes = sorted([bb.xlen, bb.ylen, bb.zlen], reverse=True)
    # 一番小さい寸法を印刷の高さとし、残り2つが床に収まるかを見る（ブリムの幅を周りに足す）
    brim = 2 * p.PRINT_BRIM
    ok = sizes[0] + brim <= limit and sizes[1] + brim <= limit
    return report(
        ok,
        f"造形範囲 {name}：{sizes[0]:.1f}×{sizes[1]:.1f}、ブリム込み{sizes[0] + brim:.1f}×{sizes[1] + brim:.1f}"
        f"（上限{limit:.0f}）、高さ{sizes[2]:.1f}（プリンタの高さの上限は未確認）",
    )


def check_cover_screws(body, cover):
    """リアカバーの6か所：通し穴があり、シャーシのボスの上面が当たり、下穴が開いているか。"""
    ok = True
    z_back = chassis.Z_BACK
    for i, (cx, cy) in enumerate(rear_cover.screw_points(), start=1):
        # ボスの上面：穴の周り（外径の内側、下穴の外側）に、シャーシの面がある
        ring = chassis.cylinder_z(cx, cy, z_back - 0.1, z_back, p.COVER_BOSS_D - 0.5).cut(
            chassis.cylinder_z(cx, cy, z_back - 0.1, z_back, p.SCREW_PILOT_D + 0.5)
        )
        seat = overlap(to_cad(ring), body) / 0.1
        # 下穴：穴の中心の細い円柱が、シャーシの中で何にも当たらない
        core = to_cad(chassis.cylinder_z(cx, cy, z_back - p.COVER_SCREW_DEPTH + 0.5, z_back, 1.0))
        pilot_open = overlap(core, body) <= TOLERANCE
        # 通し穴：カバーの板を貫く細い円柱が、カバーに当たらない
        through = to_cad(chassis.cylinder_z(cx, cy, rear_cover.Z0, rear_cover.Z1, 2.0))
        hole_open = overlap(through, cover) <= TOLERANCE
        good = seat > 1.0 and pilot_open and hole_open
        ok &= report(
            good,
            f"ネジ{i}（X {cx:.1f}, Y {cy:.1f}）：ボスの上面{seat:.1f} mm2、"
            f"下穴{'あり' if pilot_open else 'なし'}、カバーの通し穴{'あり' if hole_open else 'なし'}",
        )
    return ok


def tilted(point):
    """CADの座標の点 (x, y, z) を、スタンドで傾けた状態の (x, W 後ろ, U 上) にする。

    CADのZ＝−奥行き。stand.world と同じ式。
    """
    x, y, z = point
    w, u = stand.world(y, -z)
    return x, w, u


def lowest_points(shapes, tol=0.01):
    """形の頂点を傾けた状態にし、一番低い高さと、その高さにある点を返す。"""
    pts = [tilted(v.toTuple()) for s in shapes for v in s.vertices().vals()]
    u_min = min(u for _, _, u in pts)
    return u_min, [(x, w) for x, w, u in pts if u - u_min < tol]


def check_stand(brackets, body, cover):
    """卓上スタンド：CADを傾けて、実際の接地点・安定・下面と机の隙間を確かめる。

    支点や隙間は、計算の式ではなく、CADの頂点を傾けたときの一番低い所から求める。
    重さの中心は、筐体の重さを STAND_MASS_RATIOS の割合で変えて確かめる
    （筐体が軽いと中心が前へ寄る。重めの見積もりが、中心の位置の安全側とは限らないため）。
    """
    ok = True
    # 接地：ブラケットの一番低い点（机）
    u_desk, contacts = lowest_points(brackets)
    w_front = min(w for _, w in contacts)
    w_back = max(w for _, w in contacts)
    x0 = min(x for x, _ in contacts)
    x1 = max(x for x, _ in contacts)
    print(
        f"[INFO] 接地（CADから）：机の高さ{u_desk:.2f}、前の支点W {w_front:.1f}・後ろの支点W {w_back:.1f}、"
        f"左右X {x0:.1f}〜{x1:.1f}"
    )
    # 計算の式で作った支点と一致するか（形と式のずれを見つける）
    w_f_calc, u_calc = stand.world(*stand.FRONT_POINT)
    match = abs(u_calc - u_desk) < 0.05 and abs(w_f_calc - w_front) < 0.05
    ok &= report(match, f"スタンド：CADの接地と計算の支点が一致（前W 計算{w_f_calc:.1f}／CAD{w_front:.1f}）")

    # 本体（シャーシ＋カバー）が机より上にあるか、一番低い所の隙間
    u_case, _ = lowest_points([body, cover])
    gap_min = u_case - u_desk
    ok &= report(
        gap_min >= p.STAND_MIN_CLEARANCE,
        f"スタンド：本体の一番低い所と机の隙間（CADから）{gap_min:.1f}（最小{p.STAND_MIN_CLEARANCE}）",
    )

    # 下面の穴のある所の隙間（下面は平らな面なので、奥行きの範囲の両端で確かめる）
    def gap(depth):
        return stand.world(stand.Y_BOTTOM, depth)[1] - u_desk

    zones = {
        "Pi用の配線口（奥行き15〜35）": (15.0, 35.0),
        "Display用の配線口（奥行き3〜19）": (3.0, 19.0),
        "吸気のスリット（奥行き12〜40）": (12.0, 40.0),
    }
    for name, (d0, d1) in zones.items():
        g = min(gap(d0), gap(d1))
        ok &= report(
            g >= p.STAND_MIN_CLEARANCE, f"スタンド：{name}と机の隙間 {g:.1f}（最小{p.STAND_MIN_CLEARANCE}）"
        )

    # 安定：筐体の重さを変えて、重さの中心と支点の水平距離
    for ratio in p.STAND_MASS_RATIOS:
        (cx, cy, cz), mass = stand.center_of_mass(ratio)
        w_cg, _ = stand.world(cy, cz)
        front = w_cg - w_front
        back = w_back - w_cg
        side = min(cx - x0, x1 - cx)
        good = min(front, back, side) >= p.STAND_MIN_MARGIN
        ok &= report(
            good,
            f"スタンド：安定 筐体{int(ratio * 100)}%（合計{mass:.0f}g、中心X {cx:.1f}・Y {cy:.1f}・奥行き{cz:.1f}）"
            f" 前{front:.1f}・後ろ{back:.1f}・左右{side:.1f}（最小{p.STAND_MIN_MARGIN}）",
        )
    return ok


def screw_model(cx, head_d, head_t, shank_d):
    """キーホールに掛けるネジ（ブラケットにねじ込んだ状態）。Displayの座標。"""
    screw_y = p.KEYHOLE_ENTRY_Y + p.KEYHOLE_SLOT_LEN
    face = stand.Z_BACK  # ブラケットの当たり面＝カバーの外側
    shank = chassis.cylinder_z(cx, screw_y, face - p.STAND_SCREW_STANDOFF, face, shank_d)
    head = chassis.cylinder_z(
        cx, screw_y, face - p.STAND_SCREW_STANDOFF - head_t, face - p.STAND_SCREW_STANDOFF, head_d
    )
    return shank.union(head)


def check_stand_assembly():
    """取り付けの動き：本体をキーホールの丸い穴の位置（10上）で押し込み、10下ろす。

    途中で、本体とブラケット、カバーとネジ（上限の大きさ）が重ならないかを1mmごとに確かめる。
    ネジの頭の上と、頭の空間の天井の余裕も確かめる。
    """
    ok = True
    case = chassis.chassis_raw().union(rear_cover.rear_cover_raw())
    cover = rear_cover.rear_cover_raw()
    brs = stand.brackets_raw()
    screws = [
        screw_model(cx, p.STAND_SCREW_HEAD_D_MAX, p.STAND_SCREW_HEAD_T_MAX, p.STAND_SCREW_SHANK_D_MAX)
        for cx in p.KEYHOLE_X
    ]
    slide = p.KEYHOLE_SLOT_LEN
    worst = 0.0
    # 押し込み：丸い穴の位置（slide 上）で、本体を後ろから6手前の所から当たり面まで
    for k in range(0, 7):
        moved = case.translate((0, slide, -float(k)))
        worst = max(worst, sum(overlap(moved, b) for b in brs))
        worst = max(worst, sum(overlap(cover.translate((0, slide, -float(k))), s) for s in screws))
    # 下ろす：slide 上から最終位置まで
    for k in range(0, int(slide) + 1):
        dy = slide - k
        moved = case.translate((0, dy, 0))
        worst = max(worst, sum(overlap(moved, b) for b in brs))
        worst = max(worst, sum(overlap(cover.translate((0, dy, 0)), s) for s in screws))
    ok &= report(
        worst <= TOLERANCE,
        f"スタンド：取り付けの動き（押し込み・10下ろす）で、本体・ネジ（頭{p.STAND_SCREW_HEAD_D_MAX}×厚み"
        f"{p.STAND_SCREW_HEAD_T_MAX}、軸{p.STAND_SCREW_SHANK_D_MAX}）が重ならない（最大{worst:.3f} mm3）",
    )
    roof = p.COVER_T + p.KEYHOLE_POCKET_H
    margin = roof - (p.STAND_SCREW_STANDOFF + p.STAND_SCREW_HEAD_T_MAX)
    ok &= report(
        margin >= 0.3,
        f"スタンド：ネジの頭の上と、頭の空間の天井の余裕 {margin:.1f}（最小0.3）",
    )
    under = p.STAND_SCREW_STANDOFF - p.COVER_T
    ok &= report(under >= 0.2, f"スタンド：ネジの頭の下と、カバーの板の隙間 {under:.1f}（最小0.2）")
    return ok


def corner_wall(outer, inner, r):
    """外側の角を半径 r で丸め、内側の角は直角のときの、角の壁の一番薄い所。

    outer・inner は (x0, y0, x1, y1)。4隅それぞれの値を返す。
    """
    result = {}
    corners = {
        "左下": ((outer[0] + r, outer[1] + r), (inner[0], inner[1])),
        "左上": ((outer[0] + r, outer[3] - r), (inner[0], inner[3])),
        "右下": ((outer[2] - r, outer[1] + r), (inner[2], inner[1])),
        "右上": ((outer[2] - r, outer[3] - r), (inner[2], inner[3])),
    }
    straight = min(inner[0] - outer[0], inner[1] - outer[1], outer[2] - inner[2], outer[3] - inner[3])
    for name, ((cx, cy), (ix, iy)) in corners.items():
        # 内側の角が、角の円の中心より外側の区画にあるときだけ、円弧との距離で薄くなる
        dx = ix - cx
        dy = iy - cy
        outward = (dx * (1 if "右" in name else -1) > 0) and (dy * (1 if "上" in name else -1) > 0)
        if outward:
            result[name] = min(r - math.hypot(dx, dy), straight)
        else:
            result[name] = straight
    return result


def check_walls(body):
    """外観の加工（背面テーパー・角R・面取り）を重ねた後の、壁の一番薄い所。

    式：内側の角が直角のまま、外側の角を丸めたときの角の壁の厚み（背面の側・シャドーラインの面取りの所）。
    CAD：外側の面と、内側の空間（Displayの入る箱）の間の一番短い距離。
    下限の目安1.2は、ノズル0.4で外周の線3本分。実際の強度は試作で確かめる（#21）。
    """
    ok = True
    inner = (chassis.X_IN0, chassis.Y_IN0, chassis.X_IN1, chassis.Y_IN1)
    back = (chassis.X_OUT0, chassis.Y_OUT0, chassis.X_OUT1, chassis.Y_OUT1)
    c = p.SHADOW_CHAMFER
    back_face = (back[0] + c, back[1] + c, back[2] - c, back[3] - c)
    front = (chassis.X_FRONT0, chassis.Y_OUT0, chassis.X_FRONT1, chassis.Y_FRONT1)
    cases = [
        ("前面の側", front, p.CORNER_R),
        ("背面の側（テーパーで一番細い所）", back, p.CORNER_R),
        ("背面の端（シャドーラインの面取り、奥行き0.4の帯）", back_face, p.CORNER_R - c),
    ]
    for label, outer, r in cases:
        walls = corner_wall(outer, inner, r)
        thinnest = min(walls.values())
        detail = "・".join(f"{k}{v:.2f}" for k, v in walls.items())
        ok &= report(thinnest >= 1.2, f"壁の厚み（式）{label}：最小{thinnest:.2f}（{detail}。最小1.2）")

    # CAD：外側の側面（前面・背面の平らな面を除く。背面は開口でもともと内側とつながる）と内側の箱の最短距離
    side_faces = [
        f
        for f in chassis.outer_body().val().Faces()
        if not (f.geomType() == "PLANE" and abs(abs(f.normalAt().z) - 1.0) < 1e-6)
    ]
    outer_shell = cq.Compound.makeCompound(side_faces)
    cavity = chassis.box(chassis.X_IN0, chassis.Y_IN0, 0, chassis.X_IN1, chassis.Y_IN1, chassis.Z_BACK).val()
    d = outer_shell.distance(cavity)
    ok &= report(d >= 1.2, f"壁の厚み（CAD）：外側の面と内側の空間の最短距離 {d:.2f}（最小1.2）")
    # 内側の部品（ボス・台など）が外側の面から飛び出していない
    poke = sum(sol.Volume() for sol in chassis.chassis_raw().cut(chassis.outer_body()).solids().vals())
    ok &= report(poke <= TOLERANCE, f"外形：ボス・台などが外側の面から飛び出していない（{poke:.4f} mm3）")
    # リアカバー用ボスの中心から外側の面まで（ボスの外径3.5を引くと、ボスの周りの壁）
    for cx, cy in chassis.COVER_BOSSES_FULL + [(x, chassis.Y_IN1 - 3.0) for x in chassis.COVER_BOSSES_TOP]:
        line = chassis.box(cx - 0.05, cy - 0.05, chassis.Z_BACK - 0.4, cx + 0.05, cy + 0.05, chassis.Z_BACK).val()
        dist = outer_shell.distance(line)
        # ボスと壁は1つの立体のため、ネジの下穴から外側の面までの肉厚で見る
        wall = dist - p.SCREW_PILOT_D / 2
        ok &= report(wall >= 2.0, f"リアカバー用ボス（X {cx:.1f}, Y {cy:.1f}）：ネジの下穴から外側の面まで{wall:.2f}（最小2.0）")
    print(
        f"[INFO] 壁の厚み（角以外）：前面の側 {p.WALL + p.FRONT_FLARE:.1f}（上・左・右）、"
        f"背面の側 {p.WALL:.1f}、背面の端 {p.WALL - c:.1f}"
    )
    return ok

def window_corner_clearance(lip_x, lip_y, r, ax, ay):
    """窓の角の近くで、表示領域の角 (ax, ay) から窓の縁までの距離（ガラスの角から内側へ測る座標）。

    窓の縁：直線部分は u＝lip_x・v＝lip_y。角は中心 (lip_x＋r, lip_y＋r)、半径 r の円弧。
    表示領域は u≧ax・v≧ay に広がる長方形で、窓の縁に一番近いのはその角 (ax, ay)。
    - 角が円弧の区画（u＜中心・v＜中心）にあるとき：r −（円弧の中心までの距離）
    - それ以外：近い方の直線部分までの距離
    """
    cx, cy = lip_x + r, lip_y + r
    if ax < cx and ay < cy:
        return r - math.hypot(cx - ax, cy - ay)
    if ax < cx:
        return ax - lip_x
    if ay < cy:
        return ay - lip_y
    return min(ax - lip_x, ay - lip_y)


def check_window_corners():
    """窓（角R）と表示領域のすき間：式と、CADの形の両方で確かめる。

    Displayは隙間 CLEAR の分だけ上下左右に動くため、表示領域を4通り（左上・右上・左下・右下へ
    CLEAR ずらす）に動かして確かめる。必要なすき間は LIP_MIN_GAP。
    """
    ok = True
    r = p.WINDOW_R
    m = p.LIP_MIN_GAP
    corners = {
        "左上": (p.LIP_LEFT, p.LIP_TOP, p.BEZEL_LEFT, p.BEZEL_TOP),
        "右上": (p.LIP_RIGHT, p.LIP_TOP, p.BEZEL_RIGHT, p.BEZEL_TOP),
        "左下": (p.LIP_LEFT, p.LIP_BOTTOM, p.BEZEL_LEFT, p.BEZEL_BOTTOM),
        "右下": (p.LIP_RIGHT, p.LIP_BOTTOM, p.BEZEL_RIGHT, p.BEZEL_BOTTOM),
    }
    for name, (lip_x, lip_y, bezel_x, bezel_y) in corners.items():
        # その角に一番近づく向きに、Displayが CLEAR 動いたとき
        c = window_corner_clearance(lip_x, lip_y, r, bezel_x - p.CLEAR, bezel_y - p.CLEAR)
        ok &= report(c >= m, f"窓の角R{r} {name}（式）：表示領域の角までのすき間{c:.2f}（最小{m}）")

    # CADの形：表示領域を m だけ外へ広げた形（角は半径 m の丸）が、窓の開口の中に収まるか
    win = chassis.window()
    x0, x1 = p.BEZEL_LEFT, p.DISPLAY_W - p.BEZEL_RIGHT
    y0, y1 = p.BEZEL_BOTTOM, p.DISPLAY_H - p.BEZEL_TOP
    worst = 0.0
    for sx in (-p.CLEAR, p.CLEAR):
        for sy in (-p.CLEAR, p.CLEAR):
            area = chassis.rounded_rect_solid(
                x0 + sx - m, y0 + sy - m, x1 + sx + m, y1 + sy + m, chassis.Z_FRONT - 0.2, -0.2, m
            )
            outside = sum(sol.Volume() for sol in area.cut(win).solids().vals())
            worst = max(worst, outside)
    ok &= report(
        worst <= TOLERANCE,
        f"窓（CAD）：表示領域＋すき間{m}が、Displayを4通りに動かしても窓の開口に収まる（はみ出し{worst:.4f} mm3）",
    )
    return ok

def probe_y(x, depth, y0, y1, r=0.3):
    """上下方向の細い円柱（CADの座標）。穴が本当に開いているかを調べる。"""
    return cq.Workplane().add(
        cq.Solid.makeCylinder(r, y1 - y0, cq.Vector(x, y0, -depth), cq.Vector(0, 1, 0))
    )


def probe_depth(x, y, d0, d1, r=0.3):
    """奥行き方向の細い円柱（CADの座標）。"""
    return to_cad(chassis.cylinder_z(x, y, d0, d1, 2 * r))


def check_openings(body, cover):
    """設計した穴が、開口の断面全体で開いているか（形の引き算が失敗していないか）。

    長穴・配線口・結束バンドの穴・背面の通気口は、穴の形を各辺0.1ずつ小さくした型を通し、
    部品と重ならないことを確かめる（開口の断面全体の確認）。キーホールとワイヤーの穴は、
    内側の空間とつながる形のため、穴の中心を細い棒で通す確認（貫通の確認）にとどめる。
    """
    ok = True
    s_ = 0.1  # 型を小さくする量
    yb = (chassis.Y_OUT0 - 1, chassis.Y_IN0 + 1)
    yt = (chassis.Y_IN1 - 1, chassis.Y_FRONT1 + 1)

    def slot(cx, cz, lx, lz, y0, y1):
        return to_cad(chassis.slot_y(cx, cz, lx - 2 * s_, lz - 2 * s_, y0, y1))

    w, d = p.TIE_SLOT
    sections = {
        "上のスリット": [(slot(float(x), 28.0, 2.5, 28.0, *yt), body) for x in range(62, 143, 6)],
        "下のスリット": [(slot(float(x), 26.0, 2.5, 28.0, *yb), body) for x in range(64, 121, 6)],
        "配線口": [
            (slot(p.PI_POWER_X, 25.0, 18.0, 20.0, *yb), body),
            (slot(-p.PORT_PLUG_OUT / 2, 11.0, 14.0, 16.0, *yb), body),
        ],
        "結束バンドの穴": [
            (to_cad(chassis.box(x - w / 2 + s_, yb[0], cz - d / 2 + s_, x + w / 2 - s_, yb[1], cz + d / 2 - s_)), body)
            for cx, cz in (p.TIE_PI, p.TIE_DISPLAY)
            for x in (cx - p.TIE_PITCH / 2, cx + p.TIE_PITCH / 2)
        ],
        "背面の通気口": [
            (to_cad(chassis.box(x - 1.25 + s_, 30.0 + s_, rear_cover.Z0 - 1, x + 1.25 - s_, 75.0 - s_, rear_cover.Z1 + 1)), cover)
            for x in range(64, 141, 6)
        ],
    }
    for name, probes in sections.items():
        blocked = sum(1 for probe, part in probes if overlap(probe, part) > TOLERANCE)
        ok &= report(blocked == 0, f"穴（断面全体）{name}：{len(probes)}か所が開いている（欠け・塞がり{blocked}）")

    centers = {
        "キーホール（丸い穴・溝）": [
            (probe_depth(cx, y, rear_cover.Z0 - 0.1, rear_cover.Z1 + 1), cover)
            for cx in p.KEYHOLE_X
            for y in (p.KEYHOLE_ENTRY_Y, p.KEYHOLE_ENTRY_Y + p.KEYHOLE_SLOT_LEN)
        ],
        "ワイヤーの穴": [
            (probe_depth(cx + dx, p.WIRE_ANCHOR_Y, rear_cover.Z0 - 0.1, rear_cover.Z1 + 1), cover)
            for cx in p.KEYHOLE_X
            for dx in (-p.WIRE_HOLE_PITCH / 2, p.WIRE_HOLE_PITCH / 2)
        ],
    }
    for name, probes in centers.items():
        blocked = sum(1 for probe, part in probes if overlap(probe, part) > TOLERANCE)
        ok &= report(blocked == 0, f"穴（中心の貫通）{name}：{len(probes)}か所が貫通している（塞がり{blocked}）")

    def stadium(length, width):
        return (length - width) * width + math.pi * (width / 2) ** 2

    top_area = len(range(62, 143, 6)) * stadium(28.0, 2.5)
    bottom_area = len(range(64, 121, 6)) * stadium(28.0, 2.5)
    back_area = len(range(64, 141, 6)) * 2.5 * 45.0
    print(
        f"[INFO] 通気口の開口の面積（設計の寸法から計算）：上{top_area:.0f} mm2、下{bottom_area:.0f} mm2、"
        f"背面{back_area:.0f} mm2。断面全体の確認がOKなら、この面積が開いている"
    )
    return ok

def check_cables(brackets, body, cover):
    """卓上の配線（簡易モデル）。曲げの半径・出る位置は仮定の値での確認で、実物のケーブルを
    安全に曲げられることを保証するものではない（実物の確認は#21）。

    - 曲げに使える高さ：配線口から下面に垂直に出て、後ろ向きに机へ寝かせるのに必要な高さと比べる
    - 干渉：ケーブルのモデルと、スタンド・本体が重ならないか
    """
    ok = True
    for name, x, depth, d in cables.cable_specs():
        rows = []
        for z in (depth - 10, depth, depth + 10) if name == "Pi電源" else (depth - 8, depth, depth + 8):
            available, needed = cables.bend_budget(z, d)
            rows.append(f"奥行き{z:.0f}で{available - needed:+.1f}")
        available, needed = cables.bend_budget(depth, d)
        # 配線口の前から後ろの端まで、どこから出ても足りること
        worst = min(cables.bend_budget(z, d)[0] - needed for z in ((depth - 10, depth + 10) if name == "Pi電源" else (depth - 8, depth + 8)))
        ok &= report(
            worst >= 0,
            f"卓上の配線 {name}（仮定の曲げ半径{p.CABLE_BEND_R}）：後ろへ曲げるのに要る高さ{needed:.1f}、"
            f"使える高さ{available:.1f}（余裕 {'・'.join(rows)}）",
        )
    models = cables.cables()
    for name, shape in models.items():
        hit_stand = sum(overlap(shape, b) for b in brackets)
        hit_body = overlap(shape, body) + overlap(shape, cover)
        ok &= report(
            hit_stand <= TOLERANCE and hit_body <= TOLERANCE,
            f"卓上の配線 {name}：モデルとスタンドの重なり{hit_stand:.2f} mm3、本体との重なり{hit_body:.2f} mm3",
        )
    return ok


def check_lips():
    ok = True
    lips = {
        "上": (p.LIP_TOP, p.BEZEL_TOP),
        "下": (p.LIP_BOTTOM, p.BEZEL_BOTTOM),
        "左": (p.LIP_LEFT, p.BEZEL_LEFT),
        "右": (p.LIP_RIGHT, p.BEZEL_RIGHT),
    }
    for side, (lip, bezel) in lips.items():
        # Displayは隙間CLEARの分だけ動くため、その分も引いて確かめる
        gap = bezel - lip - p.CLEAR
        ok &= report(
            gap >= p.LIP_MIN_GAP,
            f"前面の縁 {side}：被り{lip} ベゼル{bezel} 表示領域までの余裕{gap:.1f}（最小{p.LIP_MIN_GAP}）",
        )
    return ok


def main():
    body = chassis.chassis()
    clamps = chassis.clamp_plates()
    stoppers = chassis.top_stoppers()
    cover = rear_cover.rear_cover()
    brackets = stand.brackets()
    refs = reference.parts()

    parts = {"メインシャーシ": body}
    parts.update({f"押さえ板{i}": c for i, c in enumerate(clamps, start=1)})
    parts.update({f"上部ストッパー{i}": s for i, s in enumerate(stoppers, start=1)})
    parts["リアカバー"] = cover
    parts.update({f"スタンド{i}": b for i, b in enumerate(brackets, start=1)})

    results = []
    # 形状と干渉（部品どうしは、組み合わせを1回ずつ確かめる）
    names = list(parts)
    for i, name in enumerate(names):
        results.append(check_solid(name, parts[name]))
        later = {n: parts[n] for n in names[i + 1 :]}
        results.append(check_interference(name, parts[name], later))

    # 接触
    for i, c in enumerate(clamps, start=1):
        results.append(check_contact(f"押さえ板{i}", c, "固定耳の背面", refs["tabs"], 0.1))
    for i, s in enumerate(stoppers, start=1):
        results.append(check_contact(f"上部ストッパー{i}", s, "シャーシの台", body, 0.1))
        results.append(
            check_contact(
                f"上部ストッパー{i}（隙間{p.TOP_STOP_GAP}を詰めたとき）",
                s,
                "Displayの背面",
                refs["display"],
                p.TOP_STOP_GAP + 0.05,
                gap=p.TOP_STOP_GAP,
            )
        )
    results.append(check_contact("リアカバー", cover, "シャーシの縁", body, 0.1))
    results.append(check_cover_screws(body, cover))
    for i, b in enumerate(brackets, start=1):
        results.append(check_contact(f"スタンド{i}", b, "リアカバーの背面", cover, 0.1))
        moved_up = b.translate((0, 0.1, 0))  # Yは上へ正
        area = overlap(moved_up, body) / 0.1
        results.append(report(area > TOLERANCE, f"接触 スタンド{i} → 本体の下面：{area:.1f} mm2"))
    results.append(check_stand(brackets, body, cover))
    results.append(check_stand_assembly())
    results.append(check_cables(brackets, body, cover))

    # 保持：リアカバーの有無
    print(
        "[INFO] 保持（リアカバーなし）：前面の縁＋下の押さえ板2枚＋上部ストッパー2個。"
        "どれもシャーシに付くため、リアカバーを外しても変わらない（上の接触の確認を参照）"
    )
    print("[INFO] 保持（リアカバーあり）：上と同じ。リアカバーはDisplayを押さえない")

    results.append(check_lips())
    results.append(check_window_corners())
    results.append(check_walls(body))
    results.append(check_openings(body, cover))
    for name, part in parts.items():
        grams = part.val().Volume() / 1000.0 * p.PETG_DENSITY
        print(f"[INFO] 重さ（充填100%の見積もり）{name}：{grams:.1f} g")
    for name, part in parts.items():
        results.append(check_print_size(name, part))
    d0, d1 = rear_cover.OUTER_DEPTH
    print(f"[INFO] 組み立てたときの全体の奥行き：{d1 - d0:.1f}（前面の板〜リアカバーの外側）")

    if all(results):
        print("すべてOK")
        return 0
    print("NGあり")
    return 1


if __name__ == "__main__":
    sys.exit(main())
