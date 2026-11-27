"""筐体の確認（Issue #20）。

1. 干渉：筐体と参照モデル（reference.py）が重なる体積が0か
2. 前面の縁：ガラスに被る幅が、表示領域にかからないか（LIP_MIN_GAP以上の余裕）
3. 造形範囲：外形がプリンタの造形範囲（余裕込み）に収まるか

実行：venvのPythonで `python hardware/enclosure/src/check.py`
1つでも満たさなければ、終了コード1で終わる。

参照モデルと重ならないことは、実機に組み付けられることを保証しない。
"""

import sys

import chassis
import params as p
import reference

TOLERANCE = 1e-3  # 体積の許容（mm³）。計算の誤差だけを許す


def check_interference(name, body):
    ok = True
    for part_name, part in reference.parts().items():
        common = body.intersect(part)
        volume = common.val().Volume() if common.vals() else 0.0
        status = "OK" if volume <= TOLERANCE else "NG"
        ok &= status == "OK"
        print(f"[{status}] 干渉 {name} × {part_name}: {volume:.3f} mm3")
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


def main():
    body = chassis.chassis()
    results = [
        check_interference("メインシャーシ", body),
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
