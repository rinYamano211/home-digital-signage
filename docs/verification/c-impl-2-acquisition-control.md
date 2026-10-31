# C-Impl-2 Acquisition Control Repository / Tx-A：検証と引継ぎ

正本は[technology-stack.md §23.10](../technology-stack.md#pr-c-c2-acquisition-control)、同§23.3・§23.8、[architecture.md §16](../architecture.md)、Issue #16。正本の意味論・DDL・Schedulerを変更しない。本書は今回の単体機構の実装・検証範囲を記録し、PR-C・Issue #16全体の完了とは扱わない。

## 実装Interfaceと責務

- `BackendStore.acquisitionControl`は既存の単一Connectionを借りる。新Connection・Table・Column・Migrationは追加せず、Closeは従来どおりStoreが所有する。
- `AcquisitionControlRepository.read(stateKey)`はfound / empty / invalid / database_error / pendingを区別。JSON Parse → Schema → Semantic検証を行い、不正Rowは証跡なし・自動修復なし。過去のnextAttemptAtを未来条件で拒否しない。
- `saveConditionally(request)`はinitialize / updateを分け、Tx-A内でRowの有無・正確なJSONを再照合。initializeはINSERTのみ、updateは既存Rowのみ。saved / unchanged / not_saved / unknownを区別する。
- `reconcile(stateKey)`は所有するpending AttemptのRead-only照合。再保存・HTTP再送・公開は行わない。
- `ControlAttemptManager.beginAttempt / endAttempt`はApplicationが取得試行を開始・終了するための明示API。同一Stateの試行重複を拒否する。readには有効な試行が必要で、未開始時は入力契約違反としてTypeErrorとし、Repositoryが暗黙に取得試行を開始しない。
- `ControlAttemptManager.authorizeInitial(evidence, facts)`は初回保存用の独立機構。HTTP分類済み・候補正常・DB正常・取得条件成立と、確認済み新規性の全確認事実、または保守的待機完了を要求する。最新のRead Evidenceへ拘束し、発行時にもRow不存在を再Readする。Row不存在だけでは許可しない。
- `beginShutdown({ deadlineMonotonicMs, lifecycleCleanupAllowed })`は呼出元が既存Shutdownの残り期限を供給する接続点。独自10秒枠やTimerは作らない。開始前からの有効試行・正常既存Row UPDATEのみ、明示的なLifecycle終了処理許可・期限内・正常Connection・停止なしで実行可能。初回Authorizationは既発行分も失効し、発行・再発行・INSERTを禁止する。
- `blockWrites()`は当該Contextの保存を禁止しAuthorizationを失効させる。安全な再開APIは追加しない。DB安全性の異常は既存共有Connection Coordinationでも保護する。
- `nextControlState()`は成功周期・指数Backoff・429 Retry-Afterの純粋計算。Quota抑止では両フィールドを維持する。HTTP結果分類や保存実行はしない。
- `ConservativeControlWait.check()`は単調時計のProcess内待機だけを行う。min(period, 5分)経過時もreadyForRecheckを返すだけで、送信・初期化・Quota解除を許可しない。再起動相当の新インスタンスでは待機をやり直す。

Retry-Afterの秒数・HTTP-dateは[RFC 9110 §10.2.3](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after)と[§5.6.7](https://www.rfc-editor.org/rfc/rfc9110.html#name-date-time-formats)を参照。3種類のHTTP-dateと秒数を検証し、不正・欠損は通常Backoffとする。有効な長い待機は30分上限へ切り詰めない。既存UTC日時検証・JS表現範囲を使用する。

## Evidence・Authorizationと照合

Process内の非公開WeakMapに、Repository・Connection実体・State・取得試行・Read時のRowを記録し、不透明な凍結トークンだけを返す。Connection再生成時は実体が変わるため旧証跡を利用できない。別Repositoryへの流用、複製、偽造、試行終了後利用を拒否する。時間経過だけでは失効させない。保存試行開始直前にEvidenceと必要なAuthorizationを消費し、BEGIN失敗・Rollback・unknown・unchanged後も再利用させない。入力事前拒否では消費しない。

候補とRequestのプロパティは共有busy gate内で読み、検証済みの2項目をplain copyに固定して保存予定JSONを一度生成する。COMMIT例外後の照合ではこのJSONを再利用する。BEGIN IMMEDIATE以降でRow一致を確認し、Commit前に失敗してRollback終了を確認できた場合は未保存確定、Commitへ進んだ場合は実Transaction終了を確認したうえで照合する。Transactionを解決できなければ共有Connection全体を保護する。

照合は保存前Row・予定JSON・現在Rowに加え、SQLiteのConnection内total_changes / data_versionを判断材料とする。同一値への別書込み・ABA等を検出した場合、保存前後が区別不能な場合、照合Read失敗等はunknownを維持する。専用の永続操作ID・Revision・Schema変更は追加していない。共有Connectionの別Stateへの正当な書込みでも照合の保守性によりunknownを維持する場合がある。単一Writer・管理されたDBアクセスの前提を維持し、外部Writer・再起動をまたぐ完全な操作識別や自動Recoveryを保証しない。

pendingは同じConnectionを使うControl Repository間で共有し、同一Stateの通常Read・保存を止める。照合はAttemptを所有するRepositoryだけで行う。正常Connection上のState単位pendingは他StateやPR-Bを停止させず、Connection未解決・Schema異常等は既存Coordinationを通じて共有保護する。

## C2-01〜C2-26対応表

PASSは記載した単体範囲・障害注入の結果を意味し、実HTTP・本番Coordinator・実機を含まない。

| ID    | 状態                   | 証拠・残る統合範囲                                                                                                    |
| ----- | ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| C2-01 | PASS                   | 正常・過去時刻、JSON / 構造 / 値・日時のValidation                                                                    |
| C2-02 | 部分検証               | 全確認事実が揃わなければ初回許可なし。実Published State / Counter等から事実を生成するCoordinatorは未統合              |
| C2-03 | PASS                   | 偽造・複製Evidenceを拒否、Row維持                                                                                     |
| C2-04 | 部分検証               | 別Repository・Connection・State・コピー拒否。Process跨ぎの転送は実施せず、Process私有レジストリと再生成相当で検証     |
| C2-05 | PASS                   | 時間だけでは失効なし、試行終了・Connection閉鎖／再生成後は利用不可                                                    |
| C2-06 | PASS                   | BEGIN失敗・Rollback・unknown・unchanged後の再利用拒否、入力事前拒否は未消費                                           |
| C2-07 | 部分検証               | 初回許可の全条件・正常候補・最新Evidence・発行時再Readを検証。本番HTTP分類・新規性・待機の事実生成は未統合            |
| C2-08 | PASS                   | Authorization偽造・別Evidence・別Context・消費後流用を拒否                                                            |
| C2-09 | 部分検証               | 試行終了・Shutdown・Global保存停止・Connection変更で失効。本番停止通知との接続は後続                                  |
| C2-10 | PASS                   | 不存在Evidence＋対応Authorization必須、保存試行時消費                                                                 |
| C2-11 | 部分検証               | 単調時計・待機境界・短周期・新インスタンスによる再待機。待機中HTTP抑止の本番接続は後続                                |
| C2-12 | 部分検証               | 発行時再Read、欠損と不正の分離、waitは再Read要求のみ。待機後の一連の取得判定は未統合                                  |
| C2-13 | PASS                   | 不正Rowは証跡・許可なし、自動修復せず他State継続                                                                      |
| C2-14 | PASS                   | 初回INSERT前に現れたRowを検出、上書きせず維持                                                                         |
| C2-15 | PASS                   | Read後のRow変更・消失でUPDATE拒否                                                                                     |
| C2-16 | PASS                   | BEGIN IMMEDIATE・正常Commit・Constraint / Rollback・旧Row維持・証跡消費                                               |
| C2-17 | PASS                   | 同一JSONだけunchanged、書込み省略・証跡消費、初回はINSERT                                                             |
| C2-18 | PASS                   | Commit前後例外、Rollback通知例外、Read-only比較によるsaved / not_saved / unknown                                      |
| C2-19 | 部分検証               | 候補getterの単回読取り・JSON再利用、同値前後・内部／別Connection ABAのunknown。完全な外部操作識別は保証しない         |
| C2-20 | 部分検証               | unknown後Read・保存保留、照合失敗継続・後日のRead-only確定。Tx-Pへの移行制御はPR-D統合待ち                            |
| C2-21 | PASS                   | 未解決Connectionで新Txなし、PR-B共有保護、正常Connectionのpending局所化                                               |
| C2-22 | PASS                   | 成功＝開始＋周期、1/2/4/8/16/30分・上限、Jitterなし、429の秒数／HTTP-dateと長いRetry-After                            |
| C2-23 | 部分検証               | Quota抑止の純粋計算はControl不変。Quota履歴・Tx-Q・送信中止との本番統合は未実施                                       |
| C2-24 | 後続統合待ち（未実施） | Tx-AとHTTP再送・Tx-P失敗・Pending全体の連携は今回追加しない                                                           |
| C2-25 | 部分検証               | 初回発行／INSERT禁止、正常既存UPDATEの終了処理許可・期限・停止を検証。実HTTP・本番Lifecycle・DB Close順序の統合は後続 |
| C2-26 | 後続統合待ち（未実施） | 保存停止機構のみ。Provider送信Permit / Send Gateの競合防止は今回実装しない                                            |

## 品質確認・変更しない範囲

新規115件（Repository71・Policy44）。Windows全体479件成功・Linux専用46件Skip（合計525件）。Linux CI結果はPRに記録する。Lint / Format / Type Check / Backend Build成功。

PR-BのPublished State119件、Cache関連109件、C-Impl-1の65件を回帰確認。既存テスト本文とScheduler本体、設計正本、DDL・Migration・Schema Version、HTTP Routes、依存関係、Signal Handler、Shutdown全体10秒は変更しない。Storeの変更は既存ConnectionからRepositoryを構成する3行のみで、Open / Close所有権は維持する。

## C-Impl-3以降への引継ぎ

- 本番Coordinatorが取得試行をbegin / endし、実際の永続情報から新規性・既存記録・DB正常性を確認する。InitialControlFactsは信頼されたApplicationからの確認事実であり、Repositoryが過去データ非消失やHTTP成功を発見・証明する仕組みではない。欠損だけでconfirmed_newにしない。
- 待機完了後に再Readし、欠損継続は取得条件と初回許可を再評価、不正継続は保留する。待機をQuota異常解除に流用しない。
- 実HTTP結果分類、Quota Guard / Tx-Q / Provider Send Gate、Shutdown・Global停止通知と既存期限の供給、本番Lifecycle接続と結合受入は後続。初回Authorizationは送信許可ではない。
- Tx-P / Tx-C全体連携・PendingはPR-D、継続Recovery・不正Row修復・再開はPR-E、Raspberry Pi / systemd / 実機障害はIssue #12 / #13。再起動を跨ぐ完全操作識別を解決済みとしない。
- PRはレビュー待ち・未Mergeとし、Issue #16・PR-C全体を完了扱いにしない。
