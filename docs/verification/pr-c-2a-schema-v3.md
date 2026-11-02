# PR-C-2A：Schema v3・明示Migration・初期Lifecycle Marker

## 基準・確定設計との対応

基準main：`241ae6af338f99fd022666fa59e8e4b0074dca78`（PR #56 Merge済み）。正本は[technology-stack.md D-01](../technology-stack.md#pr-c-c-impl-5b4-d01)、[D-02](../technology-stack.md#pr-c-c-impl-5b4-d02)、[D-03](../technology-stack.md#pr-c-c-impl-5b4-d03)、[D-04正式Boundary DDL](../technology-stack.md#pr-c-c-impl-5b4-boundary-final-ddl)。[H54検証計画](c-impl-5b4-history-trust-restart-recovery.md)の全文・IDは維持する。

4 TableのDDLは正本から原文どおり抽出し、lifecycle-ddl.tsに1回だけ定義する。Boundaryの重複CREATEはない。既存6 Table・Index・列・制約・保存データは変更せず、initializeSchema()の新規Provisioningは従来どおりv2とする。Migrationは既存v2への明示管理操作であり、新規DBを空のv3として自動作成する処理ではない。

## 実装Interfaceと所有権

| Module                       | 責務                                                                                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| storage/lifecycle-ddl.ts     | backend_lifecycle / startup_generations / startup_provider_boundaries / history_uncertain_rangesの確定DDL                                                                                                      |
| storage/schema.ts            | validateSchema(db, 3)。SQL定義・PK / FK / Indexを厳密照合、INTEGER PRIMARY KEYの自動Indexなしを許容。WAL / FULL / FK、quick_check / foreign_key_check、必須Lifecycle Rowの構造・canonical UUID・安全整数を検証 |
| time/boot-id.ts              | 承認済みの固定Linux OS情報源。末尾1改行を除去・UUID形式検証・小文字化。取得不能・不正・Linux以外は拒否                                                                                                         |
| storage/migration-v3.ts      | v2ToV3Migration()がOS Boot IDを1回取得して予定値を固定。WAL / FULL / FK確認後、4 DDLとRUNNING / Gen 1のMarkerを既存Migration Transactionへ追加                                                                 |
| storage/migrations.ts        | 明示target=3と渡されたMigrationだけ実行。busy / blocked / connectionUnresolvedを尊重。BEGIN IMMEDIATE・DDL・Marker・user_version・後検証をAtomic確定。未確定時は共有Connectionを保護                           |
| storage/store.ts             | configureDatabase(db, 3)でFULLを明示選択。既存v2既定値NORMAL、BackendStore Connection所有・Close責務は変更しない                                                                                               |
| storage/upgrade-v3.ts        | EX Lock・管理確認・既存v2構造・OS Boot ID・WAL / FULLを確認するオフライン管理入口。専用操作中のConnection所有・Closeは既存upgrade-v2と同じ                                                                     |
| scripts/with-backend-lock.sh | 既存単一EX / FD9 / 2秒の規約でmigrate-v3を追加。Lockを自動削除しない                                                                                                                                           |

Boot IDの具体方式は今回ユーザー承認を受けて正本D-01へ追記した。環境変数・引数による任意Boot IDの注入、固定UUID・乱数による代替は本番経路にない。単体テストのnode:os / node:fs差替えと、本番の固定情報源を区別する。

## 明示管理操作と互換性

Backendを停止し、専用Directory・EX Lock・整合するDB / WAL Backupと非互換Rollback条件を確認した管理者のみ、Build済みReleaseで次を実行する。

```sh
SIGNAGE_DATA_DIR=/var/lib/home-digital-signage \
SIGNAGE_V3_UPGRADE_ACK=backup-verified-incompatible-rollback-accepted \
sh scripts/with-backend-lock.sh migrate-v3
```

確認文字列は管理者の申告であり、Backup実在・復旧可能性を自動的に証明する機能ではない。実運用DBへこの作業中に適用していない。

通常起動の自動Migration Allowlistは空のまま。v1→v2の明示経路を維持し、migrate-v3入口はv2だけを受け入れる。既にv3のDBへの同Version修復・再適用は拒否する。

**今回のBackendStore.openは引き続きv2 Runtimeである。v3へUpgradeしたDBは、通常BackendでBLOCKEDとなり、Startup・取得・送信を開始しない。** v3共有Connectionを使うRuntimeの導入はPR-C-2B以降で行う。運用でUpgrade後すぐに現行Backendが利用可能になるとは扱わず、旧Releaseへ戻すだけでv2 DBに戻せるとも扱わない。

## Atomicity・Commit例外・Fail Closed

v2構造検証とWAL / FULL / FK確認を済ませてからBEGIN IMMEDIATEする。4 Table追加・初期RUNNING / Gen 1・user_version=3・v3後検証を同一Transactionに含める。Gen 1のStartup親・Boundary・Rangeは作らない。

Commit例外では実Transaction状態を確認し、必要なRollbackを試行する。終了確認後にVersion・厳密Schema・初期Markerの予定Boot ID / RUNNING / Gen 1・子Tableが空であることをRead-only照合する。v3への反映をこれらで確認できた場合のみ成功確定とする。Rollbackしてv2の構造を確認できれば操作は失敗として返し、無条件再実行しない。Versionだけ・Row一致だけで成功と推測しない。

検証不能・照合不一致・未解決Transactionでは例外を返し、そのv3管理操作のConnectionをblockedにする。Transaction状態未解決ならconnectionUnresolvedも設定する。busy所有者の状態を勝手に解除せず、保護されたConnectionで新しいMigrationを開始しない。管理CLIはConnectionをCloseして失敗終了する。新Connectionで再検証しても、既にv3であるDBに同じUpgradeを再実行しない。

この照合は管理EX・単一Writerの前提で今回のSchema遷移と予定Markerを照合するもので、悪意ある同一UID / rootによる書換えや管理外Restoreの完全識別を保証しない。FULLも実機Storageの耐久性を証明しない。

## 受入条件との対応

H54は全体統合条件であり、今回の検証でH54全体PASSとはしない。

| 受入条件                  | 今回の確認範囲                                                                                    | 未完了範囲                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| H54-19                    | 正式v3 DDL、初期RUNNING / Gen 1 / OS Boot IDをAtomic確定、旧6 Table / データ保持、Boundary制約    | v3 Runtime / Startup、実機耐久性                 |
| H54-20                    | 失敗・未知Version・不正Schema・Commit例外・照合不能のFail Closed。自動再実行・通常起動Upgradeなし | 管理外Restore・実機故障の完全識別                |
| H54-21                    | 書込み前・v3検証時のWAL / FULL / FK、既存Coordinationによる保護                                   | v3共有Connectionの本番Startup接続                |
| H54-07（関連するDDLのみ） | Rangeの整数・非空区間・複合FK / PK制約                                                            | Range間非重複・履歴完全性・分類・窓別待機        |
| H54-29〜32                | 対象外境界のみ記録                                                                                | CLEAN、通常StartupとHistory Trust / Recovery評価 |

## テストと検証結果

lifecycle-schema.test.tsに実SQLite・Fault Injectionの43件を追加した。正常移行と既存6 Table / データ保持、v1→v2、通常起動の自動Upgrade禁止、WAL / FULL、再接続、厳密DDL、必須Marker、BoundaryのPROVISIONED / NULL拒否、Snapshot / Fingerprint構造、PK / 複合FK / Range値、孤立FK、DDL途中・Marker挿入後失敗、Commit前後例外、Version / Marker照合不能、Rollback不能、共有Connection保護、Boot ID拒否を検証する。

storage-process.test.tsにLinux専用2件を追加。実OS Boot ID・FD9を継承する管理EX・確認なし拒否・同Version再実行拒否・移行後の旧Runtime BLOCKED・EX競合2秒Timeoutを確認する。実APIは使用せず、一時テストDBだけを操作する。

ローカル・Linux CIの最新実行結果はPR本文へ記録する。既存のSchema / Migration・PR-B・Control・Scheduler・Quota・Gate・HTTP回帰を維持し、既存テストの削除・弱体化やLint / Workflow変更は行わない。

## PR-C-2Bへの引継ぎ

- v3対応の通常BackendStore・Repository検証・FULL設定の本番接続。v2 Runtimeの既定値を今回無断変更しない。
- Startup時のBoot / Lifecycle / 全履歴検証、Generation +1、親子境界のAtomic確定。Gen 1初期MarkerをStartup証拠に代用しない。
- Provider Metadata / ConsumptionとBoundary Snapshotの意味整合、親履歴連続性、全Provider集合の完全性はStartup / History側の責務。今回の構造・FK・CHECK検証だけでHistoryの完全性を証明しない。
- Fingerprint計算・照合、Range運用・非重複判定、History Trust、Recovery管理、CLEAN、Scheduler / Coordinator / HTTP送信の本番統合は未実装。
- Schema v3への移行・Marker生成だけで送信を有効化しない。本番GateのFail Closed、Clock / History独立条件を維持する。
- Pi実機OS同期・停電・Storage耐久性・バックアップ／実運用Rollbackは未検証。今回のLinux CIを実機検証とみなさない。

Issue #16はOpen、PR-C全体は未完了。PRはMergeせずレビュー待ちとする。

## PR #57レビュー修正：全ゼロBoot UUIDの拒否

normalizedBootId()は小文字への正規化後、全ゼロUUIDをnullとして拒否する。全ゼロUUIDには英字がなく大文字化・小文字化した文字列も同一だが、両方の呼出しで拒否することを明示検証した。readOsBootId()では末尾改行なし・LF・CRLFの3経路で全ゼロUUIDを拒否し、MigrationのBEGIN / DDLやVersion変更へ進まない。保存済みLifecycle Markerに全ゼロUUIDがある場合もv3検証で拒否する。

追加5テスト。既存の正常UUID・大文字正規化・不正形式・改行処理・OS取得失敗テストは維持し、他のSchema・Migration・Startup / Trust設計は変更しない。最新の実行結果はPR本文へ記録する。
