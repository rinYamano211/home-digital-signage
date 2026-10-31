# C-Impl-4 Provider Send Gate / Trust / F-02：検証と引継ぎ

設計正本は[technology-stack.md §23.11](../technology-stack.md#pr-c-c-impl-4-send-gate-trust)のStep 1〜6、C-3/03、Clock / History Trust、F-02・F-03、[architecture.md](../architecture.md)。PR #46 Merge Commit `dde1fb475071df9932cd5c140b9a8143606afdbb`を起点とする。既存契約を変更せず、独立制御の実装範囲と本番統合の未完了範囲を記録する。Issue #16・PR-C全体を完了扱いにしない。

## コード変更前のInterface照合

| 確認対象                              | 区分         | 照合結果                                                                                                                                                                                                             |
| ------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QuotaRepository配置・所有権           | そのまま利用 | src/backend/storage/quota-repository.ts。Store所有の単一Connectionを借りる。GateはDB Connectionを所有・生成しない                                                                                                    |
| beginAttempt(providerKey)             | そのまま利用 | QuotaAttemptを返す。Repository・Connection実体・Providerへ拘束し、同一Repositoryの同Providerの試行重複を拒否。GateはこのAPIを呼び、別の不透明GateAttemptでEpochを関連付ける                                          |
| reserve(request)                      | そのまま利用 | saved / quota_blocked / not_saved / unknown。Commit成功確定時だけEvidenceを返す。Gateはreserveを実行・再実行しない                                                                                                   |
| inspectReservation(evidence, attempt) | そのまま利用 | QuotaReservationまたはnull。所有Repository / Connection・試行・閉鎖・未解決Transaction・DB異常・pendingを検証する。最終送信許可・Epoch・HTTP Lifecycleは担当しない                                                   |
| endAttempt(attempt)                   | そのまま利用 | 所有試行を終了・失効させる。Quota履歴を削除しない。Gate拒否・停止・Lifecycle終了時に使用                                                                                                                             |
| QuotaReservationEvidence              | そのまま利用 | 非公開WeakMap・凍結Object。SequenceやJSONから再生成しない。Send Permitとして利用しない                                                                                                                               |
| measurementStartedNs                  | そのまま利用 | bigint。process.hrtime.bigint()直後にDate.now()、その後BEGIN IMMEDIATE。Gateで起点を取り直さない                                                                                                                     |
| Connection世代・Coordination          | 接続が必要   | 公開の世代番号はない。Repository / DB実体とinspectReservationの失効確認を使用。GateはRepositoryを固定して試行・Permitを拘束し、Connection再生成時に旧Gate権限を移さない。共有Coordinationを変更しない                |
| QuotaTrust Callback                   | 接続が必要   | 既存reserveの事前・Transaction内確認にGate.quotaTrust(provider)を接続可能。Historyの3要素がすべて確認済みの場合だけ履歴関連2フラグをtrueとし、DB内部整合性は引き続きRepositoryが検証する。本番の確認事実供給は未接続 |
| QuotaGuard / Provider停止             | 接続が必要   | Quota窓・保存済みMetadataの検証は既存Guardに維持。Gateが管理する停止理由・Epoch・in-flight・CooldownをGuardへ移さない                                                                                                |
| 設計との不一致                        | なし         | C-Impl-3の公開Interface・コード変更は不要。新しいGate固有の型・接続境界だけを追加                                                                                                                                    |

Common Time Moduleの既存実装はUTC日時Validationであり、OS時刻・単調時計の取得用共通境界としてTimeSource / systemTimeを追加した。Domain時刻判断・Scheduler・時刻同期Serviceは追加しない。

## 実装コンポーネント

- `send/provider-send-gate.ts`のcreateProviderSendGate(repository)が本番の入口。Trust・OS成功値・任意HTTP Callbackを外部引数に持たず、未確認のClock / HistoryとHTTP Adapterなしで生成する。現時点では送信不能を維持する。Startup / Fastify / Coordinatorには接続しない。
- `send/internal/provider-send-gate.ts`は独立制御core。reservationStatus、quotaTrust、beginAttempt / endAttempt、start、stopControl、snapshot、dispose。startは取得結果を受け取り、saved以外や不正Evidenceを拒否する。DB・Quota予約・Control State更新は行わない。
- stopControl(scope)が返すclosureがその停止理由の所有権。Global / Providerの独立理由を保持し、他の所有者の理由を解除できない。Trust理由は監視・判定責務だけが所有し、再開前にGateがTRUSTED・鮮度・他理由を再確認する。管理停止の永続化成功等を判定する本番接続は未実装。
- `send/internal/permits.ts`はProcess内WeakMapによるPermit管理。Provider・QuotaAttempt・Repository / Connection実体・Sequence・Epochを拘束する。Gateが内部で発行し同じ同期呼出し中に一度だけ消費する。Permitを外部へ送信権限として発行・持越ししない。
- `send/internal/trust.ts`はClockTrustMonitor / HistoryTrustMonitor。Clockは5秒観測・差分異常1秒・観測欠落15秒・OS確認鮮度15秒・異常後安定回復60秒を使用する。観測失敗・不正時刻・同期未確認はFail Closed。Historyは内部整合性・Timestamp信頼性・完全性を別々に確認し、Clock回復から独立する。confirmは内部の確認事実境界であり、未確定の管理確認・回復手順を実装したものではない。
- TimeSourceと監視入力・HTTP Adapterの差し替えはinternal coreの単体検証で使用する。本番Factoryはこれらの差し替え口やHistoryの無条件確認APIを公開しない。OS同期取得手段・History確認経路・実HTTP Adapterが決まるまで、本番でTRUSTEDやHTTP成功を偽装しない。internal Moduleは信頼された配線・テスト用境界であり、同一Process内の任意コードを隔離するSecurity Sandboxではない。

## 同期開始・停止・Lifecycle

公開start()はCallbackを受け取らない。内部で検証済みEvidenceを確認し、F-02をBigIntで直接判定、Permit発行・消費、STARTING占有、Adapter.startをawaitなしで実行する。未終了Requestがあれば次の開始を拒否する。Adapterの契約は、同期fetch開始とそのPromise返却であり、任意実装を型だけで安全とみなさない。今回のFakeはtests/supportにのみ置き、実Provider HTTP Adapterは追加していない。

信頼済みAdapterにはRequest全体の終了を通知するlifecycleEnded callbackを渡す。fetch Promiseのresolve / rejectだけではIN_FLIGHTを解放しない。停止またはTrust失効通知では理由登録・Epoch更新・旧試行失効を先に行い、未終了RequestをABORT_REQUESTEDにしてAbortを要求する。同期Abort listenerから再入されても閉鎖・占有状態を維持する。

同期開始例外では既に開始したかを推測せず、Permitを消費済みとし、Abort要求・占有を維持する。信頼されたLifecycle終了通知後にのみ解放する。実Adapterでのfetch / Body / Cancellation終了通知の正確な実装は後続工程で必要であり、この保守的な待機をHTTP全体実装完了とは扱わない。

保証対象はApplication内で観測したfetch開始順序であり、物理送信・Provider計上時刻ではない。観測間隔中の未検出の時計異常を完全防止しない。同期区間の実時間・時計 / RTC・暫定余裕の妥当性は実機未検証。

## F-02 / Cooldown

既存EvidenceのmeasurementStartedNsからの経過時間0〜1,000,000,000nsを包含し、1,000,000,001ns以上・負値・不正値・計測失敗を拒否する。超過時は当該試行を終了し、Provider単位の単調時計期限を現在値＋5秒として保持する。期限ちょうどから再評価可能。別Stateの呼出元でも同じProvider slotを参照する。期限はDB保存・再起動復元せず、待機終了を送信許可としない。Quota不足・通常HTTP失敗に無条件Cooldownを適用しない。

reservationStatusは将来のCoordinatorが新規Tx-Q前に参照するための抑止Interfaceに留める。全Tx-Q経路の統合・直接Repository呼出しの一元化はC-Impl-5以降。Gateは予約のやり直し・履歴取消し・Backoff更新・Tx-A / Tx-P・Pending作成を行わない。

## T1〜T6の対応

PASSは独立制御・Fake Adapter・実SQLite単体の範囲に限る。実Provider・本番OS同期・Body / Cancellationの実通信・Piを含まない。

| 群  | 状態               | 検証内容・残る統合                                                                                                                                                                                                                                                 |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1  | PASS（単体）       | Permit偽造・コピー・二重消費・Provider / Attempt / Sequence / Repository / Connection実体 / Epochの不一致、他registryの拒否。Gateの非saved・偽造Evidence・別試行・別Connection・閉鎖・未解決Connectionの拒否。実Process跨ぎはProcess私有registryで再生成相当を検証 |
| T2  | PASS（Fake）       | 同期STARTING、停止先行・fetch先行、同期再入・同期例外、Stop → Resume、Abort再入、未終了Request占有、headers Promise resolve / rejectで終了しないこと。本番入口に任意Callback / Adapter差し替えなし。実HTTP Adapterの同期fetch開始・Body終了統合は後続              |
| T3  | PASS（制御単体）   | UNVERIFIED、OS未確認、時計前後ジャンプ、観測欠落・OS鮮度切れ、回復60秒境界、History各要素不足、失効通知・最終確認で閉鎖とEpoch更新、Abort・占有維持、複数停止理由独立、Clock回復後もHistory未確認なら禁止。実OS同期・管理回復は未実装                              |
| T4  | PASS（単体）       | 0 / 999,999,999 / 1,000,000,000 / 1,000,000,001ns、不正・負値・計測失敗、5秒境界、Provider slot独立・同Provider呼出元共有、再生成時に期限非復元。Quota対応Providerは従来どおりTomorrow.ioのみで、新ProviderのQuota実装を追加しない                                 |
| T5  | PASS（SQLite単体） | 拒否・遅延超過・停止・Abort・同期例外・未送信でもCommit済み履歴保持。再予約・取消しなし、Control State非更新。実HTTP結果とTx-A / Pending統合は後続                                                                                                                 |
| T6  | PASS（回帰）       | 既存PR-B・C-1・C-2・C-Impl-3のテストを変更せず維持。新規HTTP・Provider通信はなし                                                                                                                                                                                   |

## 品質確認と変更範囲

初期実装79件にPR #47レビュー対応16件を追加し、C-Impl-4は95件。レビュー修正後のWindows全体は678件成功・Linux専用47件Skip（合計725件）。Lint / Format / Type Check / Backend Build成功。Linux CI結果はPRへ記録する。

追加はTimeSource、Gate本番入口とinternal制御、2テストファイルとtest fixture、本書。既存Quota Repository / Guard / Tx-Q、Schema / Migration、Connection Coordination、Scheduler、Control Repository、既存テスト、設計正本、依存関係、Signal Handler、Shutdown全体10秒は変更しない。

## PR #47レビュー対応：P1 / P2

- **P1**：Gate自身が保持する同Providerの未終了AttemptはRepository呼出し前にnullとする。Repositoryでの外部既存Attemptは、Provider Allowlist検証済みの同期呼出しについて、現行コードの拒否箇所で使用するTypeErrorと固定message `Quota attempt unavailable`の両方が一致する場合だけnullとする。TypeError全般・messageだけで分類しない。この判定は現行Repository実装の拒否表現に依存し、表現が変われば安全側の予期しない障害として扱う。C-Impl-3の公開Interface・実装は変更しない。
- 既知拒否ではGateのAttempt Record生成・Quota予約・Permit発行・HTTP開始を行わない。それ以外の例外はProviderを閉じ、snapshot.repositoryFailureへbegin_attempt_failedを保持したうえで元の例外を再送出する。正常な取得不可として握りつぶさない。
- **P2**：対象全slotの停止理由登録・Epoch更新・ローカル旧Attempt失効を先に完了し、既開始RequestをABORT_REQUESTEDにしてAbort要求、その後に各Repositoryの後片付けを行う。後片付けを一件ずつ捕捉し、一件の失敗で他の処理を中断しない。
- 後片付け失敗はsnapshot.repositoryFailureのattempt_cleanup_failedと、そのGate instanceではResume / Trust回復で解除されない停止理由として保持する。raw例外・Secretを診断情報へ含めない。既存Attemptを再利用せず、自動cleanup再試行も行わない。回復手順を今回新設せず、必要な手動確認・後続Recoveryへ残す。
- Abort要求とLifecycle終了は区別し、後片付け失敗でも終了通知まで占有を維持する。開始例外・拒否・明示endAttemptからの同じ後片付け経路も例外を外へ漏らさず、異常保留を維持する。
- 追加16件：P1 7件（Gate重複・外部既存・固定拒否・予期しない4種類）、P2 9件（4停止経路、Abort先行、明示終了／拒否時cleanup異常、Global複数recordのFault Injection、Clock通知先の継続）。MVPはQuota ProviderがTomorrow.ioのみなので、Global複数slotの検証は内部recordのFault Injectionで行い、新Providerの取得処理を追加していない。

## 未確定・後続工程

- OS同期状態の具体取得方法・RTC-only許可条件・History Trust管理確認／回復手順は未確定。常時TRUSTEDや成功Fakeで代替しない。
- C-Impl-5以降が信頼済み実HTTP Adapter、Lifecycle終了通知、Coordinator全取得フロー、Cooldown参照、Trustの本番配線を接続する。C-Impl-4独立制御と実Provider送信可能な本番統合を区別する。
- F-03管理停止永続化・厳格な停止完了API、Startup / Shutdown本番接続、PR-DのTx-A / Tx-P / Pending、PR-EのDB Recovery / Restore / Backupは未実装。
- 実運用DB Migration、実API通信、Raspberry Pi実機・RTC・同期区間遅延・長期性能は未実施。
- Issue #16はOpen、PRは未Merge・レビュー待ち、PR-C全体は継続中とする。
