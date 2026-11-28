"""export_print.py のSTLの確認のテスト（Issue #21）。標準の unittest で動く。

実行：venvのPythonで `python hardware/enclosure/src/test_export_print.py`
"""

import tempfile
import unittest
from pathlib import Path

import numpy as np

import export_print as ep

# 外向きの面をもつ四面体（体積1/6）
V = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
TETRA = np.array(
    [
        [V[0], V[2], V[1]],
        [V[0], V[1], V[3]],
        [V[0], V[3], V[2]],
        [V[1], V[2], V[3]],
    ]
)


class MeshStatsTest(unittest.TestCase):
    def test_closed_tetra(self):
        st = ep.mesh_stats(TETRA)
        self.assertAlmostEqual(st["volume"], 1 / 6)
        self.assertEqual((st["open_edges"], st["flipped_edges"], st["degenerate"]), (0, 0, 0))

    def test_inverted_normals_give_negative_volume(self):
        st = ep.mesh_stats(TETRA[:, ::-1])
        self.assertAlmostEqual(st["volume"], -1 / 6)
        self.assertEqual(st["flipped_edges"], 0)  # 全部が逆なら、向きはそろっている

    def test_one_flipped_face(self):
        tris = TETRA.copy()
        tris[3] = tris[3][::-1]
        st = ep.mesh_stats(tris)
        self.assertEqual(st["open_edges"], 0)  # 辺の共有だけでは見つからない
        self.assertGreater(st["flipped_edges"], 0)

    def test_missing_face(self):
        st = ep.mesh_stats(TETRA[:3])
        self.assertGreater(st["open_edges"], 0)

    def test_degenerate_face(self):
        tris = np.concatenate([TETRA, [[V[0], V[0], V[1]]]])
        st = ep.mesh_stats(tris)
        self.assertEqual(st["degenerate"], 1)

    def test_collinear_face(self):
        # 異なる3点が一直線に並ぶ三角形（頂点の重なりでは見つからない）
        tris = np.concatenate([TETRA, [[V[0], V[1], 2 * V[1]]]])
        st = ep.mesh_stats(tris)
        self.assertEqual(st["degenerate"], 1)


class BedAreaTest(unittest.TestCase):
    def test_bottom_face(self):
        self.assertAlmostEqual(ep.bed_area(TETRA), 0.5)  # Z=0の下向きの面
        self.assertAlmostEqual(ep.bed_area(TETRA + [0, 0, 1]), 0.0)  # 浮いている


class PublishTest(unittest.TestCase):
    """確認がNGなら出力先を変えない。OKなら置き換える（小さな箱で試す）。"""

    def setUp(self):
        import cadquery as cq

        self.dir = tempfile.TemporaryDirectory()
        self.out = Path(self.dir.name) / "full"
        self.out.mkdir()
        (self.out / "old.stl").write_bytes(b"old")
        self.saved = (ep.OUT_DIR, ep.PARTS)
        ep.OUT_DIR = self.out
        ep.PARTS = {"box": (lambda: cq.Workplane().box(10, 10, 2), 1, [], "test")}

    def tearDown(self):
        ep.OUT_DIR, ep.PARTS = self.saved
        self.dir.cleanup()

    def test_ng_keeps_output(self):
        original = ep.check_part
        ep.check_part = lambda name, cad, path: (False, original(name, cad, path)[1])
        try:
            self.assertEqual(ep.main([]), 1)
        finally:
            ep.check_part = original
        self.assertEqual(sorted(x.name for x in self.out.iterdir()), ["old.stl"])

    def test_copy_failure_keeps_output(self):
        # 新しいデータのコピーの途中で失敗しても、前のデータは残る
        original = ep.shutil.copy2
        calls = []

        def failing_copy(src, dst):
            calls.append(src)
            if len(calls) == 2:
                raise OSError("コピーの失敗（テスト）")
            return original(src, dst)

        ep.shutil.copy2 = failing_copy
        try:
            with self.assertRaises(OSError):
                ep.main([])
        finally:
            ep.shutil.copy2 = original
        self.assertEqual(sorted(x.name for x in self.out.iterdir()), ["old.stl"])
        self.assertEqual((self.out / "old.stl").read_bytes(), b"old")
        self.assertFalse(self.out.with_name("full.new").exists())

    def test_swap_failure_restores_output(self):
        # 名前の変更（入れ替え）で失敗しても、前のデータに戻る
        original = Path.rename

        def failing_rename(path, target):
            if Path(path).name == "full.new":
                raise OSError("名前の変更の失敗（テスト）")
            return original(path, target)

        Path.rename = failing_rename
        try:
            with self.assertRaises(OSError):
                ep.main([])
        finally:
            Path.rename = original
        self.assertEqual(sorted(x.name for x in self.out.iterdir()), ["old.stl"])
        self.assertFalse(self.out.with_name("full.old").exists())

    def test_ok_replaces_output_and_verify_matches(self):
        self.assertEqual(ep.main([]), 0)
        self.assertEqual(sorted(x.name for x in self.out.iterdir()), ["box.stl", "manifest.md"])
        self.assertEqual(ep.main(["--verify"]), 0)
        (self.out / "box.stl").write_bytes(b"changed")
        self.assertEqual(ep.main(["--verify"]), 1)


class ManifestTest(unittest.TestCase):
    def test_table_is_aligned(self):
        lines = ep.markdown_table(["名前", "x"], [["ab", "長い値"]])
        widths = {ep.text_width(line) for line in lines}
        self.assertEqual(len(widths), 1)


if __name__ == "__main__":
    unittest.main()
