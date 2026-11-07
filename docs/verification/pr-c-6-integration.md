# PR-C計画4：C-Impl-6 PR-C統合受入

## 範囲と状態

[PR-C完成方針](../technology-stack.md#pr-c-completion-mvp)の計画4。technology-stack 23.8のSCH-01〜SCH-33を、PR-C（計画1〜3：PR #76〜#78）の実装に対して受入確認した。コード（`src`）は変更していない。本番のProvider登録は空のため、取得フローは実Store・Coordinator・Published State APIをMock Providerで組み立てて確認した。「再起動」は同じDBファイルを新しいStartupで開き直して再現し、Process Crash・systemd復旧そのものではない。

追加テスト：`tests/backend/pr-c-integration.test.ts`（実SQLite、Mock Provider、`fetch`・時計のMock）。

## SCH対応表

| ID     | 判定         | 根拠                                                                                                               |
| ------ | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| SCH-01 | 確認（追加） | `pr-c-integration`：Adapter Timeoutを`timeout`として失敗記録、1分Backoff                                           |
| SCH-02 | 確認         | `coordinator`：500で即時Retryせず失敗回数を加算                                                                    |
| SCH-03 | 確認         | `coordinator`：429はBackoffとRetry-Afterの遅い方                                                                   |
| SCH-04 | 確認         | `coordinator`：不正Provider dataを公開しない                                                                       |
| SCH-05 | 確認         | `coordinator`（Scheduler併用）・`state-scheduler`：同一State重複なし                                               |
| SCH-06 | 確認（追加） | `pr-c-integration`：HTTP成功後にTx-A不可ならTx-Pへ進まず公開しない                                                 |
| SCH-07 | 一部・PR-D   | 失敗確定時の旧Snapshot維持はRepositoryの既存契約。Tx-P結果不明の本格照合はPR-D                                     |
| SCH-08 | PR-D         | Tx-C連携は未実装（PR-D）                                                                                           |
| SCH-09 | 一部・PR-E   | DB一時利用不能で通常Schedulerを全体保留（`coordinator` L1・L2）。5秒間隔の継続RecoveryはPR-E                       |
| SCH-10 | PR-E         | 復旧後の検証・再開はPR-E                                                                                           |
| SCH-11 | 確認         | `published-state-repository`・`coordinator`：不正最新は前世代、期限は延長しない                                    |
| SCH-12 | 確認         | `published-state-api`・`coordinator`：不正Stateだけを省略・保留し、他Stateを提供                                   |
| SCH-13 | 確認         | `runtime-startup`：Schema不整合はBLOCKED、自動初期化なし。`coordinator`：L3・L4は全体停止                          |
| SCH-14 | 確認         | `quota-guard`・`quota-repository`：60分上限でHTTPなし、解除見込みを返す                                            |
| SCH-15 | 確認         | `quota-guard`：複数窓の最も遅い解除見込み                                                                          |
| SCH-16 | 確認         | `history-evaluation`・`history-recovery`：不正・確認不能な履歴はFail Closed                                        |
| SCH-17 | 確認         | `history-recovery` B43-01 / B43-03：Tx-Q失敗・結果不明でHTTPなし                                                   |
| SCH-18 | 確認         | `coordinator`：HTTP開始時点でConsumptionがCommit済み。`history-recovery`・`runtime-send`：再起動後も維持し保守計上 |
| SCH-19 | 確認         | `coordinator`：Quota抑止でControl State不変                                                                        |
| SCH-20 | 確認         | `state-scheduler`（C1）・Coordinatorは実行時の現在時刻で再評価                                                     |
| SCH-21 | 確認         | `state-scheduler`・`coordinator`：Task中の再判定要求を集約                                                         |
| SCH-22 | 確認         | `state-scheduler`：例外でinFlight解除・全体保留                                                                    |
| SCH-23 | 確認（追加） | `pr-c-integration`：再起動直後、保存済み`nextAttemptAt`が未来なら取得しない                                        |
| SCH-24 | 一部         | 欠損Rowは5分待機（`coordinator`）。不正Rowは承認済みの簡略化で即時State保留（修復はPR-E）                          |
| SCH-25 | 確認         | `coordinator`：新規DB・Control Rowなしは初回取得                                                                   |
| SCH-26 | 確認（追加） | `pr-c-integration`：再起動時に期限切れdataをAPIがMaskし、期限到来で再取得                                          |
| SCH-27 | PR-D         | Pending保持は未実装（PR-D）。Tx-A成功後は`nextAttemptAt`を保存するため即時再取得はしない                           |
| SCH-28 | 確認（追加） | `pr-c-integration`：HTTP Timeout後にTx-A不可なら保存できないBackoffを信用せず保留                                  |
| SCH-29 | 確認         | `runtime-send`・`history-recovery`：再起動後にSQLite履歴から保守的に再評価                                         |
| SCH-30 | PR-E         | SQLite復旧直後の再開はPR-E                                                                                         |
| SCH-31 | PR-D         | Pendingと再起動はPR-D                                                                                              |
| SCH-32 | 確認（追加） | `pr-c-integration`：TTL切れと取得失敗が同時でも期限切れdataを公開せずMetadataを保持                                |
| SCH-33 | 確認（追加） | `pr-c-integration`：1 Stateの失敗が他Stateの取得・公開を妨げない                                                   |

テスト名の`coordinator`等は`tests/backend/*.test.ts`のファイル名を示す。

## 結果

全テスト・Lint・Type Check・Backend Build・`git diff --check`の結果はPR本文に記録する。

## 未検証・延期

- PR-D：Tx-P結果不明の本格照合、Tx-C、Pending（SCH-07・08・27・31）。
- PR-E：継続DB Recovery・復旧後の再開・不正Rowの修復（SCH-09・10・24の一部・30）。
- Issue #13：Pi実機、Process Crash、systemd復旧、72時間試験、時計・NTP・単調時計の実測。
- 本番Providerの登録（Domain Service）と、その前に必須のShutdown時HTTP Abortと停止期限の検証（計画3の記録どおり）。
