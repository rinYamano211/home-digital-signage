# PR-C計画3：C-Impl-5C Acquisition Coordinator

## 範囲と状態

[PR-C完成方針](../technology-stack.md#pr-c-completion-mvp)の計画3。既存`AcquisitionCoordinator.runOnce()`を実装し、Schedulerを`main.ts`へ配線した。Domain Provider（Tomorrow.io・Open-Meteo・Google Calendar）は各Domain Serviceの責務で未実装のため、本番のProvider登録は空であり、本番ではHTTP・DB書込みを行わない。Mock Providerで取得フロー全体を検証した。Pending・Tx-C・Commit結果不明の本格照合はPR-D、不正Rowの修復・継続RecoveryはPR-E、F-03管理停止の永続化はFuture。Schema・Migration・Config・依存は変更していない。

## 契約

- `StateProvider`（Domain側が実装）：`stateKey`、`periodMs`、`quota`（Tomorrow.ioのみtrue）、`http: HttpAdapterConfig`、`parse(HttpOutcome)`→`success(data, expiresAt)` / `failure`。HTTP Adapterは既存`createHttpAdapter()`で生成し、Fake HTTPの注入口は設けない。
- `RuntimeStoreAccess`：`publishedStates.save`と`acquisitionControl`（`context` / `read` / `saveConditionally`）を追加した（5B-R1契約の拡張、承認済み）。保存はCoordinatorだけが使う。
- `createRuntimeSend(startup, http?)`：Tomorrow.ioのHTTP設定を受け取った場合だけ既存`createHttpAdapter()`でGateへ付ける。FacadeにRuntimeHistoryの`reserve`（Tx-Q）を追加した。

## `runOnce()`

1. Providerなし：1時間後に再判定（HTTP・DBアクセスなし）。
2. Control Read：`found`は`nextAttemptAt`前なら待機。`empty`はPublished Stateも未保存なら新規として即時取得、保存済みなら既存`ConservativeControlWait`で5分待機後に取得。`pending`はState単位の`storage_unresolved`、`database_error`はL1・L2が`suspended / global / database_unavailable`、L3・L4が`blocked / global / integrity_error`。`invalid`は即時に`blocked / state / integrity_error`（承認済みの簡略化。正本の5分待機後保留を省略し、修復はPR-E）。
3. 取得：Quota対象はGate `beginAttempt` → RuntimeHistory `reserve`（Tx-Q）→ Gate `start`。いずれかの拒否はControl Stateを変えずに1分後に再判定。その他は既存HTTP Adapterを直接使う。HTTPはTransaction外で実行する。
4. 分類：`parse`の成功のうち共通Envelope検証を通るものだけを成功とする。失敗は既存`nextControlState()`の有界指数Backoff（429はRetry-After）。
5. Tx-A：保存直前に再Readし、そのEvidenceで更新、または初回保存Authorizationで初期化する。保存失敗・結果不明ではTx-Pへ進まない。
6. Tx-P（正常系）：成功はdata・取得履歴・`dataSource: externalApi`で保存する。失敗は既存Snapshotのdataと正常取得履歴を維持し`lastAttempt`を`failure`にする（Snapshotがなければ`data: null`）。Cache（Tx-C）は使わない。Tx-Pの結果不明は`storage_unresolved`とし、本格照合はPR-D。
7. `nextAttemptAt`に再判定する。

## `main.ts`

Runtime昇格とRuntime Send生成の後にSchedulerを開始する（Providerは空）。`onClose`は`scheduler.stop()`（実行中の判定の終了を待つ）→ 取得制御のShutdown開始 → `stopMonitoring()` → DB Closeの順。

## テスト

`tests/backend/coordinator.test.ts`（実SQLite、`globalThis.fetch`・時計のMock）：新規取得のTx-A→Tx-Pと周期前の非取得、500・Network失敗の指数Backoffと既存data維持・成功で回復、429 Retry-Afterと初回失敗の`data: null`、不正Provider dataの失敗扱い、Control Row欠損時の5分待機、不正Control RowのState単位保留（HTTP・修復なし）、DB L2 / L4の全体停止、Providerなしの無操作、Quota Providerの抑止（Gate閉）とTx-QのCommit後に1回だけHTTP、Scheduler併用時の同一State重複防止。`runtime-store.test.ts` R1-10を拡張後の公開キーに更新した。

周期判定・5分待機・Envelope検証を外すと各テストがFAILすることを確認した。Tx-Q未登録時の抑止は、外してもGateが`runtime_history_unverified`で拒否するため二重の防御である。

## レビュー修正：Published State読取異常の分類（PR #78）

HTTPの前に、対象StateのPublished Stateを1回だけ読み取り、結果を次のとおり分類する。読取異常を「データなし」として扱わない。

- `latest` / `previous`：既存Snapshotとして扱う。取得失敗時はそのdataと正常取得履歴を維持して保存する。
- `empty`：保存済みSnapshotなし。`kind: "new"`だけを新規判定に使い、Control Row欠損時の初回取得条件に従う。
- `isolated` / `validator_error`：`blocked / state / integrity_error`。HTTP・Tx-A・Tx-Pへ進まず、既存Snapshotを上書き・修復しない（修復はPR-E）。Control Row欠損時も同じで、5分待機の完了を正常性の証拠にしない（各判定の冒頭で毎回再Readする）。
- `database_error`：既存のL1〜L4分類（L1・L2は`suspended / global / database_unavailable`、L3・L4は`blocked / global / integrity_error`）。修正前はこの経路だけL4に固定していた。

追加テスト：Control Rowあり＋`isolated`（2世代とも不正）・＋`validator_error`でHTTP・Tx-A・Tx-Pなし・DB不変、Control Row欠損＋`isolated` / `validator_error`で5分経過後も同様、有効な`previous`は利用継続、Published Stateの`database_error` L1〜L4の分類維持。修正前の分類に戻すと追加4件がFAILすることを確認した。

## 残余事項

- 本番Providerは未登録（Domain Service側で定義する）。
- 取得失敗時は既存Published Stateを維持し、期限切れはAPIが変換する。Cacheからの供給はPR-D。
- **本番Provider登録前に必須**：Shutdownは`Scheduler停止待ち → 取得制御のShutdown開始 → 監視停止 → DB Close`の順で、実行中のHTTPを待つ。HTTP Adapter Timeout（10秒）とShutdown Timeout（10秒）が同じため、HTTP実行中のShutdownは停止期限を超えるおそれがある。Provider登録前に、Shutdown時のHTTP Abortと停止期限を検証する。今回はProvider登録が空のためShutdown設計を拡張しない（F-03・PR-D・PR-Eは対象外）。
- `recover()`の早期化は行っていない（再開まで最大約10分、計画2の記録どおり）。
