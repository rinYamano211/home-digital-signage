# PR-C-2B-3：全Provider履歴検証・Atomic Startup Transaction

## 基準・実装前調査

基準mainは`dd5fdb60b71c7f3ac393c97098d0988756e86e5c`（PR #61 Merge済み）。PR #58・#60のUI設計を維持し、専用Backend worktreeで作業する。正本は[技術設計D-01〜D-04](../technology-stack.md#pr-c-c-impl-5b4-d01)、[H54検証計画](c-impl-5b4-history-trust-restart-recovery.md)、[Architecture](../architecture.md)、[Requirements](../requirements.md)。Issue #16はOpen・全体未完了。作業中にmainへ入ったPR #62（d6e4553、Frontend開発計画・品質文書・属性設定）も確認し、今回差分との重複がないことを確認した。

| 分類     | 既存機構                                                                  | 今回                                              |
| -------- | ------------------------------------------------------------------------- | ------------------------------------------------- |
| 実装済み | v3 DDL・明示Migration・初期RUNNING / Gen 1、限定v3接続、Lifecycle読取     | 再利用。Schema・Migration・通常v2 Runtimeは無変更 |
| 実装済み | quota-history-v1計算、保存済みSnapshot / cutoffによる直前Fingerprint照合  | 同一Startup Transaction内で利用                   |
| 不足     | 全Provider履歴・親子連続性の検証、新親・全Boundary・LifecycleのAtomic確定 | 内部StartupTransactionServiceを追加               |
| 後続     | startBackend配線、Recovery / Trust、Runtime Provisioning境界、CLEAN       | 未実装を維持                                      |

## Provider集合・Gen 1・全履歴

`STARTUP_PROVIDERS`は既存QuotaProvider / TOMORROW_IOから作る凍結配列で、MVPはtomorrow.ioのみ。DB Metadataから期待集合を推測しない。Metadata不在も管理対象であり、ConsumptionもなければUNPROVISIONED / cutoff NULL、正常MetadataありならPROVISIONED / last_sequence（0も独立）とする。未知・空・NULL・重複Provider、不足・過剰なBoundary集合は拒否する。Provider Registry・動的設定は追加しない。

Gen 1の例外はDBから導出する。正規RUNNING / Boot UUID / Gen 1 Marker、厳密v3、親0件・Boundary0件、全ProviderのMetadata / Consumption構造検証を要求し、過去Fingerprint照合だけを省略してGen 2へ進む。呼出元が初回フラグを指定するAPIはない。

Gen 2以降は親を昇順で取得し、2〜現在Generationの正確な連続性、previous_generation、Boot UUID、previous_stateの値域、隣接するBoot ID、Lifecycleとの一致を検証する。Gen 2の前回StateはMigrationのRUNNINGを要求する。後続のprevious_stateは前回LifecycleをINSERT時に取得して保存し、CLEANも有効値とする。各過去GenerationのProvider集合・件数を検証し、直前世代のFingerprintは既存Repositoryで照合する。古いBoundaryへフォールバックせず、全過去BoundaryのDigest再計算はしない。

Metadata / Consumption全件はbigintで読み、非負安全整数・TimestampのDate範囲、1からlast_sequenceまでの件数・Sequence連続性を既存historyFingerprint()も利用して検証する。Metadataなし・Consumptionあり、cutoff後の不正Rowも拒否する。直前PROVISIONEDからのMetadata消失・Sequence退行も救済しない。現在Metadataは過去Snapshotの代用にしない。

Timestampの非減少・現在時刻以下・Clock / History Trustは評価しない。構造がValidな逆順・未来Timestampでも本処理がCommitできることを明示テストし、構造検証と送信適格性を区別する。QuotaGuardは無変更。

## API・Connection境界

`StartupTransactionService.execute({ bootId }): StartupResult`は同期処理で、committed / rejected / database_error（既存L1〜L4）/ unknownを返す。既存BackendStore Connectionを借用し、専用EXを再検査する。要求Boot IDは既存normalizedBootId()で正規化し、固定Linux取得元のreadOsBootId()と一致することを要求する。任意文字列・乱数・環境変数による本番代替はない。

限定v3 Facadeに凍結した`startup.execute`だけを追加する。生Connection・任意SQL・Quota予約・HTTP・Send Permitは公開しない。startBackend()には接続しない。成功後も`startupComplete: false`を維持し、Startup全体・Trust・Recovery承認・送信許可の完了とは扱わない。限定Facade内で他Writerが公開されない構成により、新規Tx-Q / HTTPを開始する経路を提供しない。内部Serviceもそれらを呼び出さない。

既存Lifecycle Facadeテストは、この追加された1操作のキーだけを更新し、その他の公開制限を維持する。ServiceはConnectionを開閉しない。busyを所有し、BEGIN IMMEDIATE / COMMIT / ROLLBACKを実行する。既存busy・blocked・connectionUnresolvedでは新Transactionを開始しない。所有前から存在するTransactionは巻き戻さず、未解決として共有保護する。

## Atomicity・Fail Closed

PreflightでEX、WAL / synchronous FULL / FK、厳密Schema、Lifecycle、実OS Boot、親子履歴、全Provider構造、Generation上限を検証する。設定を黙って変更せず、Preflight成功を証拠として返さない。

BEGIN IMMEDIATE後、同じConnectionで設定・Schema・Lifecycle・親子・全現在履歴を再検証し、Gen 2以降は直前SnapshotのFingerprintを照合する。新Snapshotを確定後、親INSERT → 全Provider Boundary INSERT → 件数・集合・保存内容の完全一致確認 → 前回State / Boot / Generation拘束のLifecycle UPDATE → 更新正確に1件と新Marker確認 → COMMITの順とする。既存BoundaryをUPDATEしない。

COMMIT正常復帰とTransaction終了確認の両方を満たす場合だけcommittedを返す。COMMIT前throwでも成功後throwでも今回結果はunknownとし、見かけ上のRow一致から採用しない。COMMIT以前の失敗は所有TransactionをRollbackする。BEGINが開始後にthrowした場合も所有範囲を確認してRollbackする。Rollbackの例外は黙殺せず分類し、Transaction終了不明・残存ならconnectionUnresolved / L4 blocked、L3 / L4なら共有blockedとする。Transaction終了確定とConnection健全性を分離する。

同じConnectionではWeakSetでStartup試行済みを保持し、別Serviceを生成しても成功・失敗・unknown後に再試行しない。busy等で所有開始前に拒否した呼出しはDB試行ではない。自動Close / 再接続 / 修復 / Retryは実装しない。次回独立StartupのDB検証は別の所有Connectionで改めて行う。結果にはTrust・Permit・Recovery証拠を含めない。

## テストと受入条件対応

追加単体・実SQLiteテスト76件、Linux実Processテスト1件。テスト専用MockはOS入力・Lock・DB障害注入に限定し、本番Factoryに差替え設定を追加しない。Linux試験は一時専用Directory内で実EX・固定Linux Boot ID・明示Migration後の限定Facadeを使い、別ProcessでGen 1→2→3と進むことを検証する。実運用DB・APIへはアクセスしない。

| 正本・条件                | 今回検証する範囲                                                                                   | 残る範囲                            |
| ------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------- |
| D-01 / H54-19〜21         | Gen 1例外・Gen 2以降の連続Startup・Generation上限、既存v3 / Lock / FULL / FK                       | Deploy・実機耐久                    |
| D-02 / H54-01・18・29〜32 | 全親子・Provider構造、同一Tx再検証、親 / Boundary / Lifecycle Atomic更新、Commit unknown不採用     | Startup本番配線・Recovery           |
| D04-R01 / R05・H54-27・32 | cutoff後も含む全履歴構造、直前Snapshot照合、不一致・欠落・不正の拒否                               | Trust・窓別保守計数の本番統合       |
| H54-21 / R59-01関連       | 所有busy・未解決Connection保護、BEGIN / COMMIT前後 / ROLLBACK / 状態取得例外と他Repositoryへの保護 | 全Lifecycleの停止・CLEAN            |
| H54-22〜26・33〜44        | 今回PASSとはしない                                                                                 | 管理操作・Range・Recovery / CLEAN等 |

正常系はUNPROVISIONED / PROVISIONED 0 / 複数件、前回RUNNING / CLEAN、Boot変更、再接続。異常系は親子飛び番、余分な親・Boundary、未知Provider・空 / NULL Key、Metadata不正・欠損、Sequence重複・欠落・型・上限、Timestamp不正、cutoff後の破損、Fingerprint不一致、Boundary欠落 / 内容不一致、UPDATE 0 / 2件、Lock喪失、各Transaction例外、共有Coordination、不採用・非Retry・非公開を含む。Rollback後のPublished State / Cache保持も確認する。

ローカル全体は1,049 PASS・Linux専用52 Skip（計1,101件）。Lint / Format / Type Check / Backend Build / git diff --check成功。Linux CIの実測結果はPR本文に記録する。H54全体をPASSとは宣言しない。

## 残余リスク・PR-C-2B-4への引継ぎ

- Startup Commitは構造的境界であり、History完全性の外部事実・Timestamp Trust・送信許可を証明しない。固定Trust値で未実装条件を迂回しない。
- 全履歴・親 / Boundary読取はall()によるO(N)走査。長期履歴のメモリ・同期処理時間・Pi性能は未検証。Index・GC・Cacheは追加しない。
- 新規起動境界・世代のAtomic確定後も、Clock / History / Recovery・管理停止・Quota条件の独立評価が必要。
- 全過去BoundaryのFingerprint再計算、形式を保つHash対象外履歴の改変、未記録外部Sender消費の証明は保証範囲外。
- Startup本番配線、Plan D、Clock異常Range、Runtime Provisioning境界、CLEAN、History Trust / Recovery、Provider送信は後続へ残す。通常Backendのv2 Runtime・v3通常起動BLOCKEDは維持する。
- Schema / DDL / Migration、QuotaGuard、Scheduler / Gate / HTTP、UI / Frontend、共通設計正本・依存・Workflowは変更しない。Pi・運用DB・実API未検証。Issue #16はOpen、PRは未Merge・レビュー待ちとする。
