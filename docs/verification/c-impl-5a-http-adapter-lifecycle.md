# C-Impl-5A HTTP Adapter / Lifecycle：詳細設計・実測・検証計画

以下の設計・実測・受入計画はPR #48 / #49時点の記録として維持する。C-Impl-5A実装後の検証状態・証拠・後続範囲は末尾の「C-Impl-5A実装・受入検証」を参照する。正式受入条件の本文・IDは変更しない。

設計正本は[technology-stack.md §23.11](../technology-stack.md#pr-c-c-impl-5a-http-lifecycle)、同§23.3・23.8・23.10・F-03、[architecture.md](../architecture.md)。基準mainはe9259f670a8033a57f1b9d4d4905ab6cf32f67ab。Issue #16 / PR-C全体を完了扱いにしない。本書は今回の文書反映、前回のローカル実測、既存コード読取り、未実装の受入計画を区別する。

## 参照範囲と採用状態

- [既存Gate](../../src/backend/send/internal/provider-send-gate.ts)、[本番Factory](../../src/backend/send/provider-send-gate.ts)、[Trust](../../src/backend/send/internal/trust.ts)、[Permit](../../src/backend/send/internal/permits.ts)を読み取った。
- [C-Impl-2の契約・検証範囲](c-impl-2-acquisition-control.md)、[C-Impl-4の契約・検証範囲](c-impl-4-send-gate-trust.md)、Quota Repository / Guard、Schedulerと関連テストを照合した。今回は既存テストを再実行していない。
- 案A（AdapterによるBody・Lifecycle単独所有）、同期fetch開始、HttpOutcome基準型、終了確認後の通知／結果配送順序を正本に記録した。本番Adapterのコード・受入テストは未実装である。
- 本番FactoryはHTTP Adapterなし・未確認TrustでFail Closedのまま。今回送信可能にせず、Coordinator / Fastify / Startupへ接続しない。

## Interface・結果・所有権

HttpStartAdapter.start(signal, lifecycleEnded): Promise<unknown>とGateアルゴリズムは維持する。実Adapterの結果Promiseは正本のHttpOutcomeを返す。Headers受信で得たHttpMetadata（status、未解釈文字列retryAfter）をBody結果とは独立して保持し、responseはhttpと上限内Byte列、body_error / body_too_largeはhttp必須、network_error / timeout / abortedは取得済みならhttpを保持できる。HTTP 429・500もresponseに含む。Response・Reader・Stream・Secret・元の例外を結果にせず、JSON Parse・Domain Validation・Backoff・Tx-A / Tx-P・Quota更新は責務外とする。

### 今回確定したHTTPメタデータと429優先順位

| シナリオ                                 | HttpOutcome・後続処理                                          |
| ---------------------------------------- | -------------------------------------------------------------- |
| 429、Body正常終了                        | response + http.status=429。Coordinatorが有効Retry-Afterを適用 |
| 429、Body通常読込失敗                    | body_error + 429メタデータ。有効Retry-Afterを適用              |
| 429、Bodyサイズ超過                      | body_too_large + 429メタデータ。有効Retry-Afterを適用          |
| 500、Body失敗                            | HTTPメタデータを保持し通常失敗                                 |
| 429受信後、Timeoutによる終了が先に確定   | timeoutを優先。通常Timeout Backoffであり429待機へ置き換えない  |
| 429受信後、制御Abortによる終了が先に確定 | abortedを優先。Control State非更新                             |
| HTTP終端確定後のAbort / Timeout          | 分類・確定メタデータを変更しない                               |

通常Body失敗・サイズ超過でも429メタデータを採用する優先順位は、今回追加確定した判断である。従来C-2にこの優先順位まで明記されていたとは記録しない。待機計算は既存23.3・23.10を維持し、CoordinatorがHeaderの秒数・HTTP-dateを解釈して、通常Backoffと有効Retry-Afterの遅い方を使う。30分超も尊重し、欠損・不正値は通常Backoff。Adapterは解釈や保存をしない。

Headers受信・Timeout通知・Abort要求だけでは終端確定しない。最初に成立を確認した終端を一度だけ確定し、分類とメタデータを固定する。Signal失効だけで後続の任意エラーをtimeout / abortedと断定せず、実終了との因果を確認する。

生のfetchはHeaders時点のPromiseを返すが、案Aはそれを内部所有し、Body処理の完了を待つ結果Promiseを外部へ返す。現行GateはPromise<unknown>を受け、成否でFlightを解放しないため、型と制御は整合する。一方、Interfaceの既存コメントにある「そのfetchのPromiseを返す」という表現は、結果Promiseとの同一性を要求するようにも読める。実装時にコメント・説明を明確化する要修正事項であり、今回はGateコードやシグネチャを変更していない。架空の別公開Interface・永続Tableは追加しない。

設定検証は原則生成時。startは同じ同期呼出し内でfetchを実行し、Headers以降の非同期処理を分離する。事前準備がSignalやRequest構築を伴う場合も、Permit消費後にawaitで開始を遅らせない。開始前の例外、fetchのReject、部分開始を否定できない同期throwを混同しない。

## Body上限の暫定運用値と検証待ち事項

本番Body上限は未採用の状態から、次の暫定運用値を採用済み・実API計測による最終確認待ちへ更新する。正本は[technology-stack.mdのC-Impl-5A](../technology-stack.md#pr-c-c-impl-5a-http-lifecycle)。実装・実Provider計測・境界試験の成功を意味しない。

| 対象                                            | 暫定上限値                                  |
| ----------------------------------------------- | ------------------------------------------- |
| Adapter共通絶対上限                             | 1 MiB（1,048,576 bytes）                    |
| Open-Meteo（Current / Hourly / Weekly Weather） | 256 KiB（262,144 bytes）                    |
| Tomorrow.io（RainForecast）                     | 256 KiB（262,144 bytes）                    |
| Google Calendar                                 | 1 MiB（1,048,576 bytes）／HTTP Response単位 |

maxBodyBytesはAdapter生成時に検証し、共通絶対上限を超える設定は禁止する。Provider設定の選択はAdapter外側の責務とする。実受信Byte数を累積し、上限ちょうどを許容、1 Byte超過でbody_too_largeとする。圧縮時はアプリケーションに渡される展開後Bodyを対象とし、Content-Lengthによる早期判定だけで実Byte検査を省略しない。上限超過後もAbort / Cancel等の所有処理が未終了ならLifecycle通知・Flight解放を行わない。プロセス全体のメモリ上限を保証する設定ではない。

以下は既存H5A-I10等に沿う今後の検証観点であり、新しいテスト実施・PASSを記録するものではない。

- 設定値と共通絶対上限の関係、上限ちょうど／1 Byte超過、Content-Lengthあり／なし、展開後Bodyの実Byte判定を確認する。
- 実Provider接続時に受信Byte数、応答サイズの変動、通信時間、メモリ使用量、上限境界値を測定し、暫定設定の妥当性を再評価する。
- Calendarは各HTTP Responseに適用し、ページ単位と全ページ累積量を測定する。全ページ累積Byte数・最大ページ数・最大イベント数の上限は後続Schedule統合工程で検討する。
- 前回EXP-11・12の32-byte上限は合成実験値のまま保持し、今回の256 KiB／1 MiBの実測証拠として流用しない。内部buffer・圧縮展開・JSON展開を含む総メモリの保証としない。

## 現行Gateの終了・throw・再入のコード照合

| 経路                          | 実際の制御と必要な検証                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| Adapter呼出し前               | slot.flightにSTARTING、starting=trueを登録済み。同期待機／再入時も占有を見せる                     |
| start中の同期finish           | finished=trueだけを記録。starting中は解除しない。適法な終了根拠なしにAdapterから呼ばない           |
| Promiseを正常返却             | starting=false、必要ならIN_FLIGHTへ。finishedならfinishを再評価して解除・Attempt cleanup           |
| PromiseのFulfill / Rejectのみ | Flightは解除しない。既存Fakeテストはこの保持を検証するが、実Body処理の証拠ではない                 |
| start同期throw・未通知        | catchでABORT_REQUESTED・Abort要求・Attempt失効／cleanup。Flightを保持し、http_start_failedを返す   |
| 適法な同期finish後のthrow     | catchの安全処理後にfinishedなら解除可能。未開始が証明済み／全所有処理終了済み以外でfinishしない    |
| start返却後のfinish           | Flightを同期解除しcleanupする。通知と結果Promise配送の間の新規開始をテストで観測する               |
| cleanup異常                   | cleanupAttemptedで再試行・二重処理を抑止。Provider停止理由が残り、Flight解除だけでは送信再開しない |

既存tests/backend/provider-send-gate.test.tsには同期再入、同期開始例外、Promise Rejectのみでは終了しないこと、停止・cleanup異常のFake試験が存在する。今回はそのソースを確認しただけであり、追加したH5A-I条件や実Adapter結合がPASSしたとはしない。

現行Gateのアルゴリズムに必須の安全性変更は今回の読取りで特定していない。Interfaceコメントの整合、同期終了通知とthrowの組合せ、通知間隙の再入は実装前／実装時の要確認である。終了不明を解放する方向へGateを変更しない。

## U-08・C-2・F-03との順序整合

次の4段階を設計契約とする。

1. **HTTP終端結果の内部確定**：Adapterが最初の実際の終端を一度だけ確定し、後続イベントで分類・メタデータを変更しない。
2. **Lifecycle終了確認とGate通知**：Adapter所有のBody読込・Cancel等の終了を確認し、lifecycleEndedを最大1回呼ぶ。Gateは既存の規則でFlightを解放する。
3. **HttpOutcome Promise配送**：通常の終了確認済み経路ではGate通知後にPromiseをFulfillし、AdapterからGate経由でCoordinatorへ結果を渡す。
4. **Tx-A開始可否の再判定**：Coordinatorが停止状態・DB安全性・Evidence・必要なAuthorization・取得順序を再確認する。停止判定と保存試行開始登録・トークン消費を同期的に競合制御し、BEGIN IMMEDIATEを試みる直前というC-2 / F-03境界を維持する。

内部確定・Gate解放・Promise受信は別時点である。通知前に結果とdrain状態を固め、通知後からFulfillまで追加の外部Callbackやawaitを挟まない。結果確定後の後片付けAbortで結果を変更しない。終了未確認ならLifecycle通知も通常の結果Promise完了も行わず、Pending・Flight保持を維持する。Reject・Timeout Signal・Abort要求は終了証明ではない。予期しない内部契約違反のRejectはHttpOutcomeによる通常失敗通知と区別する。

finishはFlightの同期解除とQuota Attempt cleanupを伴う。通知とPromise配送の間に管理停止や別の正常試行が入る可能性があるため、Gateの空き・Promise受信を保存許可とせず、C-2のState直列化・新旧判定・Evidence / AuthorizationとPR-D公開条件を維持する。

| 管理停止の成立境界                           | 期待結果                                                 |
| -------------------------------------------- | -------------------------------------------------------- |
| HTTP内部終端確定前                           | 停止後に確定した結果から新規Tx-Aを開始しない             |
| 内部確定後、Lifecycle通知前                  | 終端結果を変更しない。新規Tx-Aは禁止                     |
| Lifecycle通知後、Promise配送前               | Gate解放を保存許可とせず、新規Tx-Aは禁止                 |
| Promise配送後、Tx-A開始前                    | Coordinatorの停止再確認で新規Tx-Aを禁止                  |
| 停止前に適法なTx-A開始登録・トークン消費済み | F-03の既存条件で結果確定を許容。Shutdown・DB安全性を優先 |

内部確定はAdapter、終了通知はAdapter→Gate、結果配送はAdapter→Gate→Coordinator、停止再確認とTx-A開始競合制御はC-Impl-5C側が担当する。F-03の厳格な停止完了追跡・SUSPENDED Commit・開始済みTx-A / Tx-P / PendingはC-Impl-5C以降の統合責務を維持する。新しい公開Callback・永続Table・独自の終端時刻Tokenを追加しない。Coordinatorの具体的な実装構造は未固定のままである。

## 前回のNode.js 24実測を再確認した証拠

Work成果物http-lifecycle-20261101のreport.md・timelines.md・results.json・events.jsonl・experiment.mjs・timeout-probe.jsonへアクセスでき、今回本文・生ログ・スクリプトを読み直した。今回はHTTP実験を再実行していない。成果物はWork内に保存され、GitHubへ生ログ一式を追加したものではない。本書には追跡用の要約・代表時系列・SHA-256を記録する。

| 環境・範囲     | 確認内容                                                                     |
| -------------- | ---------------------------------------------------------------------------- |
| 実行環境       | Windows 11 Home x64 / 10.0.26200、Node.js 24.14.0、npm 11.9.0、Undici 7.21.0 |
| 標準API        | fetch・AbortSignal.timeout・AbortSignal.anyが利用可能                        |
| 主実験         | EXP-01〜18、variantとFault Injectionを含む35ケース、127.0.0.1のみ            |
| 独立追試       | 合成Timeout2ケース、明示Request保持variant1ケースの計3ケース                 |
| 非対象         | Linux / Pi、TLS / Proxy、実Provider、実APIキー、実Quota DB、本番Gate統合     |
| 失敗試行の分離 | sandboxのEACCES試行はHTTP証拠から除外。最初の実通信run中断ログは別保存       |

| EXP | 観測事実・検証境界                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 01  | 200・11 bytesを正常読了。実Adapter完了ではない                                                                                          |
| 02  | fetch Fulfill約1.402ms、Body読了150.763ms。HeadersとBodyは別                                                                            |
| 03  | 204はResponse.body=null。Domain Dataの成功を保証しない                                                                                  |
| 04  | 429でもfetch Fulfill、Retry-After=12。Backoff保存の結合なし                                                                             |
| 05  | 500でもfetch Fulfill。HTTP status判定と通信例外を分離                                                                                   |
| 06  | Headers前Abort要求39.578ms、fetch拒否41.558ms。要求時点は未解決                                                                         |
| 07  | Abort要求52.050ms、closed拒否52.838ms、read拒否52.852ms                                                                                 |
| 08  | 合成Signal失効後もread / closedが観測上限で未解決。下記で別記                                                                           |
| 09  | 短い合成TimeoutでGate先行・Timeout先行を確認。全経路の保証ではない                                                                      |
| 10  | cancel呼出し32.504ms、Body終了32.985ms、cancel Promise完了32.995ms。呼出しと完了は別                                                    |
| 11  | 実験上限32 bytesに対しContent-Length=128で早期拒否・cancel。32を本番値にしない                                                          |
| 12  | Content-Lengthなし、実受信48 bytesで上限32超過を検出しcancel                                                                            |
| 13  | Server切断後にread / closedがTypeError拒否。物理ネットワーク終了の一般保証ではない                                                      |
| 14  | 正常終了先行・Abort先行を確認。近接同設定3回は読了1回・Abort2回。固定順序を保証しない                                                   |
| 15  | AbortとTimeoutの先行別を確認。実験の同時設定で常に同じ順になるとは結論しない                                                            |
| 16  | 不正URL・TRACE・不正signal・例外getterはPromise Reject。native fetch同期throwは未再現。Request構築の同期throwとAdapter途中throwのFIは別 |
| 17  | fetch解決後にBody停滞。約10秒でreadが拒否した例。08を否定する証拠ではない                                                               |
| 18  | cancel遅延・cancel未解決・read未解決の明示FI。130ms観測内の保持を確認し、native Undiciの永久停止とはしない                              |

### EXP-08：事実・再現差・原因・安全側動作

| 区分               | 内容                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 観測された事実     | 総合ハーネスで合成Signalの10秒Timeout後もBody read / reader.closedが残る例を2runで観測。最初は中断、次は記録後に実験Serverを切断                                                          |
| 主runの時系列      | fetch Fulfill 1.790ms → 合成SignalのTimeout失効10001.214ms → 観測上限11000.703msでもclosed / read pending → Server後片付け11000.816ms → read拒否11001.975ms（TypeError / UND_ERR_SOCKET） |
| 再現していない事実 | 独立した合成Timeout追試3ケースは約10秒でTimeoutError拒否し、強制後片付けなし。直接timeoutの主run variantも終了した                                                                        |
| 原因未特定         | GC・参照保持・接続再利用・Undici・Windows・ハーネス等への原因帰属は未確定。Request保持を解決策と断定しない                                                                                |
| ログ分類の限界     | 実験ラッチterminal=timeoutは失効reasonを使用した分類。Server切断後のTypeErrorを、Timeoutだけで終端した証拠に数えない                                                                      |
| 採用する安全側動作 | Signalだけで結果・Lifecycle・Gate解放を確定しない。所有read / cancel等の終了未確認ならFlightと結果Promiseを保持                                                                           |
| 保証しないこと     | 追加1秒の観測上限は本番の解放条件ではない。10秒以内の強制drain、物理TCP切断、Provider側終了を保証しない                                                                                   |

### 成果物照合用SHA-256

| Work成果物名       | SHA-256                                                          |
| ------------------ | ---------------------------------------------------------------- |
| report.md          | 8EFDF3F5A2FAED8B5F8B37BDA9043A6628572F151D051C6CFABF06FE9EB934FD |
| timelines.md       | B7AC2547CDC1088BBF5E7D4A4A0E8F564070B47DFABE886020459072C6083925 |
| results.json       | B9D237B76597D158B9357A7993A29A54B1628CD6688562251C1B5FDAF3BAB51A |
| events.jsonl       | 84DC2CA388C89C8759786C86419D0BEDDBBD5C91DF6768936DE4ECF9E7225079 |
| timeout-probe.json | 31DC74293BED31236F56D84D7DDAD5E2430DFDC13D0BDFEF7BE0E5974E76E7FA |
| experiment.mjs     | 7F80D872E341BCB3E0EAAD65D47AB0A263FFF7D068DDAFBB467FA2C50BE33063 |

実測ログはApplicationの観測であり、Server側Request / Response Closeは補助証拠に留める。Request closeはRequest受信完了でも発生し、Response BodyやClientの終了証明ではない。標準APIの意味は[Node.js 24.14.0 Globals](https://nodejs.org/download/release/v24.14.0/docs/api/globals.html)・[Web Streams](https://nodejs.org/download/release/v24.14.0/docs/api/webstreams.html)も参照し、仕様説明を本番実測成功へ置き換えない。

## 受入条件の正本と過去の検討観点

C-Impl-5Aの正式なInterface受入条件は下記H5A-I01〜H5A-I12とする。既存SG-01〜09、HTTP-01〜07、TQ-04および関連TQ、F03-01以降、関連C1・C2・SCHも正式契約として維持し、IDを削除・再採番・意味変更しない。

H5A-01〜23は正式本文をGitHubで確認できない過去の検討観点であり、独立した正式受入IDとして扱わない。従来の23行の本文未取得表は本節へ集約した。観点自体は破棄せず、確認できる内容を次の正式条件へ対応付ける。元の各番号との一対一対応は未照合であり、推測で再定義しない。追加条件が必要と判明した場合は正式IDを上書きせず追加候補として報告する。

| 確認可能な過去の検討内容                        | 正式な追跡先                         | 照合状態                                                         |
| ----------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| 同期fetch開始・開始例外・安全側保持             | H5A-I01〜03、SG-01〜05               | 観点は確認済み。旧H5A個別番号との対応は未照合                    |
| Body所有・終了確認・通知最大1回                 | H5A-I04〜06・08、HTTP-01〜03、SG-01  | 観点とEXP証拠を保持。旧個別番号は未照合                          |
| 終端競合・通知順序・保存許可                    | H5A-I07、HTTP-02・07、F03-01・02等   | 正式順序は今回確定。旧個別番号は未照合                           |
| 429 / 500・Retry-After・サイズ制限・返却境界    | H5A-I09・10・12、HTTP-04、SCH-02・03 | 観点を保持。新しい429優先順位は今回追加判断                      |
| Gate・SQLite・Quota結合（旧16〜19の集合的範囲） | H5A-I07・11、SG、TQ-04、C2、F03      | 集合としての範囲情報のみ。個別番号割当は未照合、HTTP単独PASSなし |
| 上記以外の旧H5A-01〜23の個別本文                | 未照合                               | 不明な内容を新しい正式条件として作らない                         |

## H5A-I01〜12：正式なInterface設計受入条件

各行の状態は**設計確定／C-Impl-5A実Adapter未実装／受入テスト未検証**である。既存Gate・Quota等の実装済み範囲や既存試験記録、前回HTTP実測とは別管理とし、この修正で新規テストPASSを作らない。後続工程欄はC-Impl-5A単体完成の未完了と本番統合の未完了を混同しないための区分である。同じ観点は既存SG・HTTP・TQ試験を拡張・再利用でき、ID数だけ独立テスト関数を増やす義務ではない。

| ID      | 工程                                    | 条件・期待結果                                                                                                                                                                                | 既存契約対応                               | 証拠・後続範囲                                                                                       |
| ------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| H5A-I01 | C-Impl-5A Adapter単体・Gate結合         | 有効startの同一同期呼出し内でfetchを開始し結果Promiseを返す                                                                                                                                   | SG-02・05                                  | EXP-16は入力Reject・FIのみ。実Adapter結合は未検証                                                    |
| H5A-I02 | C-Impl-5A Adapter単体・Gate結合         | Permit消費からfetch呼出しまでawait・非同期開始遅延なし                                                                                                                                        | SG-02・07                                  | 呼出し順序計測・同期再入は実装時検証                                                                 |
| H5A-I03 | C-Impl-5A Adapter単体・Gate結合         | 同期throwは未開始証明と部分開始不明を分離。http_start_failed / ABORT_REQUESTED維持                                                                                                            | SG-01・03・05、TQ-04                       | EXP-16部分検証。native同期throw未再現。実Adapter結合は未検証                                         |
| H5A-I04 | C-Impl-5A Adapter単体                   | AdapterだけがBody / reader / cancelを所有し二重消費・Stream流出なし                                                                                                                           | HTTP-01、SG-01                             | EXP-01〜13はハーネスの観測。本番所有権は未検証                                                       |
| H5A-I05 | C-Impl-5A Adapter単体・Gate結合         | Headers・Abort・Timeout・cancel呼出しだけでは通知せず全所有処理終端を要求                                                                                                                     | HTTP-01〜03、SG-01                         | EXP-02・07・08・10・17・18。実Adapter結合は未検証                                                    |
| H5A-I06 | C-Impl-5A Adapter単体・Gate結合         | 正常・異常・近接競合・再入を通じLifecycle通知は最大1回                                                                                                                                        | HTTP-02・03、SG-01・05                     | 実験ラッチと本番通知を区別。実Adapter受入は未検証                                                    |
| H5A-I07 | C-Impl-5A Gate結合・C-Impl-5C           | 内部終端確定→Lifecycle確認・Gate通知→Promise配送→CoordinatorのTx-A再判定。通知と配送の間の管理停止・別試行を検証し、Gate解放を保存許可にしない                                                | HTTP-02・07、SG-01・02・05、F03-01・02・12 | 5Aは順序・間隙のFake結合、実Coordinator・停止とTx-A開始登録は5Cで検証。後続統合未実施                |
| H5A-I08 | C-Impl-5A Adapter単体・Gate結合         | 終了未確認Timeout / AbortはPending・Flight保持。Signal失効・Rejectだけで通常完了にしない                                                                                                      | HTTP-01〜03、SG-01・06・09                 | EXP-08・18。実Adapter結合は未検証                                                                    |
| H5A-I09 | C-Impl-5A Adapter単体・C-Impl-5C        | 429 / 500のresponse、Body失敗・超過時のhttp保持、未解釈Retry-Afterを検証。429 Body失敗にも有効Retry-After、Timeout終了先行ならTimeout優先、制御Abort終了先行ならControl非更新、確定後変更なし | HTTP-02〜04、SCH-02・03、C2-22             | EXP-04・05は正常Body範囲のみ。新しいBody失敗時優先順位は今回設計確定・未検証。待機計算・Tx-A結合は5C |
| H5A-I10 | C-Impl-5A Adapter単体                   | Content-Length早期拒否と実Byte累積、body_too_largeとcleanup完了を分離                                                                                                                         | HTTP-01・02、SG-01                         | EXP-11・12は合成上限32。本番値は暫定採用済み・実測確認待ち。圧縮等は未検証                           |
| H5A-I11 | C-Impl-5A Gate結合・C-Impl-5C           | AdapterはBackoff・Quota・Tx-A / Tx-Pを操作しない。停止・拒否・Abort等でも消費維持                                                                                                             | TQ-04、SG-03・04・08・09、HTTP-04〜07      | 5Aは副作用なしの結合検証、実Quota / SQLite・Tx-Aは5C。HTTP単独でPASSにしない                         |
| H5A-I12 | C-Impl-5A Adapter単体・公開境界レビュー | HttpOutcomeだけを公開しResponse / Stream / Reader / Secret / 元例外の漏洩なし                                                                                                                 | HTTP-07、SG-02                             | 型・返却値・ログは実Adapter実装時に検証                                                              |

### 工程別の検証責務・状態

| 工程                   | 主な検証対象                                                                                       | 実装・検証状態                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| C-Impl-5A Adapter単体  | 同期開始、Body単独所有、Timeout / Abort、HttpMetadata / Outcome、Body上限、H5A-I01〜06・08〜10・12 | 詳細設計確定、実Adapter未実装・受入未検証。前回EXPの限定的実測は上記に分離        |
| C-Impl-5A Gate結合     | Flight保持・解放、再入、同期throw、通知順序、停止競合、H5A-I01〜08・11                             | 既存Gate制御は実装済みで既存文書にFake試験記録あり。実Adapter結合は未実装・未検証 |
| C-Impl-5B              | Clock / History Trustの本番配線、停止理由・通知との接続                                            | 後続工程。既存Trust coreの単体実装と本番確認事実の供給を区別                      |
| C-Impl-5C              | Coordinator、Quota / SQLite、Tx-A開始競合、429 Backoff適用、H5A-I07・09・11、F-03                  | 後続工程・具体実装構造未確定。5A単独から統合PASSにしない                          |
| 後続実機・Provider検証 | Linux / Pi、実API、TLS / Proxy、運用・復旧、暫定値の妥当性                                         | 未検証。PR-D / PR-Eの既存責務も維持                                               |

### 実装時の重点結合シナリオ

- Gate.start前／Adapter内fetch前の証明済み失敗、native Promise Reject、fetch開始後の同期throwを分ける。終了通知なしではABORT_REQUESTEDを保持する。
- 適法なfinishがstartの返却前に発生する経路、finish後に内部例外が出る経路、Abort listenerやcleanupから再入する経路を検証する。finished / startingとcleanupAttemptedの意味を維持する。
- 通知による同期Flight解除後、Promise Fulfill／Coordinator継続前に別試行が来るスケジュールを作り、旧結果の保存許可・新旧判定をGateの空き状態から推論しない。
- 内部終端確定前、確定後／Lifecycle通知前、通知後／Promise配送前、配送後／Tx-A開始前の各境界に管理停止を置く。後続Abortで分類・メタデータを変更せず、新規Tx-Aは禁止。停止前に適法な開始登録・トークン消費済みのTx-Aだけ既存F-03で継続し、上位Shutdown・DB保護を優先する。
- timeout / Abort / cancelに未解決Promiseを注入し、結果Promise Pending・Flight保持を確認する。観測Timeoutで強制Fulfill／finishしない。
- 429のBody正常・通常読込失敗・サイズ超過の各結果でメタデータ保持と有効Retry-After引継ぎを検証する。500 Body失敗、429後のTimeout終了先行・制御Abort終了先行、確定後の後続通知も組み合わせ、H5A-I09の優先順位を検証する。待機計算とControl保存は5C側で確認する。
- Bodyなし、取消しReject、lock解放による人工的closed拒否を区別する。Content-Lengthなし・不正・圧縮等の実Byte検証とメモリ境界は追加試験へ残す。
- 送信失敗・未送信・AbortでもTQ-04の消費維持、AdapterからControlやDBへ副作用がないことを実Gate／Quota結合で確認する。ローカルHTTP単独を結合PASSとはしない。

## 解消した事項・残る未決事項

今回、HttpMetadataの独立保持と429 Body失敗時優先順位、4段階の通知／保存境界、正式受入H5A-I01〜12への正本整理を確定し、従来の「Body失敗メタデータは要確認」「内部確定記録のInterface未固定を理由に順序全体を未決」とした説明を更新した。新たな公開Callback・永続Table・独自終端時刻Tokenは不要とする。実装済み・テストPASSを意味しない。

| 未決事項・注意点                                                                                      | 確認工程                                                    |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 本番Body Byte上限は暫定採用済み。実験用32 bytesを流用せず、共通上限・Provider値の妥当性を最終確認する | C-Impl-5A実装時の境界検証・実Provider計測、後続Schedule統合 |
| EXP-08の原因、Node / Undici一般的再現性、最小再現                                                     | C-Impl-5Aの追加検証および後続環境検証。未解決時の保持は維持 |
| Linux / Pi、実Provider・TLS・ProxyのLifecycle挙動                                                     | 後続実機・Provider検証。Windowsローカル実測だけで保証しない |
| Signal原因と実際のfetch / readエラーの因果を確認する実装条件                                          | C-Impl-5AのFI・HTTP単体／Gate結合で、確定した優先順位を検証 |
| Coordinatorの具体構造、停止再確認・Tx-A開始登録の同期競合制御、厳格な停止完了追跡                     | C-Impl-5C以降。既存F-03境界を変えずに統合                   |
| Clock / History Trust本番配線・確認事実の供給                                                         | C-Impl-5B。既存core単体と本番確認を区別                     |
| 生fetch Promise返却と読めるソースコメントの明確化                                                     | C-Impl-5A実装時。シグネチャ・Gateアルゴリズムは維持         |
| 旧H5A-01〜23の確認不能な個別本文・番号対応                                                            | 過去観点として未照合。正式受入の必須IDへ推測で昇格しない    |

PR-Dの公開・Pending、PR-Eの継続Recovery / Backup、F-03の厳格な停止完了とStartup / Management Stop統合は既存境界を維持する。AdapterにDB・Backoff更新を移さず、不明な意味論をCodexが独断で補完しない。

## 今回の文書確認

PR #48初回作成時に最新main・関連PR・実装と前回実測ログを確認した。今回の修正は既存PR #48の最新Head・差分と関連契約を再確認し、対象2文書のC-Impl-5A説明のみを更新する。既存C-1 / C-2 / F-01〜03 / U-12・SG・HTTP・TQの本文・IDは維持し、Body失敗時の429優先順位を今回の追加確定事項として区別する。Architectureは既存の所有権境界が成立するため変更しない。

本番コード・テストコード・DDL・Migration・依存・Workflow・Issue #16は変更しない。今回はHTTP実験・既存テスト再実行・実機・実Provider通信は行っていない。PR #48の既存ブランチへ追加Commitし、新規PR作成・main直接Push・Mergeは行わない。

## C-Impl-5A実装・受入検証

基準mainはPR #49のMerge Commit `3d2967cfd338a8e53d6a1098e0644e09c4fba670`。上記の設計時点記録・EXP証拠を保持し、以下を新しい実装検証記録として追加する。H5A-I01〜12の本文・IDを再定義せず、5Aの担当範囲と後続5B / 5Cを区別する。

### 実装・Interface照合

- `src/backend/http/outcome.ts`に設計どおりのHttpMetadata / HttpOutcomeを定義した。statusと未解釈retryAfter、上限内Uint8Array以外のResponse / Reader / Stream / 元例外を外へ返さない。
- `http/internal/native-http-adapter.ts`のNativeHttpAdapterがBody・Reader・取消しを単独所有する。startは非asyncで同じ同期呼出し内にfetchを開始し、Headers Promiseは内部所有、外部へPromise<HttpOutcome>を返す。既存Promise<unknown>と互換であり、Gateのコード変更はInterfaceコメントの明確化だけ。
- `http/native-http-adapter.ts`のcreateHttpAdapter(config)はNode.js native fetch・AbortSignal.timeout(10_000)・AbortSignal.anyを使用する。Provider URL / Headers / maxBodyBytesの選択は外側で行う。本番Gate Factory・Trust・Coordinator・Startupへ結線しない。GETのnative fetch呼出しを提供するだけで、Domain Clientや実Provider API統合は追加しない。
- 設定URL・Headers・Byte上限は生成時に検証・固定する。maxBodyBytesは非負の安全整数・共通絶対上限1,048,576以下。0はBodyなしのみ許容する上限として扱う。Provider暫定値の自動選択やCalendarページ累積制御は追加しない。
- 実Byteを累積し、超過chunkは採用bufferへ入れず、responseは読み取り済みchunkをcopyして構築する。Content-Lengthは有効な非圧縮長の早期拒否補助だけに使い、Content-Encodingありでは展開後Byteの実検査を優先する。総メモリ上限保証ではない。
- native fetch同期throwは部分開始を否定できず、通知せずsanitized同期例外とする。fetch呼出し前のSignal準備失敗だけは所有HTTP処理なしと確認し、同期終了通知後にsanitized例外とする。Promise RejectはHeaders前の実fetch終了、Body readはreadと本来のclosedの終了を別々に確認する。
- 監視用Signal失効だけで終了にしない。エラーと合成Signal reasonのObject identityが一致する場合にのみTimeout / Abort因果を採用し、無関係なTypeError等を遡って変換しない。Windows native Body Timeout / Abortでreason identityを確認し、Fault Injectionでも一致・不一致と順序を検証した。実Provider・TLS・Proxy・他Runtimeで同じ因果表現になる一般保証はしない。
- read / cancelと、releaseLock前に取得した本来のreader.closedを確認する。Cancel Rejectだけで完了せず、本来のStreamエラーと同一の例外であること等を要求する。終了根拠が不足・矛盾すればPendingとし、lock解放で人工的な終了根拠を作らない。
- 終端分類・Metadataを固定し、所有処理終了確認→lifecycleEnded通知→結果Promiseのresolveを行う。通知後に追加の外部Callbackやawaitを挟まない。通知失敗等の内部違反は汎用ErrorでRejectし、元の例外やURL・Credentialを返さない。終了不明を成功・通知へ変換しない。

### 新規テスト一覧・証拠

すべての実通信は127.0.0.1の一時Port。Provider・APIキーは使用していない。

| ファイル                                  | 件数 | 主な検証                                                                                                                                                                                                              |
| ----------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tests/backend/http-adapter.test.ts        | 57   | 生成時検証、同期start、開始前／部分開始不明、fetch Reject、単独所有、Bodyなし、429 / 500、Abort / Timeout因果、Byte境界、Content-Length、Cancel Pending / Reject、readとclosedの独立終了、通知最大1回、内部例外非露出 |
| tests/backend/http-adapter-native.test.ts | 9    | native localhost 200 / 429 / 500、HeadersとBodyの別終了、Abort、切断Body、gzip展開後の上限ちょうど／超過、Headers後も同じ実10秒Timeout                                                                                |
| tests/backend/http-adapter-gate.test.ts   | 11   | Permit消費→fetch→Gate復帰の同期順序、再入、準備失敗・部分開始不明、Pending read / cancel、Abort保持、通知と配送の間の別試行・管理停止、finish後例外・cleanup異常、消費履歴維持・Control非更新                         |

Test Doubleはtests/support/http-adapter-fixture.tsとinternal HttpRuntime境界へ分離。本番createHttpAdapterにfetch / Timeout / Signalの注入設定を公開しない。既存send-gate-fixtureは変更せず再利用する。FIのPending観測にはイベント／PromiseとsetImmediateのcheckpointを用い、固定Sleep・無効化・本番の追加解放Timeoutを導入しない。

### H5A-I01〜12：今回の5A検証結果

PASSは記載のNode.js / localhost / FI / Gate結合範囲であり、実Provider・実機・5C統合を含まない。正式条件本文は上記の設計表を維持する。

| ID      | 結果       | 根拠・後続範囲                                                                                                                                                               |
| ------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H5A-I01 | PASS（5A） | 同じ同期呼出しでfetchを開始。native localhostと実Adapter＋Gate / FIの開始観測                                                                                                |
| H5A-I02 | PASS（5A） | Permit consume→fetch→Gate returnが先行し、queued microtaskはその後。Gateアルゴリズムは無変更                                                                                 |
| H5A-I03 | PASS（FI） | 証明済み準備失敗はSTARTING中の一度通知、native呼出し同期throw FIはABORT_REQUESTED保持。native実通信で同期throwを再現済みとはしない                                           |
| H5A-I04 | PASS（5A） | reader取得1回、clone / teeなし、Body Used・公開結果境界。Body / reader / cancelの外部引渡しなし                                                                              |
| H5A-I05 | PASS（5A） | Headers・Signal・cancel呼出しでは通知しない。read / closedの片方未解決、cancel未解決では保持                                                                                 |
| H5A-I06 | PASS（5A） | 正常・異常・後続Abort / Timeout・再入・通知後throwで通知最大1回。内部違反はsanitized Reject                                                                                  |
| H5A-I07 | 部分検証   | 終端固定・通知・配送順序と通知間隙の管理停止／別試行をFake結合で確認。実CoordinatorのTx-A開始再判定・F-03登録競合は5C未検証                                                  |
| H5A-I08 | PASS（5A） | native全体10秒とFI。Timeout後のread / closed未解決、Abort後やCancel未終了は結果Pending・Flight保持。EXP-08の根本原因解決・永久停止を一般証明しない                           |
| H5A-I09 | 部分検証   | 429正常・Body失敗／超過時のMetadata、500 Body失敗、因果確認できるTimeout / Abort先行、確定後不変を確認。Retry-Afterは未解釈文字列であり、Backoff適用・Tx-Aは5C未検証         |
| H5A-I10 | PASS（5A） | 256 KiB／1 MiBの−1／ちょうど／＋1、生成時上限、変化する設定getter固定、Content-Length欠損・不正・不一致、実累積、gzip展開後、超過後cleanup待機。実Providerサイズ計測は未実施 |
| H5A-I11 | 部分検証   | AdapterにDB / Quota / Backoff処理なし。実Gate＋一時SQLiteで部分開始不明・Timeout・Abort・cleanup異常でも消費保持・Control非更新。Coordinator全経路・Tx-A / Tx-Pは5C未検証    |
| H5A-I12 | PASS（5A） | HttpOutcomeのみを公開。URL / HeadersのSynthetic Secret・元例外をエラー／Metadataへ露出しない。Adapterからログへraw情報を送らない構造                                         |

### 品質確認・変更範囲

新規77件。Windows全体755件成功・Linux専用47件Skip（計802件）。Lint / Format / Type Check / Backend Build成功。Linux CI結果はPRへ記録する。これらは今回実装後の結果であり、上記の過去EXP実測を再実行した結果ではない。

新規Adapter3ファイル、テスト3ファイル、test fixture1ファイルと本書の追記・整形、GateのInterfaceコメントだけを変更する。Gateの実行アルゴリズム・状態遷移、Quota Repository / Guard、Schema / Migration / Transaction、Scheduler、Control、Trust、既存テスト、依存・Workflow、設計正本technology-stack.mdの正式本文は変更しない。main由来の本書のPrettier未整形は内容不変の整形で解消した。

### 未解決事項・5B / 5Cへの引継ぎ

- C-Impl-5BのClock / History Trust本番配線・確認事実の供給は未実装。RTC-only条件やHistory回復手順を独自に決めず、本番GateはFail Closedを維持する。
- C-Impl-5CのCoordinator・Quota / SQLite・Tx-A登録競合・HTTP 429 Backoff適用・F-03管理停止を未実施として維持する。結果Promise受信やGate解放を保存許可とみなさない。
- 実Provider API / APIキー / Domain変換、Linux / Raspberry Pi実機、TLS / Proxy、Calendar累積制限、実Providerサイズ・長期性能、PR-D / PR-Eは未実施。Linux CIのlocalhost試験とPi実機を混同しない。
- 終了証拠が足りない場合は意図的にPendingとなる。EXP-08の原因・一般的再現性は未解決。追加Timeout・推測による解放を導入しない。
- 任意Runtimeがnativeと異なるError identityを返す場合はTimeout / Abortと断定せず、確認されたnetwork_error / body_errorまたは終了未確認の保留として扱う。対応Runtimeの拡大は因果・終了根拠の検証を伴う。
- 実装PRは未Merge・レビュー待ち、Issue #16・PR-C全体は継続中。

### PR #50追加修正：Lifecycle終了条件の確定

通知条件を、通信終了・Adapter所有処理完了・Reader lock解放の3条件がすべて確認できた場合に限定した。reader.closedのsettleだけでlock解放とはみなさない。Bodyを取得した経路では、native ReadableStreamのbrand-checking locked getterで解放を確認し、通知直前にも再確認する。解放前throw、解放しないreturn、再lock、確認不能は通知せずFlightを保持する。

正常読了・Bodyエラー・サイズ超過の各経路で、read / cancel / 本来のclosedの終了と、lock解放を別々に扱う。実際の解放後throwで3条件が成立した場合のみ最大1回通知し、結果は元例外・秘密情報を含まないsanitized ErrorでRejectする。正常なHttpOutcome・429 Metadata・Timeout / Abortの分類と優先順位は変更しない。通知済み状態はCallback前に固定し、再入・追加Abort / Timeout・通知例外でも再通知しない。

追加18件：Adapter FI11件、実Gate結合7件。3経路×解放前／後の6ケースを両層で検証し、通知0／1回・Flight保持／解放・sanitized Reject・Quota履歴保持・Control非更新を確認する。追加でnative lock状態の偽装拒否、解放なしreturn、同期／microtask再lock、通知例外、通知後の次回試行への再入を確認する。既存の終了未確認read / closedテストはnative Readerのlock関係を保つFIへ変更した。H5A-I05 / I06 / I08の追加境界を検証し、正式条件本文・IDは変更しない。

Gateアルゴリズム、Quota、SQLite、Coordinator、Backoff、F-03と本番Trust配線は変更しない。故障注入による確認であり、実Provider・Pi実機での検証ではない。終了・所有権の根拠不足時のFail Closedと既存の後続範囲を維持する。最新の全体検証・Linux CI結果はPR #50へ記録する。
