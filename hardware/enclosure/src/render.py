"""外観確認用の陰影つきの画像（PNG）を作る（Issue #20、PR 5a）。

CadQueryと一緒に入るVTKで、画面を開かずに描く。色はマットなダークチャコールを仮に使う
（色・材料は#21で決める）。Displayは黒い板、Piは描かない。

実行：venvのPythonで `python hardware/enclosure/src/render.py`
出力：hardware/enclosure/out/render-*.png
"""

from pathlib import Path

import vtk

import cables
import chassis
import params as p
import rear_cover
import reference
import stand

OUT_DIR = Path(__file__).resolve().parent.parent / "out"
BODY_COLOR = (0.30, 0.30, 0.31)  # 仮の色（ダークチャコール）
SCREEN_COLOR = (0.05, 0.05, 0.06)
WALL_COLOR = (0.85, 0.84, 0.82)
DESK_COLOR = (0.55, 0.45, 0.35)
CABLE_COLOR = (0.85, 0.85, 0.85)  # ケーブルは見分けやすい明るい色（実物は黒）


def actor(shape, color, tolerance=0.05):
    """CadQueryの形（Workplane）をVTKの表示部品にする。"""
    poly = shape.val().toVtkPolyData(tolerance, 0.2)
    normals = vtk.vtkPolyDataNormals()
    normals.SetInputData(poly)
    normals.SetFeatureAngle(35)
    normals.Update()
    mapper = vtk.vtkPolyDataMapper()
    mapper.SetInputConnection(normals.GetOutputPort())
    a = vtk.vtkActor()
    a.SetMapper(mapper)
    prop = a.GetProperty()
    prop.SetColor(*color)
    prop.SetSpecular(0.05)
    prop.SetDiffuse(0.9)
    prop.SetAmbient(0.25)
    return a


def screen():
    """表示面（ガラス）の代わりの黒い薄い板。前面の窓の奥に置く。"""
    import cadquery as cq

    glass = cq.Workplane().add(
        cq.Solid.makeBox(p.DISPLAY_W, p.DISPLAY_H, 0.5, cq.Vector(0, 0, -0.5))
    )
    return glass  # CADの座標（Z＝−奥行き）：ガラス面は奥行き0〜0.5


def scene_parts(with_stand=False, with_cables=False):
    parts = [(chassis.chassis(), BODY_COLOR), (rear_cover.rear_cover(), BODY_COLOR)]
    parts.append((screen(), SCREEN_COLOR))
    if with_stand:
        parts += [(b, BODY_COLOR) for b in stand.brackets()]
    if with_cables:
        parts += [(c, CABLE_COLOR) for c in cables.cables().values()]
    return parts


def render(
    name, parts, camera_pos, focal, view_up=(0, 1, 0), extra=(), size=(1600, 1000), rotate_x=0.0, parallel=False
):
    ren = vtk.vtkRenderer()
    ren.SetBackground(0.96, 0.96, 0.95)
    transform = vtk.vtkTransform()
    transform.RotateX(rotate_x)
    for shape, color in parts:
        a = actor(shape, color)
        a.SetUserTransform(transform)  # 本体だけ傾ける
        ren.AddActor(a)
    for shape, color in extra:
        ren.AddActor(actor(shape, color))  # 壁・机は傾けない
    light = vtk.vtkLight()
    light.SetLightTypeToSceneLight()
    light.SetPosition(-400, 600, 900)
    light.SetFocalPoint(*focal)
    light.SetIntensity(1.1)
    ren.AddLight(light)
    fill = vtk.vtkLight()
    fill.SetLightTypeToSceneLight()
    fill.SetPosition(600, 200, 400)
    fill.SetFocalPoint(*focal)
    fill.SetIntensity(0.35)
    ren.AddLight(fill)
    rim = vtk.vtkLight()  # 背面を見るときのための弱い光
    rim.SetLightTypeToSceneLight()
    rim.SetPosition(-200, 400, -800)
    rim.SetFocalPoint(*focal)
    rim.SetIntensity(0.6)
    ren.AddLight(rim)
    cam = ren.GetActiveCamera()
    cam.SetPosition(*camera_pos)
    cam.SetFocalPoint(*focal)
    cam.SetViewUp(*view_up)
    cam.SetViewAngle(30)
    if parallel:
        # 真横・真正面は平行投影（遠近で手前が大きく見えないように）
        cam.ParallelProjectionOn()
        cam.SetParallelScale(130)
    ren.ResetCameraClippingRange()
    win = vtk.vtkRenderWindow()
    win.SetOffScreenRendering(1)
    win.AddRenderer(ren)
    win.SetSize(*size)
    win.SetMultiSamples(8)
    win.Render()
    grab = vtk.vtkWindowToImageFilter()
    grab.SetInput(win)
    grab.Update()
    writer = vtk.vtkPNGWriter()
    writer.SetFileName(str(OUT_DIR / f"render-{name}.png"))
    writer.SetInputConnection(grab.GetOutputPort())
    writer.Write()


def main():
    import cadquery as cq

    OUT_DIR.mkdir(exist_ok=True)
    center = (87.0, 72.0, -25.0)
    parts = scene_parts()
    d = 650  # カメラまでの距離
    views = {
        "front": (center[0], center[1], d),
        "left45": (center[0] - d * 0.7, center[1] + 80, d * 0.7),
        "right45": (center[0] + d * 0.7, center[1] + 80, d * 0.7),
        "left": (center[0] - d, center[1], center[2]),
        "right": (center[0] + d, center[1], center[2]),
        "back": (center[0], center[1], -d),
    }
    for name, pos in views.items():
        render(name, parts, pos, center, parallel="45" not in name)

    # 壁掛け：背面の後ろに壁
    wall = cq.Workplane().add(
        cq.Solid.makeBox(700, 500, 5, cq.Vector(-260, -170, -(rear_cover.Z1 + 5)))
    )
    render(
        "wall-left45",
        parts,
        (center[0] - d * 0.75, center[1] + 60, d * 0.6),
        center,
        extra=[(wall, WALL_COLOR)],
    )

    # 卓上：スタンドで後ろへ傾ける。机の面は、傾けた後の接地の高さに置く
    tilt = p.STAND_TILT_DEG
    u_desk = stand.world(*stand.FRONT_POINT)[1]
    desk = cq.Workplane().add(cq.Solid.makeBox(700, 5, 500, cq.Vector(-260, u_desk - 5, -350)))
    sparts = scene_parts(with_stand=True, with_cables=True)
    for name, pos in {
        "desk-front": (center[0], center[1] + 60, d),
        "desk-left45": (center[0] - d * 0.75, center[1] + 120, d * 0.6),
        "desk-left": (center[0] - d, center[1], center[2]),
        "desk-back-left45": (center[0] - d * 0.6, center[1] + 160, -d * 0.75),
    }.items():
        render(
            name, sparts, pos, center, rotate_x=-tilt, extra=[(desk, DESK_COLOR)], parallel=name in ("desk-front", "desk-left")
        )
    # 下から見た図（机なし・傾けない）：下面の配線口・スタンド・ケーブルの位置関係
    render(
        "desk-bottom",
        sparts,
        (center[0], center[1] - d, center[2]),
        center,
        view_up=(0, 0, 1),
        parallel=True,
    )
    print(f"PNG: {OUT_DIR}")


if __name__ == "__main__":
    main()
