# C-Impl-3 Quota永続化 / Quota Guard / Tx-Q：検証と引継ぎ

正本は[technology-stack.md §23.11](../technology-stack.md#pr-c-c-impl-3-quota-persistence)、同§12.4・§12.6、[architecture.md §16](../architecture.md)、Issue #16。設計PR #44のMerge Commit `58528fdd42f9d8548ff35545ce32d9298fa4652a`を起点とする。設計正本の意味論を変更せず、今回の実装・検証範囲を記録する。PR-C・Issue #16全体の完了とは扱わない。

## 実装Interfaceと責務

- `BackendStore.quota`は既存の単一Connectionを借りる。ConnectionのOpen / CloseはStoreが所有し、既存Connection Coordinationのbusy・未解決Transaction・DB異常による保護を共有する。
- `QuotaGuard.evaluate(provider, history, now, trust)`はDB・HTTP非依存の判定。Tomorrow.ioのBackend運用上限400 / 20 / 1をローリング24時間 / 60分 / 1秒へ適用し、各窓に暫定2秒を加える。Dashboard確認値500 / 25 / 3と区別する。余裕込み境界ちょうどはカウントし、最遅の解除見込みを返す。これは再評価の目安であり、予約・送信許可ではない。暫定余裕の実測・数学的安全保証は行わない。
- `QuotaRepository.inspect(provider, trust, now)`はMetadata・履歴を短いRead Transactionで読み、構造・安全整数・Sequence連続性・Timestamp・Trust・Quotaを検証する。履歴欠損・不正を自動修復しない。
- `beginAttempt(provider) / endAttempt(attempt)`はProcess内の取得試行境界。同一Repository内の同一Providerの重複試行を拒否し、保存試行開始時に消費する。BEGIN失敗後も同じ試行で再予約しない。Applicationによる開始・終了の本番接続は後続工程。
- `reserve({ providerKey, attempt, trust })`はTx-Q。Trustは信頼されたApplicationからの確認事実を供給するCallbackとし、事前・Transaction内で確認する。`saved / quota_blocked / not_saved / unknown`を区別する。
- `reconcile(provider)`は当該Repositoryが保持するunknown予約のRead-only照合。予定Sequence・Timestamp・内容を再生成せず、再予約しない。
- `inspectReservation(evidence, attempt)`は後続Gateへの読取専用境界。Provider・Sequence・予約Timestamp・計測起点を返すが、Send Permitではなく送信許可を決定しない。非公開WeakMapの不透明トークンを用い、偽造・複製・別Repository・別試行・終了済み試行・Connection閉鎖／再生成後の流用を拒否する。永続Evidence Tableは追加しない。

Clock Trust、履歴Timestampの信頼性、履歴完全性は独立した確認事実。SQLiteの内部整合性、ACTIVE、空履歴だけでは後二者を証明できない。将来の信頼されたApplicationが管理外Restore・巻戻し・外部Sender等の前提を確認する必要があり、不明ならfalseでFail Closedする。OS同期監視・外部Senderの自動検出は今回実装していない。

## Schema v2と明示Migration

既存4 TableのDDL・制約・既存データを保持し、設計どおりの`provider_quota_metadata`、`provider_quota_consumptions`、`idx_provider_quota_reserved_at`だけを追加する。`user_version=2`、DDL・PK・FK・Index・未知構造を厳密検証する。接続単位でForeign Keyを有効化・確認する。SQLite INTEGERはBigIntとして読み、安全整数範囲を確認してからNumberへ変換する。

新規DBの明示初期化はv2となるが、Provider Metadataは作成しない。Schema初期化・MigrationとQuota Provisioningは別操作である。

### v1からの適用条件

旧Releaseのv1限定Schema検証はv2を拒否することをテストした。したがって§12.4の旧Release読書き互換条件を満たさず、**通常起動時の自動Migration allowlistは空のまま**とする。既存v1での通常起動はBLOCKEDとなり、自動Upgradeしない。

管理者はBackendを停止し、既存の専用Storage Directory・単一EX Lock運用下で整合するDB / WALのBackupを確保する。旧Releaseへのsymlink切替だけではRollbackできないことを確認してから、ビルド済みの新Releaseで次を実行する。

```sh
SIGNAGE_V2_UPGRADE_ACK=backup-verified-incompatible-rollback-accepted \
SIGNAGE_DATA_DIR=/var/lib/home-digital-signage \
sh scripts/with-backend-lock.sh migrate-v2
```

この確認値は管理者による運用確認であり、自動Backup検証を実装したものではない。通常起動からは呼び出さない。既存FD9継承・EX・2秒Timeout・Lockファイル非削除を維持する。

Migrationはv1事前検証、BEGIN IMMEDIATE、追加DDLとVersion更新、v2検証を同一Transactionで実行する。失敗時はRollback後のVersion / Schemaを再照合する。Commit例外後にv2と確定できれば再適用せず、v1と確定すれば失敗を返す。照合不能・v0・未知Version・不正Schemaを推測で修復しない。管理外Restoreを自動化せず、Rollback / Restore時のQuota履歴完全性再確認・継続RecoveryはPR-Eおよび運用設計へ残す。

### 初回Provider Provisioning

`provisionProvider(provider, confirmation)`はF-01の明示的な管理操作用境界。信頼できる時刻、過去使用がQuota期間外であること、安全余裕、同じキーを使う他Senderの不在について、すべての管理者確認を要求する。Repository自身がこれらの外部事実を発見するものではない。既存Metadata・履歴があれば初期化を拒否し、通常起動・再起動・キー変更で履歴を消さない。

Commit例外でProvisioningを確定できなければunknownとし、当該Process / Connectionで後続予約を保留する。自動再初期化・複雑な専用Provisioning Service・管理UIは追加しない。実アカウントでの管理者確認・本番管理経路との接続は未実施。

## Tx-QとCommit不明時の安全性

Trust・試行・Connection確認後、`process.hrtime.bigint()`の直後に`Date.now()`を取得する。BEGIN IMMEDIATE内でMetadata・全履歴を再Readし、整合性と3窓を再評価する。予約可能時だけSequence採番・消費INSERT・Metadata更新をAtomicに行い、Commit成功確定後のみ証拠を返す。Timestamp取得・Transaction・Commit・照合にかかった時間を計測起点から除外しない。

Commit例外では実Transaction状態とRollback結果を確認し、保存前・一度だけ固定した予定内容・保存後をRead-only比較する。Row / Sequence一致だけでsavedとはせず、`total_changes`と`data_version`も確認して介在書込みを検出する。同一値への別書込みやABA、照合失敗はunknownを維持する。未解決Connectionでは別Transactionを開始せず、PR-B・C-2にも既存共有保護を適用する。

別Stateへの正当な書込みでも照合証拠が変化すればunknownが継続し得る。これは保守的な既知制約であり、安全な継続RecoveryはPR-Eへ残す。再起動を跨ぐ完全な操作帰属や管理外DB巻戻し検出を保証しない。

Quota不足・Trust不成立・Tx-Q失敗／unknownでControl Stateは変更しない。Commit済み履歴を取り消すAPIはなく、試行終了・未送信でも履歴を保持する。後続のHTTP失敗・Timeout・Abort・Gate拒否時も削除しない契約とする。HTTP・Send Gateは今回存在せず、Commit前送信禁止の保存基盤の検証までである。

## 受入条件対応

PASSは今回の単体機構・SQLite実DB・障害注入範囲を意味し、実HTTP / Provider / Piでの保証とは区別する。

| 条件                                          | 状態                   | 検証範囲・残る事項                                                                                                                                                                                             |
| --------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema / Migration                            | PASS                   | 新規v2、v1データ・旧DDL保持、v2再起動、v0・未知Version・不正DDL・未知Index・FK異常拒否、途中失敗Rollback、Commit前後例外・再照合不能、Metadata自動作成なし。Linux実Processで明示Upgrade・自動Upgrade拒否を検証 |
| QH-01 / QH-02                                 | PASS                   | Metadata欠損・SUSPENDED、不正数値、Sequence欠損・重複・last_sequence不一致を拒否                                                                                                                               |
| QH-03 / CLK-03                                | 部分検証               | 3つのTrust入力を独立判定。不成立時の非書込み。実OS同期・管理外Restore・外部Sender検出は未実装                                                                                                                  |
| QH-04                                         | PASS                   | GC・削除・取消APIなし。未送信／試行終了後も消費を保持                                                                                                                                                          |
| QH-05                                         | PASS                   | 3窓の前・境界・後、暫定2秒、最遅解除見込み、Timestamp異常拒否                                                                                                                                                  |
| TQ-01                                         | PASS                   | 単一共有Connection、BEGIN IMMEDIATE、Tx内再判定、採番・INSERT・Metadata更新、途中制約失敗Rollback、重複・再入抑止                                                                                              |
| TQ-02                                         | 部分検証               | 4結果とControl非更新、unknown時は予約証拠なし。実HTTP送信抑止との統合は後続                                                                                                                                    |
| TQ-03                                         | PASS                   | Commit前後例外、Read-only照合失敗・再照合、ABA、保存結果の一意帰属不能時unknown、未解決Connection共有保護                                                                                                      |
| TQ-04                                         | 部分検証               | 未送信でも履歴保持。最終Gate・Timeout・Abortとの実HTTP統合は未実施                                                                                                                                             |
| KEY-01〜KEY-03                                | 部分検証               | 初期安全性の全確認必須、既存履歴リセット禁止。実アカウント確認・キー変更管理統合・外部Sender把握は今回の保証外                                                                                                 |
| F-02                                          | 部分検証               | 単調時計→Timestampの取得順・Commit時間を含む計測起点維持。送信直前経過時間判定・暫定余裕の実機妥当性は後続                                                                                                     |
| Send Gate / Management Stop / HTTP / Recovery | 後続統合待ち（未実施） | C-Impl-4〜6、PR-D / PR-Eへ維持。C1-29の実Provider送信安全性をPASSとしない                                                                                                                                      |

## 品質確認・回帰

新規105件（Quota Guard / Schema / Repositoryの104件とLinux実ProcessのMigration1件）。Windows全体583件成功・Linux専用47件Skip（合計630件）。Lint / Format / Type Check / Backend Build成功。Linux CI結果はPRへ記録する。

既存PR-BのPublished State119件・Cache関連109件、C-Impl-1の65件、C-Impl-2の115件を維持する。既存テストの変更はSchema Version / Table数の期待値と未知Versionの検証値、Linux Migration検証の追加に限定する。Scheduler本体、Acquisition Controlの公開Interface、HTTP Routes、依存関係、Signal Handler、Shutdown全体10秒、Connection所有権、設計正本は変更しない。

## C-Impl-4以降への引継ぎ

- Clock Trust / History Trustの確認事実を生成する信頼されたApplication、OS同期監視、Provider Send Gate / Send Permitは未実装。予約証拠を送信許可に流用しない。
- Gateは予約の試行・Connection・Trust・停止状態を再確認し、取得済み計測起点からF-02を評価する。新しい起点をCommit後に取得し直さない。Gate拒否・遅延超過でもQuota履歴を取り消さずControlを変更しない。
- Coordinator / HTTP Lifecycle・Startup / Management Stopの本番統合、PR-DのTx-P / Pending、PR-Eの継続Recovery / Backupは未実装。
- 履歴は全件保持・検証し、GC・圧縮は追加しない。長期データ量の性能・Pi実機は未測定。
- PRは未Merge・レビュー待ち、Issue #16はOpen、PR-C全体は継続中とする。
