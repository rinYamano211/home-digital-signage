# C-Impl-5A HTTP Adapter / Lifecycle：詳細設計・実測・検証計画

設計正本は[technology-stack.md §23.11](../technology-stack.md#pr-c-c-impl-5a-http-lifecycle)、同§23.3・23.8・23.10・F-03、[architecture.md](../architecture.md)。基準mainはe9259f670a8033a57f1b9d4d4905ab6cf32f67ab。Issue #16 / PR-C全体を完了扱いにしない。本書は今回の文書反映、前回のローカル実測、既存コード読取り、未実装の受入計画を区別する。

## 参照範囲と採用状態

- [既存Gate](../../src/backend/send/internal/provider-send-gate.ts)、[本番Factory](../../src/backend/send/provider-send-gate.ts)、[Trust](../../src/backend/send/internal/trust.ts)、[Permit](../../src/backend/send/internal/permits.ts)を読み取った。
- [C-Impl-2の契約・検証範囲](c-impl-2-acquisition-control.md)、[C-Impl-4の契約・検証範囲](c-impl-4-send-gate-trust.md)、Quota Repository / Guard、Schedulerと関連テストを照合した。今回は既存テストを再実行していない。
- 案A（AdapterによるBody・Lifecycle単独所有）、同期fetch開始、HttpOutcome基準型、終了確認後の通知／結果配送順序を正本に記録した。本番Adapterのコード・受入テストは未実装である。
- 本番FactoryはHTTP Adapterなし・未確認TrustでFail Closedのまま。今回送信可能にせず、Coordinator / Fastify / Startupへ接続しない。

## Interface・結果・所有権

HttpStartAdapter.start(signal, lifecycleEnded): Promise<unknown>は維持し、実Adapterの結果PromiseをHttpOutcomeに特殊化する基準案を正本へ記録した。HTTP 429・500もresponse、retryAfterは未解釈Header、bodyは設定上限内のUint8Array。失敗はnetwork_error / timeout / aborted / body_error / body_too_largeである。Response・Reader・Stream・Secret・元の例外を結果にしない。JSON Parse・Domain Validation・Backoff・Tx-A / Tx-P・Quota更新は責務外である。

生のfetchはHeaders時点のPromiseを返すが、案Aはそれを内部所有し、Body処理の完了を待つ結果Promiseを外部へ返す。現行GateはPromise<unknown>を受け、成否でFlightを解放しないため、型と制御は整合する。一方、Interfaceの既存コメントにある「そのfetchのPromiseを返す」という表現は、結果Promiseとの同一性を要求するようにも読める。実装時にコメント・説明を明確化する要修正事項であり、今回はGateコードやシグネチャを変更していない。架空の別公開Interface・永続Tableは追加しない。

設定検証は原則生成時。startは同じ同期呼出し内でfetchを実行し、Headers以降の非同期処理を分離する。事前準備がSignalやRequest構築を伴う場合も、Permit消費後にawaitで開始を遅らせない。開始前の例外、fetchのReject、部分開始を否定できない同期throwを混同しない。

## 現行Gateの終了・throw・再入のコード照合

| 経路 | 実際の制御と必要な検証 |
|---|---|
| Adapter呼出し前 | slot.flightにSTARTING、starting=trueを登録済み。同期待機／再入時も占有を見せる |
| start中の同期finish | finished=trueだけを記録。starting中は解除しない。適法な終了根拠なしにAdapterから呼ばない |
| Promiseを正常返却 | starting=false、必要ならIN_FLIGHTへ。finishedならfinishを再評価して解除・Attempt cleanup |
| PromiseのFulfill / Rejectのみ | Flightは解除しない。既存Fakeテストはこの保持を検証するが、実Body処理の証拠ではない |
| start同期throw・未通知 | catchでABORT_REQUESTED・Abort要求・Attempt失効／cleanup。Flightを保持し、http_start_failedを返す |
| 適法な同期finish後のthrow | catchの安全処理後にfinishedなら解除可能。未開始が証明済み／全所有処理終了済み以外でfinishしない |
| start返却後のfinish | Flightを同期解除しcleanupする。通知と結果Promise配送の間の新規開始をテストで観測する |
| cleanup異常 | cleanupAttemptedで再試行・二重処理を抑止。Provider停止理由が残り、Flight解除だけでは送信再開しない |

既存tests/backend/provider-send-gate.test.tsには同期再入、同期開始例外、Promise Rejectのみでは終了しないこと、停止・cleanup異常のFake試験が存在する。今回はそのソースを確認しただけであり、追加したH5A-I条件や実Adapter結合がPASSしたとはしない。

現行Gateのアルゴリズムに必須の安全性変更は今回の読取りで特定していない。Interfaceコメントの整合、同期終了通知とthrowの組合せ、通知間隙の再入は実装前／実装時の要確認である。終了不明を解放する方向へGateを変更しない。

## U-08・C-2・F-03との順序整合

次の3段階を分ける。

1. Adapter内部で最初のHTTP終端結果を確定する。Headers、Timeout通知、Abort要求だけでは確定しない。
2. 全所有処理の終端を確認してlifecycleEndedを最大1回通知する。
3. HttpOutcome PromiseをFulfillしCoordinatorが結果を受け取る。

通常経路では1→2→3とし、結果確定後の後片付けAbortで結果を変更しない。終了未確認なら2・3を行わず、結果候補があってもPromise Pending・Gate保持を維持する。予期しない内部契約違反のRejectは正常なHttpOutcome通知と区別し、終了確認の代用にしない。

Gate解放時刻はHTTP終端の内部確定時刻でもCoordinatorの受信時刻でもない。finishは同期解除・Quota Attempt cleanupを伴うため、通知とPromise配送の間に、別の正常試行が開始できる可能性がある。これを結果の古さ・保存許可・Tx-A開始許可として扱わず、C-2の取得試行直列化・新旧判定・Evidence / Authorization、F-03の停止境界、PR-Dの公開条件を独立に維持する。

停止前に内部確定しても、停止後の新規Tx-Aを許可しない。Promise受信を内部確定に読み替えず、必要な信頼された試行記録・停止との順序をCoordinator統合前に照合する。既に適法に開始済みのTx-AだけをF-03で扱い、AdapterがTx-Aを開始しない。内部確定記録の具体Interfaceは未固定で、HttpOutcomeに推測で情報を追加しない。F-03のTx-A開始境界・Commit分類・Pending・厳格な停止完了は変更しない。

## 前回のNode.js 24実測を再確認した証拠

Work成果物http-lifecycle-20261101のreport.md・timelines.md・results.json・events.jsonl・experiment.mjs・timeout-probe.jsonへアクセスでき、今回本文・生ログ・スクリプトを読み直した。今回はHTTP実験を再実行していない。成果物はWork内に保存され、GitHubへ生ログ一式を追加したものではない。本書には追跡用の要約・代表時系列・SHA-256を記録する。

| 環境・範囲 | 確認内容 |
|---|---|
| 実行環境 | Windows 11 Home x64 / 10.0.26200、Node.js 24.14.0、npm 11.9.0、Undici 7.21.0 |
| 標準API | fetch・AbortSignal.timeout・AbortSignal.anyが利用可能 |
| 主実験 | EXP-01〜18、variantとFault Injectionを含む35ケース、127.0.0.1のみ |
| 独立追試 | 合成Timeout2ケース、明示Request保持variant1ケースの計3ケース |
| 非対象 | Linux / Pi、TLS / Proxy、実Provider、実APIキー、実Quota DB、本番Gate統合 |
| 失敗試行の分離 | sandboxのEACCES試行はHTTP証拠から除外。最初の実通信run中断ログは別保存 |

| EXP | 観測事実・検証境界 |
|---|---|
| 01 | 200・11 bytesを正常読了。実Adapter完了ではない |
| 02 | fetch Fulfill約1.402ms、Body読了150.763ms。HeadersとBodyは別 |
| 03 | 204はResponse.body=null。Domain Dataの成功を保証しない |
| 04 | 429でもfetch Fulfill、Retry-After=12。Backoff保存の結合なし |
| 05 | 500でもfetch Fulfill。HTTP status判定と通信例外を分離 |
| 06 | Headers前Abort要求39.578ms、fetch拒否41.558ms。要求時点は未解決 |
| 07 | Abort要求52.050ms、closed拒否52.838ms、read拒否52.852ms |
| 08 | 合成Signal失効後もread / closedが観測上限で未解決。下記で別記 |
| 09 | 短い合成TimeoutでGate先行・Timeout先行を確認。全経路の保証ではない |
| 10 | cancel呼出し32.504ms、Body終了32.985ms、cancel Promise完了32.995ms。呼出しと完了は別 |
| 11 | 実験上限32 bytesに対しContent-Length=128で早期拒否・cancel。32を本番値にしない |
| 12 | Content-Lengthなし、実受信48 bytesで上限32超過を検出しcancel |
| 13 | Server切断後にread / closedがTypeError拒否。物理ネットワーク終了の一般保証ではない |
| 14 | 正常終了先行・Abort先行を確認。近接同設定3回は読了1回・Abort2回。固定順序を保証しない |
| 15 | AbortとTimeoutの先行別を確認。実験の同時設定で常に同じ順になるとは結論しない |
| 16 | 不正URL・TRACE・不正signal・例外getterはPromise Reject。native fetch同期throwは未再現。Request構築の同期throwとAdapter途中throwのFIは別 |
| 17 | fetch解決後にBody停滞。約10秒でreadが拒否した例。08を否定する証拠ではない |
| 18 | cancel遅延・cancel未解決・read未解決の明示FI。130ms観測内の保持を確認し、native Undiciの永久停止とはしない |

### EXP-08：事実・再現差・原因・安全側動作

| 区分 | 内容 |
|---|---|
| 観測された事実 | 総合ハーネスで合成Signalの10秒Timeout後もBody read / reader.closedが残る例を2runで観測。最初は中断、次は記録後に実験Serverを切断 |
| 主runの時系列 | fetch Fulfill 1.790ms → 合成SignalのTimeout失効10001.214ms → 観測上限11000.703msでもclosed / read pending → Server後片付け11000.816ms → read拒否11001.975ms（TypeError / UND_ERR_SOCKET） |
| 再現していない事実 | 独立した合成Timeout追試3ケースは約10秒でTimeoutError拒否し、強制後片付けなし。直接timeoutの主run variantも終了した |
| 原因未特定 | GC・参照保持・接続再利用・Undici・Windows・ハーネス等への原因帰属は未確定。Request保持を解決策と断定しない |
| ログ分類の限界 | 実験ラッチterminal=timeoutは失効reasonを使用した分類。Server切断後のTypeErrorを、Timeoutだけで終端した証拠に数えない |
| 採用する安全側動作 | Signalだけで結果・Lifecycle・Gate解放を確定しない。所有read / cancel等の終了未確認ならFlightと結果Promiseを保持 |
| 保証しないこと | 追加1秒の観測上限は本番の解放条件ではない。10秒以内の強制drain、物理TCP切断、Provider側終了を保証しない |

### 成果物照合用SHA-256

| Work成果物名 | SHA-256 |
|---|---|
| report.md | 8EFDF3F5A2FAED8B5F8B37BDA9043A6628572F151D051C6CFABF06FE9EB934FD |
| timelines.md | B7AC2547CDC1088BBF5E7D4A4A0E8F564070B47DFABE886020459072C6083925 |
| results.json | B9D237B76597D158B9357A7993A29A54B1628CD6688562251C1B5FDAF3BAB51A |
| events.jsonl | 84DC2CA388C89C8759786C86419D0BEDDBBD5C91DF6768936DE4ECF9E7225079 |
| timeout-probe.json | 31DC74293BED31236F56D84D7DDAD5E2430DFDC13D0BDFEF7BE0E5974E76E7FA |
| experiment.mjs | 7F80D872E341BCB3E0EAAD65D47AB0A263FFF7D068DDAFBB467FA2C50BE33063 |

実測ログはApplicationの観測であり、Server側Request / Response Closeは補助証拠に留める。Request closeはRequest受信完了でも発生し、Response BodyやClientの終了証明ではない。標準APIの意味は[Node.js 24.14.0 Globals](https://nodejs.org/download/release/v24.14.0/docs/api/globals.html)・[Web Streams](https://nodejs.org/download/release/v24.14.0/docs/api/webstreams.html)も参照し、仕様説明を本番実測成功へ置き換えない。

## H5A-01〜23：既存条件の分類・追跡状態

最新main・指定資料・repository検索と前回成果物には正式な条件本文を確認できなかった。前回のH5A表も番号だけを保持した「正式ID判定未検証」であり、今回それを確定条件として流用しない。ユーザーへ本文または参照先を照会済み。次のIDを保持するが、未取得の意味を推測してHTTP単体等へ割り振らない。

| ID | 分類 | 状態 | 理由・対応 |
|---|---|---|---|
| H5A-01 | 分類保留 | 未検証（正式ID判定） | 正式条件本文未取得。HTTP単体・Gate結合・Quota / SQLite結合・後続Coordinatorの個別割当を推測しない。 |
| H5A-02 | 分類保留 | 未検証（正式ID判定） | 正式条件本文未取得。HTTP単体・Gate結合・Quota / SQLite結合・後続Coordinatorの個別割当を推測しない。 |
| H5A-03 | 分類保留 | 未検証（正式ID判定） | 正式条件本文未取得。HTTP単体・Gate結合・Quota / SQLite結合・後続Coordinatorの個別割当を推測しない。 |
| H5A-04 | 分類保留 | 未検証（正式ID判定） | 正式条件本文未取得。HTTP単体・Gate結合・Quota / SQLite結合・後続Coordinatorの個別割当を推測しない。 |
| H5A-05 | 分類保留 | 未検証（正式ID判定） | 正式条件本文未取得。HTTP単体・Gate結合・Quota / SQLite結合・後続Coordinatorの個別割当を推測しない。 |
| H5A-06 | 分類保留 | 未検証（正式ID判定） | 正式条件本文未取得。HTTP単体・Gate結合・Quota / SQLite結合・後続Coordinatorの個別割当を推測しない。 |
| H5A-07 | 分類保留 | 未検証（正式ID判定） | 正式条件本文未取得。HTTP単体・Gate結合・Quota / SQLite結合・後続Coordinatorの個別割当を推測しない。 |
| H5A-08 | 分類保留 | 未検証（正式ID判定） | 正式条件本文未取得。HTTP単体・Gate結合・Quota / SQLite結合・後続Coordinatorの個別割当を推測しない。 |
| H5A-09 | 分類保留 | 未検証（正式ID判定） | 正式条件本文未取得。HTTP単体・Gate結合・Quota / SQLite結合・後続Coordinatorの個別割当を推測しない。 |
| H5A-10 | 分類保留 | 未検証（正式ID判定） | 正式条件本文未取得。HTTP単体・Gate結合・Quota / SQLite結合・後続Coordinatorの個別割当を推測しない。 |
| H5A-11 | 分類保留 | 未検証（正式ID判定） | 正式条件本文未取得。HTTP単体・Gate結合・Quota / SQLite結合・後続Coordinatorの個別割当を推測しない。 |
| H5A-12 | 分類保留 | 未検証（正式ID判定） | 正式条件本文未取得。HTTP単体・Gate結合・Quota / SQLite結合・後続Coordinatorの個別割当を推測しない。 |
| H5A-13 | 分類保留 | 未検証（正式ID判定） | 正式条件本文未取得。HTTP単体・Gate結合・Quota / SQLite結合・後続Coordinatorの個別割当を推測しない。 |
| H5A-14 | 分類保留 | 未検証（正式ID判定） | 正式条件本文未取得。HTTP単体・Gate結合・Quota / SQLite結合・後続Coordinatorの個別割当を推測しない。 |
| H5A-15 | 分類保留 | 未検証（正式ID判定） | 正式条件本文未取得。HTTP単体・Gate結合・Quota / SQLite結合・後続Coordinatorの個別割当を推測しない。 |
| H5A-16 | Gate / Quota・SQLite結合（集合として確認） | 未検証（正式ID判定） | 依頼の範囲指定で結合観点であることは確認。各IDの個別定義・割当は本文照合待ち。HTTP単独でPASSにしない。 |
| H5A-17 | Gate / Quota・SQLite結合（集合として確認） | 未検証（正式ID判定） | 依頼の範囲指定で結合観点であることは確認。各IDの個別定義・割当は本文照合待ち。HTTP単独でPASSにしない。 |
| H5A-18 | Gate / Quota・SQLite結合（集合として確認） | 未検証（正式ID判定） | 依頼の範囲指定で結合観点であることは確認。各IDの個別定義・割当は本文照合待ち。HTTP単独でPASSにしない。 |
| H5A-19 | Gate / Quota・SQLite結合（集合として確認） | 未検証（正式ID判定） | 依頼の範囲指定で結合観点であることは確認。各IDの個別定義・割当は本文照合待ち。HTTP単独でPASSにしない。 |
| H5A-20 | 分類保留 | 未検証（正式ID判定） | 正式条件本文未取得。HTTP単体・Gate結合・Quota / SQLite結合・後続Coordinatorの個別割当を推測しない。 |
| H5A-21 | 分類保留 | 未検証（正式ID判定） | 正式条件本文未取得。HTTP単体・Gate結合・Quota / SQLite結合・後続Coordinatorの個別割当を推測しない。 |
| H5A-22 | 分類保留 | 未検証（正式ID判定） | 正式条件本文未取得。HTTP単体・Gate結合・Quota / SQLite結合・後続Coordinatorの個別割当を推測しない。 |
| H5A-23 | 分類保留 | 未検証（正式ID判定） | 正式条件本文未取得。HTTP単体・Gate結合・Quota / SQLite結合・後続Coordinatorの個別割当を推測しない。 |

正式本文の確認後、HTTP単体／Gate結合／Quota・SQLite結合／後続Coordinator統合へ分類し、H5A-I表とEXP証拠へ対応付ける。今回既存23条件の置換・番号再定義は行わない。実測で確認した個別観点と、本番受入条件への正式対応は区別する。

## H5A-I01〜12：追加のInterface設計受入条件

すべて**実Adapterの実装・受入テストは未実施**。前回の実測、既存Gate Fake試験の記録、今後の本番結合を区別する。同じ観点は既存SG・HTTP・TQ等の試験を拡張・再利用でき、ID数だけ独立テスト関数を増やす義務ではない。

| ID | 分類 | 条件・期待結果 | 既存契約対応 | 証拠・未完了範囲 |
|---|---|---|---|---|
| H5A-I01 | HTTP単体＋Gate結合 | 有効startの同一同期呼出し内でfetchを開始し、native Promise互換の結果Promiseを返す | SG-02・05 | EXP-16は入力Reject・FIのみ。実AdapterとGate結合は未実装 |
| H5A-I02 | HTTP単体＋Gate結合 | Permit消費からfetch呼出しまでawait・非同期開始遅延なし | SG-02・07 | 呼出し順序計測と同期再入試験を追加予定。未実施 |
| H5A-I03 | HTTP単体＋Gate結合 | 同期throwは未開始証明と部分開始不明を分離。http_start_failed / ABORT_REQUESTED維持 | SG-01・03・05、TQ-04 | EXP-16は部分検証。native同期throwは未再現。既存GateのFake試験を実Adapterへ拡張する |
| H5A-I04 | HTTP単体 | AdapterだけがBody / reader / cancelを所有し二重消費・外部Stream流出なし | HTTP-01、SG-01 | EXP-01〜13は実験ハーネスの観測。本番所有権は未実装 |
| H5A-I05 | HTTP単体＋Gate結合 | Headers・Abort・Timeout・cancel呼出しだけでは通知せず、全所有処理の終端を要求 | HTTP-01〜03、SG-01 | EXP-02・07・08・10・17・18。EXP-08は未解決現象、結合未検証 |
| H5A-I06 | HTTP単体＋Gate結合 | 正常・異常・近接競合・再入を通じLifecycle通知は最大1回 | HTTP-02・03、SG-01・05 | 実験の結果ラッチと本番通知の一度限りを区別。本番未検証 |
| H5A-I07 | Gate結合＋後続Coordinator統合 | 内部結果確定→drain確認→通知→Promise Fulfill。通知による同期解放と間隙の再開始を検証 | HTTP-02・07、SG-01・02・05、F-03 | 実装前の重要結合条件。停止時刻・結果配送・Tx-A許可を混同しない。未実施 |
| H5A-I08 | HTTP単体＋Gate結合 | 終了未確認Timeout / AbortはPending・占有維持。10秒経過やRejectだけで通常完了としない | HTTP-01〜03、SG-01・06・09 | EXP-08とEXP-18が保持の必要性を示す。実Gate結合は未実施 |
| H5A-I09 | HTTP単体＋後続Coordinator統合 | 429 / 500をresponseとして返し、retryAfterを未解釈で渡す。Body障害時メタデータは要確認 | HTTP-04、SCH-02・03 | EXP-04・05でHeaders・Body確認。Backoff / Retry-After保存の結合なし |
| H5A-I10 | HTTP単体 | Content-Length早期拒否と実Byte累積、body_too_largeとcleanup完了を分離 | HTTP-01・02、SG-01 | EXP-11・12は32-byte合成上限。本番値・圧縮等は未確定／未検証 |
| H5A-I11 | Gate結合＋Quota / SQLite結合＋後続Coordinator統合 | AdapterはBackoff・Quota・Tx-A / Tx-Pを操作しない。停止・拒否・Abort等でも永続消費維持 | TQ-04、SG-03・04・08・09、HTTP-04〜07 | 今回DB・Quotaを実行せず。HTTP単独からPASSとしない |
| H5A-I12 | HTTP単体＋公開境界レビュー | HttpOutcomeだけを公開しResponse / Stream / Reader / Secret / 元例外の漏洩なし | HTTP-07、SG-02 | 型・返却値・診断ログの検証は本番実装時。未実施 |

### 実装時の重点結合シナリオ

- Gate.start前／Adapter内fetch前の証明済み失敗、native Promise Reject、fetch開始後の同期throwを分ける。終了通知なしではABORT_REQUESTEDを保持する。
- 適法なfinishがstartの返却前に発生する経路、finish後に内部例外が出る経路、Abort listenerやcleanupから再入する経路を検証する。finished / startingとcleanupAttemptedの意味を維持する。
- 通知による同期Flight解除後、Promise Fulfill／Coordinator継続前に別試行が来るスケジュールを作り、旧結果の保存許可・新旧判定をGateの空き状態から推論しない。
- 内部終端確定→通知→配送の各間に管理停止を置く。後続Abortで確定済み結果を変更せず、停止後の新規Tx-Aは開始しない。上位Shutdown・DB保護は優先する。
- timeout / Abort / cancelに未解決Promiseを注入し、結果Promise Pending・Flight保持を確認する。観測Timeoutで強制Fulfill／finishしない。
- 429 / 500、Bodyなし、Bodyエラー、サイズ超過、取消しReject、lock解放による人工的closed拒否を区別する。Content-Lengthなし・不正・圧縮等の実Byte検証とメモリ境界は追加試験へ残す。
- 送信失敗・未送信・AbortでもTQ-04の消費維持、AdapterからControlやDBへ副作用がないことを実Gate／Quota結合で確認する。ローカルHTTP単独を結合PASSとはしない。

## 未決事項・実装前確認

1. H5A-01〜23の正式条件本文・個別分類・既存受入との対応。
2. 設定する本番Body Byte上限。実験用32 bytesを流用しない。圧縮・展開済みByte・内部buffer・JSON展開の総メモリを保証しない。
3. 合成SignalのEXP-08未終了の最小再現・原因と、Node 24別patch／Linux／Piでの追加検証。未解決時保持の安全条件は緩和しない。
4. Signal原因と実際のfetch / readエラーの対応を確認する実装条件。Signal失効だけで後続の任意エラーをtimeout / abortedへ分類しない。
5. HttpOutcomeのbody_error / body_too_largeではstatus・retryAfterが消える。429 Body失敗時にも既存C-2の有効Retry-After尊重を維持する引継ぎが必要。機密を含まないHTTPメタデータを信頼された経路で保持する修正案をレビューするが、今回勝手な型拡張・C-2変更はしない。
6. 内部終端確定記録・停止順序とCoordinatorの接続。Promise配送時刻への読み替え禁止、Gate占有をTx-A許可として利用しないこと。
7. 生fetch Promiseを返すように読める既存コメントの明確化。型・Gateアルゴリズムは維持し、結果Promise・Body所有権へ説明を合わせる。

上記を実装前にレビューし、不明な意味論をCodexが独断で補完しない。今回の文書でC-Impl-5A全体が実装可能と無条件に承認されたとは扱わない。C-Impl-5以降のCoordinator / HTTP Client本番配線、F-03の厳格な停止完了、Startup / Management Stop、PR-D・PR-E、実Provider・Pi検証は後続工程へ維持する。

## 今回の文書確認

GitHubの最新mainとOpen PR一覧を取得して関連PRなしを確認。コード・既存テスト・検証文書を読み取り、前回Workの実測ログを再確認した。設計正本はC-Impl-5A小節の追加のみ、既存C-1 / C-2 / F-01〜03 / U-12・SG・HTTP・TQの本文・IDを維持する。Architectureは既存の所有権境界が成立するため変更しない。

本番コード・テストコード・DDL・Migration・依存・Workflow・Issue #16は変更しない。今回はHTTP実験・既存テスト再実行・実機・実Provider通信は行っていない。文書専用PRを作成し、Mergeしない。
