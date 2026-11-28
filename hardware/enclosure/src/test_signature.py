"""signature.py のテスト（Issue #20、PR 5b）。標準の unittest で動く。

実行：venvのPythonで `python hardware/enclosure/src/test_signature.py`
"""

import math
import unittest

import numpy as np

import signature as sg


def mask_area(strokes, min_gap=0.0):
    mask, _, _, _ = sg.engrave_mask(strokes, min_gap)
    return mask.sum() * sg.RES * sg.RES


class SampleTest(unittest.TestCase):
    def test_point_only(self):
        pts = sg.sample([("M", (1.0, 2.0))])
        self.assertEqual(pts.shape, (1, 2))

    def test_short_line(self):
        # 刻みより短い線も、始点と終点の2点になる
        pts = sg.sample([("M", (0.0, 0.0)), ("L", (0.01, 0.0))])
        self.assertEqual(len(pts), 2)
        np.testing.assert_allclose(pts[-1], (0.01, 0.0))

    def test_zero_length_line(self):
        pts = sg.sample([("M", (0.0, 0.0)), ("L", (0.0, 0.0))])
        np.testing.assert_allclose(pts, [(0.0, 0.0), (0.0, 0.0)])

    def test_full_circle_closes(self):
        pts = sg.sample([("M", (1.0, 0.0)), ("A", (0.0, 0.0), 1.0, 0, 360)])
        np.testing.assert_allclose(pts[0], pts[-1], atol=1e-9)
        np.testing.assert_allclose(np.hypot(pts[:, 0], pts[:, 1]), 1.0, atol=1e-9)

    def test_arc_direction(self):
        # 負の向きの円弧は時計回り：90°→−90°は右側（x>0）を通る
        pts = sg.sample([("M", (0.0, 1.0)), ("A", (0.0, 0.0), 1.0, 90, -90)])
        self.assertGreater(pts[len(pts) // 2][0], 0.9)

    def test_bezier_ends(self):
        pts = sg.sample([("M", (0.0, 0.0)), ("C", (1.0, 2.0), (3.0, 2.0), (4.0, 0.0))])
        np.testing.assert_allclose(pts[0], (0.0, 0.0))
        np.testing.assert_allclose(pts[-1], (4.0, 0.0))

    def test_unknown_segment(self):
        with self.assertRaises(ValueError):
            sg.sample([("M", (0.0, 0.0)), ("Q", (1.0, 1.0))])


class DistanceFieldTest(unittest.TestCase):
    def test_point_is_disk(self):
        area = mask_area([([("M", (0.0, 0.0))], 1.0)])
        self.assertAlmostEqual(area, math.pi * 0.25, delta=0.02)

    def test_zero_length_line_is_disk(self):
        area = mask_area([([("M", (0.0, 0.0)), ("L", (0.0, 0.0))], 1.0)])
        self.assertAlmostEqual(area, math.pi * 0.25, delta=0.02)

    def test_line_area(self):
        # 長さ5・幅1の線（両端は丸い）：5×1＋円1つ分
        area = mask_area([([("M", (0.0, 0.0)), ("L", (5.0, 0.0))], 1.0)])
        self.assertAlmostEqual(area, 5.0 + math.pi * 0.25, delta=0.05)

    def test_ring_area(self):
        # 半径2・幅0.8の円：2π×2×0.8
        area = mask_area([([("M", (2.0, 0.0)), ("A", (0.0, 0.0), 2.0, 0, 360)], 0.8)])
        self.assertAlmostEqual(area, 2 * math.pi * 2.0 * 0.8, delta=0.1)


class DimensionTest(unittest.TestCase):
    CASES = [(4.5, 0.8), (4.0, 0.8), (5.0, 0.6), (4.5, 1.0), (3.5, 0.5)]

    def test_letters_fit_height_and_width(self):
        for H, w in self.CASES:
            # 背面の文字も同じ線幅を使うため、背面の高さもそろえる（隙間の条件を満たすように）
            with sg.override(SIGN_LETTER_H=H, SIGN_LETTER_LINE=w, SIGN_BACK_LETTER_H=max(H, 4.0)):
                for ch in "PHOS":
                    lines, width = sg.letter_strokes(ch)
                    x0, y0, x1, y1 = sg.bounds([(s, w) for s in lines])
                    with self.subTest(H=H, w=w, ch=ch):
                        self.assertAlmostEqual(y0, 0.0, delta=0.01)
                        self.assertAlmostEqual(y1, H, delta=0.01)
                        self.assertAlmostEqual(x0, 0.0, delta=0.01)
                        self.assertAlmostEqual(x1, width, delta=0.01)

    def test_all_glyphs_fit_height_and_width(self):
        for H, w in ((4.0, 0.8), (4.5, 0.8), (5.0, 0.6)):
            for ch in sg.GLYPHS.strip():
                lines, width = sg.letter_strokes(ch, H, w)
                x0, y0, x1, y1 = sg.bounds([(s, w) for s in lines])
                with self.subTest(H=H, w=w, ch=ch):
                    self.assertAlmostEqual(y0, 0.0, delta=0.01)
                    self.assertAlmostEqual(y1, H, delta=0.01)
                    self.assertAlmostEqual(x0, 0.0, delta=0.01)
                    self.assertAlmostEqual(x1, width, delta=0.01)

    def test_space_and_unknown_glyph(self):
        lines, width = sg.letter_strokes(" ", 4.0, 0.8)
        self.assertEqual(lines, [])
        self.assertAlmostEqual(width, 4.0 * sg.SPACE_RATIO)
        with self.assertRaises(ValueError):
            sg.letter_strokes("X", 4.0, 0.8)

    def test_back_text_layout(self):
        strokes = sg.back_text_strokes()
        x0, y0, x1, y1 = sg.bounds(strokes)
        n = len(sg.p.SIGN_BACK_TEXT)
        height = n * sg.p.SIGN_BACK_LETTER_H + (n - 1) * sg.p.SIGN_BACK_LINE_GAP
        # 外形の中心が原点、高さは行の高さと行間の合計
        self.assertAlmostEqual((x0 + x1) / 2, 0.0, delta=0.01)
        self.assertAlmostEqual(y0, -height / 2, delta=0.01)
        self.assertAlmostEqual(y1, height / 2, delta=0.01)

    def test_wordmark_width_includes_gaps(self):
        with sg.override(SIGN_LETTER_GAP=2.0):
            strokes, total = sg.wordmark_strokes()
            widths = sum(sg.letter_strokes(ch)[1] for ch in "PHOS")
            self.assertAlmostEqual(total, widths + 3 * 2.0, places=6)
            x0, _, x1, _ = sg.bounds(strokes)
            self.assertAlmostEqual(x1 - x0, total, delta=0.01)

    def test_symbol_fits_height(self):
        for H in (18.0, 15.0, 22.0):
            for w in (1.0, 0.8, 1.2):
                with sg.override(SIGN_SYMBOL_H=H, SIGN_SYMBOL_LINE=w):
                    _, y0, _, y1 = sg.bounds(sg.symbol_strokes())
                    with self.subTest(H=H, w=w):
                        self.assertAlmostEqual(y0, 0.0, delta=0.01)
                        self.assertAlmostEqual(y1, H, delta=0.01)

    def test_mark_layout(self):
        strokes, word_w = sg.wordmark_strokes()
        mark = sg.mark_strokes()
        word = mark[: len(strokes)]
        x0, y0, x1, y1 = sg.bounds(word)
        # ロゴは茎（X=0）の真下が中心、下端が Y=0
        self.assertAlmostEqual((x0 + x1) / 2, 0.0, delta=0.01)
        self.assertAlmostEqual(y0, 0.0, delta=0.01)
        # シンボルの下端は、ロゴの上端から SIGN_STACK_GAP 上
        _, sy0, _, _ = sg.bounds(mark[len(strokes) :])
        self.assertAlmostEqual(sy0 - y1, sg.p.SIGN_STACK_GAP, delta=0.01)


class ValidateTest(unittest.TestCase):
    def test_current_values_pass(self):
        sg.validate()

    def test_out_of_range(self):
        cases = [
            {"SIGN_LETTER_H": 3.0},
            {"SIGN_LETTER_H": 7.0},
            {"SIGN_LETTER_LINE": 0.3},
            {"SIGN_SYMBOL_H": 40.0},
            {"SIGN_SYMBOL_LINE": 0.0},
            {"SIGN_STACK_GAP": -1.0},
            {"SIGN_LETTER_H": float("nan")},
            {"SIGN_LETTER_LINE": "0.8"},
        ]
        for values in cases:
            with self.subTest(values=values), sg.override(**values):
                with self.assertRaises(ValueError):
                    sg.validate()
                with self.assertRaises(ValueError):
                    sg.mark_strokes()

    def test_inner_gap_too_narrow(self):
        # 範囲の中でも、低い文字に太い線は、Sの中の隙間が狭すぎる
        with sg.override(SIGN_LETTER_H=3.5, SIGN_LETTER_LINE=1.0):
            with self.assertRaises(ValueError):
                sg.letter_strokes("S")

    def test_back_text_unknown_glyph(self):
        with sg.override(SIGN_BACK_TEXT=("PHOS", "OBJECT 00X")):
            with self.assertRaises(ValueError):
                sg.validate()

    def test_symbol_line_thinner_than_letters(self):
        with sg.override(SIGN_SYMBOL_LINE=0.6, SIGN_LETTER_LINE=0.8):
            with self.assertRaises(ValueError):
                sg.validate()


class NarrowSpotTest(unittest.TestCase):
    def two_lines(self, gap):
        """幅1の平行な2本の線。縁どうしの間が gap。"""
        d = 1.0 + gap
        return [
            ([("M", (0.0, 0.0)), ("L", (6.0, 0.0))], 1.0),
            ([("M", (0.0, d)), ("L", (6.0, d))], 1.0),
        ]

    def test_narrow_gap_is_found(self):
        r = sg.inspect(self.two_lines(0.4), min_gap=0.0)
        self.assertEqual(r["narrow_gaps"], [])  # min_gap=0 では確認しない
        mask, _, _, origin = sg.engrave_mask(self.two_lines(0.4), 0.0)
        spots = sg.narrow_spots(~mask, 0.6, origin)
        self.assertTrue(spots)
        _, x, y = spots[0]
        self.assertAlmostEqual(y, 0.7, delta=0.1)  # 2本の線の間
        self.assertTrue(0.0 < x < 6.0)

    def test_narrow_gap_is_filled(self):
        r = sg.inspect(self.two_lines(0.4), min_gap=0.6)
        self.assertEqual(r["narrow_gaps"], [])
        self.assertGreater(r["fill_area"], 6.0 * 0.4 * 0.8)  # 間がほぼ埋まる

    def test_wide_gap_is_kept(self):
        r = sg.inspect(self.two_lines(0.8), min_gap=0.6)
        self.assertEqual(r["narrow_gaps"], [])
        self.assertLess(r["fill_area"], 0.05)  # 間は埋めない（端の丸い所の小さな角だけ）

    def test_wedge_is_found_locally(self):
        # V字に開く2本の線：根元の細い切れ込みだけが狭い所として見つかる
        v = [
            ([("M", (0.0, 0.0)), ("L", (8.0, 2.0))], 1.0),
            ([("M", (0.0, 0.0)), ("L", (8.0, -2.0))], 1.0),
        ]
        mask, _, _, origin = sg.engrave_mask(v, 0.0)
        spots = sg.narrow_spots(~mask, 0.6, origin)
        self.assertTrue(spots)
        self.assertLess(spots[0][1], 4.0)  # 根元の側
        r = sg.inspect(v, min_gap=0.6)
        self.assertEqual(r["narrow_gaps"], [])

    def test_thin_line_is_found(self):
        mask, _, _, origin = sg.engrave_mask([([("M", (0.0, 0.0)), ("L", (5.0, 0.0))], 0.5)], 0.0)
        self.assertTrue(sg.narrow_spots(mask, 0.8, origin))
        self.assertFalse(sg.narrow_spots(mask, 0.5, origin))

    def test_current_design_passes(self):
        for strokes in (sg.symbol_strokes(), sg.wordmark_strokes()[0], sg.back_text_strokes()):
            r = sg.inspect(strokes)
            self.assertEqual(r["narrow_gaps"], [])
            self.assertEqual(r["narrow_lines"], [])
            # SVG（線画）との差は、埋めた所だけで、線の縁から min_gap/2 以内
            self.assertLessEqual(r["fill_offset"], sg.p.SIGN_MIN_GAP / 2 + sg.RES)


class OutlineTest(unittest.TestCase):
    def test_outline_area_matches_mask(self):
        # CADに使う輪郭の面積が、刻印の形（画素）の面積と合う
        for strokes in (sg.mark_strokes(), sg.back_text_strokes()):
            mask, _, _, _ = sg.engrave_mask(strokes)
            area = sum(
                sg.polygon_area(o) - sum(sg.polygon_area(h) for h in hs)
                for o, hs in sg.outlines(strokes)
            )
            self.assertAlmostEqual(area, mask.sum() * sg.RES**2, delta=0.2)

    def test_outline_counts(self):
        # マーク：シンボル1つ（葉の内側が穴2つ）＋P・H・O・Sの4つ
        polys = sg.outlines(sg.mark_strokes())
        self.assertEqual(len(polys), 5)
        self.assertEqual(sum(len(hs) for _, hs in polys), 2 + 1 + 0 + 1 + 0)

    def test_max_bridge(self):
        mask, _, _, _ = sg.engrave_mask([([("M", (0.0, 0.0)), ("L", (5.0, 0.0))], 1.0)], 0.0)
        self.assertAlmostEqual(sg.max_bridge(mask), 1.0, delta=0.05)


class SvgTest(unittest.TestCase):
    def test_point_path(self):
        self.assertIn("l0,0", sg.svg_path([("M", (1.0, 1.0))], 10.0))

    def test_arc_flags(self):
        # 反時計回り（Yが上）の大きい円弧は、Yを反転したSVGでは large=1・sweep=0
        d = sg.svg_path([("M", (1.0, 0.0)), ("A", (0.0, 0.0), 1.0, 0, 270)], 0.0)
        self.assertIn(" 0 1 0 ", d)
        d = sg.svg_path([("M", (0.0, 1.0)), ("A", (0.0, 0.0), 1.0, 90, -90)], 0.0)
        self.assertIn(" 0 0 1 ", d)


if __name__ == "__main__":
    unittest.main()
