# PR-C-2B-1：限定v3 Connection・Lifecycle読取基盤

## 基準と調査結果

基準main：`fee4be1`（PR #57のv3基盤、PR #58のUI設計反映済み）。[D-01](../technology-stack.md#pr-c-c-impl-5b4-d01)・[D-02](../technology-stack.md#pr-c-c-impl-5b4-d02)・[H54検証計画](c-impl-5b4-history-trust-restart-recovery.md)・[PR-C-2A検証記録](pr-c-2a-schema-v3.md)を参照する。UI作業とは別worktree・Backend専用Branchで実装し、共通設計正本・Frontend・UI設計は変更しない。

| 分類     | 作業前の状態                                                                                       | 今回                                                       |
| -------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 実装済み | v3 DDL・厳密Schema / Marker検証、WAL / FULL / FK設定、Linux Boot ID、明示Migration                 | 再利用。DDL・Migrationは変更しない                         |
| 部分実装 | BackendStoreはConnectionを所有するが通常経路はv2のみ。v3 ValidatorはMarkerを検証するが値を返さない | v2経路を維持し、限定v3経路と既存Marker検証結果の返却を追加 |
| 未実装   | Lifecycle Repository、Startup前に限定公開するv3接続                                                | 今回追加                                                   |
| 後続     | 通常Startup Transaction・Generation +1・親子境界、History / Recovery、CLEAN、送信本番統合          | 今回未実装のまま維持                                       |

## Connection所有権と限定公開

`BackendStore.openV3ForStartup(lock): StartupStoreAccess`は専用EX保持・安全な既存DBファイル・fileMustExistを要求する。旧Version / 未知Versionを設定前に拒否し、既存configureDatabase(db, 3)・validateSchema(db, 3)を使ってWAL / FULL / FK、quick_check / foreign_key_check、厳密Schema、必須Markerを検証する。Migration・Provisioning・新規Table生成は呼び出さない。

初期の共有busy / blocked / connectionUnresolved・既存Transactionを確認し、検証中は同じCoordinationのbusyを所有する。失敗したら取得したConnectionをCloseして例外を返し、SQLite例外の分類材料は維持する。他の所有者のbusyを勝手に解除しない。

ConnectionのOpen / Close所有者はBackendStoreで、Repositoryは借用だけとする。限定v3経路でも1 Connectionだけを作る。公開する凍結Facadeは以下だけを持つ。

- `startupComplete: false`
- `lifecycle.read()`
- `close()`（同じBackendStore所有Connectionを冪等にClose）

raw DB・通常Repository・Quota予約・HTTP開始・Trust更新・独立Lifecycle更新は公開しない。内部で所有する通常Repositoryオブジェクトが存在してもFacadeから参照させず、その生成自体はDB書込み・取得開始・送信を行わない。Facade経由のMarker読取でstartupCompleteがtrueになる経路はない。

既存BackendStore.open / startBackend / Shutdown・v2 NORMAL設定は変更しない。通常Backendはv3 DBで従来どおりBLOCKEDとなる。本PRは限定v3接続の明示APIを追加するだけで、通常Runtimeへは配線しない。

## Lifecycle読取とTransaction

`LifecycleRepository.read()`はfound（marker）またはdatabase_error（既存L1〜L4・reason）を返す。空・不正を正常なデフォルト値に変換しない。既存validateLifecycleMarker()の検証を再利用し、正規のRUNNING / CLEAN・canonical非ゼロUUID・安全整数Generationを凍結されたLifecycleMarkerとして返す。既存Validatorは同じ拒否条件を維持し、今回検証した値を返すように拡張した。

readは共有busyを取得してBEGIN → Schema / Marker検証 → COMMIT → Transaction終了確認を行う。書込みはしない。COMMIT例外では、Rollbackを必要に応じて試みてTransaction状態を再確認し、終了済みでもMarkerを返さずエラーとする。結果不明を成功に推測せず、自動Retryもしない。未解決時はconnectionUnresolvedと共有blockedを設定して後続操作を止める。

不正Schema / MarkerはL3、未知例外は機密情報を除いたL4として共有保護する。一時SQL異常L1やClose済みConnectionのL2と区別する。既に開始済みの所有不明Transactionを見つけた場合は、それを借用・RollbackせずFail Closedにする。

`readWithinTransaction()`は後続Startup所有者向けの内部読取境界であり、開いたConnection・所有busy・進行中Transaction・停止なしを要求する。自身はBEGIN / COMMIT / UPDATEを行わない。このメソッドをFacadeへ公開せず、今回Startupの書込みAPIは追加しない。後続ではStartup親・全Provider境界・Lifecycle更新を単一Transactionへまとめ、その中で前回Markerを再Readする。今回read()で得たMarkerを将来のStartup更新用Evidenceとして流用しない。

## 検証と受入条件

追加テストはLifecycle Repository / 接続単体39件、Linux実Process2件。単体は実SQLiteを使用するが、Windows上ではEX / OS PermissionのPath検証だけをTest Doubleへ分離する。Linux試験では実際の専用Directory・FD9 / EX・管理Migrationを経たDBで限定APIを検証する。v3テストデータのCLEAN / Generationは型・構造のfixtureであり、CLEAN ShutdownやStartupの実行証拠ではない。

| H54関連         | 今回確認する範囲                                                                                                        | 未完了条件                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| H54-19 / 20関連 | v3構造・正規Marker読取、旧Version・未知Version・不正Schema / Marker・FK不整合拒否、暗黙作成・Migrationなし              | Migration本体は既存PR-C-2Aの回帰、通常Startup全体は後続 |
| H54-21          | v3 ConnectionのWAL / FULL / FK、共有busy / blocked / connectionUnresolved、所有権・Close、Read COMMIT例外・Rollback不能 | 通常Startup Transactionの書込み                         |
| H54-32関連境界  | Startup未完了false、FacadeにQuota / HTTP / Trust / 書込み能力なし、Read成功で送信許可へ変換しない                       | Clock / History / Quota / Lifecycleを統合した実送信判定 |
| H54-01 / 29〜31 | 本PRで証拠を発行・CLEAN更新しないことを明記                                                                             | Startup Commit、CLEAN、Recovery本体                     |

正常RUNNING / CLEAN・最大安全整数、Nil / 形式不正 / 大文字未正規化Boot ID、Generation負数・不正型・範囲外、Marker欠損・複数行を確認する。BEGIN / COMMIT前後例外・未知SQLite例外・Rollback不能ではMarkerを返さず、共有保護・他Repositoryへの非干渉を確認する。

限定v3 Storeの公開フィールド・凍結、EX拒否、v1 / v2 / 未知Version拒否・Close、欠損DBの非作成、Schema / Marker / FK不整合時のClose、FULL設定失敗の例外分類を検証する。Linuxでは正常接続・閉鎖後EX解放・Generation不変・Startup / Quota Row非作成、FD9 / EXなし拒否を確認する。

最新の品質結果・件数・Linux CIリンクはPR本文へ記録する。既存PR-C-2A・Storage / Migration / Quota / Scheduler / Send Gate / HTTP / Shutdown回帰を維持する。H54全体をPASSとはしない。

## 残余リスクとPR-C-2B-2への引継ぎ

- Schema / Marker構造の検証は、前回Bootと現在OS Bootの一致、親履歴連続性、全Provider集合・Consumption完全性の証明ではない。現在Boot ID取得・Startup Generation確定は後続。
- readWithinTransaction()を利用するStartup所有者が、親・全Provider Boundary・Lifecycle更新をAtomicに確定し、失敗・unknownで今回証拠を採用しないこと。独立したLifecycle更新Transactionは追加しない。
- 専用FD9 / EXをConnection寿命中保持し、単一Writer・安全な専用Directoryの既存運用前提を維持する。同一Process内の任意コードや管理者による直接DBアクセスを防ぐセキュリティ境界ではない。
- v3 Schema検証にはquick_check等を含むため、長期履歴でのコスト・Pi実機性能は未検証。これを理由に検証を省略しない。
- History Fingerprint / Range / Trust / Recovery / CLEAN、Scheduler / Coordinator、本番HTTP送信は未実装。read成功・RUNNING / CLEANの値を送信許可にしない。
- UI・共通正本・DDL・Migration・依存・Workflowは変更しない。実運用DB・Deploy・Pi実機へ操作しない。

Issue #16はOpen、PRは未Merge・通常Chatでのレビュー待ち。今回の完了は接続・読取基盤に限る。

## R59-01：読取Transactionの終了とConnection再利用

D-02のStartup Transactionは書込みと証拠発行を伴い、Commit unknownでは今回Startup証拠を採用しない。本Repository.read()は書込み・証拠発行を行わず、BEGIN / COMMITの例外ではMarkerを返さない。この読取失敗後の新しいreadを、Startup書込みの再実行・成功扱い・送信許可と混同しない。readWithinTransaction()は引き続きTransactionの開始・終了を所有せず、後続Startup所有者がD-02の規則を適用する。

既存v2 Control / Cache Repositoryと同じく、inTransactionを確認し、必要ならRollback後に実際の終了状態を再確認する。一方、inTransaction=falseだけではConnectionの健全性を証明しない。今回、ROLLBACK例外も既存classifyDatabaseErrorの対象として保持し、元例外またはcleanup例外がL3 / L4なら、終了済みでも共有blockedとして再利用を拒否する。既存v2 Repository・Migration本体の振る舞いは変更しない。

| 状況                                                                                                                                     | 現在のread結果                                | 同じConnectionでの後続read                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------- |
| BEGIN拒否・COMMIT前例外でTransaction終了を確認。必要なRollbackも実状態で終了確認でき、元例外とcleanup例外が既存DEGRADED（L1 / L2）の範囲 | database_error。Markerなし                    | 自動Retryはしない。後述の全条件を満たす新しいreadのみ評価可能   |
| COMMIT成功後の例外でinTransaction=falseを確認、元例外が一時SQL異常                                                                       | database_error。取得済みMarkerは不採用        | 新しいreadで最初から検証。古いMarkerや成功結果を再利用しない    |
| ROLLBACKが例外を投げたが終了を確認できた                                                                                                 | database_error。Markerなし                    | 例外も分類。L1 / L2だけなら再検証候補、L3 / L4ならblockedで禁止 |
| 元例外またはcleanup例外がL3 / L4                                                                                                         | database_error。共有blocked                   | Transaction終了済みでも禁止。connectionUnresolvedとは別の理由   |
| ROLLBACK未終了、Transaction状態が取得不能、所有不明の既存Transaction                                                                     | database_error。connectionUnresolvedとblocked | getterが後で回復しても自動解除しない。新Transaction禁止         |

再利用候補となるのは、読取Transactionの終了を確認でき、観測した例外が既存分類上の非致命的な範囲であり、共有Coordinationに停止理由がない場合だけである。次回readはConnectionがopenであること・busy所有者なし・blockedなし・connectionUnresolvedなしを確認して、新しい読取Transaction内でWAL / FULL / FK・Schema / SQLite整合性・Markerを再検証する。条件不足・確認不能ならMarkerを返さない。これはStorageやOSが将来も健全であるという一般保証ではなく、既存契約に従った新しい読取の評価条件である。

busyは現在の同期操作の所有権であり、finallyで自分の所有分だけを解放する。busy=falseを「正常復旧」の印にしない。connectionUnresolvedはTransaction終了を確定できないこと、blockedは既知の致命的異常・健全性不明による停止を表す。終了済み・blocked・connectionUnresolved=falseは成立する。いずれも今回自動解除するAPIは追加しない。

既存BEGIN / COMMIT前後・Rollback不能テストに、同一Connectionでの次回読取、fresh Marker再検証、共有保護の確認を追加した。追加13件では、Rollback終了後通知例外のL1 / L3 / L4、Commit前後の致命的例外、Transaction状態取得不能3位置、BEGIN実行後例外、後続read時のFULL / FK再検証を確認する。致命的・未解決時は別Lifecycle RepositoryとPR-Bの後続操作もDBへ進まないことを確認した。状態取得失敗はnative getterを改変せず、テスト専用Proxyで実SQLiteの操作を維持して注入する。

最新の全体品質・Linux CI結果はPR #59本文へ記録する。UI・共通正本・v2 Repository・Migration・Startup Generation・送信統合は変更しない。
