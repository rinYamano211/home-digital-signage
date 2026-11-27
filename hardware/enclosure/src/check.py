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
    # 一番小さい寸法を印刷の高さとし、残り2つが床に収まるかを見る
    ok = sizes[0] <= limit and sizes[1] <= limit
    return report(
        ok,
        f"造形範囲 {name}：{sizes[0]:.1f}×{sizes[1]:.1f}（上限{limit:.0f}）、"
        f"高さ{sizes[2]:.1f}（プリンタの高さの上限は未確認）",
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
