# PR-C / 5B-R1 Runtime DBアクセス境界

## 範囲と状態

`BackendStore.openV3ForStartup()`で開いたv3接続を、Startup Commitの確認後に限り、同じ接続のままRuntime DBアクセスへ移行する境界を追加した。`startBackend()`・`main.ts`への配線、Clock / History Trust、Gate送信許可、HTTP・Coordinatorは対象外。Schema・Migration・Config・依存は変更していない。設計正本は変更せず、本記録に契約を記載する（ユーザー承認済みの案A）。

## 契約

```ts
interface RuntimeStoreAccess {
  readonly runtimeActive: true;
  readonly quota: QuotaRepository;
}
BackendStore.activateRuntime(startup: StartupStoreAccess): RuntimeStoreAccess | null;
```

- `openV3ForStartup()`が返したFacadeだけが、内部のWeakMapで接続所有者に結び付く。構造コピー・偽装オブジェクトは`null`。
- 昇格条件：Close未開始、DB Open、`busy`・Blocked・Unresolvedでない、`db.inTransaction === false`、`committedStartup(db)`が有効。いずれか不成立なら`null`（Fail Closed）。
- `committedStartup()`はStartupの確定Commit後だけに記録される接続固有の証跡で、Lifecycle Marker・Boundaryの一致も確認する。未実行・Rejected・Unknown（行がCommitされていても）では証跡がなく、Lifecycle行の`RUNNING`だけでは昇格しない。
- 公開するのはStartupで生成済みの同一`QuotaRepository`だけ。生Connection・任意SQL・Startup Transaction・Lifecycle更新・Close・Trust・Gate・HTTPは公開しない。
- 2回目以降の呼出しは条件を再確認し、同じ凍結オブジェクトを返す。接続・Repositoryを新たに生成しない。
- Closeの所有者はStartup Facadeの`close()`のまま（`main.ts`の`onClose`）。Close開始後は昇格せず、昇格済みの`quota`も接続Closeにより各操作がFail Closedになる。
- `StartupStoreAccess`の形（`close` / `lifecycle` / `startup` / `startupComplete: false`）は変更しない。Startupの再実行は既存の1回限りガードで拒否される。

## v3 QuotaRepositoryの整合性

`BackendStore`は`new QuotaRepository(db)`（既定Schema Version 2）を生成していたため、v3接続ではQuotaの各操作が`validateSchema(db, 2)`で失敗していた（Fail Closedだが利用不可）。`openV3ForStartup()`では`new QuotaRepository(db, 3)`を生成するよう修正した。v2の`BackendStore.open()`は従来どおりVersion 2。

QuotaRepositoryの実行中Attemptはインスタンス単位で管理されるため、同一接続に2つ目のRepositoryを作らない。PublishedState・Cache・AcquisitionControlの各RepositoryはVersion 2の検証のままで、Runtimeへ公開しない（範囲外）。

## テスト

`tests/backend/runtime-store.test.ts`（実SQLite・一時ファイル。Boot IDとDBファイル検証はMock）。

| ID       | 確認内容                                                                          |
| -------- | --------------------------------------------------------------------------------- |
| R1-01/02 | Startup前・RUNNING行だけでは不可、Commit後のみ可、構造コピー・偽装Facadeは不可    |
| R1-03    | Rejected後は不可、同一接続での再実行も拒否                                        |
| R1-04    | COMMIT結果Unknownは、行がCommit済みでも不可                                       |
| R1-05    | Blocked・Unresolvedで不可                                                         |
| R1-06    | 実行中Transaction・`busy`で不可、解消後に可                                       |
| R1-07/08 | 同一接続、二重昇格で同一オブジェクト・同一Repository（Attempt枠が1つ）            |
| R1-09    | Close後は昇格不可、昇格済みQuotaもFail Closed、二重Closeは安全                    |
| R1-10    | Runtimeは`quota`と`runtimeActive`だけ・凍結、Startup Facadeの形と再実行拒否は不変 |
| R1-11    | v3でinspect・Provisioning・Tx-Q拒否が動作（Version 2に戻すとFAILすることを確認）  |
| R1-12    | 昇格後も本番Gate Factoryは予約・送信を許可しない（Trustはfalse）                  |

Commit証跡の確認を外すとR1-01・R1-03・R1-04がFAILすることも確認した。

## 残余リスク・後続（5B-R2）

- RuntimeHistory・HistoryRangeRepository・HistoryRecoveryは生Connectionをconstructorで要求する。生Connectionを公開しないため、R2ではStorage内部でこれらを組み立てる経路の設計が必要。
- `startBackend()`はまだ`activateRuntime()`を呼ばない。Shutdown開始後に昇格しない制御はR2の配線側で担う（Store単体ではClose開始後のみ拒否）。
- v3接続上のPublishedState・Cache・AcquisitionControlのVersion整合は未対応。
