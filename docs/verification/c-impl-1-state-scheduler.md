# C-Impl-1 State Scheduler：検証範囲・後続引継ぎ

設計正本は[technology-stack.md §23.9](../technology-stack.md#pr-c-c1-scheduler)、[architecture.md §16.8](../architecture.md#168-sqlite初期化とbackend-lifecycle)、Issue #16。本書は実装の検証対応表であり、設計契約・受入条件を変更しない。PR-C全体・Issue #16の完了を意味しない。

## 実装範囲

- `StateScheduler`：`start(): void`、`requestRecheck(StateKey): void`、`stop(): Promise<void>`。
- `AcquisitionCoordinator.runOnce(StateKey): Promise<RunOnceResult>`は依存先Interfaceのみ。scheduled / suspended / blockedと既存scope・reasonを維持する。
- 既存5 Stateごとの単一Timer・単一inFlight、再判定要求集約、Callback世代無効化、最大2^31−1msでの長時間Timer分割とCoordinatorによる再評価。
- 停止・保留はstart / requestRecheckでは解除しない。安全確認後の再開は後続Recoveryへ残す。
- 既存Cacheの`utcInstant()`を共通Time Moduleへそのまま移動し、Cache側のexportを維持した。UTC明示・実在日付・未来時刻を検証し、独自の時刻補正や無条件Retryはしない。従来のJS Date表現・精度と閏秒非対応を維持する。
- Provider・DB・Backoff・Quota・Tx-A/P/C・Pending・Domain処理は持たない。ログは固定event・State・scope・reasonのみで、例外本文・外部入力は出力しない。

## C1-01〜C1-29対応表

PASSは記載した検証範囲のみ。後続統合待ちの行は単体部分が成功しても全条件PASSとはしない。Fake Timer・Mock Coordinatorを使い、DB CloseはLifecycle試験のMockである。

| ID    | 状態                             | 今回の証拠・後続範囲                                                                                                                            |
| ----- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| C1-01 | 後続統合待ち                     | startは5 Stateを通常runOnceへ委譲。保存済みControl・nextAttemptAt・復元判断は未実装Coordinatorとの統合で検証                                    |
| C1-02 | PASS                             | 5 State独立Timer、他StateのTimer継続                                                                                                            |
| C1-03 | PASS                             | 二重start・再予約・取消しで各State最大1 Timer                                                                                                   |
| C1-04 | 後続統合待ち                     | 発火時の実時計をMock Coordinatorが観測。実保存状態の再評価は後続                                                                                |
| C1-05 | PASS                             | 60秒の未完了Task中もState単位で重複なし                                                                                                         |
| C1-06 | PASS                             | 20回のinFlight再判定要求を1回へ集約、同期的再入も保護                                                                                           |
| C1-07 | PASS                             | Task終了後に予約／保留、Reject後もstopが完了しinFlightが残らない                                                                                |
| C1-08 | 後続統合待ち                     | scheduledの待機時刻をHTTP結果と解釈せず予約。実Backoff・Quota・周期計算は後続                                                                   |
| C1-09 | PASS                             | state / storage_unresolvedは局所保留、requestRecheckで解除不可                                                                                  |
| C1-10 | PASS（Scheduler単体）            | DB利用不能・Schema非互換のGlobal結果で全Timer取消し。実DB障害からの結果生成・Recoveryは後続                                                     |
| C1-11 | 後続統合待ち                     | stop後の新規Task・Timer再予約禁止を検証。実HTTP送信禁止はSend Gate未実装のため未検証                                                            |
| C1-12 | 後続統合待ち                     | stopが全inFlightの終了を待つ。既存RowのTx-A保存条件は後続                                                                                       |
| C1-13 | PASS                             | stopのPromise同一性、二重stop・stop後start・再判定が無害                                                                                        |
| C1-14 | 後続統合待ち                     | Fastify試験でTask終了後のみMock DB Close。実BackendStore所有権と本番起動経路への接続は後続                                                      |
| C1-15 | PASS（既存ShutdownとのMock結合） | Task未終了時はinstallShutdownの全体10秒でexit code 1、追加待機枠なし。OS・同期SQLite・実機は従来どおり別検証                                    |
| C1-16 | 後続統合待ち                     | Scheduler独自Task Timeoutなし、長時間Task重複なし。実HTTP Timeoutとの結合は後続                                                                 |
| C1-17 | 後続統合待ち                     | 試験で既存installShutdown・Fastifyを利用しSignal Listener各1個。本番へのScheduler登録は後続                                                     |
| C1-18 | PASS（Scheduler単体）            | suspended / blockedの通常Timerなし、start・再判定では解除しない。Recovery再開は後続                                                             |
| C1-19 | PASS                             | 過去・現在・Promise解決遅延による過去化を拒否、集約要求があっても救済しない                                                                     |
| C1-20 | PASS                             | 実在日付・UTC形式・時刻範囲を厳密検証、固定reasonログ、不正値の非出力                                                                           |
| C1-21 | PASS                             | 不正recheckAt等のState異常を局所化し他Stateを継続                                                                                               |
| C1-22 | PASS（Scheduler単体）            | Global保留後の通常再実行・遅延結果からの再予約なし。実DBとの統合は後続                                                                          |
| C1-23 | 後続統合待ち                     | 時計進行だけでは前倒しせず発火時に実時計で委譲。実取得制約の維持は後続                                                                          |
| C1-24 | 後続統合待ち                     | 時計巻戻り後も実時計でCoordinatorへ委譲。保存済みBackoff・Quota・nextAttemptAtの維持は後続                                                      |
| C1-25 | PASS                             | 同期throw・Promise Rejectを捕捉しstopの終了待機も完了                                                                                           |
| C1-26 | PASS                             | 予期しない例外・不正な結果契約をGlobal保留、即時Retryなし                                                                                       |
| C1-27 | PASS                             | 取消し・再予約・stop後の古いCallback、同じCallbackの重複呼出しを無効化                                                                          |
| C1-28 | PASS                             | Node Timer上限で分割し、中間境界でCoordinatorを再実行して時刻・条件の再評価を委譲                                                               |
| C1-29 | 後続統合待ち（未実施）           | Schedulerは全Timerを止め遅延結果を無効化するが、実行中Coordinatorの実Provider送信を阻止するPermit / Send Gateは未実装。送信安全性PASSとはしない |

## Lifecycle試験からの引継ぎ

本番mainへMock Coordinatorや仮Schedulerを注入していない。`main.ts`・`installShutdown()`・Fastifyの本番Hook・BackendStore Close所有権・全体10秒は変更していない。

Lifecycle試験ではpreCloseでstopを呼んで同期的に新規Taskを禁止し、DBを閉じる同じonClose処理でstopをawaitした後にMock DB Closeを行う。FastifyのpreClose自体の待機はHook timeoutで打ち切られ得るため、preClose待機だけをDB Close順序の保証にしない。実Storeとの接続時にもTask終了前に通常Closeへ進まないことを確認する。既存Shutdownの10秒を超えた際の強制終了はそのまま維持する。

## PR #42レビュー：Timer予約とinFlight解除の境界

指摘された「runOnce完了後に予約したTimerが、まだ残るinFlightを見て破棄され、次回判定が消える」競合は、現行実装と通常のNode.js Timerでは再現せず、実装修正は不要と判断した。Schedulerの本体・C-1契約は変更していない。

`await coordinator.runOnce()`から再開した後は、結果検証 → recheckの読取り → arm()による取消し・予約 → finallyのinFlight解除まで、awaitや別の非同期中断点がない。setTimeoutはCallbackを同期的に呼ばず、現在のJavaScript処理を中断しない。0ms Timerでも、予約処理とfinallyの間へ割り込むことはない。外側のPromiseがまだsettleしていなくても、Timer発火までにはslot.inFlight自体は解除済みとなる。

requestRecheckが完了継続より前に実行された場合はinFlight中のフラグへ集約され、scheduledの検証後に0ms再判定として予約される。完了継続の後に実行された場合はinFlight解除済みなので、既存Timerを取消し・再予約する。通常のMicrotask・Timer・nextTickはこの同期区間の途中へ割り込まない。stopも前なら結果からの予約を禁止し、後なら予約済みTimerを取消す。Callbackの世代検証は取消し前の古いCallbackを無効化する。

この判断は現行の中断点とNodeの非同期Timerに基づく。今後、armからfinallyまでにawait等を追加する場合は前提が変わるため再検証が必要。テスト用setTimeoutがCallbackを登録中に同期実行するような置換は、Node標準Timerの再現とは扱わない。

参照：[Node.js v24.14.0 Timers](https://nodejs.org/download/release/v24.14.0/docs/api/timers.html#settimeoutcallback-delay-args)、[Node.js Event Loop / process.nextTick](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick#understanding-processnexttick)。ローカル実Timer試験はNode v24.14.0で実行。Linux CIでも実Timer試験を実行し、使用Node版・結果はCIログで確認する。

追加ファイルは`tests/backend/state-scheduler-races.test.ts`。既存57件のテスト本文は変更していない。

| 検証   | 追加件数 | 確認内容                                                                                                               |
| ------ | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| R42-01 | 3        | Promise解決前、解決後、Timer予約直後のMicrotaskで再判定要求を20回集約。再判定後の将来Timerも発火し、消失しない         |
| R42-02 | 1        | 集約された0ms再判定と、続く最短1ms Timerの発火を分離して確認                                                           |
| R42-03 | 2        | 完了前・予約直後のstopが勝ち、追加Task・Timerが発生しない                                                              |
| R42-04 | 1        | 完了後の再予約に対して古いCallbackを呼んでも、新しいTimerが消えない                                                    |
| R42-05 | 1        | Fake Timerを解除した実Node Timerで、登録後に同期処理を10ms続けても割込みなし。20回の連続再判定と追加の再判定が進行する |

追加8件によりScheduler関連は65件となる。これらはHTTP・Quota・Tx-A・C1-29の実Provider送信安全性を検証するものではなく、上記の後続統合待ちの分類を変更しない。

## 品質確認と残作業

Windows：Scheduler関連65件成功（既存57件＋追加8件）。全体364件成功・Linux専用46件Skip（合計410件）。Lint / Format / Type Check / Backend Build成功。Linux実Process試験の結果はPRのCIを別途参照する。

PR-BのPublished State保存53件・Read66件、Cache Repository80件・Cache Entry29件を回帰確認。日時関数の移動以外にPR-Bの証跡・Transaction・Generation・TTL・DB処理は変更していない。設計正本、DDL、Migration、依存関係、HTTP Routeも変更していない。

C-Impl-2〜6では、既存の工程分担に従ってCoordinator・Acquisition Control / Tx-A・Backoff、Quota Guard / Tx-Q / Provider Send Gate、各停止理由の連携、本番Lifecycle接続と受入統合を検証する。今回その順序・Interface・責務を新たに決定しない。Tx-P / Tx-C全体連携・PendingはPR-D、継続Recovery・安全確認後再開はPR-E、OS・systemd・Pi実機はIssue #12 / #13へ維持する。
