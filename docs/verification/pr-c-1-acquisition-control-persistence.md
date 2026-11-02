# PR-C-1：Acquisition Control State / Tx-A永続化基盤の差分確認

## 基準と実装済み範囲

基準mainは `afa060a91a674ca14203d0beedc1075b079c0b4f`。PR #52・#55の設計はMerge済みである。正本は[technology-stack.md §23.10](../technology-stack.md#pr-c-c2-acquisition-control)、[architecture.md §16](../architecture.md)。既存の[C-Impl-2検証記録](c-impl-2-acquisition-control.md)を置き換えない。

今回依頼されたRepository / Tx-AはC-Impl-2（PR #43）で実装済み。重複Repository・新API・Schema変更を追加せず、実SQLiteをCloseして新Connectionへ置換する永続復元テストを補完した。新規の本番Moduleはない。

| 責務                        | 既存Module・契約                                                                  | 今回の差分                                         |
| --------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------- |
| 保存データの検証            | acquisition/control-state.ts：consecutiveFailures、nextAttemptAtの2項目           | 型・値域・UTC契約は変更しない                      |
| Read・Tx-A                  | storage/acquisition-control-repository.ts：read / saveConditionally / reconcile   | 再実装しない                                       |
| Evidence・初回保存          | 同RepositoryのControlAttemptManager：beginAttempt / endAttempt / authorizeInitial | 本番のHTTP分類・新規性判断を追加しない             |
| Connection所有              | storage/store.ts：単一Connectionを各Repositoryへ供給                              | Open / Close・Connection Coordinationを変更しない  |
| Startup時に利用するRead基盤 | 新Connection上で既存Repositoryを構成し、明示的な試行Contextでread                 | Startup処理・Scheduler起動・送信再開には結線しない |

Readのfound / empty / invalid / database_error / pending、保存のsaved / unchanged / not_saved / unknownを維持する。BEGIN IMMEDIATE、Row再照合、単回消費Evidence、初回INSERTのAuthorization、Commit例外のRead-only照合は既存実装を利用する。foundやempty、Evidenceの取得はHTTP送信許可ではない。欠損だけで新規性を認めず、不正Rowの自動初期化・修復は行わない。

## 追加テスト12件

追加先は `tests/backend/acquisition-control-repository.test.ts`。既存の一時ファイルDB・故障注入・後始末を再利用し、各テストで独立したDBを使う。

| 件数 | 追加検証                                                                                                                           | 既存受入条件との対応                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 5    | 各StateのTx-A保存後にDBをClose・新Connectionへ置換。保存値を復元し、旧Evidenceを拒否、新Evidenceで更新可能。試行未開始のReadは拒否 | C2-01 / 04 / 05                       |
| 1    | 再接続後の未登録Rowはempty。新規性不明の事実から初回Authorizationを発行せず、Rowを作らない                                         | C2-02 / 07（Application統合は未実施） |
| 4    | JSON破損・型不正・負の失敗数・実在しない日時が再接続後もinvalid。Evidenceなし、Row不変、他Stateへ非波及                            | C2-01 / 13                            |
| 1    | 書込みCommit前の例外でRollback・Read-only照合後not_saved。新Connectionでも旧Control値・PR-Bの保存Rowを保持                         | C2-16 / 18                            |
| 1    | v1の自動Upgrade拒否後、既存の明示v1→v2 Migrationを適用。再接続後Control値を保持し、Quota Metadataを自動作成しない                  | C2-01、既存Migration契約              |

最後のMigrationテストは一時テストDB上の既存Migration関数の検証であり、管理CLI・EX Lock・実運用Migration全体を新たに検証したものではない。EX・Provisioning・BackendStoreの実Process経路は既存Linux回帰を利用する。PR-B非干渉テストの合成Rowは所有テーブルの値が変わらないことの確認用であり、Domain Snapshot / Cacheの意味検証は既存のRepository回帰へ委ねる。

## 既存テストとの対応

| 今回の依頼範囲             | 既存の証拠・追加範囲                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Allowlist・構造・型・値域  | C2-01 / 13と既存のAllowlistテスト。再接続後の不正分類を追加                                                                   |
| Atomic保存・競合・Rollback | C2-14〜18。今回Rollback後の永続状態を再接続で確認                                                                             |
| Commit unknown・再試行禁止 | C2-18〜21。予定JSON固定、ABA・Read-only照合失敗時unknown、通常Read / 後続保存保留、未解決Connection保護を既存テストで回帰確認 |
| State障害とDB障害          | C2-13 / 21。State単位pending局所化、Schema・未解決TransactionでPR-B共有保護                                                   |
| Connection再生成           | C2-04 / 05の証跡失効に加え、今回5 Stateの永続値復元を検証                                                                     |
| 初回保存・停止             | C2-02〜10 / 25。既存の単体機構のみ。HTTP分類・本番Lifecycle結線は未完了                                                       |

受入IDや設計の期待結果は新設・変更していない。既存C2-01〜26の部分検証・後続統合待ちはC-Impl-2検証記録の区分を維持する。今回のPRでC2全条件やIssue #16全体を完了扱いにしない。

## PR #52・#55との境界

D-01〜D-04のSchema v3、Lifecycle / Startup Boundary、History Fingerprint / Range / Recoveryは設計確定と実装完了を区別する。現行コードのSchema v2・WAL / NORMALを今回変更せず、v3とWAL / FULLの全体導入は後続とする。今回のテスト成功をv3対応やStartup安全性全体の検証結果とは扱わない。

初回Authorizationの確認事実は後続Applicationが実際の永続情報から生成する必要がある。テストの合成確認事実は本番の新規性・Trust確認を代行しない。Process内pending照合情報やEvidenceを永続化・復元する機構は追加せず、再起動を跨ぐCommit帰属の完全識別は保証しない。

## 品質結果と後続工程

対象Repositoryテスト83件（既存71件＋追加12件）は成功。Windows全体は785件成功・Linux専用47件Skip（計832件）。Lint / Format / Type Check / Backend Build / git diff --checkは成功。Linux CIへのリンクと結果はPR本文へ記録する。

通常のnpm ciはWindows C++ビルド環境不足で失敗した。その後npm ci --ignore-scriptsで同じlockfileの依存を再導入し、公式better-sqlite3パッケージ同梱のWindows prebuildでSQLiteの実動作・全回帰を確認した。依存定義・lockfile・CI設定は変更していない。Linux CIでは通常のnpm ciを実行する。

最新main由来のc-impl-5b4-history-trust-restart-recovery.mdに既存のPrettier違反があったため、表の整形のみ補正した。表の区切り・空白を正規化した比較で本文・受入ID・期待結果の不変を確認した。設計判断の変更ではない。

今回追加テストは実SQLiteを利用するが、別ProcessのCrash・電源断・Pi実機耐久性は検証しない。

Scheduler・HTTP・Timeout / Backoff実行・429統合・Quota予約・History Trust・Fingerprint・Startup / Lifecycle / Recovery・Pending・Domain / UI・Backup / Restoreの実装には着手しない。次の実装単位は、確定済みD設計と残作業を照合して別途指定する。今回のRead復元基盤だけで自動送信可能とは扱わない。Issue #16はOpen、PRは未Merge・レビュー待ちとする。
