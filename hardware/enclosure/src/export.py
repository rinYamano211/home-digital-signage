"""参照モデルとメインシャーシの図（SVG）と、形の数値の要約を出力する（Issue #20）。

実行：venvのPythonで `python hardware/enclosure/src/export.py`
出力：hardware/enclosure/out/ の SVG
- reference-*：参照モデル（正面・背面・下面・左側面）
- chassis-*：メインシャーシ（正面・背面・下面・上面・斜め後ろ）
- clamps-*：メインシャーシに押さえ板2枚と上部ストッパー2個を付けた状態（背面・斜め後ろ）
- rear-cover-*：リアカバー（背面〈壁の側〉・内側・斜め）
- assembly-*：全部を組み立てた状態（正面・背面・下面・斜め後ろ）
- stand-*：卓上スタンドを付けた状態（横・斜め後ろ）。本体は傾けずに描く
- exterior-*：外観の確認（正面・背面・左右45度・左右側面）
- wall-*：壁掛けの状態（壁の板を後ろに置く。左45度・左側面）
- desk-*：卓上の状態（スタンドで後ろへ傾ける。左45度・左側面）
"""

from pathlib import Path

import cadquery as cq

import chassis
import rear_cover
import reference
import stand

OUT_DIR = Path(__file__).resolve().parent.parent / "out"

# 見る向き（projectionDir は、形から見る人の方へ向かう向き）。CADのZは正面へ正。
VIEWS = {
    "front": (0, 0, 1),  # 正面（ガラス側）から
    "back": (0, 0, -1),  # 背面から
    "bottom": (0, -1, 0),  # 下から
    "left": (-1, 0, 0),  # 正面から見て左側面から
}

CHASSIS_VIEWS = {
    "front": (0, 0, 1),
    "back": (0, 0, -1),
    "bottom": (0, -1, 0),
    "top": (0, 1, 0),  # 上から
    "iso-back": (-1, 1, -1.5),  # 斜め後ろ（左上）から
}


def export_views(name, shape, views=VIEWS):
    for view, direction in views.items():
        path = OUT_DIR / f"{name}-{view}.svg"
        cq.exporters.export(
            shape,
            str(path),
            opt={
                "projectionDir": direction,
                "showAxes": False,
                "showHidden": False,
                "width": 800,
                "height": 600,
            },
        )


SIDE_FLIP = ((0, 0, 0), (0, 0, 1), 180)  # 横から見る図は、上下が逆になるため180度回す


def export_exterior(assembly, with_stand):
    """外観の確認用の図。横から見る図は、回してから反対の側から見る（左右が入れ替わるため）。"""
    flipped = assembly.rotate(*SIDE_FLIP)
    export_views(
        "exterior",
        assembly,
        {"front": (0, 0, 1), "back": (0, 0, -1), "left45": (-1, 0.25, 1), "right45": (1, 0.25, 1)},
    )
    export_views("exterior", flipped, {"left": (1, 0, 0), "right": (-1, 0, 0)})

    # 壁掛け：背面の後ろに壁の板（厚み5）を置く。CADのZ＝−奥行き
    wall = cq.Workplane().add(
        cq.Solid.makeBox(500, 300, 5, cq.Vector(-150, -70, -(rear_cover.Z1 + 5)))
    )
    on_wall = assembly.add(wall)
    export_views("wall", on_wall, {"left45": (-1, 0.25, 1)})
    export_views("wall", on_wall.rotate(*SIDE_FLIP), {"left": (1, 0, 0)})

    # 卓上：スタンドごと、本体を後ろへ傾ける（X軸まわり。上が奥へ）
    tilted = with_stand.rotate((0, 0, 0), (1, 0, 0), -p_tilt())
    export_views("desk", tilted, {"left45": (-1, 0.25, 1)})
    export_views("desk", tilted.rotate(*SIDE_FLIP), {"left": (1, 0, 0)})


def p_tilt():
    import params

    return params.STAND_TILT_DEG


def summary():
    lines = []
    for name, shape in reference.parts().items():
        bb = shape.val().BoundingBox()
        lines.append(
            f"{name:14s} X {bb.xmin:7.1f}..{bb.xmax:7.1f}"
            f"  Y {bb.ymin:7.1f}..{bb.ymax:7.1f}"
            f"  depth {-bb.zmax:5.1f}..{-bb.zmin:5.1f}"
        )
    return lines


def main():
    OUT_DIR.mkdir(exist_ok=True)
    export_views("reference", reference.assembly())
    export_views("chassis", chassis.chassis(), CHASSIS_VIEWS)
    with_clamps = chassis.chassis()
    for plate in chassis.clamp_plates() + chassis.top_stoppers():
        with_clamps = with_clamps.add(plate)
    export_views(
        "clamps",
        with_clamps,
        {k: CHASSIS_VIEWS[k] for k in ("back", "iso-back")},
    )
    export_views(
        "rear-cover",
        rear_cover.rear_cover(),
        {
            "back": (0, 0, -1),  # 壁の側から
            "inside": (0, 0, 1),  # 内側（正面の側）から
            "iso-inside": (1, 1, 1.5),  # 内側を斜めから
        },
    )
    assembly = with_clamps.add(rear_cover.rear_cover())
    export_views(
        "assembly",
        assembly,
        {k: CHASSIS_VIEWS[k] for k in ("front", "back", "bottom", "iso-back")},
    )
    with_stand = assembly
    for bracket in stand.brackets():
        with_stand = with_stand.add(bracket)
    export_views("stand", with_stand, {"iso-back": CHASSIS_VIEWS["iso-back"]})
    # 横から見た図：CadQueryのSVGは横向きの視点で上下が逆になるため、
    # 奥行きの軸のまわりに180度回してから描く（足が下になる）
    export_views(
        "stand",
        with_stand.rotate((0, 0, 0), (0, 0, 1), 180),
        {"side": (1, 0, 0)},
    )
    export_exterior(assembly, with_stand)
    for line in summary():
        print(line)
    print(f"SVG: {OUT_DIR}")


if __name__ == "__main__":
    main()
