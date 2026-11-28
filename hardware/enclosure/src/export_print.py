"""本印刷用データ（部品ごとのSTL）の書き出しと確認（Issue #21）。

各部品を、印刷の向き（docs/enclosure-design.md 2章）で床（Z=0）に置き、STL（バイナリ、単位mm）で
書き出す。書き出したSTLを読み直し、CADと合っているかを確かめる。

- 分割の細かさは長さで決める（弦の誤差 MESH_TOL mm、角度 MESH_ANGLE ラジアン）。
  CadQueryの書き出しは、細かさを形の大きさに対する比で扱い、前に作った分割を使い回すため、
  そのままでは小さい丸い穴（下穴2.5など）が粗くなる。ここでは分割を消してから作り直す
- 部品の向きは、実物の形（reference.to_cad で直した形）を回すだけにする（鏡像にしない）

実行：venvのPythonで `python hardware/enclosure/src/export_print.py`
出力：hardware/enclosure/print/full/*.stl、manifest.md
- いったん一時フォルダに書き出して確かめ、全部OKのときだけ出力先に置き換える。
  NGのときは出力先を変えず、終了コード1で終わる（NGのデータを印刷用と取り違えないため）
- `--verify`：出力先を変えずに一時フォルダに作り直し、出力先のSTLとSHA-256が一致するか確かめる
  （コミット済みのデータが今のソースから作ったものか。一致しなければ終了コード1）
"""

import hashlib
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
from engraving import read_stl

OUT_DIR = Path(__file__).resolve().parent.parent / "print" / "full"
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


def write_manifest(out_dir, rows, fingerprint):
    lines = [
        "# 本印刷用データ（部品の一覧）",
        "",
        "`hardware/enclosure/src/export_print.py`で書き出した。手で編集しない。",
        "",
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
        f"合計（数を掛けた重さ、スタンドを含む）：{total:.0f} g（充填100%の見積もり）",
        "",
        "印刷の前に、スライサーで単位（mm）・大きさ・向き・サポートの要否・薄い所を確かめる（docs/enclosure-design.md 8章）。",
        "",
        "今のソースから作り直したデータと一致するかは、`python hardware/enclosure/src/export_print.py --verify`で確かめる。",
        "",
    ]
    (out_dir / "manifest.md").write_text("\n".join(lines), encoding="utf-8", newline="\n")


def build(out_dir):
    """out_dir にSTLとmanifestを書き出して確かめる。(合否, ファイル名→SHA-256)"""
    ok = True
    rows = []
    digests = {}
    for name, (make, count, rotations, orient) in PARTS.items():
        shape = place(make(), rotations)
        path = out_dir / f"{name}.stl"
        write_stl(shape, path)
        good, result = check_part(name, shape, path)
        ok &= good
        digests[path.name] = sha256(path)
        rows.append((name, count, orient, result["size"], result["volume"], digests[path.name]))
        print(f"[INFO] {name}：三角形 {result['triangles']}、{path.stat().st_size / 1e6:.2f} MB")
    write_manifest(out_dir, rows, source_fingerprint())
    return ok, digests


def publish(tmp):
    """一時フォルダの中身で、出力先を置き換える。途中で失敗しても、前のデータを残す。

    1. 出力先の隣に新しいフォルダ（full.new）を作り、全部をコピーする。失敗したら消して終わる
    2. 前のフォルダを full.old に名前を変え、full.new を full に名前を変える。
       2つ目が失敗したら、full.old を full に戻す
    3. 成功したら full.old を消す
    同じ場所での名前の変更なので、前のデータが消えた状態は残らない。
    """
    parent = OUT_DIR.parent
    parent.mkdir(parents=True, exist_ok=True)
    staging = parent / (OUT_DIR.name + ".new")
    backup = parent / (OUT_DIR.name + ".old")
    for leftover in (staging, backup):
        if leftover.exists():
            shutil.rmtree(leftover)
    try:
        staging.mkdir()
        for new in sorted(tmp.iterdir()):
            shutil.copy2(new, staging / new.name)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    had_old = OUT_DIR.exists()
    if had_old:
        OUT_DIR.rename(backup)
    try:
        staging.rename(OUT_DIR)
    except BaseException:
        if had_old:
            backup.rename(OUT_DIR)
        shutil.rmtree(staging, ignore_errors=True)
        raise
    if had_old:
        shutil.rmtree(backup, ignore_errors=True)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    verify = "--verify" in argv
    with tempfile.TemporaryDirectory() as tmp_name:
        tmp = Path(tmp_name)
        ok, digests = build(tmp)
        if not ok:
            print("NGあり。出力先は変えていない")
            return 1
        if verify:
            same = True
            for name, digest in digests.items():
                target = OUT_DIR / name
                match = target.exists() and sha256(target) == digest
                same &= match
                print(f"[{'OK' if match else 'NG'}] 照合 {name}：出力先のSTLと{'一致' if match else '不一致'}")
            manifest_match = (OUT_DIR / "manifest.md").exists() and (OUT_DIR / "manifest.md").read_bytes() == (
                tmp / "manifest.md"
            ).read_bytes()
            same &= manifest_match
            print(f"[{'OK' if manifest_match else 'NG'}] 照合 manifest.md：{'一致' if manifest_match else '不一致'}")
            print("すべて一致" if same else "不一致あり（作り直してCommitする）")
            return 0 if same else 1
        publish(tmp)
    print(f"出力: {OUT_DIR}")
    print("すべてOK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
