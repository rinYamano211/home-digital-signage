# PR-C計画2：5B-R2B・5B本番統合・本番Wait時計

## 範囲と状態

[PR-C完成方針](../technology-stack.md#pr-c-completion-mvp)の計画2。HistoryRecoveryを同じv3接続で1つだけ生成し（5B-R2B）、OS同期確認・Clock Trust・認証済みHistoryを本番Gateへ配線した（5B本番統合）。本番の`verifiedWaitReading()`を有効にした。HTTP Adapterは付けず、送信経路・Coordinator・SchedulerはC-Impl-5Cで扱う。Schema・Migration・Config・依存は変更していない。

## 変更

- `wait-clock.ts`：`process.hrtime.bigint()`とProcess固定の凍結継続性IDを返す。取得失敗・負値は`null`。逆行・不連続はHistoryRecoveryの既存規則で失効する。Process再起動でWaitは引き継がない。
- `store.ts`：`BackendStore.createHistoryRecovery(startup, gate, clock)`。`createRuntimeHistory()`済みで同じClock、`activateRuntime()`と共通の条件を要求し、1接続1インスタンス。別Gate・別Clock・Close後は`null`、生成失敗後は再生成しない。生成時にGateを閉じRuntimeHistoryをFreezeする（既存動作）。
- `send/provider-send-gate.ts`：`createRuntimeSend(startup)`。OsSyncReader → ClockTrustMonitor → RuntimeHistory → ProviderSendGate（Tomorrow.ioのみ、旧HistoryTrustMonitorはTRUSTEDにしない）→ HistoryRecovery → HistoryRecheck（C 5分、BとCで`recover()`）。`startMonitoring()` / `stopMonitoring()`と既存のGate操作を公開する。既存の`createProviderSendGate()`は変更しない。
- `main.ts`：Startup committed・Runtime昇格後に生成し`startMonitoring()`。`onClose`でDB Closeの前に`stopMonitoring()`（Recheck停止 → Recovery破棄 → Clock・Reader停止 → Gate破棄）。

## 動作

- 起動直後はGateが閉じている。OS同期の成功と既存の60秒安定観測でClockがTRUSTEDになり、`recover()`で開く候補になる。
- 過去の消費がない場合は最初のC（約5分）で開く。過去の消費がある再起動では、最初のCでDrain・Waitを開始し、HistoryRecheckが通知前に次回を計画する既存仕様のため、次のC（約10分）で開く。
- `timedatectl`が`no`・失敗の場合は開かない。
- HTTP Adapterがないため、Gateの`start`は`http_adapter_unavailable`で送信しない。

## テスト

- `tests/backend/runtime-send.test.ts`（実SQLite、Fake Timer・時計、`execFile`のMock）：R2Bの生成条件・単一生成・失敗後の非再生成・Close後の拒否、Commit前・偽装Facadeで`null`、新規履歴で約5分後に開く・Stop後にTimerが残らない、過去履歴ありの再起動で10分前は閉・10分で開く、OS同期`no`・失敗で開かない。
- `tests/backend/history-wait-clock.test.ts`：本番Wait時計の単調性・継続性ID、取得失敗・負値で`null`（旧「本番は常に`null`」テストを承認済み方針に合わせて置換）。
- `runtime-startup.test.ts`：実v3 Startupで監視が配線されること。

本番Wait時計を無効にすると再起動テスト、Recheck通知を外すと2件、Clock停止を外すとTimer残りのテスト、Clock一致確認を外すとR2BテストがFAILすることを確認した。

## 残余事項・C-Impl-5Cへの引継ぎ

- 再開までの時間（約5〜10分）はHistoryRecheckの既存仕様による。早期の`recover()`はC-Impl-5CのCoordinatorで扱う。
- HTTP Adapter・Coordinator・Schedulerの配線はC-Impl-5C。
- Pi実機での`timedatectl`・単調時計・NTP補正の確認は実機検証（Issue #13）。
