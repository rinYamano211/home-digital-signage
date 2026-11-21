# Issue #117：再起動後のTomorrow.io Quota判定の実機確認

## 範囲と状態

[Issue #117](https://github.com/rinYamano211/home-digital-signage/issues/117)で、再起動後のQuotaの窓別待機を廃止した（設計：[技術スタック選定 Q-01](../technology-stack.md#quota-simplification-issue-117)、PR #118。実装：PR #119）。本書には、その実装をRaspberry Piへ適用した結果を記録する。適用と確認はユーザーが手動で行った。Claude CodeはPiを操作していない。

| 項目          | 内容                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 確認日        | 2026-11-21（JST）                                                                                                                          |
| 対象          | `main`のMerge Commit `6eee07f`（PR #119）。Release `20261121-173752-6eee07f`                                                               |
| 環境          | Raspberry Pi 5（[Issue #12の記録](issue-12-autostart.md)と同じ機器）、Node.js v24.22.1、npm 11.19.1                                         |
| 状態          | **Issue #117の主要な目的（旧履歴が400件を超えても、再起動後に降雨の取得が再開すること）についてPASS**。Quotaの境界値は実機では確かめていない |
| 記録しない値  | Secret・地点・個別のQuota履歴の時刻                                                                                                        |

## 背景（修正前の問題）

- 修正前は、再起動の前の消費履歴（`cutoffSequence`以前）を時刻を見ずに全件、各窓へ数えていた。履歴が400件以上あると24時間窓（上限400件）が埋まり、再起動のたびに約25時間、降雨を取得しなかった（[21.9](../technology-stack.md#rainforecast-issue-93-design)）。
- 2026-11-21、Issue #12の実機確認中の再起動の後、92分以上、降雨の取得が一度も試みられなかった（[Issue #12の記録](issue-12-autostart.md)の「Network復旧後の自動回復」）。
- Q-01では、Clock TRUSTEDの下で、全Consumptionを`reserved_at_ms`と対称の窓（`|now − t| ≤ 窓幅 + 2秒`）で数える。24時間より前の行は24時間窓に数えない。

## 方法

1. Pi上で最新の`main`をCloneし、依存パッケージをインストールして、Backend・FrontendをBuildした。[運用手順書](../operations.md)4.1は開発PCでBuildして転送する手順だが、今回はPi上でBuildした。
2. 既存の`activate-release.sh`でReleaseを切り替えた。
3. Backendのログと`/api/published-states`で、起動と降雨の取得を確かめた。
4. SQLiteの`provider_quota_consumptions`を読み取り専用で集計した。

## 結果

### Deploy・起動

| 項目                         | 結果                                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Release                      | `activate-release: 20261121-173752-6eee07f is active`。`/opt/home-digital-signage/current`が対象のReleaseを参照した          |
| Backend                      | systemdのServiceが`active`。2026-11-21 17:38:50（JST）に起動した                                                             |
| 起動のログ                   | `startup_complete`・`rain_forecast_provider_enabled`・`storage_startup_committed`・`database_status`（`HEALTHY`）            |
| 時刻                         | NTPは`synchronized`、RTCは`valid`                                                                                            |
| API                          | `/api/published-states`が正常に応答した                                                                                      |
| 異常                         | 起動時の異常終了・DBの初期化の失敗はなかった                                                                                 |

### 降雨の取得の再開

| 項目                       | 結果                    |
| -------------------------- | ----------------------- |
| Backendの起動              | 2026-11-21 17:38:50 JST |
| 取得の試行                 | 2026-11-21 17:43:50 JST |
| データの更新               | 2026-11-21 17:43:51 JST |
| 起動から取得の成功まで     | 約5分                   |
| `lastAttemptResult`        | `success`               |
| `dataSource`               | `externalApi`           |
| 降雨の状態                 | `dry`                   |

- 観測した事実：再起動の後に、`rainForecast`の取得時刻と更新時刻が新しくなった。
- 解釈：再起動の後に、外部APIからの新しい取得が成功したと判断した。約5分は、Recoveryの5分周期の再評価（契機C）の最初の回と合う。修正前の動作では、下の履歴の件数から約25時間取得しなかったはずである。
- 根拠の限界：取得の成功を示す専用のログは見ていない（成功はINFOのログに出ない）。根拠は`/api/published-states`の更新である。

### Quota履歴（`tomorrow.io`）

| 項目                                          | 件数 |
| --------------------------------------------- | ---: |
| 総履歴                                        |  851 |
| 24時間窓の中（マージン2秒を含む）             |  227 |
| 24時間窓の外の過去の履歴                      |  624 |

- 24時間窓の中は`ABS(nowMs - reserved_at_ms) <= 86402000`で数えた。
- 解釈：総履歴は400件を超えており、修正前の判定なら24時間窓は上限に達していた。修正後は24時間より前の624件を数えないので、24時間窓は227件で上限（400件）に届かず、取得が再開した。
- **制約：この集計は取得の成功の後に行った。取得を判定した時点の厳密な件数ではない**（判定の後に、少なくとも今回の取得の1件が加わっている）。60分窓・1秒窓の件数は集計していない。

## 判定

| 確認項目                                             | 判定             |
| ---------------------------------------------------- | ---------------- |
| PR #119のReleaseの適用                               | PASS             |
| Backendの起動                                        | PASS             |
| SQLiteの正常な起動（`HEALTHY`）                      | PASS             |
| NTPの同期・Providerの有効化                          | PASS             |
| 既存のQuota履歴の保持（851件が残っている）           | PASS             |
| 古いQuota履歴がある状態での、Tomorrow.ioの取得の再開 | PASS             |
| 1秒・60分・24時間のQuotaの境界値                     | 実機では確かめていない |

**総合：Issue #117の主要な目的についてPASS。**

## 自動テストと実機の確認の範囲

| 範囲 | 確認した場所 |
| --- | --- |
| 再起動の後、24時間より前の旧履歴が多くても取得が再開する | 実機（本書）と自動テスト（`runtime-send.test.ts`） |
| 3つの窓の境界値（過去・未来の±1ms）、未来の時刻の行、Timestampの逆転、`releaseAtMs`の算出、数値の上限 | 自動テストだけ（`conservative-quota.test.ts`） |
| Gateの事前評価の後に窓が上限に達した場合に、Tx-Qで予約しない | 自動テストだけ（`history-recovery.test.ts`） |
| Quotaが足りない場合に60秒後に再試行し、Schedulerを止めない | 自動テストだけ（`coordinator.test.ts`） |

## 未確認の事項

1. Quotaの境界値（1秒・60分・24時間）の実機での挙動。
2. 窓の中の件数が上限に達している状態からの再開（今回は24時間窓に余裕があった）。
3. Network復旧の後の降雨の再取得。[Issue #12の記録](issue-12-autostart.md)の未実施の項目2のままである（今回は再起動の後の取得だけを確かめた）。
4. 降雨がある時の値と表示（今回は`dry`）。

## 関連

- [Issue #117](https://github.com/rinYamano211/home-digital-signage/issues/117)、PR #118（設計）、PR #119（実装、`6eee07f`）
- [Issue #12の記録](issue-12-autostart.md)：修正前の問題を観察した記録
- [Issue #93の記録](issue-93-rainforecast.md)：再起動後の待機（約65〜70分）を初めて確認した記録
