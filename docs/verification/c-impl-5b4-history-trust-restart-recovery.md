# C-Impl-5B-4 History Trust / Restart Recovery：詳細設計・受入計画

設計正本は[technology-stack.md §23.11](../technology-stack.md#pr-c-c-impl-5b4-history-restart)。今回の基準mainは`96e29396b95a1ea02ee06589331230656ef77fd0`（[PR #51](https://github.com/rinYamano211/home-digital-signage/pull/51)の設計Merge済み、PR #50のC-Impl-5A実装を含む）。親[Issue #16](https://github.com/rinYamano211/home-digital-signage/issues/16)はOpenで継続する。

PR #51はMerge Commit `96e29396b95a1ea02ee06589331230656ef77fd0`でmainへ反映済み。本更新は同Commitを基準に、採用確定したD-01〜D-03を追記する。P0・P1 / R-01〜R-03の文書反映、既存コードの読取り結果、未実施の受入計画を区別し、設計文書の存在をLifecycle Repository実装済みとは扱わない。既存ADR専用ファイル・ディレクトリは確認できず、既存方式に従いtechnology-stack.mdを正本とする。コード・テストコード・DB・Issueは変更しない。以下の受入条件はすべて**設計確定・テスト未実施**である。

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

| 事象・前提                                 | 次の段階・処理                                                 | 送信・証拠への制約                                                   |
| ------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| Process開始                                | Gate閉鎖、Startup境界の確定・Trust検証                         | 旧Attempt / Permit / メモリ待機は復活しない                          |
| Startup境界Commit未確定                    | 安全側停止・照合                                               | cutoffや待機証拠を発行しない                                         |
| 自動復帰の全条件を確認                     | 保守的な通常Quota評価                                          | 案D待機未完了の旧履歴は各窓に全件計上。強制HTTPなし                  |
| RUNNING、またはCLEAN + 異なるOS Boot       | MVP自動復旧条件を独立検証                                      | Boot差・通常クラッシュだけで管理者隔離せず、検証後もQuota / Gate判定 |
| Marker不正・欠損・DB不整合                 | Fail Closed                                                    | 正常なRUNNINGと同一視せず、推測復帰しない                            |
| 有効Tokenで管理者承認成立                  | 今回Processの25時間隔離開始                                    | 案Dとは別起点・別証拠。CLEAN禁止                                     |
| 隔離完了                                   | 全窓待機・起動境界・DB / Clock / History・キー排他利用の再検証 | 完了時間だけで開放せず、再検証待ちはCLEAN禁止                        |
| 再検証成功、History復帰                    | 通常判定の候補                                                 | 管理停止等を独立維持。Guard・Tx-Q・Gateを迂回しない                  |
| 壁時計Trustのみ失効                        | Tx-Q / HTTP停止、Drain、影響範囲固定・窓別隔離                 | 単調時計継続なら管理者隔離証拠保持。Clock回復とHistory回復は別       |
| Drain不能、単調時計継続性不明、Suspend検出 | Fail Closed                                                    | 該当証拠失効。新たな待機証拠を推測発行しない                         |
| Shutdown開始                               | STOPPING・Gate閉鎖・新規取得禁止・Drain                        | HTTP開始と同じ同期境界で直列化                                       |
| CanStartCleanTx成立                        | Boot ID・Generation拘束の専用TxでCLEAN更新、正確に1件を要求    | 共有10秒Deadline・B_clean確認後のみ開始                              |
| Drain済みでもRecovery不適格                | RUNNING維持で安全に終了可能                                    | 次回同一OS BootでもCLEAN経由の隔離迂回を許さない                     |
| CLEAN Commit unknown                       | 今回Processは正常終了未確定、再試行・RUNNING書戻し禁止         | 次回DB上CLEAN + 同一Boot + 全条件成立なら候補                        |
| Startup Commit unknown                     | 今回起動証拠を採用せずFail Closed                              | CLEANの次回照合と混同しない                                          |
| Deadline / B_clean不成立                   | CLEAN省略・RUNNING維持、可能なCloseを進める                    | 全体期限は延長しない                                                 |
| CLEAN確定後のClose失敗                     | CLEAN成立とClose失敗を別記録                                   | 安全な終了完了と同一視しない                                         |

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

## D-01〜D-03確定設計とH54の対応（未実装・未検証）

詳細DDLは正本の[D-01](../technology-stack.md#pr-c-c-impl-5b4-d01)・[D-02](../technology-stack.md#pr-c-c-impl-5b4-d02)・[D-03](../technology-stack.md#pr-c-c-impl-5b4-d03)に一元化する。本書には重複掲載しない。既存H54-01〜44の番号・本文を維持し、以下を承認済み設計との対応として整理する。新しい正式受入IDや独立テスト関数の追加義務は設定しない。

| 設計・検証契約                     | 対応する既存H54                | 期待結果・後続実装への引継ぎ                                                                                                                                                           |
| ---------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-01：Singleton・Generation・CLEAN | 18〜21・29〜32・43             | Migration Gen 1→初回Startup Gen 2、通常Startupで正確に+1、上限拒否。CLEANは増分なし・Boot / Gen拘束・更新1件。自動生成・修復・巻戻しなし                                               |
| D-01：4 Tableと明示Migration       | 19〜21                         | v2の6 Table / Index / Quota履歴維持、4 Table追加・Gen 1・user_version=3をAtomic確定。書込み前WAL / FULL / FK、通常起動Upgradeなし。INTEGER PRIMARY KEYの自動IndexなしをValidatorで考慮 |
| D-02：Preflight・全履歴検証案A     | 01・19〜21・27・32             | EX・厳密v3・FULL / FK・正常Connection・Lifecycle1行・OS Boot ID・親履歴Gen 2〜現在Gen連続・Provider集合を検証。全Consumption構造 / SequenceはBEGIN IMMEDIATE内で検証                   |
| D-02：Startup Atomicity・結果不明  | 01・18・29〜32                 | 前回Lifecycle再検証→親INSERT→全Provider境界INSERT→集合完全一致→前回State / Boot / Gen拘束UPDATE1件→Commit。unknownは今回証拠不採用、再試行なし、次回独立検証                           |
| D-02：Provider分類・F-01           | 04・24・27・28                 | DDLでPROVISIONED / NULL拒否。Backendは状態・整数範囲・Metadata / Consumption一致を独立検証。F-01後はStartup境界不変・Runtime Cutoff 0、unknownなら発行なし                             |
| D-03：永続Range・Runtime証拠分離   | 07〜10・33〜37・44             | 複合FK、非空範囲、cutoff < start <= end <= last、非重複・分類漏れなし。UPDATE / DELETE / 統合禁止、Provider / Gen内Range ID単調・再利用なし。待機・Valid区間は非永続                   |
| D-03：Clock異常時の順序            | 08・12・33〜36                 | Clock失効→同期Gate閉鎖→Valid凍結→Drain→最終Sequence→全履歴分類→Tx内非重複検証→Range Commit→待機開始。Drain失敗 / Commit unknownはRange確定証拠なし                                     |
| D-03：Runtime Validの競合          | 07〜10・14・27・34〜36         | Clock TrustとTx-Q Commit成功後のみValid証拠を生成し、Clock異常と同期制御。生成失敗 / unknownではValid扱いせずFail Closed。固定historyComplete=true禁止                                 |
| D-03：Range別計数・再開案A         | 02〜07・09・10・27・33・37・44 | C_old + C_valid + 各Rangeの計数。未完了範囲は窓に全件計上し、待機未完了でも保守的Quotaと独立条件成立なら再開候補。管理者隔離25時間は別条件                                             |
| D-03：再異常・Process停止          | 05・06・15〜17・25・35・37・44 | 単調時計継続なら既存待機保持可能、不明なら失効。回復だけで復活・Valid昇格しない。確定前停止はRUNNING、再起動は新cutoffの案Dへ                                                          |
| D-01〜03と既存R-01〜03             | 11〜18・26・28〜32・38〜43     | CLEAN適格性・共有10秒Deadline / B_clean・Commit unknown・管理者隔離迂回禁止を維持。送信再開候補とCLEAN適格を同一視せずD-04へ接続                                                       |

**追加受入観点の提案（未承認・新ID未付与）**：Generation上限と親履歴欠落、Provider境界集合過不足、Range複合FK・Range ID再利用、Runtime F-01境界の失敗、Valid証拠生成とClock失効の競合を、上表の既存H54へどう割り当てるか実装前に確認する。独立した追加テストケースにするかはレビュー待ちであり、今回正式ID・実装方法を確定しない。

### 現行コードとの差とD-04への接続

| ファイル                                | 必要な後続対応（今回コード変更なし）                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| src/backend/storage/schema.ts           | v3の4 Table・PK / 複合FK・Index構造検証は未実装。INTEGER PRIMARY KEYに既存PK Index必須チェックを適用しない |
| src/backend/storage/store.ts            | 現行WAL + NORMAL。v3 / FULLの設定・検証とLifecycle所有権への接続が必要                                     |
| src/backend/storage/quota-repository.ts | Startup / Range / Runtime Valid証拠とTx-Q Commit・unknown保護の連携が必要                                  |
| src/backend/quota/quota-guard.ts        | 全Timestampによる評価から、構造検証とH_old / Valid / Rangeの保守的窓計数を分離する必要                     |
| src/backend/send/internal/trust.ts      | Range状態・Clock異常時の凍結と証拠失効・History判定への接続が必要                                          |
| src/backend/send/provider-send-gate.ts  | Startup / Recovery条件と本番Gateの閉鎖・再開候補の連携が必要。固定trueを供給しない                         |
| src/backend/shutdown.ts                 | CLEAN Transaction・共有Deadline Gate・B_clean確認は未実装                                                  |
| src/backend/main.ts                     | Startup / Lifecycle / Recoveryの本番統合が必要                                                             |

D-04でU-01〜U-03の採用方針・復旧4状態・History 3状態を確定した。具体API・実装型と技術検証は後続へ残す。D-03の待機未完了でも可能な保守的再開と、独立した管理者隔離・CLEAN禁止を取り違えない。既存PR-Dの公開・Pending、PR-Eの継続DB Recovery / Restore責務を変更しない。

## D-04採用方針と検証への引継ぎ

本更新はPR #52のHead d5eb375f3187c4a0bf5a71376ca3dd39a83b4f28に積み重ねる文書PRであり、PR #52をmain反映済みとは扱わない。正本は[D-04](../technology-stack.md#pr-c-c-impl-5b4-d04)。以下は採用済み方針と未実施の検証観点であり、新しい正式受入ID・テストPASSを設定しない。H54-01〜44の番号・本文は維持する。

| 区分       | 採用内容                                                                                                                                          | 既存H54との対応・未実施の確認                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| U-01       | v2の6 Tableとv3の4 Table、明示Migration・FULL、Gen 1初期隔離→Gen 2通常Startup、OS Boot / Process Instance / Startup Genの分離                     | H54-01・19〜21・29〜32。過去Boundary / 履歴検証後のAtomic Startup。Snapshot・Fingerprintは正本の正式統合DDLを実装対象とする。実装未完了 |
| U02-01〜07 | TRUSTED / CONSERVATIVE / BLOCKED、Window別保守計上、メモリ待機、Tx-Q内再判定、Clock / Recovery分離、証拠不足拒否、隔離解除をU-03へ委譲            | H54-02〜10・27・33〜37・44。従来Boolean・Monitorとの結合は未実装。固定trueで代替しない                                                  |
| U03-01〜08 | 既存4管理操作とRecoveryAdminService、復旧4状態、一回限りToken、Process / Boot / Gen / Boundary拘束、UDS認可、独立隔離、cancel責務分離、再起動失効 | H54-04〜06・15〜17・22〜25・28。既存SUSPENDEDの解除に流用しない。具体Token / UDS実装は未検証                                            |

| D-04レビュー | 反映した規約                                                                                                                | 対応する既存観点                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| D04-R01      | 過去Startup Boundary・履歴を検証後に新境界を保存。上書きで不整合を解消しない                                                | H54-01・19〜21・32                                                          |
| D04-R02      | CONSERVATIVEは完全性・Range境界・排他的分類・Window別保守計上が成立する場合のみ                                             | H54-07〜10・27・33〜37                                                      |
| D04-R03      | Plan DはStartup Commitに加え固定境界・単調時計連続性・Window開始証拠を要求。管理者隔離は正当なapprove後で独立               | H54-02〜06・15・16                                                          |
| D04-R04      | 明示v3 Migrationと通常Startup、書込み前FULL、Gen 1隔離・Gen 2の接続                                                         | H54-19〜21・24                                                              |
| D04-R05      | SHA-256 / quota-history-v1、Snapshotから過去Metadataを再現、cutoffまで昇順、型タグ・長さ付き符号化、Boundaryへ小文字Hex保存 | H54-01・22・27・32。タグ・統合DDLは追加承認済み。独立テストベクトルは未検証 |
| D04-R06      | Peer Credentials・OS権限とUDS認可の実装可能性を確認できない場合、管理操作を許可しない                                       | H54-22・23・25                                                              |
| D04-R07      | OperationallyDrained AND RecoveryCleanEligible、隔離中CLEAN禁止、次回起動の隔離迂回禁止                                     | H54-11〜18・26・29〜32・38〜43                                              |

### Fingerprint最終仕様・統合DDLと検証の区別

正式仕様は[正本D-04](../technology-stack.md#pr-c-c-impl-5b4-d04)、物理保存先は[正式統合DDL](../technology-stack.md#pr-c-c-impl-5b4-boundary-final-ddl)に一元化する。PR #52の基準DDLは保持するが、実装・Schema Validator・明示v2→v3の最終対象はD-04統合定義とする。

- Snapshot・Fingerprintの追加3カラムを正式採用：history_status_snapshot、initialized_at_ms_snapshot、history_fingerprint。UNPROVISIONEDはSnapshot2項目NULL・Digest必須、PROVISIONED / 0はSnapshot必須。provider_key・cutoff_sequence・既存PK / FK / CHECKを再利用する。
- quota-history-v1 / SHA-256、TypeTag 1バイト + Valueバイト長の4バイト符号なしBig Endian + Value。STRING=0x01、INTEGER=0x02、NULL=0x03、METADATA_ABSENT=0x04、COUNT=0x05。NULL / ABSENTはLength=0でタグを区別する。
- PROVISIONEDはVersion→provider_key→history_status→initialized_at_ms→cutoff時点last_sequence→COUNT→sequence昇順の各行(sequence→reserved_at_ms)。UNPROVISIONEDはVersion→METADATA_ABSENT→COUNT 0でMetadata4項目・履歴行を出力しない。
- UTF-8・Unicode正規化なし、整数とCOUNTは共通安全整数範囲の非負10進ASCII。ゼロは0、先頭ゼロ・プラス・小数点・IEEE 754バイナリを使用しない。区切り文字・改行を挿入せず、件数と実符号化行数を一致させる。
- 小文字64桁HexをBoundaryへ保存し、過去Snapshotとcutoffから再計算する。現在Metadataを代用せず、履歴欠落・不整合・再現不能・不一致・Commit unknownはFail Closed。Hashは外部Sender不在・実HTTP回数の証明ではない。

正本に提示されたPROVISIONED・履歴0件（p / ACTIVE / initialized 0 / cutoff 0）のバイト列を掲載した。後続で独立ベクトルとして照合し、UNPROVISIONEDとConsumption 1件も作成・検証対象とする。今回期待Digestの算出・テストコード・実行結果を追加せず、設計確定と検証未実施を区別する。

### R55-01〜04のレビュー対応

| 指摘   | 対応と状態                                                                                                                                                  | 既存H54との対応（未実施）                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| R55-01 | 3カラムと分岐CHECKを正式採用し、D-04に完全なCREATE TABLEを掲載。PR #52の基準DDLは保持、実装は正式統合定義を参照                                             | H54-01・19〜21・24・27。Snapshot / cutoff / FingerprintをAtomic保存し不在と0件を区別する必要 |
| R55-02 | 暗号学的乱数32バイト、初期5分の単調時計期限、Processメモリのみ、再発行失効、approve検証試行時消費・失敗後再利用不可、7拘束項目、CLI stdin優先・Secret非監査 | H54-05・22・23。期限、再発行、検証失敗後再利用、境界 / diagnosisRevision不一致を実装時に確認 |
| R55-03 | ISOLATED維持+Token失効、APPROVED_WAITING / REVALIDATING→ISOLATED、RECOVEREDは拒否。RECOVERED確定と直列化し旧結果の復帰を防止                                | H54-15〜17・22・28。cancelはSUSPENDEDの代用やQuota削除、HTTP取消し完了保証ではない           |
| R55-04 | Startup Commitだけで待機開始せず、固定履歴境界・単調時計連続性・Window別開始時点を要求。失効時は該当待機未完了。管理者25時間隔離は正当なapprove後に独立開始 | H54-01〜06・09・25・37。各証拠不足と失効を実装時に確認                                       |

R55-01とD04-R05の追加承認により、3カラム・制約と符号化のタグ・長さ・順序は確定済み。明示v2→v3で統合Tableを作成し、Gen 1でBoundaryなし、Gen 2からSnapshot・cutoff・FingerprintをAtomic保存する。v2の既存6 Table・Quota履歴を維持し、自動修復・過去Metadata推測Backfillは行わない。旧基準v3適用DBが存在する場合の明示対応は別途確認する。今回DB / Migrationは未操作。

### 技術検証（未実施）

- UDS Peer Credentials取得とOS権限設定。利用可能なAPI・失敗時の拒否を確認し、ローカル接続だけで認可しない。
- Sleep / Suspend抑止、Pi単調時計の継続性・待機証拠失効。
- Shutdown B_clean値、同期SQLiteの長時間停止、Pi SQLite耐久性。
- Fingerprint独立テストベクトルと過去Snapshot / cutoff再計算。
- 既存Quota Guardと新History Trustの結合、Tx-Q内のTrust再評価。

U-01〜U-03・D04-R01〜R07、R55-01の統合DDLとD04-R05のバイト列仕様は設計確定。相互運用性の独立ベクトル・実装結合・実機検証は未実施であり、設計確定をPASS・実装完了とは扱わない。新しいTable・管理コマンド・管理Serviceは追加しない。

## 個人利用MVP向け整理（設計変更・未実装）

| クロスレビュー項目             | 対応                                                                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1〜2：基本方針・通常クラッシュ | 構造・Fingerprint一致・履歴整合・保守計上・Clock・独立停止なし・予約時Guardの全条件で承認なし自動復旧候補。正常Startupと送信許可は別。重大不整合は停止・診断・手動対応 |
| 3：DDL一本化                   | PR #55内の旧Boundary CREATE TABLE掲載を正本リンクへ置換。完全な定義はD-04統合DDL1件だけ。PR #52は変更しない                                                            |
| 4：Fingerprint範囲             | 直前Boundaryのprefix Hash + 全Consumption構造 / Sequence + cutoff後全件計上を最小補完案として提示。保証範囲の差があるため照合縮小は保留                                |
| 5：Suspend                     | systemd等のSleep / Suspend抑止・常時稼働を前提とし、複雑な独自監視を新設しない。連続性不明は待機未完了、再起動証拠復元なし                                             |
| 6：状態名                      | 旧Monitor、新History、DB history_status、Provider管理停止、Recovery状態を別責務として表に整理。既存値の改名なし                                                        |
| 7：CLEAN                       | History TRUSTED・未完了Rangeなし・必要履歴 / Boundary検証・隔離未完了でないこと等を要求。CONSERVATIVEはCLEAN許可ではない                                               |
| 8：diagnosisRevision           | Process内診断Revisionをinspect Tokenへ拘束。承認判断に影響する変化で更新、approve不一致拒否、再起動引継ぎ・DB列なし                                                    |
| 9：整数                        | v3の非PK / 複合PK INTEGERへtypeof確認を追加。既存v2 DDLは変更せずBackend整数・安全範囲検証を維持。遡及SQL変更は別途承認が必要                                          |
| 10：実装区分                   | MVP必須、重大不整合時の例外経路、後続実機・運用確認を分類。機能削除・新ID追加・PASS化なし                                                                              |

通常復旧では前回RUNNINGの旧履歴をPlan Dで保守計上し、1分 / 65分 / 25時間の各待機完了前は全件計上したうえでQuota Guardを確認する。管理者独立25時間隔離は毎回の通常クラッシュに課さず、重大不整合の例外経路で維持する。Clock単独の問題は送信停止を維持しつつ既存Clock Recoveryで再評価し、無条件に恒久隔離へ昇格させない。APIキーを他Senderで使わないことは運用前提で、Hashが技術的に証明する事実ではない。

### 実装前の判断保留

1. **H54-31と新MVP方針の衝突**：既存H54-31はRUNNINGまたは異Bootで管理者復帰とする旧期待結果である。ID・本文の変更禁止に従いそのまま保持した。新MVP条件では自動復旧候補にできるため、期待結果の変更・対応表の採用を別途承認する必要がある。旧H54を黙って読み替えたり、新方針の試験PASSとしたりしない。
2. **Fingerprint照合縮小の保証範囲**：直前BoundaryのcutoffまでのConsumptionは1回のHashで覆えるが、より古いBoundary Snapshot / Digest自体の改変検出と、直前cutoff後の形式を保った改変のHash検出は別である。後者は旧全世代方式でもcutoff外なら覆えない。候補Aは直前prefix照合 + 全件構造 / Sequence + cutoff後全件計上に保証を限定してMVPで受容する方式、候補Bは既存の過去Boundary検証範囲を維持する方式。新Table / 複雑なキャッシュを作らず、今回Aを独断採用せず照合範囲縮小を保留する。異常な最新Boundaryを飛ばすFallbackは行わない。
3. **既存v2の遡及整数制約**：既存4 State系TableとQuota2 TableのSQL制約追加は互換性・Migrationに影響する。今回新v3側の整数検証と既存Backend検証を整理し、v2 DDLの変更は実施しない。

本PRの承認済み整理は文書へ反映するが、上記不整合・判断は未解決として報告する。受入実装前に解消が必要。PR #52のBranch変更・Merge・Rebaseは不要で、行っていない。

## 実装前の要確認事項と保証境界

- **D-01〜D-03で解消した未決扱い**：4 Table DDL、lifecycle_key=1、Generationの+1・上限、Startup親子Atomicityと全ConsumptionのTx内検証案A、F-01後Runtime Cutoff、Range複合FK・永続境界とRuntime証拠の分離・再開案Aは確定済み。DDL未指定・Generation未定義という旧記述は適用しない。実装・テストは未完了。
- **DDLとBackend検証の境界**：PROVISIONED分岐のIS NOT NULL追加はChatレビューで承認済み・反映済み。PROVISIONED / NULLをDDLのCHECKでも拒否し、BackendでもProvider状態・cutoff整数範囲・Metadata / Consumption一致を独立検証する。DDL成立だけでStartup履歴の完全性を証明しない。上表のH54対応へ反映したが、NULL拒否の実行テストは未実施でありPASSとは扱わない。
- **D-04と実装詳細**：U-01〜U-03・D04-R01〜R07とFingerprint承認範囲は上記に反映した。型タグ値・Snapshot統合DDLは追加承認済み。Token実装、具体API・型、Runtime証拠管理、追加テスト実装と独立ベクトル検証は後続へ残す。既存Guard / Trust Monitorは新Interface未対応であり、固定trueで迂回しない。
- **Shutdown開始余裕**：R-03のB_cleanはPi 5実機検証後に決定。単調時計Deadline Gateの具体配線・計測を確認し、B_cleanを同期COMMITの完了保証としない。
- **管理操作**：復旧4状態、UDS管理者認可、cancelとSUSPENDEDの分離は採用済み。Tokenの32バイト・初期5分単調期限・消費と再発行失効、7拘束項目、cancel遷移と直列化は採用済み・実装試験未実施。UDS配置・所有権・Peer Credentials APIは未検証。既存管理停止／ResumeとHistory復帰承認を混同しない。
- **Sleep / 時刻**：systemd等のSleep / Suspend抑止・常時稼働運用を採用し、複雑な独自検出機構は追加しない。OS設定とPi単調時計は未検証。抑止だけで連続性を証明せず、不明時は該当待機未完了。Clock本番確認・RTC-only許可は新たに固定しない。
- **耐久性・外部前提**：WAL + FULLでも電源断・microSD・管理外Restoreの完全検出／耐久保証はしない。Provider計上遅延上限不明はレベルB受容。外部Sender不在は管理者確認の前提であって技術的証明ではない。
- **C-Impl-5B-5前の確認**：上記未指定事項をレビューし、H54対応を既存テストへ割り当て、実Startup / Shutdown / Gate / Quotaの結合範囲を確定してから実装する。今回実装・テスト実行・Migration・実Provider通信・実機試験は行っていない。
