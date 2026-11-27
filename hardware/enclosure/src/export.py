"""参照モデルの図（SVG）と、形の数値の要約を出力する（Issue #20）。

実行：venvのPythonで `python hardware/enclosure/src/export.py`
出力：hardware/enclosure/out/ の SVG（正面・背面・下面・左側面）
"""

from pathlib import Path

import cadquery as cq

import reference

OUT_DIR = Path(__file__).resolve().parent.parent / "out"

# 見る向き（projectionDir は、形から見る人の方へ向かう向き）。CADのZは正面へ正。
VIEWS = {
    "front": (0, 0, 1),  # 正面（ガラス側）から
    "back": (0, 0, -1),  # 背面から
    "bottom": (0, -1, 0),  # 下から
    "left": (-1, 0, 0),  # 正面から見て左側面から
}


def export_views(name, shape):
    for view, direction in VIEWS.items():
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
    for line in summary():
        print(line)
    print(f"SVG: {OUT_DIR}")


if __name__ == "__main__":
    main()
