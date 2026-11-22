# Issue #98：天気パネルの遠距離視認性の検証

## 範囲と状態

[Issue #98](https://github.com/rinYamano211/home-digital-signage/issues/98)で改善した「今日の天気」の表示（[PR #129](https://github.com/rinYamano211/home-digital-signage/pull/129)）を、開発PCの検証画面とRaspberry Piの実画面で確認した。設計は[UI設計 5.2](../ui-design.md#52-今日の天気)（[PR #128](https://github.com/rinYamano211/home-digital-signage/pull/128)で更新）に従う。改善のきっかけは[Issue #9の検証](issue-9-weather.md)のE1（約3mからの視認性：改善要）である。

Raspberry Piでの確認は、ユーザーが手動で行った。Backendは使わず、検証用Build（合成データ）だけを表示した。

- 確認日：2026-11-22（Pi実機）。開発PCでの実測は2026-11-21
- Pi実機の対象：PR #129の`c960346`（ブランチ`feat/issue-98-weather-visibility`）
- 結果：Pi実機の確認項目V1〜V7はすべてPASS
- **改善前（`a291e15`）と改善後のPi実機での比較は行っていない。** 改善後の表示だけを確認した
- **PR #129の2つ目のCommit`64ca046`（上段のすき間12→10px、幅広の検証シナリオ追加）は、Pi実機では確認していない**（下記「確認していないこと」）

## 対象のCommit

| Commit    | 内容                                                                                                    | 開発PCでの実測 | Pi実機 |
| --------- | ------------------------------------------------------------------------------------------------------- | -------------- | ------ |
| `c960346` | 今日の天気の拡大・時間別の整列と色（上段の左右余白20px・すき間12px）、検証シナリオ、Markupのテスト      | あり           | V1〜V7 |
| `64ca046` | 上段のすき間を12→10pxに変更。検証シナリオ「上段の幅広」（`-38°`・天気不明・最高 -28°／最低 -40°）を追加 | あり           | 未確認 |

## 環境ごとの結果

| 環境                           | 確認したこと                                                                          | 結果                                    |
| ------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------- |
| 開発PC（Windows）＋検証画面    | 1280×800・DPR 1で、フォント読込後に枠幅・文字幅・余りを実測（下記「開発PCでの実測」） | 全シナリオで重なり・文字切れなし        |
| CI（GitHub Actions、Linux）    | PR #129の品質検査                                                                     | `64ca046`で成功                         |
| Raspberry Piの画面＋合成データ | 検証用BuildをPiのChromium Kioskで表示し、視認性・収まり・回帰を確認（V1〜V7）         | `c960346`でPASS。改善前との比較は未実施 |

## 開発PCでの実測

PR #129の本文に記録した値。Windowsの開発PC上のChromium系ブラウザ（Claude Codeの内蔵ブラウザ）で、検証画面（`vite --mode verify`）を1280×800・DPR 1で表示し、Zen Maru Gothic 5.3.1の読込後に測った。**Pi実機での測定値ではない。**

- 右領域 670.4px、上段の内幅 630.4px、時間別の1枠 109.1px（全シナリオで6列とも同じ幅）
- 現在気温（120px・太字）の幅：`18°` 201.3px、`-10°` 258.1px、`-38°` 267.6px
- 時間別：枠の高さ 158.6px。現在・時間別がともに日付付きの更新待ちで、降雨帯が一番高い状態（降り始め・更新待ち、95px）でも、時間別タイルの余りは9.8px
- アイコンと気温の数字（符号を含む）の中心のずれ：全シナリオで0px。`°`と枠の右端の間：最小11.3px
- `明日 0時`（24px・太字）：幅90.8px。縦線と重ならない

上段の横幅（使用幅＝アイコン＋気温＋天気名＋最高最低＋すき間×3。残り＝内幅630.4px−使用幅）：

| 組合せ                                                     | `c960346`（すき間12px）         | `64ca046`（すき間10px）      |
| ---------------------------------------------------------- | ------------------------------- | ---------------------------- |
| 通常（`18°`・くもり・最高 19°／最低 9°）                   | 残り 110.6px                    | 残り 116.6px                 |
| 最も厳しい組合せ（`-10°`・天気不明・最高 -10°／最低 -15°） | 残り 9.0px                      | 残り 15.0px                  |
| 幅広（`-38°`・天気不明・最高 -28°／最低 -40°）             | 残り −3.0px（計測は修正作業時） | 残り 3.0px                   |
| 幅広＋日付付きの更新待ち                                   | 残り −3.0px（同上）             | 残り 3.0px（札と重ならない） |

- 幅広の組合せは`c960346`の検証シナリオには含まれていない。`c960346`のCSSに`64ca046`のシナリオを加えた状態で測り、最高最低が右の余白に3px入ることを確認したため、すき間を10pxにした。

## Raspberry Pi実機での確認

| 項目         | 内容                                                          |
| ------------ | ------------------------------------------------------------- |
| 対象         | `c960346`の検証用Build（`dist/frontend-verify/`）             |
| 画面         | Raspberry Pi実機、Chromium Kioskモード。GUIはlabwc（Wayland） |
| 表示データ   | 検証画面の合成データ（Backendは使わない）                     |
| 改善前の比較 | 行っていない                                                  |

検証画面のキー（Frontend開発手順 11.7・12.7）で、今日の天気だけを巡回させ、天気の合成データ（Wキー）を切り替えた。

| No. | 確認項目                                                         | 結果 | 備考                                     |
| --- | ---------------------------------------------------------------- | ---- | ---------------------------------------- |
| V1  | 現在気温を符号込みで読み取れ、現在の天気の概要を一瞥で把握できる | PASS | 改善後の表示のみ。改善前との比較は未実施 |
| V2  | 時間別の時刻・アイコン・気温・降水確率を読める                   | PASS |                                          |
| V3  | 時間別を上段の末尾から下段の先頭へ続けて読める。先頭枠の時刻の色 | PASS |                                          |
| V4  | `明日 0時`と縦線の表示・配置                                     | PASS |                                          |
| V5  | 厳しいデータの組合せでの収まり                                   | PASS | `c960346`のシナリオの範囲（下記）        |
| V6  | 降水確率の読みやすさ、50%以上と未満の色の区別                    | PASS |                                          |
| V7  | 週間天気・予定・時計の回帰                                       | PASS |                                          |

- 結果はV1〜V7の単位で報告された。シナリオごとの個別の結果は記録していない。
- V5の対象は、`c960346`の検証画面にある組合せ（最も厳しい組合せ`-10°`×降雨帯7状態、負の気温・`100%`・5枠など）である。`64ca046`で加えた「上段の幅広」は含まない。
- 実機の表示で特に気になる点はなく、追加のUI修正の要望はなかった。

### 記録していない条件

以下は値を記録していない。推測で補わない。

- 画面の輝度の設定、室内の明るさ（昼・夜）
- 普段の確認距離、実際の確認距離（V1の「約3m」は計画値）
- Chromiumのバージョン
- Pi上のBuild成果物のファイル名（成果物とCommitの照合）

## 実機検証の手順と、発生した問題

今後の実機検証で再利用できるよう、今回の手順と対処を記録する。本番の設定・デプロイ手順は変更していない。

### 1. 検証用Buildの作成（Windows）

```powershell
git fetch origin
git switch --detach c960346
git log -1 --oneline
npm ci --ignore-scripts
npm run build:frontend:verify
```

成果物は`dist/frontend-verify/`。

**問題**：通常の`npm ci`で、`better-sqlite3`のネイティブモジュールのBuildが失敗した。node-gypがVisual StudioのC++ Build環境を見つけられなかった（Windows、Node.js v24.14.0、Python 3.13.7、node-gyp 12.2.0、better-sqlite3 13.0.3）。

**対処**：BackendとSQLiteを使わないFrontendだけの検証のため、`npm ci --ignore-scripts`を使った。Visual Studio Build Toolsは入れていない。

- この方法はFrontendだけの検証用であり、Backendの動作は保証しない。通常の依存のインストール手順は変えない。
- `--ignore-scripts`では`better-sqlite3`が使えないため、開発PCでの`vitest`ではSQLiteを使うテストがスキップされる。全件はCIで確認する。

### 2. Piへの転送

本番用のディレクトリとは分けて、一時ディレクトリに置いた（Issue #9の検証と同じ`~/signage-check`）。

```powershell
ssh signage@<pi> "mkdir -p ~/signage-check/issue-98"
scp -r dist/frontend-verify signage@<pi>:~/signage-check/issue-98/
```

### 3. 検証用HTTP Serverの起動（Pi）

既存のnginxの設定は変えず、Pythonの簡易HTTP Serverを使った。

```bash
cd ~/signage-check/issue-98/frontend-verify
python3 -m http.server 8080 --bind 127.0.0.1
```

検証用URLは`http://127.0.0.1:8080/`。

### 4. 既存のKioskの一時停止

**問題**：既存のChromiumをAlt+F4で終了しても、自動で再起動された。ユーザーUnit`home-digital-signage-kiosk.service`が`Restart=always`（`RestartSec=5s`）で動いているためである。

**対処**：Kioskのサービスだけを一時停止した。自動起動の無効化やUnitの変更はしていない。Backendのサービス（`home-digital-signage-backend.service`）は停止・変更していない（今回の合成データの検証では使っていない）。

```bash
systemctl --user stop home-digital-signage-kiosk.service
```

### 5. 検証用のChromium Kioskの起動（labwc・Wayland）

**問題**：SSHから通常のChromiumの起動コマンドを実行すると、`Missing X server or $DISPLAY`、`The platform failed to initialize. Exiting.`で終了した。

**確認**：Kioskのサービスの設定と、systemdのユーザー環境の変数を確認した。

```bash
systemctl --user cat home-digital-signage-kiosk.service
systemctl --user show-environment | grep -E 'DISPLAY|WAYLAND|XDG_RUNTIME_DIR|XAUTHORITY'
```

`XDG_RUNTIME_DIR=/run/user/1000`、`DISPLAY=:0`、`WAYLAND_DISPLAY=wayland-0`だった。

**対処**：labwc（Wayland）に合わせて、環境変数を指定して起動した。既存のChromiumのプロファイルとは分けた。

```bash
XDG_RUNTIME_DIR=/run/user/1000 \
WAYLAND_DISPLAY=wayland-0 \
DISPLAY=:0 \
chromium \
  --ozone-platform=wayland \
  --kiosk \
  --no-first-run \
  --user-data-dir=/tmp/chromium-issue-98 \
  http://127.0.0.1:8080/
```

### 6. 検証後の復旧

検証用のChromiumとPythonのHTTP Serverを終了し、既存のKioskのサービスを再開した。通常の稼働状態に戻したことを確認した。

```bash
systemctl --user start home-digital-signage-kiosk.service
```

## Issue #98の完了条件との対応

| 完了条件                                                                                 | 確認方法・状態                                                                                      |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 改善案を決め、実装する                                                                   | 設計：PR #128（Merge済み）。実装：PR #129（本記録の作成時点でOpen）                                 |
| Raspberry Piの実画面で、1280×800・約3mから再確認し、結果を`docs/verification/`へ記録する | `c960346`でV1〜V7 PASS（本記録）。`64ca046`の差分は未確認。確認距離は記録していない（約3mは計画値） |

## Issue #13への引き継ぎ

- MVP全体の視認性の受入確認（R-05）
- 時計の大きさの比較（現行200pxと210px程度）

## 確認していないこと

| 事項                                                     | 扱い                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 改善前（`a291e15`）と改善後のPi実機での比較              | 行っていない。改善前の状態はIssue #9のE1を参照                                       |
| `64ca046`のPi実機での表示                                | 上段のすき間12→10pxと「上段の幅広」の組合せ。開発PCでは残り3pxで収まることを確認した |
| 実際の確認距離・輝度・室内の明るさ・Chromiumのバージョン | 記録していない                                                                       |
| シナリオごとの個別の結果                                 | V1〜V7の単位で報告された                                                             |
| 実データ（Backend）での表示                              | 合成データだけで確認した                                                             |
| MVPの視認性受入・時計の大きさ                            | Issue #13で扱う                                                                      |
