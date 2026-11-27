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
- 卓上スタンド：重さの中心が前後・左右の支点の内側に余裕をもってあるか、
  本体の下面（配線口・吸気のスリット）と机の間に隙間があるか

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


def check_stand(brackets):
    """卓上スタンド：安定（重さの中心と支点）と、本体の下面と机の隙間。"""
    ok = True
    (cg_x, cg_y, cg_z), mass = stand.center_of_mass()
    print(
        f"[INFO] 重さの見積もり：{mass:.0f} g（筐体は充填100%として重めに見積もる）、"
        f"重さの中心 X {cg_x:.1f} Y {cg_y:.1f} 奥行き {cg_z:.1f}"
    )
    w_cg, _ = stand.world(cg_y, cg_z)
    w_front, u_desk = stand.world(*stand.FRONT_POINT)
    w_back, u_back = stand.world(*stand.back_point((cg_y, cg_z)))
    ok &= report(abs(u_back - u_desk) < 1e-6, "スタンド：前後の支点が同じ高さ（机の上）")
    ok &= report(
        w_cg - w_front >= p.STAND_MIN_MARGIN,
        f"スタンド：前へ倒れる向きの余裕（重さの中心〜前の支点）{w_cg - w_front:.1f}（最小{p.STAND_MIN_MARGIN}）",
    )
    ok &= report(
        w_back - w_cg >= p.STAND_MIN_MARGIN,
        f"スタンド：後ろへ倒れる向きの余裕（重さの中心〜後ろの支点）{w_back - w_cg:.1f}（最小{p.STAND_MIN_MARGIN}）",
    )
    x0 = min(p.KEYHOLE_X) - p.STAND_W / 2
    x1 = max(p.KEYHOLE_X) + p.STAND_W / 2
    side = min(cg_x - x0, x1 - cg_x)
    ok &= report(
        side >= p.STAND_MIN_MARGIN,
        f"スタンド：左右に倒れる向きの余裕（重さの中心〜外側のブラケット）{side:.1f}（最小{p.STAND_MIN_MARGIN}）",
    )
    # ブラケットの輪郭の点が、机より下に出ない
    low = min(stand.world(y, z)[1] for y, z in stand.profile((cg_y, cg_z))) - u_desk
    ok &= report(low >= -1e-6, f"スタンド：ブラケットが机より下に出ない（最も低い点の差 {low:.2f}）")

    # 本体の下面（Y＝下面、奥行き z）と机の隙間
    def gap(z):
        return stand.world(stand.Y_BOTTOM, z)[1] - u_desk

    checks = {
        "本体の下面（一番低い後ろの端）": (stand.Z_BACK, stand.Z_BACK),
        "Pi用の配線口（奥行き15〜35）": (15.0, 35.0),
        "Display用の配線口（奥行き3〜19）": (3.0, 19.0),
        "吸気のスリット（奥行き12〜40）": (12.0, 40.0),
    }
    for name, (z0, z1) in checks.items():
        g = min(gap(z0), gap(z1))
        ok &= report(
            g >= p.STAND_MIN_CLEARANCE,
            f"スタンド：{name}と机の隙間 {g:.1f}（最小{p.STAND_MIN_CLEARANCE}）",
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
    results.append(check_stand(brackets))

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
