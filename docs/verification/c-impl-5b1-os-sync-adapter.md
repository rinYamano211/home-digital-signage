# C-Impl-5B-1 OS同期確認Adapter

## 範囲と状態

正本：[技術スタック選定 C-Impl-5B-1](../technology-stack.md#pr-c-c-impl-5b1-os-sync)（PR #71）。

`src/backend/send/internal/os-sync.ts`の`OsSyncReader`と単体テストだけを実装した。`createProviderSendGate()`・`startBackend()`への本番配線は行わず、本番Gateは引き続き送信できない。`ClockTrustMonitor`・History Trust・Quota Guard・Schema・Config・依存は変更していない。

## 実装

- `timedatectl show -p NTPSynchronized --value`を`execFile`で非同期実行する。Shell・環境変数の上書き・Configはない。
- 出力`yes\n`のみ`confirmed: true`、`no\n`は`confirmed: false`。実行失敗・Timeout・不正出力は`null`とし、以前の成功結果を破棄する。成功を生成するFallbackはない。
- 確認周期5秒・Timeout 3秒。`checkedAtNs`は出力検証後に単調時計で記録し、`current()`は15秒を超えた結果・時計が戻った結果を返さない。
- 確認は同時に1つだけ実行する。Timeout・`stop()`では子ProcessをAbortで終了させ、決着するまで次の子Processを起動しない。`stop()`後・再開後は、停止前に開始した確認の結果を採用しない。
- `ClockTrustMonitor`には`() => reader.current()`を同期Callbackとして渡す。Clock Trustの判定・状態遷移・Trust EpochはMonitor側のまま。

## テスト

`tests/backend/os-sync.test.ts`（Fake Clock・Fake Command・Fake Timer、実OSに依存しない）。

| ID    | 確認内容                                                          |
| ----- | ----------------------------------------------------------------- |
| OS-01 | 初回確認の完了前は`null`                                          |
| OS-02 | `yes`で`confirmed: true`                                          |
| OS-03 | `no`で`confirmed: false`、以前の成功を置換                        |
| OS-04 | 不正出力（空・改行なし・大文字・空白・複数行等）で`null`          |
| OS-05 | 実行失敗・同期例外で`null`                                        |
| OS-06 | TimeoutでAbortし`null`、遅れて届いた結果も破棄                    |
| OS-07 | 15秒超過・単調時計の逆行で`null`                                  |
| OS-08 | 遅い確認と次周期が重複しない                                      |
| OS-09 | `stop()`でAbortし遅延結果を破棄、Timerが残らない                  |
| OS-10 | 停止・再開で旧結果を採用せず、旧子Processの決着前に重複起動しない |
| OS-11 | 失敗後は新しい成功のみ採用                                        |
| OS-12 | 既存`ClockTrustMonitor`の同期Callbackとして接続でき、判定は不変   |

本番Commandの引数・Timeout・Shellなしは`execFile`をMockして確認した。

## 残余リスク・後続

- `NTPSynchronized=yes`は直近のNTP通信成功・絶対時刻誤差の上限を保証しない（正本のとおり）。
- Pi OS実機での`timedatectl`の出力・所要時間、systemd-timesyncdの動作は未検証。
- 本番配線（Gate Factory・Startup / Shutdownでの`start()` / `stop()`）、Window Waitの本番入力、RTC-only送信の禁止を本番経路で確認する作業は後続の5B本番統合で行う。
