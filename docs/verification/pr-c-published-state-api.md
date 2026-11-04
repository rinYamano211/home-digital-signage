# PR-C計画1：v3 Repository整合とPublished State API

## 範囲と状態

[PR-C完成方針](../technology-stack.md#pr-c-completion-mvp)（PR #75）の計画1。v3接続でPublishedState・Cache・AcquisitionControl Repositoryを利用可能にし、`GET /api/published-states`（technology-stack 10.2〜10.9）を実装した。Coordinator・Provider取得・保存経路（C-Impl-5C）、Pending（PR-D）、継続Recovery（PR-E）、Domain固有Schemaは対象外。Schema・Migration・Config・依存は変更していない。

## 変更

- 3 RepositoryのconstructorにSchema Version（既定2）を追加し、`validateSchema`へ渡す。`openV3ForStartup()`はVersion 3で生成する。v2の`BackendStore.open()`は従来どおり。
- `RuntimeStoreAccess`に読取専用の`publishedStates: { read }`を追加した（5B-R1契約の拡張、ユーザー承認済み）。保存は公開しない。
- `src/backend/published-state-api.ts`：共通Envelopeの検証とResponse生成。
  - Validatorは`{data, meta}`、Metadata 6項目の型・UTC RFC 3339、10.6の整合条件を検証する。`data`はObjectまたは`null`のみ確認し、Domain固有SchemaはWeather / Schedule Serviceの責務とする。
  - `latest` / `previous`はStateを返す。`empty` / `isolated` / `validator_error`はState Keyを省略し、他のStateを妨げない。`database_error`は全体を503とする。
  - `now >= expiresAt`では`data`・`dataSource`を`null`にし、他のMetadataを維持する（10.8）。Scheduleは`data.date`がAsia/Tokyo（UTC+9、夏時間なし）の今日と異なれば同様に変換する。新しいSnapshotは生成しない。
- `app.ts`：RouteはDB状態に関係なく登録し、既定は503。
- `main.ts`：Startup committed（HEALTHY）の後だけ`activateRuntime()`を呼び、Routeへ渡す。未昇格・Close後は503。Trust・Quota・送信権限は付与しない。

## テスト

- `tests/backend/published-state-api.test.ts`（実SQLite、v3 Startup Commit後）：3 RepositoryのVersion 3検証とv2既定のFail Closed、未公開Stateの省略、未取得State、期限切れ変換、ScheduleのAsia/Tokyo日付変換、不正State 6種の省略、Runtimeなし・Blocked・Close後・既定Routeの503。
- `runtime-startup.test.ts`：実v3 Startupで200・空`states`、非Store Facade（全Startup結果）で503。
- `runtime-store.test.ts` R1-10：Runtimeの公開キーを`publishedStates`（`read`のみ・凍結）を含む形に更新した。

StoreのVersion指定を外すと10件、期限切れ変換を外すと1件、Tokyo日付をUTC日付にすると1件、整合条件を外すと1件がFAILすることを確認した。

## 残余事項

- Domain固有Schemaの検証は未実装（Domain Service側）。共通構造が正しければ`data`の内容は検証せず返す。
- 本番の保存経路はC-Impl-5Cで実装する。それまでAPIは保存済みSnapshotだけを返す。
- Frontend向けのMockデータ供給は追加していない（テストは実SQLiteへの保存で確認）。
