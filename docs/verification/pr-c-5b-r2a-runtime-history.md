# PR-C / 5B-R2A Runtime History生成境界

## 範囲と状態

5B-R1の`BackendStore`に、同じv3接続・同じ`QuotaRepository`で既存の`RuntimeHistory`と`HistoryRangeRepository`を生成・再利用する境界を追加した。HistoryRecovery・HistoryTrustMonitor・Gateへの登録・`main.ts`配線・Schema・Config・依存は対象外で、変更していない。`runtime-history.ts`・`history-range-repository.ts`も変更していない。設計正本は変更せず、本記録に契約を記載する。

## 契約

```ts
interface RuntimeHistoryAccess {
  readonly history: RuntimeHistory;
  readonly ranges: HistoryRangeRepository;
}
BackendStore.createRuntimeHistory(
  startup: StartupStoreAccess,
  clock: ClockTrustMonitor,
): RuntimeHistoryAccess | null;
```

- 生成条件は`activateRuntime()`と共通の判定（Close未開始、DB Open、busy・Blocked・Unresolvedでない、Transactionなし、`committedStartup(db)`が有効）に、`clock instanceof ClockTrustMonitor`を加えたもの。Clock `TRUSTED`は条件にしない。不成立なら`null`。
- 正規のStartup Facadeだけを内部WeakMapで所有者に結び付ける。構造コピー・偽装は`null`。
- 初回は`new RuntimeHistory(db, quota, clock)`と`new HistoryRangeRepository(db, history)`を生成する。`quota`は5B-R1と同じインスタンス。束ねるオブジェクトだけを凍結し、コンポーネント内部は凍結しない。
- 同じFacade・同じClockの再呼出しは条件を再確認し、同じオブジェクトを返す。別のClock・Close後は`null`。
- 生成が例外で失敗した場合（例：接続を別のRuntimeHistoryが所有済み）は失敗を記録し、以後は再生成せず`null`を返す。不完全な束は返さない。RuntimeHistoryの接続単位の単一所有制約は変更しない。
- 生の接続は公開しない。`activateRuntime()`・`StartupStoreAccess`の契約は変更しない。

## 権限境界の確認

公開されるメソッドは既存の認証境界の内側にある。`reserve()`は5B-R1で公開済みの`quota.reserve()`にClock `TRUSTED`・Epoch・Freezeの確認を加えるだけで、`register()`は自身のTrialとClock `TRUSTED`での2回確認が必要。`acceptProvisioning`・`discardAffected`・`resumeAfterRecovery`・Rangeの`insert`はHistoryRecovery発行の認証済みEvidenceが必要で、HistoryRecoveryは生成しない。`freeze()`は送信をさらに閉じる方向にだけ働く。本番Gate FactoryはClock未信頼で、HTTP Adapterもない。生成はClock / History Trust・Quota判定・送信許可を意味しない。

`quota.reserve()`が呼出し側のQuotaTrust値を受け取る点は、C-Impl-3以来の既存契約で、本PRで広がらない。

## テスト

`tests/backend/runtime-store.test.ts`（5B-R1のFixtureを再利用、実SQLite）。

| ID     | 確認内容                                                                               |
| ------ | -------------------------------------------------------------------------------------- |
| R2A-01 | Startup前・Rejected・Unknownで不可、構造コピー不可。前提不成立は単一所有枠を消費しない |
| R2A-02 | 同一接続・同一QuotaRepository（`runtimeHistoryMatches`）、Rangeが同じHistoryで読める   |
| R2A-03 | 同じClockの再呼出しで同一の凍結オブジェクト、内部は非凍結                              |
| R2A-04 | 別・偽装Clockは不可、単一所有は維持。生成失敗後は再生成せず`null`                      |
| R2A-05 | busy・Blocked・Unresolved・Transaction中・Close後は不可（解消後は同一物を再取得）      |
| R2A-06 | 生成後もTrust未確立、Tx-Q・Range INSERT・Gate開始は拒否、Consumptionは増えない         |

Clockの一致確認を外すとR2A-04、共通判定を外すとR2A-01・R2A-05がFAILすることを確認した。生成失敗の記録は、外しても既存の単一所有制約で同じく拒否されるため、二重の防御である。

Provisioning前にStartupした接続では、Runtimeのcutoffが`null`のままでRangeの読取りは`runtime_provisioning_unconfirmed`で拒否される（F-01のEvidenceはHistoryRecoveryが発行するため、既存仕様どおり）。

## 5B-R2Bへの引き継ぎ

- HistoryRecoveryは生の接続とGateをconstructorで要求するため、`store.ts`の内側で生成する経路が必要。
- HistoryRecoveryは生成時にGateを閉じRuntimeHistoryをFreezeする。生成順序と送信停止の扱いを決める必要がある。
- Provisioning前にStartupした場合のF-01（Runtime cutoff 0）はHistoryRecovery経由で確定する。
