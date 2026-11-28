"""印刷用データ（部品ごとのSTL）の書き出しと確認（Issue #21）。

3組を書き出す：本印刷用（print/full。筐体の部品）、仮印刷用（print/trial。小さなテストピース。
trial_pieces.py）、本印刷の予備（print/full-variants。下穴の径を変えたもの）。印刷当日に仮印刷で確かめてから本印刷する（docs/enclosure-design.md 8章）。

各部品を、印刷の向き（docs/enclosure-design.md 2章）で床（Z=0）に置き、STL（バイナリ、単位mm）で
書き出す。書き出したSTLを読み直し、CADと合っているかを確かめる。

- 分割の細かさは長さで決める（弦の誤差 MESH_TOL mm、角度 MESH_ANGLE ラジアン）。
  CadQueryの書き出しは、細かさを形の大きさに対する比で扱い、前に作った分割を使い回すため、
  そのままでは小さい丸い穴（下穴2.5など）が粗くなる。ここでは分割を消してから作り直す
- 部品の向きは、実物の形（reference.to_cad で直した形）を回すだけにする（鏡像にしない）

実行：venvのPythonで `python hardware/enclosure/src/export_print.py`
出力：hardware/enclosure/print/full/・trial/ の *.stl と manifest.md
- いったん一時フォルダに2組とも書き出して確かめ、全部OKのときだけ出力先に置き換える。
  NGのときは出力先を変えず、終了コード1で終わる（NGのデータを印刷用と取り違えないため）
- `--verify`：出力先を変えずに一時フォルダに作り直し、出力先のSTLとSHA-256が一致するか確かめる
  （コミット済みのデータが今のソースから作ったものか。一致しなければ終了コード1）
"""

import hashlib
import re
import shutil
import sys
import tempfile
import unicodedata
from pathlib import Path

import cadquery as cq
import numpy as np
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRepTools import BRepTools
from OCP.StlAPI import StlAPI_Writer

import chassis
import params as p
import rear_cover
import stand
import trial_pieces
from engraving import read_stl

PRINT_DIR = Path(__file__).resolve().parent.parent / "print"
MESH_TOL = 0.01  # mm。弦の誤差（曲面と三角形の間の最大の距離）
MESH_ANGLE = 0.1  # ラジアン。隣り合う三角形の角度の差の上限
VOLUME_TOL = 0.005  # STLとCADの体積の差の許容（比）
SIZE_TOL = 0.05  # mm。STLとCADの外形の差の許容
DEGENERATE_AREA = 1e-9  # mm²。これより小さい三角形を面積0とみなす（一直線に並んだ3点を含む）


def rot(axis, deg):
    """原点を通る軸の周りの回転（右手系。鏡像にならない）。"""
    return (axis, deg)


# 部品：名前 → (形を作る関数, 数, 回転の並び, 印刷の向きの説明)
# 形はCADの座標（Z＝正面へ正）。回転のあと、外形の最小の角を原点に動かす
PARTS = {
    "main-chassis": (
        chassis.chassis,
        1,
        [rot((1, 0, 0), 180)],
        "前面を下",
    ),
    "rear-cover": (rear_cover.rear_cover, 1, [], "背面（壁の側）を下"),
    "clamp-plate": (lambda: chassis.clamp_plates()[0], 2, [], "平らな面を下"),
    "top-stopper": (
        lambda: chassis.top_stoppers()[0],
        2,
        [rot((0, 1, 0), -90)],
        "L字の輪郭を床に置く（横に寝かせる）",
    ),
    "stand-bracket": (
        lambda: stand.brackets()[0],
        2,
        [rot((0, 1, 0), -90)],
        "輪郭を床に置く（厚み12が高さ。任意の部品）",
    ),
}

# 仮印刷のテストピース（trial_pieces.py）。印刷の向きは、元の部品と同じ
TRIAL_PARTS = {
    "trial-engraving": (
        trial_pieces.engraving_piece,
        1,
        [rot((1, 0, 0), 180)],
        "刻印の面を下（前面の板と同じ）",
    ),
    "trial-pilot-holes": (
        trial_pieces.pilot_piece,
        1,
        [],
        "土台の板を下（ボスは上向き。シャーシのボスと同じ）",
    ),
    "trial-front-corner": (
        trial_pieces.front_corner_piece,
        1,
        [rot((1, 0, 0), 180)],
        "前面を下（メインシャーシと同じ）",
    ),
    "trial-keyhole": (trial_pieces.keyhole_piece, 1, [], "背面を下（リアカバーと同じ）"),
}

# 本印刷の予備：下穴の径だけを変えたもの（仮印刷の下穴のテストピースで合った径を、当日にPCを使わずに選ぶ）
PILOT_VARIANTS = (2.4, 2.6)


def with_pilot(make, name, d):
    """下穴の径を d にして形を作る関数（params を一時的に変える）。"""

    def make_variant():
        from signature import override

        with override(**{name: d}):
            return make()

    return make_variant


VARIANT_PARTS = {}
for _d in PILOT_VARIANTS:
    VARIANT_PARTS[f"main-chassis-pilot{_d}"] = (
        with_pilot(chassis.chassis, "SCREW_PILOT_D", _d),
        1,
        [rot((1, 0, 0), 180)],
        f"前面を下。リアカバー・押さえ板・上部ストッパーの下穴を{_d}にしたもの",
    )
    VARIANT_PARTS[f"stand-bracket-pilot{_d}"] = (
        with_pilot(lambda: stand.brackets()[0], "STAND_SCREW_PILOT_D", _d),
        2,
        [rot((0, 1, 0), -90)],
        f"輪郭を床に置く。キーホール用ネジの下穴を{_d}にしたもの（任意の部品）",
    )

# 組：名前 → (部品, 表題, 説明)
SETS = {
    "full": (PARTS, "本印刷用データ（部品の一覧）", "筐体の部品。STLは1個分なので、スライサーで数を増やす"),
    "trial": (
        TRIAL_PARTS,
        "仮印刷用データ（テストピースの一覧）",
        "本印刷の前に小さく印刷して確かめる。見る点はprint/README.md",
    ),
    "full-variants": (
        VARIANT_PARTS,
        "本印刷の予備データ（下穴の径を変えたもの）",
        f"仮印刷の下穴のテストピースで{'・'.join(str(d) for d in PILOT_VARIANTS)}が合ったときに、"
        "print/full/ の同じ部品の代わりに使う。ほかの部品はprint/full/のまま",
    ),
}


def place(shape, rotations):
    """回して、外形の最小の角を原点に置く。"""
    s = shape.val()
    for axis, deg in rotations:
        s = s.rotate(cq.Vector(0, 0, 0), cq.Vector(*axis), deg)
    bb = s.BoundingBox()
    return s.translate(cq.Vector(-bb.xmin, -bb.ymin, -bb.zmin))


def write_stl(shape, path):
    """分割を消し、長さで決めた細かさで分割し直して、バイナリのSTLに書く。"""
    BRepTools.Clean_s(shape.wrapped)
    mesh = BRepMesh_IncrementalMesh(shape.wrapped, MESH_TOL, False, MESH_ANGLE, True)
    mesh.Perform()
    writer = StlAPI_Writer()
    writer.ASCIIMode = False
    if not writer.Write(shape.wrapped, str(path)):
        raise RuntimeError(f"STLを書けない：{path}")


def mesh_stats(tris):
    """三角形の並びから、体積（向きつき）・外形と、形の不具合の数。

    頂点は1e-4 mmで丸めて同じ点にまとめる。不具合の数：
    - open_edges：2つの三角形で共有されない辺（穴・重なり）
    - flipped_edges：向きの合わない辺。閉じた形で面の向きがそろっていれば、
      どの辺も「a→b」と「b→a」が1回ずつ現れる（同じ向きが2回、または逆向きがない辺を数える）
    - degenerate：面積0の三角形（2つ以上の頂点が同じ点、または3つの頂点が一直線。
      面積が DEGENERATE_AREA 未満）
    """
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    volume = float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6)
    lo, hi = tris.reshape(-1, 3).min(axis=0), tris.reshape(-1, 3).max(axis=0)
    keys = np.round(tris.reshape(-1, 3) / 1e-4).astype(np.int64)
    _, idx = np.unique(keys, axis=0, return_inverse=True)
    idx = idx.reshape(-1, 3)
    area = np.linalg.norm(np.cross(b - a, c - a), axis=1) / 2
    same_point = (idx[:, 0] == idx[:, 1]) | (idx[:, 1] == idx[:, 2]) | (idx[:, 0] == idx[:, 2])
    degenerate = int(np.sum(same_point | (area < DEGENERATE_AREA)))
    directed = np.concatenate([idx[:, [0, 1]], idx[:, [1, 2]], idx[:, [2, 0]]])
    undirected = np.sort(directed, axis=1)
    _, counts = np.unique(undirected, axis=0, return_counts=True)
    open_edges = int(np.sum(counts != 2))
    uniq, dcounts = np.unique(directed, axis=0, return_counts=True)
    n = int(idx.max()) + 1
    code = uniq[:, 0] * n + uniq[:, 1]
    reverse = uniq[:, 1] * n + uniq[:, 0]
    has_reverse = np.isin(reverse, code)
    flipped_edges = int(np.sum(dcounts > 1) + np.sum(~has_reverse))
    return {
        "volume": volume,
        "lo": lo,
        "hi": hi,
        "open_edges": open_edges,
        "flipped_edges": flipped_edges,
        "degenerate": degenerate,
    }


def bed_area(tris, tol=1e-3):
    """Z=0にある、下向きの三角形の面積（床に着く面）。"""
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    cross = np.cross(b - a, c - a)
    norm = np.linalg.norm(cross, axis=1)
    down = cross[:, 2] < -0.999 * np.maximum(norm, 1e-12)
    flat = np.all(np.abs(tris[:, :, 2]) < tol, axis=1)
    return float((norm[down & flat] / 2).sum())


def exact_size(shape):
    """CADの外形の大きさ（面の形から求めた正確な値。BoundingBox()は少し大きめに出る）。"""
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape.wrapped, box, False, False)
    x0, y0, z0, x1, y1, z1 = box.Get()
    return np.array([x1 - x0, y1 - y0, z1 - z0])


def check_part(name, cad, path):
    """書き出したSTLを読み直して確かめる。(合否, 結果の辞書)"""
    tris = read_stl(path)
    stats = mesh_stats(tris)
    volume, lo, hi = stats["volume"], stats["lo"], stats["hi"]
    open_edges, flipped, degenerate = stats["open_edges"], stats["flipped_edges"], stats["degenerate"]
    cad_size = exact_size(cad)
    size = hi - lo
    cad_volume = cad.Volume()
    result = {
        "triangles": len(tris),
        "size": size,
        "volume": volume,
        "cad_volume": cad_volume,
        "bed": bed_area(tris),
        "open_edges": open_edges,
        "flipped_edges": flipped,
        "degenerate": degenerate,
    }
    checks = [
        (abs(lo[2]) < 1e-3, f"Zの最小 {lo[2]:.4f}（0。床に置いてある）"),
        (
            np.all(np.abs(size - cad_size) <= SIZE_TOL),
            f"外形 {size[0]:.2f}×{size[1]:.2f}×{size[2]:.2f}（CAD {cad_size[0]:.2f}×{cad_size[1]:.2f}×{cad_size[2]:.2f}）",
        ),
        (
            volume > 0 and abs(volume / cad_volume - 1) <= VOLUME_TOL,
            f"体積 {volume:.1f} mm3（CAD {cad_volume:.1f}、差 {100 * (volume / cad_volume - 1):+.3f}%。正＝面の向きが外向き）",
        ),
        (open_edges == 0, f"閉じた形：2つの三角形で共有されない辺 {open_edges}"),
        (flipped == 0, f"面の向きがそろっている：向きの合わない辺 {flipped}"),
        (degenerate == 0, f"面積0の三角形 {degenerate}"),
        (result["bed"] > 0, f"床に着く面 {result['bed']:.1f} mm2"),
    ]
    ok = True
    for good, text in checks:
        print(f"[{'OK' if good else 'NG'}] {name}：{text}")
        ok &= bool(good)
    return ok, result


def source_fingerprint():
    """CADのソース（src/*.py。test_*.pyを除く）の指紋：改行をLFにそろえて並べたもののSHA-256の先頭12文字。

    同じソースからは同じ値になる。データがどのソースから作られたかを、Commitに頼らずに示す。
    """
    digest = hashlib.sha256()
    for path in sorted(Path(__file__).resolve().parent.glob("*.py")):
        if path.name.startswith("test_"):
            continue  # テストは形に影響しない
        digest.update(path.name.encode())
        digest.update(path.read_bytes().replace(b"\r\n", b"\n"))
    return digest.hexdigest()[:12]


def text_width(text):
    """Markdownの表をそろえるための幅（全角は2）。"""
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in text)


def markdown_table(header, rows):
    """列の幅をそろえたMarkdownの表（Prettierの形式に合わせる）。"""
    table = [header] + rows
    widths = [max(3, *(text_width(r[i]) for r in table)) for i in range(len(header))]

    def line(cells):
        return "| " + " | ".join(c + " " * (w - text_width(c)) for c, w in zip(cells, widths)) + " |"

    return [line(header), "| " + " | ".join("-" * w for w in widths) + " |"] + [line(r) for r in rows]


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_manifest(out_dir, rows, fingerprint, title="本印刷用データ（部品の一覧）", note=""):
    lines = [
        f"# {title}",
        "",
        "`hardware/enclosure/src/export_print.py`で書き出した。手で編集しない。",
        "",
    ]
    if note:
        lines += [note, ""]
    lines += [
        f"- CADのソースの指紋：`{fingerprint}`（`src/*.py`〈テストを除く〉のSHA-256の先頭12文字。同じソースなら同じ値）",
        "- 形式：STL（バイナリ）、単位mm。部品は印刷の向きで床（Z=0）に置いてある",
        f"- 分割の細かさ：弦の誤差{MESH_TOL} mm、角度{MESH_ANGLE}ラジアン",
        f"- 重さは、PETG（密度{p.PETG_DENSITY}）で中身を詰めた（充填100%）ときの見積もり。実際はスライサーの充填率で変わる",
        "",
    ]
    header = [
        "ファイル",
        "数",
        "印刷の向き",
        "外形（X×Y×高さ）",
        "体積 mm³",
        "重さの見積もり g（1個）",
        "SHA-256（先頭16文字）",
    ]
    body = []
    total = 0.0
    for name, count, orient, size, volume, digest in rows:
        grams = volume / 1000 * p.PETG_DENSITY
        total += grams * count
        body.append(
            [
                f"`{name}.stl`",
                str(count),
                orient,
                f"{size[0]:.1f}×{size[1]:.1f}×{size[2]:.1f}",
                f"{volume:.0f}",
                f"{grams:.1f}",
                f"`{digest[:16]}`",
            ]
        )
    lines += markdown_table(header, body)
    lines += [
        "",
        f"合計（数を掛けた重さ）：{total:.0f} g（充填100%の見積もり）",
        "",
        "印刷の前に、スライサーで単位（mm）・大きさ・向き・サポートの要否・薄い所を確かめる（docs/enclosure-design.md 8章）。",
        "",
        "今のソースから作り直したデータと一致するかは、`python hardware/enclosure/src/export_print.py --verify`で確かめる。",
        "",
    ]
    (out_dir / "manifest.md").write_text("\n".join(lines), encoding="utf-8", newline="\n")


def build(out_dir, parts, title="本印刷用データ（部品の一覧）", note=""):
    """out_dir にSTLとmanifestを書き出して確かめる。(合否, ファイル名→SHA-256)"""
    ok = True
    rows = []
    digests = {}
    for name, (make, count, rotations, orient) in parts.items():
        shape = place(make(), rotations)
        path = out_dir / f"{name}.stl"
        write_stl(shape, path)
        good, result = check_part(name, shape, path)
        ok &= good
        digests[path.name] = sha256(path)
        rows.append((name, count, orient, result["size"], result["volume"], digests[path.name]))
        print(f"[INFO] {name}：三角形 {result['triangles']}、{path.stat().st_size / 1e6:.2f} MB")
    write_manifest(out_dir, rows, source_fingerprint(), title, note)
    return ok, digests


def staging_dir(out_dir):
    return out_dir.parent / (out_dir.name + ".new")


def backup_dir(out_dir):
    return out_dir.parent / (out_dir.name + ".old")


def folder_intact(folder):
    """folder の中のSTLが、manifest.md に書いたSHA-256（先頭16文字）と全部合うか。"""
    manifest = folder / "manifest.md"
    if not manifest.exists():
        return False
    rows = re.findall(r"^\| `([^`]+\.stl)` \|.*\| `([0-9a-f]{16})` +\|$", manifest.read_text(encoding="utf-8"), re.M)
    if not rows:
        return False
    return all((folder / name).exists() and sha256(folder / name).startswith(digest) for name, digest in rows)


def recover(out_dir):
    """前の実行が途中で止まった（停電・強制終了など）あとの片付け。前のデータは失わない。

    - X.new：途中までのコピー。元のデータは別にあるため、消してよい
    - X がなく X.old だけある：入れ替えの途中で止まった。X.old を X に戻す
    - X と X.old の両方がある：入れ替えは済み、X.old を消す前に止まった。
      X の中身が manifest.md のSHA-256と全部合うときだけ X.old を消す。
      合わないときは、どちらも消さずに止める（手で確かめる）
    """
    staging, backup = staging_dir(out_dir), backup_dir(out_dir)
    if staging.exists():
        shutil.rmtree(staging)
    if not backup.exists():
        return
    if not out_dir.exists():
        backup.rename(out_dir)
        print(f"[INFO] 前の実行が途中で止まっていたため、{backup.name} を {out_dir.name} に戻した")
    elif folder_intact(out_dir):
        shutil.rmtree(backup)
        print(f"[INFO] 前の実行で残った {backup.name} を消した（{out_dir.name} の中身はmanifestと一致）")
    else:
        raise RuntimeError(
            f"{out_dir.name} と {backup.name} の両方があり、{out_dir.name} の中身がmanifestと合わない。"
            "どちらが正しいかを手で確かめてから、不要な方を消す"
        )


def publish(pairs):
    """一時フォルダの中身で、出力先をまとめて置き換える。途中で失敗したら、全部を前のデータに戻す。

    pairs：[(一時フォルダ, 出力先), ...]（本印刷・仮印刷の2組）
    1. 全部の組について、出力先の隣に X.new を作ってコピーする。失敗したら X.new を全部消して終わる
    2. 組ごとに、X を X.old に、X.new を X に名前を変える。途中で失敗したら、
       それまでに入れ替えた組も含めて X.old を X に戻す（片方の組だけ新しくならない）
    3. 全部成功したら X.old を消す
    停電などで途中で止まったときの片付けは、次の実行の始めに recover() が組ごとに行う。
    """
    stagings = [staging_dir(out) for _, out in pairs]
    try:
        for (tmp, out), staging in zip(pairs, stagings):
            out.parent.mkdir(parents=True, exist_ok=True)
            staging.mkdir()
            for new in sorted(tmp.iterdir()):
                shutil.copy2(new, staging / new.name)
    except BaseException:
        for staging in stagings:
            shutil.rmtree(staging, ignore_errors=True)
        raise
    swapped = []  # (出力先, 前のデータがあったか)
    try:
        for (_, out), staging in zip(pairs, stagings):
            had_old = out.exists()
            if had_old:
                out.rename(backup_dir(out))
            swapped.append((out, had_old))
            staging.rename(out)
    except BaseException:
        for out, had_old in reversed(swapped):
            if out.exists() and (not had_old or backup_dir(out).exists()):
                shutil.rmtree(out)  # 入れ替え済みの新しいデータ（前のデータがなかった組も、前の状態＝なしに戻す）
            if had_old and backup_dir(out).exists():
                backup_dir(out).rename(out)
        for staging in stagings:
            shutil.rmtree(staging, ignore_errors=True)
        raise
    for out, had_old in swapped:
        if had_old:
            shutil.rmtree(backup_dir(out), ignore_errors=True)


def compare(tmp, out_dir, digests):
    """作り直したデータ（tmp）と出力先が一致するか。"""
    same = True
    for name, digest in digests.items():
        target = out_dir / name
        match = target.exists() and sha256(target) == digest
        same &= match
        print(f"[{'OK' if match else 'NG'}] 照合 {out_dir.name}/{name}：{'一致' if match else '不一致'}")
    manifest = out_dir / "manifest.md"
    match = manifest.exists() and manifest.read_bytes() == (tmp / "manifest.md").read_bytes()
    same &= match
    print(f"[{'OK' if match else 'NG'}] 照合 {out_dir.name}/manifest.md：{'一致' if match else '不一致'}")
    return same


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    verify = "--verify" in argv
    for name in SETS:
        recover(PRINT_DIR / name)
    with tempfile.TemporaryDirectory() as tmp_name:
        built = {}
        ok = True
        for name, (parts, title, note) in SETS.items():
            tmp = Path(tmp_name) / name
            tmp.mkdir()
            good, digests = build(tmp, parts, title, note)
            ok &= good
            built[name] = (tmp, digests)
        if not ok:
            print("NGあり。出力先は変えていない")
            return 1
        if verify:
            # 全部の組を最後まで照合してから判定する（最初の不一致で止めない）
            results = [compare(tmp, PRINT_DIR / name, digests) for name, (tmp, digests) in built.items()]
            same = all(results)
            print("すべて一致" if same else "不一致あり（作り直してCommitする）")
            return 0 if same else 1
        publish([(tmp, PRINT_DIR / name) for name, (tmp, _) in built.items()])
    print(f"出力: {PRINT_DIR}（{'・'.join(SETS)}）")
    print("すべてOK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
