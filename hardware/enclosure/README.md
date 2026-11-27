# 筐体CAD（CadQuery）

Issue #20の筐体CADのソース。寸法・要件の出典は[筐体要件・実測寸法・取付条件](../../docs/enclosure-requirements.md)（Issue #19）。

## 環境の作り方（Windows）

CadQueryは、Repoの外のvenv（このプロジェクト専用のPython環境）に入れる。Repoの中に作ると、Windowsのパスの長さの上限（260文字）を超えてインストールに失敗するため。

- 場所：`C:\Users\<ユーザー名>\.venvs\hds-enclosure`
- 確認した版：Python 3.13.7、CadQuery 2.8.0（`requirements.txt`で固定）

```powershell
python -m venv $env:USERPROFILE\.venvs\hds-enclosure
& $env:USERPROFILE\.venvs\hds-enclosure\Scripts\python -m pip install -r hardware/enclosure/requirements.txt
```

消すときは、venvのフォルダを削除する。

## 実行

Repoのルートで実行する。

```powershell
& $env:USERPROFILE\.venvs\hds-enclosure\Scripts\python hardware/enclosure/src/export.py
```

参照モデルの各部品の範囲（X・Y・奥行き）を表示し、`hardware/enclosure/out/`に図（SVG）を出力する。SVGはブラウザで開いて確認する。

## ファイル

| ファイル           | 内容                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| `requirements.txt` | CadQueryの版                                                         |
| `src/params.py`    | 寸法をすべて集めたファイル。値ごとに「実測・計算・仮定・公式」を書く |
| `src/reference.py` | 参照モデル。筐体の中に入る物を、実測値から作った単純な箱で表す       |
| `src/export.py`    | 参照モデルの図（SVG）の出力と、範囲の表示                            |
| `out/*.svg`        | 出力した図（正面・背面・下面・左側面）。`export.py`で作り直せる      |

## 座標

- `params.py`は、docsと同じ座標で書く：Displayを正面から見て左下の角が原点。X＝右、Y＝上、Z＝正面のガラス面から背面への奥行き。
- この座標は左手系のため、CADの中では`reference.to_cad`でZの符号を反転する（CADのZ＝−奥行き）。反転しないと、実物の鏡像になる。

## 参照モデル

細かい形は再現せず、「筐体が入ってはいけない範囲」として、少し大きめの箱で表す。

| 名前            | 中身                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------- |
| `display`       | Display本体（薄い部分＋下側の基板がある部分。基板は左右いっぱいと仮定）                   |
| `tabs`          | 下部の固定耳2つ（穴あき。穴の中心のYは仮定）                                              |
| `display_plugs` | 左側面の端子に挿したプラグ＋ケーブル（Zは基準面が未確認のため余裕を足す）                 |
| `pi`            | Pi 5＋Active Cooler＋スペーサー（基板の外形は公式値、高さは仮定を含む計算値に余裕を足す） |
| `pi_plugs`      | Piの下側に挿したプラグ（X位置を測っていないため、基板の幅いっぱいとする）                 |

仮定と余裕の量は`params.py`に書いてある。強度・温度・組立適合性は検証していない。
