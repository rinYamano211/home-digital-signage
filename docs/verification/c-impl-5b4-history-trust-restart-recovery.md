# C-Impl-5B-4 History Trust / Restart Recovery：詳細設計・受入計画

設計正本は[technology-stack.md §23.11](../technology-stack.md#pr-c-c-impl-5b4-history-restart)。基準mainは`8544d988db6af29ca7eb105f18bed271bcd4b6f8`（[PR #50](https://github.com/rinYamano211/home-digital-signage/pull/50)のC-Impl-5A実装反映済み）。親[Issue #16](https://github.com/rinYamano211/home-digital-signage/issues/16)はOpenで継続する。

本書はP0・P1横断整合性レビューと採用済みR-01〜R-03の文書反映、既存コードの読取り結果、未実施の受入計画を区別する。現行mainにC-Impl-5B-4専用設計・Lifecycle Repositoryはなく、今回の合意から設計を追加した。既存ADR専用ファイル・ディレクトリは確認できず、既存方式に従いtechnology-stack.mdを正本とする。コード・テストコード・DB・Issueは変更しない。以下の受入条件はすべて**設計確定・テスト未実施**である。

## レビュー指摘と反映先

| 指摘 | 正本の反映先                 | 設計上の結論                                                                                           |
| ---- | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| P0-1 | Startup境界と2系統の待機     | 案Dの窓別待機と管理者承認後25時間隔離を独立証拠として管理し、管理者復帰時は両方を要求                  |
| P0-2 | Clock回復と履歴の保守的評価  | H_old / H_new_valid / H_new_uncertainを重複なく分離し、不確実範囲のDrain・固定境界・独立窓別待機を要求 |
| P0-3 | CLEAN適格性とShutdown        | Timeoutと未終了を分離。OperationallyDrained AND RecoveryCleanEligibleで隔離迂回を禁止                  |
| P1-1 | Lifecycle MarkerとSchema v3  | 明示v2→v3、backend_lifecycle初期RUNNING、Migration書込み前WAL + FULL、既存履歴維持                     |
| P1-2 | ローカル管理承認             | CLI / UDS / Backend内RecoveryAdminService、メモリTokenと承認、監査時Secret非出力                       |
| P1-3 | Clock回復と履歴の保守的評価  | 案A。壁時計Trust失効だけでは単調時計の継続性を確認して待機保持。Suspend非対応                          |
| P1-4 | F-01とRestart Recoveryの分離 | UNPROVISIONED / PROVISIONED / 異常を区別し、F-01と異常復帰の条件を代替させない                         |

### R-01〜R-03の追加確定

| 指摘 | 正本の見出し                          | 検証の対応                                                       |
| ---- | ------------------------------------- | ---------------------------------------------------------------- |
| R-01 | CLEAN Transaction・結果不明・次回起動 | H54-01・18、H54-29〜32・43。今回unknownと次回DB検証を分離        |
| R-02 | 複数Clock異常範囲                     | H54-07〜10、H54-33〜37・44。範囲別証拠・保守的開始境界・統合禁止 |
| R-03 | Shutdown Deadline Gate                | H54-13・26、H54-38〜42。共有Deadline・B_clean・Close失敗の分離   |

## 状態遷移と共有する不変条件

以下の名前は説明用の論理段階であり、公開Interfaceや新たな永続列の追加指示ではない。DBのhistory_status、History Trustの論理状態、RuntimeのSTOPPING、Lifecycle Markerは別の状態として扱う。

| 事象・前提                                 | 次の段階・処理                                                 | 送信・証拠への制約                                             |
| ------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------- |
| Process開始                                | Gate閉鎖、Startup境界の確定・Trust検証                         | 旧Attempt / Permit / メモリ待機は復活しない                    |
| Startup境界Commit未確定                    | 安全側停止・照合                                               | cutoffや待機証拠を発行しない                                   |
| 自動復帰の全条件を確認                     | 保守的な通常Quota評価                                          | 案D待機未完了の旧履歴は各窓に全件計上。強制HTTPなし            |
| RUNNING、またはCLEAN + 異なるOS Boot       | 管理者承認待ち                                                 | 新規Tx-Q / HTTP禁止、CLEAN禁止                                 |
| Marker不正・欠損・DB不整合                 | Fail Closed                                                    | 正常なRUNNINGと同一視せず、推測復帰しない                      |
| 有効Tokenで管理者承認成立                  | 今回Processの25時間隔離開始                                    | 案Dとは別起点・別証拠。CLEAN禁止                               |
| 隔離完了                                   | 全窓待機・起動境界・DB / Clock / History・キー排他利用の再検証 | 完了時間だけで開放せず、再検証待ちはCLEAN禁止                  |
| 再検証成功、History復帰                    | 通常判定の候補                                                 | 管理停止等を独立維持。Guard・Tx-Q・Gateを迂回しない            |
| 壁時計Trustのみ失効                        | Tx-Q / HTTP停止、Drain、影響範囲固定・窓別隔離                 | 単調時計継続なら管理者隔離証拠保持。Clock回復とHistory回復は別 |
| Drain不能、単調時計継続性不明、Suspend検出 | Fail Closed                                                    | 該当証拠失効。新たな待機証拠を推測発行しない                   |
| Shutdown開始                               | STOPPING・Gate閉鎖・新規取得禁止・Drain                        | HTTP開始と同じ同期境界で直列化                                 |
| CanStartCleanTx成立                        | Boot ID・Generation拘束の専用TxでCLEAN更新、正確に1件を要求    | 共有10秒Deadline・B_clean確認後のみ開始                        |
| Drain済みでもRecovery不適格                | RUNNING維持で安全に終了可能                                    | 次回同一OS BootでもCLEAN経由の隔離迂回を許さない               |
| CLEAN Commit unknown                       | 今回Processは正常終了未確定、再試行・RUNNING書戻し禁止         | 次回DB上CLEAN + 同一Boot + 全条件成立なら候補                  |
| Startup Commit unknown                     | 今回起動証拠を採用せずFail Closed                              | CLEANの次回照合と混同しない                                    |
| Deadline / B_clean不成立                   | CLEAN省略・RUNNING維持、可能なCloseを進める                    | 全体期限は延長しない                                           |
| CLEAN確定後のClose失敗                     | CLEAN成立とClose失敗を別記録                                   | 安全な終了完了と同一視しない                                   |

`CanMarkClean = OperationallyDrained AND RecoveryCleanEligible`はStartup / Shutdown / Recoveryの共通不変条件とする。Lifecycle MarkerをHTTP成功フラグにせず、予約永続化・所有処理終了・Recovery適格性を確認する。DB・History構造不整合を待機時間だけで解除しない。

## 現行実装との照合・後続変更

以下は基準mainのコード読取り結果であり、今回の実装・試験結果ではない。

| 読取り対象                                         | 現行の契約・制限                                                                                                                                   | C-Impl-5B-4実装時に必要な整合                                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/backend/quota/quota-guard.ts`                 | 全履歴でTimestamp順序・now以前・initializedAtMs以後を要求。QuotaTrustの3事実を要求し、各窓をTimestamp + 2秒で評価                                  | 履歴構造・完全性検証と窓別評価を分離。案D / 不確実Sequence範囲の保守的計数は未対応。historyCompleteを固定trueで通過させない                       |
| `src/backend/storage/quota-repository.ts`          | reserveのBEGIN IMMEDIATE内でGuard再評価、saved / not_saved / unknown / quota_blocked、Read-only照合、Opaque予約証拠。F-01専用provisionProviderあり | Startup Snapshot・History証拠の受渡しとGuard再評価を整合。予約証拠とHistory証拠を分離し、既存Commit帰属照合を維持                                 |
| `src/backend/storage/connection-coordination.ts`   | Connectionごとのbusy / connectionUnresolved / blockedを共有                                                                                        | Lifecycle Repositoryも同じ単一Connection保護へ参加。未解決Connectionで新Transaction禁止                                                           |
| `src/backend/storage/store.ts`                     | WAL / synchronous=NORMALを設定・検証、BackendStoreがConnection所有                                                                                 | v3設計ではFULLへ変更が必要。Migration書込み前にもFULL確認。今回コードは変更しない                                                                 |
| `src/backend/storage/schema.ts`                    | v2の6 Table・Index厳密検証、v1事前検証、新規初期化v2                                                                                               | v3とbackend_lifecycleの検証追加が必要。v2履歴を保持し、既存Rowを書き換えない                                                                      |
| `src/backend/storage/migrations.ts`                | 明示V1_TO_V2あり、自動Allowlist空、通常target=2、unknown時VersionとSchema照合                                                                      | 明示V2_TO_V3と前後Schema・Marker整合性検証が必要。通常起動で自動Migrationしない                                                                   |
| `src/backend/http/internal/native-http-adapter.ts` | 10秒Signal、Body / Cancel / reader.closedとLock解放証拠、Lifecycle最大1回。未解決はPending / Gate Flight保持                                       | Timeout結果とAdapter終了を分離してCLEAN評価。Promise RejectだけをDrain証拠にしない。既存5Aの単体実装を変更する依頼ではない                        |
| `src/backend/send/internal/provider-send-gate.ts`  | Permit即時消費、record.usedとFlight先行登録、同期start、finish後Attempt無効化                                                                      | HTTPと永続予約の1対1追跡・Shutdown同期境界を本番統合で検証。CLEAN / Restart Recoveryはまだ未接続                                                  |
| `src/backend/send/internal/trust.ts`               | ClockTrustMonitorの単体監視とHistoryTrustMonitorの内部confirm境界                                                                                  | 固定成功事実を供給せず、今回のStartup / 承認 / 待機 / 隔離証拠からHistoryを判定。現行confirm自体を復帰Policyの完成としない                        |
| `src/backend/send/provider-send-gate.ts`           | OS確認はnull、History未確認、Adapter未接続で本番送信不可                                                                                           | Fail Closedを維持して後続配線へ。5B-1〜3の本番配線完了を主張しない                                                                                |
| `src/backend/shutdown.ts` / PR-A Lifecycle         | installShutdown・app.close・全体10秒、同期SQLite中断は保証しない                                                                                   | 同じ終了経路内にDrain→適格性→単調時計Deadline Gate→CLEAN→DB Closeを統合。現行Timerに絶対Deadline / B_clean判定は未実装。専用Handler・追加猶予なし |

Schema v2→v3とNORMAL→FULLは今回明示された将来設計の変更点である。v1/v2の過去実装・検証記録は履歴として維持し、現行実装がv3/FULL対応済みとは記載しない。既存の電源断時Commit喪失許容説明だけでQuota / Lifecycleの耐久性確認を省略しない。

## 受入条件（未実施）

専用ID `H54-01`〜`H54-44`を用いる。既存SCH・C1・C2・QH・TQ・SG・CLK・REC・ADM・HTTP・KEY・H5A-Iの条件を削除・変更しない。対応する既存テストを拡張・再利用でき、ID数だけ独立テスト関数を要求しない。既存CI成功は以下のPASSを意味しない。

| ID     | 条件・期待結果                                                                                                              | 既存観点との対応               |
| ------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| H54-01 | Startup境界Commit成功後だけcutoff・Fingerprintと単調時計起点を採用。Startup Commit unknownは今回証拠を不採用・Fail Closed   | REC-01、TQ条件                 |
| H54-02 | 1分・65分・25時間を窓別独立評価。未完了は旧履歴全件計上、完了した窓だけ除外                                                 | QH、CLK条件                    |
| H54-03 | 通常復帰の安全条件成立時、窓別待機未完了でも旧履歴全件計上でQuota判定可能                                                   | REC、QH条件                    |
| H54-04 | 管理者承認後25時間の隔離を別起点で計測。隔離と案D全窓完了・再検証をすべて要求                                               | REC、KEY条件                   |
| H54-05 | Backend再起動で承認・Token・全メモリ待機証拠失効。旧Attempt・Permitも再利用不可                                             | REC-04、SG条件                 |
| H54-06 | 壁時計Trustだけ失効しても単調時計継続なら隔離待機を保持。Clock回復だけでHistory回復しない                                   | CLK-02・03                     |
| H54-07 | 全Consumptionの一意区分、cutoff < startSequence <= endSequence、範囲非重複と窓別合算を確認                                  | QH-01〜03、CLK-03              |
| H54-08 | Clock失効通知→Gate閉鎖→Drain→確定境界→分類→待機。検出時lastSequenceを最終境界とせず、Drain不能では証拠未発行                | SG、HTTP-02・03                |
| H54-09 | 複数範囲の独立待機・境界固定・証拠非流用・MVP統合禁止。空範囲は作らない                                                     | CLK、QH条件                    |
| H54-10 | 待機完了・Clock回復でも不確実履歴をValid再分類しない。履歴保持、構造不正は時間で解除しない                                  | CLK-02・03、QH条件             |
| H54-11 | 永続予約確定・Adapter終了・追加送信なし・DB正常・Recovery適格ならTimeout後もCLEAN候補                                       | HTTP-01〜03、H5A-I05〜08       |
| H54-12 | Adapter未終了・未追跡HTTP・予約Commit unknown・Connection異常ならCLEAN禁止                                                  | TQ-04、SG-01、H5A-I08          |
| H54-13 | ShutdownとHTTP開始権限取得を同期的に直列化。停止先行なら新規Tx-Q / HTTP禁止                                                 | C1、SG、F03条件                |
| H54-14 | HTTP開始と永続予約証拠が1対1。同じ証拠で追加送信しない。再送には独立予約                                                    | TQ-04、SG条件                  |
| H54-15 | 管理者承認待ち・隔離中・再検証待ちでDrain済みでもRUNNING維持、CLEAN禁止                                                     | REC、ADM条件                   |
| H54-16 | 隔離途中の安全なShutdown→同一OS Boot再起動でもCLEAN経由で25時間隔離を迂回できない                                           | REC-04、H54-04・05・15         |
| H54-17 | History未確認・Clock異常範囲待機未完了・DB未解決ではRecoveryCleanEligible=false                                             | CLK-03、QH条件                 |
| H54-18 | CLEAN成功・Rollback・unknownを区別。今回unknownは正常終了未確定、無条件再試行・RUNNING書戻し禁止、次回はDB検証              | TQ・C2・PR-Bの結果不明保護     |
| H54-19 | v2→v3と初期RUNNING / generation=1 / Migration時boot_idを同一Txで確定し、旧履歴・Tableを保持                                 | PR-B Migration、REC条件        |
| H54-20 | Migration失敗・未知Version・不正Schema・結果不明を安全側処理。自動再実行・通常起動Upgradeなし                               | PR-B Migration条件             |
| H54-21 | Migration書込み前・共有ConnectionでWAL / FULL設定確認。Lifecycleも共有Coordinationに従う                                    | PR-B Connection・Migration条件 |
| H54-22 | inspect TokenのProcess / Boot / generation / cutoff / Fingerprint / 期限 / 診断拘束を再確認し、古い・再利用・二重承認を拒否 | KEY、ADM条件                   |
| H54-23 | CLIはBackendのRecoveryAdminServiceに委譲しDB直接更新なし。監査でAPIキー・Token非出力                                        | KEY、既存Secrets方針           |
| H54-24 | UNPROVISIONED / PROVISIONED / 異常を分類。F-01専用初期化と異常復帰を独立させ、Quota再検証                                   | KEY-01・02、QH条件             |
| H54-25 | 単調時計逆行・取得不能・継続性不明・Suspend疑義で証拠失効・Fail Closed。PiでSleep抑止・時計挙動確認                         | CLK条件、Issue #12 / #13       |
| H54-26 | 全体10秒の単調時計Deadlineを共有しCanStartCleanTxを判定。Drain / Recovery未完了・期限切れ・単調時計不明ならCLEAN禁止        | C1、PR-A Shutdown、REC条件     |
| H54-27 | Guardの構造検証と保守的窓評価を分離し、固定historyComplete=trueで迂回せず、Quota不足でControl非更新                         | QH、TQ、C2条件                 |
| H54-28 | 管理停止は独立維持し、DB Recovery・隔離完了・F-01完了だけではResumeしない。PR-D / PR-E境界維持                              | ADM、REC、F03条件              |
| H54-29 | CLEAN Commit成功・Rollback確定を確認。RUNNING→CLEANは今回Boot ID・Generationで拘束し、更新1件のみ成功候補                   | H54-18、PR-B結果不明保護       |
| H54-30 | CLEAN Commit unknownでDB上CLEANの場合、今回正常終了は未確定だが次回同一Boot・全安全条件成立なら自動復帰候補                 | R-01、REC-01                   |
| H54-31 | CLEAN Commit unknownでDB上RUNNING、またはCLEANでも異なるBootなら管理者復帰。DB不正・欠損はFail Closed                       | R-01、H54-15・16               |
| H54-32 | CLEAN + 同一BootでもHistory / Quota / Clock / Lifecycle条件不足では自動復帰・HTTP禁止。Startup unknownで証拠不採用          | R-01、H54-01                   |
| H54-33 | Clock異常2回以上の非重複範囲を保持。後発範囲へ先発待機を流用せず、各窓で独立に全件計上・除外                                | R-02、H54-09                   |
| H54-34 | Tx-Q CommitとClock異常検出が競合してもDrain後境界を確定。Drain / 境界確定失敗はFail Closed                                  | R-02、H54-08、TQ               |
| H54-35 | 最後に信頼確認したSequenceとの対応不明なら未確定影響範囲を保守的拡大。Timestamp逆算によるValid扱い禁止                      | R-02、CLK                      |
| H54-36 | 分類漏れ・重複・逆順境界・旧cutoff混入・確定境界変更・範囲統合を拒否。安全な分類不能なら停止                                | R-02、H54-07                   |
| H54-37 | 単調時計証拠失効とProcess再起動を区別。再起動後は範囲証拠失効・全旧履歴を案Dで評価                                          | R-02、H54-05・25、REC-04       |
| H54-38 | ShutdownのHTTP / DB / Lifecycleで同じ単調時計絶対Deadlineを使用し、段階ごとに10秒を再付与しない                             | R-03、PR-A Shutdown            |
| H54-39 | B_clean開始余裕不足・CLEAN前期限超過ではTxを開始せずRUNNING維持、可能なClose・EX解放を進める                                | R-03、H54-26                   |
| H54-40 | Drain / Recovery未完了・Clock異常・Connection不明・Shutdown所有権不正ではCLEAN禁止                                          | R-03、H54-12・17               |
| H54-41 | 同期SQLite / COMMIT長時間停止でTimer強制中断・10秒保証を主張せず、危険Rollback・再試行・成功推測を禁止                      | R-03、H54-18                   |
| H54-42 | CLEAN Commit成功後のDB Close失敗は別記録。CLEAN成立を取り消す無条件書戻しや正常終了推測をしない                             | R-03、R-01                     |
| H54-43 | Boot ID / Generation不一致、更新0件・複数件ではCLEAN成功としない。適格性確認からCommitまで新規送信禁止                      | R-01、H54-13・29               |
| H54-44 | 異常再発でも新Consumptionがなければ空範囲なし。待機完了 / Clock回復で過去不確実履歴をValid再分類しない                      | R-02、H54-09・10               |

## 実装前の要確認事項と保証境界

- **自動復帰の具体検証**：R-01のMarker別分岐・CLEAN結果分類は採用確定。History / Quota / Clock等の全条件の検証手段、generation更新・上限、Fingerprint・cutoff保存／照合、起動中失敗の具体処理は実装前詳細化。前回Commit unknownだけで復帰可否を決めず、条件不成立時は安全側停止とする。
- **Schema v3の具体DDL・SQL**：依頼はTable名・4管理項目・初期値を確定している。列型・制約・lifecycle_key値、通常Startupの具体SQLは未指定でありDDLを創作しない。CLEAN更新はR-01のBoot / Generation拘束・正確に1件・結果不明規約を採用済み。NORMALからFULLへの適用・検証順序、旧Release非互換・新規DB Provisioningのv3対応も実装前に確認する。
- **履歴の証拠表現**：R-02でRangeの概念項目、非重複・固定境界・独立待機・統合禁止・再分類禁止を採用確定。実装型・レジストリ構造・信頼確認Sequenceとの対応証拠、QuotaTrustから保守的窓評価へのAPIは詳細化待ち。固定trueで迂回せず、完全性を待機だけで回復させない。
- **Shutdown開始余裕**：R-03のB_cleanはPi 5実機検証後に決定。単調時計Deadline Gateの具体配線・計測を確認し、B_cleanを同期COMMITの完了保証としない。
- **管理操作**：Tokenの具体有効期間、UDSの配置・所有権・認可、cancelの詳細動作、再承認時の状態遷移は未確定。既存管理停止／ResumeとHistory復帰承認を混同しない。
- **Sleep / 時刻**：systemd Sleep抑止・監視・Suspend検出の具体方式とPi単調時計の実挙動は未検証。観測周期だけでSuspend完全検出とはしない。Clock Trust本番確認・RTC-only許可を今回新たに固定しない。
- **耐久性・外部前提**：WAL + FULLでも電源断・microSD・管理外Restoreの完全検出／耐久保証はしない。Provider計上遅延上限不明はレベルB受容。外部Sender不在は管理者確認の前提であって技術的証明ではない。
- **C-Impl-5B-5前の確認**：上記未指定事項をレビューし、H54対応を既存テストへ割り当て、実Startup / Shutdown / Gate / Quotaの結合範囲を確定してから実装する。今回実装・テスト実行・Migration・実Provider通信・実機試験は行っていない。
