"""筐体の確認（Issue #20）。

0. 形状：正しい立体（isValid）で、1つのつながった塊か
1. 干渉：筐体と参照モデル（reference.py）が重なる体積が0か
2. 前面の縁：ガラスに被る幅が、表示領域にかからないか（LIP_MIN_GAP以上の余裕）
3. 造形範囲：外形がプリンタの造形範囲（余裕込み）に収まるか

実行：venvのPythonで `python hardware/enclosure/src/check.py`
1つでも満たさなければ、終了コード1で終わる。

この確認がすべてOKでも、実機での組立適合性・強度・冷却性能は保証しない。
参照モデルは暫定の範囲で、実物の細かい形ではない。
"""

import sys

import chassis
import params as p
import reference

TOLERANCE = 1e-3  # 体積の許容（mm³）。計算の誤差だけを許す


def check_interference(name, body):
    ok = True
    for part_name, part in reference.parts().items():
        # 重なりが複数の離れた塊になっても、すべての体積を合計する
        common = body.intersect(part)
        volume = sum(s.Volume() for s in common.solids().vals())
        status = "OK" if volume <= TOLERANCE else "NG"
        ok &= status == "OK"
        print(f"[{status}] 干渉 {name} × {part_name}: {volume:.3f} mm3")
    return ok


def check_solid(name, body):
    """形が正しい立体で、1つのつながった塊か（ボスやリブが浮いていないか）。"""
    solids = body.solids().vals()
    valid = all(s.isValid() for s in solids)
    single = len(solids) == 1
    print(f"[{'OK' if valid else 'NG'}] 形状 {name}：isValid={valid}")
    print(f"[{'OK' if single else 'NG'}] ソリッドの数 {name}：{len(solids)}（1であること）")
    return valid and single


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
        status = "OK" if gap >= p.LIP_MIN_GAP else "NG"
        ok &= status == "OK"
        print(
            f"[{status}] 前面の縁 {side}：被り{lip} ベゼル{bezel} "
            f"表示領域までの余裕{gap:.1f}（最小{p.LIP_MIN_GAP}）"
        )
    return ok


def check_print_size():
    limit = p.PRINT_BED - p.PRINT_MARGIN
    w = chassis.OUTER["x"][1] - chassis.OUTER["x"][0]
    h = chassis.OUTER["y"][1] - chassis.OUTER["y"][0]
    d = chassis.OUTER["depth"][1] - chassis.OUTER["depth"][0]
    # 前面を下にして印刷する：床に置く面は幅×高さ、印刷の高さは奥行き
    ok = w <= limit and h <= limit
    status = "OK" if ok else "NG"
    print(
        f"[{status}] 造形範囲 メインシャーシ 幅{w:.1f}×高さ{h:.1f}（上限{limit:.0f}）、"
        f"印刷の高さ{d:.1f}（プリンタの高さの上限は未確認）"
    )
    return ok


def check_clamps(body):
    """押さえ板：正しい立体か、参照モデル・メインシャーシと重ならないか、耳に掛かるか。"""
    ok = True
    tabs = reference.parts()["tabs"]
    for i, plate in enumerate(chassis.clamp_plates(), start=1):
        name = f"押さえ板{i}"
        ok &= check_solid(name, plate)
        ok &= check_interference(name, plate)
        common = plate.intersect(body)
        volume = sum(s.Volume() for s in common.solids().vals())
        status = "OK" if volume <= TOLERANCE else "NG"
        ok &= status == "OK"
        print(f"[{status}] 干渉 {name} × メインシャーシ: {volume:.3f} mm3")
        # 板を耳の側へ0.1動かすと耳と重なる＝板が耳の背面に掛かっている
        pushed = plate.translate((0, 0, 0.1))  # CADのZは正面へ正
        overlap = sum(s.Volume() for s in pushed.intersect(tabs).solids().vals())
        status = "OK" if overlap > TOLERANCE else "NG"
        ok &= status == "OK"
        print(f"[{status}] 押さえ {name} が耳に掛かる面積: {overlap / 0.1:.1f} mm2")
    return ok


def main():
    body = chassis.chassis()
    results = [
        check_solid("メインシャーシ", body),
        check_interference("メインシャーシ", body),
        check_clamps(body),
        check_lips(),
        check_print_size(),
    ]
    if all(results):
        print("すべてOK")
        return 0
    print("NGあり")
    return 1


if __name__ == "__main__":
    sys.exit(main())
