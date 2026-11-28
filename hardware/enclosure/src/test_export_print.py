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
        self.saved = (ep.PRINT_DIR, ep.SETS)
        ep.PRINT_DIR = self.out.parent
        ep.SETS = {"full": ({"box": (lambda: cq.Workplane().box(10, 10, 2), 1, [], "test")}, "テスト", "")}

    def tearDown(self):
        ep.PRINT_DIR, ep.SETS = self.saved
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

    def fail_checks(self):
        original = ep.check_part
        ep.check_part = lambda name, cad, path: (False, original(name, cad, path)[1])
        return original

    def test_recover_after_crash_mid_swap(self):
        # full → full.old の直後に止まった：full がなく full.old だけ。次の実行の始めに戻す
        self.out.rename(self.out.with_name("full.old"))
        original = self.fail_checks()  # 今回の書き出しはNGにして、戻すだけを確かめる
        try:
            self.assertEqual(ep.main([]), 1)
        finally:
            ep.check_part = original
        self.assertEqual((self.out / "old.stl").read_bytes(), b"old")
        self.assertFalse(self.out.with_name("full.old").exists())

    def test_recover_removes_backup_when_output_is_intact(self):
        # 入れ替えは済み、full.old を消す前に止まった：full がmanifestと合えば full.old を消す
        self.assertEqual(ep.main([]), 0)
        backup = self.out.with_name("full.old")
        backup.mkdir()
        (backup / "old.stl").write_bytes(b"old")
        self.assertEqual(ep.main(["--verify"]), 0)
        self.assertFalse(backup.exists())

    def test_recover_keeps_both_when_output_is_broken(self):
        # 両方あり、full がmanifestと合わない：どちらも消さずに止める
        self.assertEqual(ep.main([]), 0)
        (self.out / "box.stl").write_bytes(b"broken")
        backup = self.out.with_name("full.old")
        backup.mkdir()
        (backup / "old.stl").write_bytes(b"old")
        with self.assertRaises(RuntimeError):
            ep.main([])
        self.assertTrue((backup / "old.stl").exists())
        self.assertEqual((self.out / "box.stl").read_bytes(), b"broken")

    def test_recover_removes_leftover_staging(self):
        staging = self.out.with_name("full.new")
        staging.mkdir()
        (staging / "half.stl").write_bytes(b"half")
        self.assertEqual(ep.main([]), 0)
        self.assertFalse(staging.exists())

    def two_sets(self):
        import cadquery as cq

        trial = self.out.with_name("trial")
        trial.mkdir()
        (trial / "old.stl").write_bytes(b"old-trial")
        ep.SETS = {
            "full": ({"box": (lambda: cq.Workplane().box(10, 10, 2), 1, [], "test")}, "テスト", ""),
            "trial": ({"small": (lambda: cq.Workplane().box(5, 5, 2), 1, [], "test")}, "テスト", ""),
        }
        return trial

    def test_second_swap_failure_restores_both(self):
        # 2組目の入れ替えで失敗したら、1組目も前のデータに戻る
        trial = self.two_sets()
        original = Path.rename

        def failing_rename(path, target):
            if Path(path).name == "trial.new":
                raise OSError("名前の変更の失敗（テスト）")
            return original(path, target)

        Path.rename = failing_rename
        try:
            with self.assertRaises(OSError):
                ep.main([])
        finally:
            Path.rename = original
        self.assertEqual(sorted(x.name for x in self.out.iterdir()), ["old.stl"])
        self.assertEqual((trial / "old.stl").read_bytes(), b"old-trial")
        for leftover in ("full.new", "full.old", "trial.new", "trial.old"):
            self.assertFalse(self.out.with_name(leftover).exists(), leftover)

    def test_verify_checks_all_sets(self):
        # 1組目が不一致でも、2組目まで照合する
        self.two_sets()
        self.assertEqual(ep.main([]), 0)
        (self.out / "box.stl").write_bytes(b"changed")
        calls = []
        original = ep.compare

        def counting_compare(tmp, out_dir, digests):
            calls.append(out_dir.name)
            return original(tmp, out_dir, digests)

        ep.compare = counting_compare
        try:
            self.assertEqual(ep.main(["--verify"]), 1)
        finally:
            ep.compare = original
        self.assertEqual(calls, ["full", "trial"])

    def test_ok_replaces_output_and_verify_matches(self):
        self.assertEqual(ep.main([]), 0)
        self.assertEqual(sorted(x.name for x in self.out.iterdir()), ["box.stl", "manifest.md"])
        self.assertEqual(ep.main(["--verify"]), 0)
        (self.out / "box.stl").write_bytes(b"changed")
        self.assertEqual(ep.main(["--verify"]), 1)


class PilotPieceTest(unittest.TestCase):
    """仮印刷の下穴のテストピース：下穴の径・深さ・目印の点の数。"""

    def test_holes(self):
        import cadquery as cq

        import params as p
        import trial_pieces as tp

        solid = tp.pilot_piece().val()
        top = tp.PILOT_PLATE_T + tp.PILOT_BOSS_H
        depth = tp.p.COVER_SCREW_DEPTH
        cy = p.COVER_BOSS_D + 7.0 - p.COVER_BOSS_D / 2 - 1.0
        for i, d in enumerate(tp.PILOT_DIAMETERS):
            cx = tp.PILOT_PITCH * (i + 0.5)
            with self.subTest(d=d):
                # 穴の縁のすぐ内側は空き、すぐ外側は材料。深さの底より下は材料
                z = top - depth / 2
                self.assertFalse(solid.isInside(cq.Vector(cx + d / 2 - 0.05, cy, z)))
                self.assertTrue(solid.isInside(cq.Vector(cx + d / 2 + 0.05, cy, z)))
                self.assertTrue(solid.isInside(cq.Vector(cx, cy, top - depth - 0.2)))
                # 目印の点の数＝順番（点の並びの両隣1つ分も含めて数える。板の外は除く）
                width = tp.PILOT_PITCH * len(tp.PILOT_DIAMETERS)
                xs = [cx + (k - i / 2) * tp.DOT_PITCH for k in range(-1, i + 2)]
                dots = sum(
                    not solid.isInside(cq.Vector(x, 2.5, tp.PILOT_PLATE_T - 0.2)) for x in xs if 0 < x < width
                )
                self.assertEqual(dots, i + 1)


class VariantTest(unittest.TestCase):
    def test_pilot_override_is_temporary(self):
        # 予備データを作る関数は、下穴の径を一時的に変え、終わったら元に戻す
        import params as p

        seen = []
        make = ep.with_pilot(lambda: seen.append(p.SCREW_PILOT_D), "SCREW_PILOT_D", 2.4)
        before = p.SCREW_PILOT_D
        make()
        self.assertEqual(seen, [2.4])
        self.assertEqual(p.SCREW_PILOT_D, before)

    def test_variant_names(self):
        names = set(ep.VARIANT_PARTS)
        for d in ep.PILOT_VARIANTS:
            self.assertIn(f"main-chassis-pilot{d}", names)
            self.assertIn(f"stand-bracket-pilot{d}", names)


class ManifestTest(unittest.TestCase):
    def test_table_is_aligned(self):
        lines = ep.markdown_table(["名前", "x"], [["ab", "長い値"]])
        widths = {ep.text_width(line) for line in lines}
        self.assertEqual(len(widths), 1)


if __name__ == "__main__":
    unittest.main()
