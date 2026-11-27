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


def check_walls():
    """外観の加工（背面テーパー・角R・シャドーラインの面取り）を重ねた後の、壁の一番薄い所。

    内側の形は直角の箱のまま。背面（テーパーで一番細い所）と、シャドーラインの面取りの所で確かめる。
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
        ("背面の端（シャドーラインの面取り）", back_face, p.CORNER_R - c),
    ]
    for label, outer, r in cases:
        walls = corner_wall(outer, inner, r)
        thinnest = min(walls.values())
        detail = "・".join(f"{k}{v:.2f}" for k, v in walls.items())
        limit = 1.2 if "面取り" in label else 1.5
        ok &= report(thinnest >= limit, f"壁の厚み {label}：最小{thinnest:.2f}（{detail}。最小{limit}）")
    print(
        f"[INFO] 壁の厚み（角以外）：前面の側 {p.WALL + p.FRONT_FLARE:.1f}（上・左・右）、"
        f"背面の側 {p.WALL:.1f}、背面の端 {p.WALL - c:.1f}"
    )
    return ok


def check_window_corners():
    """窓の4隅のRが、表示領域の角にかからないか（Displayが隙間の分だけ動いても LIP_MIN_GAP 残す）。"""
    ok = True
    r = p.WINDOW_R
    corners = {
        "左上": (p.LIP_LEFT, p.LIP_TOP, p.BEZEL_LEFT, p.BEZEL_TOP),
        "右上": (p.LIP_RIGHT, p.LIP_TOP, p.BEZEL_RIGHT, p.BEZEL_TOP),
        "左下": (p.LIP_LEFT, p.LIP_BOTTOM, p.BEZEL_LEFT, p.BEZEL_BOTTOM),
        "右下": (p.LIP_RIGHT, p.LIP_BOTTOM, p.BEZEL_RIGHT, p.BEZEL_BOTTOM),
    }
    for name, (lip_x, lip_y, bezel_x, bezel_y) in corners.items():
        # ガラスの角から測る。円の中心は (縁＋R, 縁＋R)、表示領域の角は (ベゼル−隙間, ベゼル−隙間)
        d = math.hypot(lip_x + r - (bezel_x - p.CLEAR), lip_y + r - (bezel_y - p.CLEAR))
        margin = r - d
        ok &= report(
            margin >= p.LIP_MIN_GAP,
            f"窓の角R{r} {name}：表示領域の角までの余裕{margin:.2f}（最小{p.LIP_MIN_GAP}）",
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
    """設計した穴が、本当に開いているか（形の引き算が失敗していないか）。

    穴の中心に細い円柱を通し、部品と重ならないことを確かめる。開口の面積も表示する。
    """
    ok = True
    y_bottom = (chassis.Y_OUT0 - 1, chassis.Y_IN0 + 1)
    y_top = (chassis.Y_IN1 - 1, chassis.Y_FRONT1 + 1)
    groups = {
        "上のスリット": [(probe_y(float(x), 28.0, *y_top), body) for x in range(62, 143, 6)],
        "下のスリット": [(probe_y(float(x), 26.0, *y_bottom), body) for x in range(64, 121, 6)],
        "配線口": [
            (probe_y(p.PI_POWER_X, 25.0, *y_bottom), body),
            (probe_y(-p.PORT_PLUG_OUT / 2, 11.0, *y_bottom), body),
        ],
        "結束バンドの穴": [
            (probe_y(cx + dx, cz, *y_bottom, r=0.2), body)
            for cx, cz in (p.TIE_PI, p.TIE_DISPLAY)
            for dx in (-p.TIE_PITCH / 2, p.TIE_PITCH / 2)
        ],
        "背面の通気口": [
            (probe_depth(float(x), 52.5, rear_cover.Z0 - 1, rear_cover.Z1 + 1), cover)
            for x in range(64, 141, 6)
        ],
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
    for name, probes in groups.items():
        blocked = sum(1 for probe, part in probes if overlap(probe, part) > TOLERANCE)
        ok &= report(blocked == 0, f"穴 {name}：{len(probes)}か所が開いている（塞がり{blocked}）")

    def stadium(length, width):
        return (length - width) * width + math.pi * (width / 2) ** 2

    top_area = len(range(62, 143, 6)) * stadium(28.0, 2.5)
    bottom_area = len(range(64, 121, 6)) * stadium(28.0, 2.5)
    back_area = len(range(64, 141, 6)) * 2.5 * 45.0
    print(
        f"[INFO] 通気口の開口の面積：上{top_area:.0f} mm2、下{bottom_area:.0f} mm2、"
        f"背面{back_area:.0f} mm2（スリットの数・大きさはPR 5aで変えていない）"
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

    # 保持：リアカバーの有無
    print(
        "[INFO] 保持（リアカバーなし）：前面の縁＋下の押さえ板2枚＋上部ストッパー2個。"
        "どれもシャーシに付くため、リアカバーを外しても変わらない（上の接触の確認を参照）"
    )
    print("[INFO] 保持（リアカバーあり）：上と同じ。リアカバーはDisplayを押さえない")

    results.append(check_lips())
    results.append(check_window_corners())
    results.append(check_walls())
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
