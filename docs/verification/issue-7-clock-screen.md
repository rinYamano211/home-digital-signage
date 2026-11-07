# Issue #7：基本画面と時計の実機確認

## 範囲と状態

[Frontend開発手順 第7章](../frontend-development.md#7-raspberry-piでの実機確認)の手順で、PR #80（開発基盤）・PR #81（基本画面・時計・未同期表示・検証画面）の成果物をRaspberry Piで確認した。確認はユーザーが目視で行った。

- 確認日：2026-11-07
- 対象：`main`の1e028f7（PR #81のMerge Commit）と同じコード
- 環境：Raspberry Pi・Raspberry Pi OS・Chromium（Kioskモード）。Windows PCからSSHで操作し、Piに接続したディスプレイで目視した
- 成果物：Windows PCで`npm run build:frontend`・`npm run build:frontend:verify`を実行し、`dist/frontend/`・`dist/frontend-verify/`をscpで転送した
- 一時HTTPサーバー：`python3 -m http.server <port> --bind 127.0.0.1 --directory <成果物>`

WindowsのPCでは、better-sqlite3のNative Build（Visual Studio C++が必要）で通常の`npm ci`が失敗するため、`npm ci --ignore-scripts`で依存を入れた。Frontendの成果物はbetter-sqlite3を使わない。

## 通常画面

| No. | 確認項目                                                         | 結果 |
| --- | ---------------------------------------------------------------- | ---- |
| 1   | 通常Build・検証用Buildの生成                                     | PASS |
| 2   | Raspberry Piへの転送                                             | PASS |
| 3   | ChromiumでのKiosk表示                                            | PASS |
| 4   | 1280×800の全画面に収まり、スクロールバー・余白・カーソルが出ない | PASS |
| 5   | フォントが同梱のZen Maru Gothicで表示される                      | PASS |
| 6   | 日付・曜日・時刻がPiの`date`の結果と一致する                     | PASS |
| 7   | 再読み込みせずに、分が変わると表示が自動で更新される             | PASS |
| 8   | Wi-Fiを切っても表示が続く                                        | PASS |
| 9   | Wi-Fiを切っている間も時計が更新される                            | PASS |

## 未同期表示（検証画面）

| No. | 確認項目                                     | 結果 |
| --- | -------------------------------------------- | ---- |
| 10  | 初期表示が未同期表示（時計アイコンと案内文） | PASS |
| 11  | Spaceキーで時計表示へ切り替わる              | PASS |
| 12  | 再度Spaceキーで未同期表示へ戻る              | PASS |
| 13  | 時計表示へ戻るときにフェードで表示される     | PASS |

フェードは目視で確認し、時間（0.6秒）は計測していない。

## Issue #7の完了条件との対応

| 完了条件                                     | 根拠     |
| -------------------------------------------- | -------- |
| Raspberry Piのディスプレイに画面が表示される | No. 3    |
| 現在時刻が正しく表示される                   | No. 6    |
| 時刻が自動更新される                         | No. 7・9 |
| 全画面で利用できる                           | No. 3・4 |

## 等幅数字が効かない件

Zen Maru Gothic（`@fontsource/zen-maru-gothic` 5.3.1）は等幅数字（OpenTypeの`tnum`）を持たない。`font-variant-numeric: tabular-nums`を指定しても数字の幅は揃わず、[UI設計 3.4](../ui-design.md)の想定と異なる。PCのBrowserで測った時刻の数字幅（200px・ウェイト700）：

| 文字 | 0   | 1   | 2   | 3   | 4   | 5   | 6   | 7   | 8   | 9   | :   |
| ---- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 幅px | 96  | 78  | 86  | 92  | 95  | 90  | 95  | 79  | 98  | 92  | 48  |

- 時刻の幅は最大約437px（上限の見積り）で、時計タイルで使える幅482pxに収まる。`00:00`・`11:11`・`23:59`を含め欠けは出ない。
- 時刻が変わると、時刻の右端が最大約80px動く。
- 判断（2026-11-07、ユーザー）：今は変更しない。Issue #13の実機確認で、右端の伸び縮みが気になるかを確認する。

## 未検証・対象外

- 実際の時刻同期の状態に応じた自動切替：Issue #65（正式な時刻利用可否の判定）。今回は検証画面の手動切替のみ。
- Backend：対象外。
- 約3mからの判読性、起動時間、長時間稼働、等幅数字の見え方：Issue #13。
- 本番配信（nginx）・Kioskの自動起動・Deploy：Issue #12。
- Pi上の確認用ファイル（`~/signage-check`）は確認後に削除した。
