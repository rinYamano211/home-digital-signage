"""参照モデル：筐体の中に入る物を、実測値から作った単純な形で表す（Issue #20）。

実測値と仮定から作った、暫定の「入ってはいけない範囲（キープアウト）」である。
- 実物の細かい形は再現していない。
- 筐体がこれらと重ならないことは、実機に組み付けられることを保証しない。
- 筐体の設計を進めるときに、必要に応じて形を細かくする。
値の出典は params.py。
"""

import cadquery as cq

import params as p


def box(x0, y0, z0, x1, y1, z1):
    """2つの角の座標から箱を作る。"""
    return (
        cq.Workplane("XY")
        .box(x1 - x0, y1 - y0, z1 - z0, centered=False)
        .translate((x0, y0, z0))
    )


def display():
    """Display本体：薄い部分（全面）＋背面の基板がある部分（下側）。"""
    panel = box(0, 0, 0, p.DISPLAY_W, p.DISPLAY_H, p.DISPLAY_T_THIN)
    board = box(0, 0, p.DISPLAY_T_THIN, p.DISPLAY_W, p.BOARD_TOP_Y, p.DISPLAY_T_BOARD)
    return panel.union(board)


def tabs():
    """下部の固定耳2つ。上は直線、下は耳の幅の中央を中心とする円弧。穴あき。

    円弧の中心と穴の中心は、Yは同じ（仮定）、Xは0.1ずれる（params.py を参照）。
    """
    result = None
    for side in ("left", "right"):
        x_outer = 0.0 if side == "left" else p.DISPLAY_W
        sign = 1.0 if side == "left" else -1.0
        cx = x_outer + sign * p.TAB_HOLE_CX
        x0 = min(x_outer, x_outer + sign * p.TAB_W)
        thickness = p.TAB_Z1 - p.TAB_Z0
        rect = box(x0, p.TAB_HOLE_CY, p.TAB_Z0, x0 + p.TAB_W, 0, p.TAB_Z1)
        arc = (
            cq.Workplane("XY")
            .circle(p.TAB_W / 2)
            .extrude(thickness)
            .translate((x0 + p.TAB_W / 2, p.TAB_HOLE_CY, p.TAB_Z0))
        )
        hole = (
            cq.Workplane("XY")
            .circle(p.TAB_HOLE_D / 2)
            .extrude(thickness)
            .translate((cx, p.TAB_HOLE_CY, p.TAB_Z0))
        )
        tab = rect.union(arc).cut(hole)
        result = tab if result is None else result.union(tab)
    return result


def display_plugs():
    """Display左側面の端子に挿したプラグ＋ケーブルの範囲。

    Yは2つの端子を含む範囲（プラグの幅の半分＋1を足す）。Zは基準面が未確認のため、
    端子のZの前後にプラグの厚み（6.9）の半分と余裕を足す。
    """
    half_w = 11.0 / 2 + 1.0  # 仮定：プラグの幅（11.0・10.9の大きい方）の半分＋1
    half_t = 6.9 / 2 + p.MARGIN_Z_UNCERTAIN  # 仮定
    return box(
        -p.PORT_PLUG_OUT,
        p.PORT_POWER_Y - half_w,
        max(0.0, p.PORT_Z - half_t),
        0,
        p.PORT_HDMI_Y + half_w,
        p.PORT_Z + half_t,
    )


def pi_envelope():
    """Pi 5＋Active Cooler＋スペーサーの範囲（基板の外形×背面から一番高い所まで）。"""
    return box(
        p.PI_X0,
        p.PI_Y0,
        p.DISPLAY_T_BOARD,
        p.PI_X0 + p.PI_W,
        p.PI_Y0 + p.PI_H,
        p.PI_TOP_Z + p.MARGIN_Z_UNCERTAIN,
    )


def pi_plugs():
    """Piの下側に挿したプラグ（電源USB-C・Micro HDMI）の範囲。

    各プラグのX位置は測っていないため、基板の幅いっぱいとする（仮定）。
    奥行きもPiの一番高い所までとっているため、安全側だが大きすぎる。筐体の設計で
    干渉が出すぎる場合は、プラグの位置を測るか公式図面を使って細かくする。
    """
    return box(
        p.PI_X0,
        p.PI_Y0 - p.PI_PLUG_DROP,
        p.DISPLAY_T_BOARD,
        p.PI_X0 + p.PI_W,
        p.PI_Y0,
        p.PI_TOP_Z + p.MARGIN_Z_UNCERTAIN,
    )


def rtc_space():
    """RTC Battery（任意・後付け）を置くために空けておく範囲（仮定の大きさ）。"""
    return box(
        p.RTC_SPACE_X[0],
        p.RTC_SPACE_Y[0],
        p.RTC_SPACE_DEPTH[0],
        p.RTC_SPACE_X[1],
        p.RTC_SPACE_Y[1],
        p.RTC_SPACE_DEPTH[1],
    )


def to_cad(shape):
    """奥行き（Z＝背面へ正）で作った形を、CADの座標（Z＝正面へ正）に直す。

    params.py の座標（X右・Y上・Z奥）は左手系のため、そのままでは実物の鏡像になる。
    Zの符号を反転して、右手系のCADで実物と同じ形にする。CADのZ＝−奥行き。
    """
    return shape.mirror("XY")


def parts():
    """名前つきの参照モデルの一覧（CADの座標）。"""
    return {
        "display": to_cad(display()),
        "tabs": to_cad(tabs()),
        "display_plugs": to_cad(display_plugs()),
        "pi": to_cad(pi_envelope()),
        "pi_plugs": to_cad(pi_plugs()),
        "rtc_space": to_cad(rtc_space()),
    }


def assembly():
    """参照モデルをすべて合わせた形。"""
    result = None
    for shape in parts().values():
        result = shape if result is None else result.union(shape)
    return result
