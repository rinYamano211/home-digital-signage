"""render.py のUIの画像の読み込みのテスト（Issue #20）。標準の unittest で動く。

実行：venvのPythonで `python hardware/enclosure/src/test_render.py`
"""

import tempfile
import unittest
from pathlib import Path

import vtk

import render


def write_jpeg(path, w, h):
    """w×h の単色のJPEGを書く。"""
    src = vtk.vtkImageCanvasSource2D()
    src.SetScalarTypeToUnsignedChar()
    src.SetNumberOfScalarComponents(3)
    src.SetExtent(0, w - 1, 0, h - 1, 0, 0)
    src.SetDrawColor(30, 30, 34)
    src.FillBox(0, w - 1, 0, h - 1)
    src.Update()
    writer = vtk.vtkJPEGWriter()
    writer.SetFileName(str(path))
    writer.SetInputConnection(src.GetOutputPort())
    writer.Write()


class LoadUiImageTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)

    def tearDown(self):
        self.dir.cleanup()

    def test_current_image(self):
        w, h, _ = render.load_ui_image().GetOutput().GetDimensions()
        self.assertAlmostEqual(w / h, 1280 / 800, delta=0.01)

    def test_full_size_and_scaled(self):
        for w, h in ((1280, 800), (800, 500)):
            path = self.root / f"ui-{w}.jpg"
            write_jpeg(path, w, h)
            with self.subTest(size=(w, h)):
                reader = render.load_ui_image(path)
                self.assertEqual(reader.GetOutput().GetDimensions()[:2], (w, h))

    def test_missing_file(self):
        with self.assertRaises(FileNotFoundError):
            render.load_ui_image(self.root / "none.jpg")

    def test_not_jpeg(self):
        path = self.root / "bad.jpg"
        path.write_text("not an image", encoding="utf-8")
        with self.assertRaises(ValueError):
            render.load_ui_image(path)

    def test_wrong_aspect_or_too_small(self):
        for w, h in ((1280, 720), (1024, 768), (640, 400)):
            path = self.root / f"ui-{w}x{h}.jpg"
            write_jpeg(path, w, h)
            with self.subTest(size=(w, h)), self.assertRaises(ValueError):
                render.load_ui_image(path)


if __name__ == "__main__":
    unittest.main()
