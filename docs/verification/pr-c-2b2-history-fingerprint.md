# PR-C-2B-2：quota-history-v1 Fingerprint計算・照合

## 基準と実装前調査

基準main：`52af7ec8b8531e7ebbd866857ac04879d278d5f7`（PR #59 Merge済み、PR #58・#60のUI設計を維持）。正本は[U-01 / D04-R05](../technology-stack.md#pr-c-c-impl-5b4-d04)、[R55-01正式DDL](../technology-stack.md#pr-c-c-impl-5b4-boundary-final-ddl)、[H54検証計画](c-impl-5b4-history-trust-restart-recovery.md)を参照する。

| 実装前の分類 | 既存内容                                                                                                                    | 今回                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 実装済み     | Schema v3・正式Boundary Snapshot列、Lifecycle読取、限定v3接続、Connection Coordination、quotaTimestamp()                    | 再利用。DDL・Migration・既存Quota / Gateの意味論は変更しない |
| 不足         | quota-history-v1のTLV・SHA-256、保存済みSnapshotからの再計算・一致判定                                                      | 新規追加                                                     |
| 後続         | Startup親子連続性・全Provider集合・全Consumption構造 / 完全性・Metadata整合、Startup Atomic Commit、Trust / Recovery / 送信 | 今回未実装のまま維持                                         |

UI作業とは別worktree・Backend Branchで作業し、共通設計正本・既存Store Facade・UI・依存・Workflowは変更しない。

## 計算と入力検証

`quota/history-fingerprint.ts`のhistoryFingerprint(history: QuotaHistory)は既存QuotaHistory型を受け、SHA-256の小文字64桁Hexを返す。Versionはquota-history-v1。Node標準Cryptoを使い、フィールドごとのTLVを順番にHashへ渡す。フォーマットにない区切り・空白・改行は追加しない。

内部encodeHistoryField()は1バイトTag・4バイトunsigned Big EndianのUTF-8バイト長・Valueを生成する。STRING / INTEGER / NULL / METADATA_ABSENT / COUNTの確定Tagを維持する。整数は非負安全整数から先頭ゼロ等のない10進ASCIIへ変換し、負数・小数・NaN・Infinity・安全範囲外・数値文字列・暗黙変換を拒否する。負のゼロや不正なUTF-16 surrogateも黙って補正しない。

PROVISIONEDではproviderKey / historyStatus / initializedAtMs / lastSequence（保存済みcutoff）・実件数を固定順に符号化する。全件数がlastSequenceと一致し、各sequenceが1からcutoffまで厳密に連続することを要求する。配列の並べ替え・重複除去・欠落補完はしない。

UNPROVISIONEDはmetadata=null・Consumption空配列だけを受け、Version・METADATA_ABSENT・COUNT 0を符号化する。複数NULLフィールドでMetadata不在を代用しない。PROVISIONED / 0とは固定バイト列もDigestも異なる。エラーは元入力・例外を含まないFingerprintInputErrorとする。

### 確認済みのTimestamp / Trust境界

実装時のユーザー確認により、Fingerprint段階では既存quotaTimestamp()による非負安全整数・Date範囲の構造検証を行い、時刻の非減少・現在時刻以下といった信頼性判断は後続Startup / History Trustへ分離する。壁時計や固定Trust値を与えて既存Guardを通す実装にはしない。

同じ履歴をFingerprintとして再現できても、既存QuotaGuardは時刻順序等を満たさなければ従来どおり拒否するテストを追加した。QuotaGuard / quotaTimestamp / 予約処理は無変更。整数の最大安全値のTLV符号化と、TimestampとしてDate範囲外の最大安全整数の拒否も区別する。

## 保存済みSnapshotからの照合

`storage/history-fingerprint-repository.ts`のHistoryFingerprintRepositoryは既存StoreのConnectionを借用する内部Repository。verifyLatestWithinTransaction(providerKey)だけを持ち、新しいConnection・Transaction所有者・公開Facadeを追加しない。

1. 呼出元がbusyとTransactionを所有していること、Connectionがopen・blocked / unresolvedでないことを要求する。
2. 既存LifecycleRepository.readWithinTransaction()でv3 Schema・正規Markerを確認する。親子連続性を検証済みとは扱わない。
3. 対象Providerのgeneration降順の先頭Rowを取得し、そのgenerationがLifecycleの現世代と一致することを要求する。最新が欠落・不正なら拒否し、古い有効Rowへフォールバックしない。
4. 保存済みprovider_state / cutoff_sequence / history_status_snapshot / initialized_at_ms_snapshot / history_fingerprintを検証する。PROVISIONEDのcutoffをlastSequenceとして再構成し、現在provider_quota_metadataを代用しない。
5. PROVISIONEDでは対象Providerのsequence <= cutoffをsequence ASCで読み、SQLite INTEGERをbigintで取得・安全整数範囲を確認してからnumber化する。Prefixの件数・Sequence・Timestamp構造を検証して再Hashする。
6. UNPROVISIONEDは過去のMetadata不在を再現する。後でProvisioningされて現在Metadata / Consumptionが存在していても、過去Snapshotへ混ぜない。
7. 保存済みDigestとの完全一致とTransactionがまだ進行中であることを確認した場合のみmatchedを返す。

結果はmatched / rejected / database_error。matchedには照合対象のProvider・Generation・cutoff・Digestを返すが、これはTrust・Startup成功・送信Permit・Commit証拠ではない。Migration Gen 1でBoundaryがない場合もmatchedとはせず、特別な初回Startup判断は後続へ残す。

SQLのORDER BYは確定仕様の読取順序であり、不正Sequenceを修復する処理ではない。取得済み行をApplication側でsort / deduplicateしない。形式不正Digest、Snapshot不正、Prefix欠損・不正、Digest不一致はrejectedまたはDB構造検証失敗となり、保存済みRow・Digestを更新しない。

## Transaction・Connection境界

このRepositoryはBEGIN / COMMIT / ROLLBACK / Closeを実行しない。呼出元Startupが同一Transactionに照合と後続処理を統合する。所有busyがなければ入力契約違反として拒否する。既存blocked / connectionUnresolvedではSQLへ進まず、所有者のbusyを解除しない。

SQLite例外は既存L1〜L4分類を再利用し、L3 / L4は共有blockedで保護する。Transaction状態が取得不能ならconnectionUnresolvedも設定する。Readerが呼出元のTransactionを勝手に解決・再実行しない。後続Startup所有者は非matchedを受けたらStartup証拠を採用せず、Rollback・Commit unknownの扱いをD-02に従って実施する。今回Commitを実行しないため、照合結果をCommit成功とみなす経路も追加しない。

既存BackendStore.openV3ForStartup()の限定Facadeは変更しない。後続PR-C-2B-3が同じStore Connectionを渡し、所有するStartup Transaction内で内部Repositoryを構成・呼び出す。今回の計算・照合の実装を、公開Startup API配線の完了とは扱わない。

## 固定ベクトルの独立検証

`tests/fixtures/generate-history-fingerprint-vectors.py`はTypeScript実装を参照しないPython標準ライブラリstruct / hashlibによる参照計算。固定JSONには入力・完全なTLVバイト列hex・期待Digestの8ケースを保存し、CIテストはこの固定値だけを読む。PythonはNodeアプリ・CIの新しい実行依存ではない。

```sh
python tests/fixtures/generate-history-fingerprint-vectors.py
```

テストでNode Cryptoによる固定hexのHash確認と、本番historyFingerprint()のDigestを別々に固定期待値へ照合する。正本のPROVISIONED / p / ACTIVE / 0件の提示バイト列は別の固定literalでも照合する。UNPROVISIONED、0件・1件・複数件、UTF-8、NFC / NFD、Length 300バイトを独立ベクトルに含める。

| 固定ケース                                   | 期待SHA-256                                                      |
| -------------------------------------------- | ---------------------------------------------------------------- |
| UNPROVISIONED                                | 0442c820ae3054bba6a92b7dc65d1c9e4f243969d782ea5a6a054bbbcb48482f |
| PROVISIONED / p / ACTIVE / 0件               | a8aa51134d2bfbc088400d60f2dc92fc6862d2f8079ab7e3f0bd35eda4ce4014 |
| PROVISIONED / p / ACTIVE / 2件（1:10, 2:20） | 101cf467d633b0028d9c06f13174f7f46ccd14b6a364351fd1f26adfed85b4cf |

## テスト・H54対応と未検証範囲

追加88件：計算56件、実SQLite Repository32件。既存Storage / Quota / Scheduler / Gate / HTTP / Migration / Lifecycle回帰を維持する。ローカルは973 PASS・Linux専用51 Skip（計1024件）、Lint / Format / Type Check / Backend Build / git diff --check成功。最新Linux CI結果はPR本文へ記録する。

| 条件                | 今回の範囲                                                                 | 後続                                                                         |
| ------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| U-01 / D04-R05      | 確定TLV・SHA-256、固定独立ベクトル、Snapshot再現・一致判定                 | 新Boundaryへの保存                                                           |
| D04-R01・H54-31関連 | 直前Snapshot・Prefixの再Hash。不正最新Rowや世代不一致を古いRowで救済しない | Lifecycle親子連続性・全Provider集合・全Consumption完全性・Metadata全体整合性 |
| H54-21              | 既存Connection / Coordination、所有Transaction内読取、SQL異常時の保護      | Startup全書込みと同一Transactionへの配線                                     |
| H54-01              | 照合結果とStartup Commit成功の区別                                         | Startup Commit・証拠採用・unknown処理                                        |
| H54-22              | 対象外を維持                                                               | 管理者TokenとFingerprint拘束                                                 |

cutoffより後のConsumptionは当該Digestへ含めない。その範囲に不正Timestamp等があっても、このFingerprintが一致するケースを明示検証し、全Consumptionの型・Sequence・完全性・窓別保守計上は必ず後続Startupで行う。より古いBoundary Snapshot / Digestの網羅的改変検出、外部Sender不存在・実HTTP回数の証明ではない。

Prefix読取は既存Repositoryと同様にall()を使い、Hashはフィールド単位で更新する。長期履歴でのメモリ・走査時間、Pi性能・実機耐久性は未検証。新しいIndex・GC・Cache・最適化機構を追加しない。

Startup Generation更新・親 / Boundary INSERT / UPDATE・Lifecycle更新・History Trust / Range / Recovery / CLEAN・Scheduler / Coordinator・Provider HTTP有効化は未実装。UI・共通設計正本・DDL・Migration・Quota契約・Send Gate・OS同期方式は変更しない。Issue #16はOpen、PRは未Merge・レビュー待ちとする。
