# PR-C-2B-4A：Schema v3 Startup本番配線・安全な起動状態

## 基準・既存コード調査

基準mainは`2a46d5e192420dfbbf4d152fbea8662b16ab1dd2`（PR #63 Merge済み）。UI / FrontendのPR #58・#60・#62・#64を保持し、専用Backend Branchで作業する。正本は[技術設計D-01〜D-04](../technology-stack.md#pr-c-c-impl-5b4-d01)、[Architecture](../architecture.md)、[Requirements](../requirements.md)、[H54検証計画](c-impl-5b4-history-trust-restart-recovery.md)、[Atomic Startup検証](pr-c-2b3-atomic-startup.md)。

| 分類     | 既存内容                                                                            | 今回                                      |
| -------- | ----------------------------------------------------------------------------------- | ----------------------------------------- |
| 実装済み | Schema v3・明示Migration・Boot ID取得、限定v3 Store、Atomic Startup                 | そのまま再利用。Transactionの重複実装なし |
| 実装済み | Config・EX、Fastify /ping、installShutdown、10秒期限、Signal処理機会                | 維持                                      |
| 未配線   | startBackendの通常v2 Store Open                                                     | 限定v3 Store Openとstartup.executeへ変更  |
| 後続     | Clock / History Trust・Recovery / Plan D・Runtime Provisioning・CLEAN・Provider送信 | 未実装を維持                              |

既存検証記録にある「v2 Runtime」「v3通常起動BLOCKED」は当時の実装状態であり、このPRで本番起動だけをv3へ進める。過去記録や共通設計正本を全面更新しない。v2用BackendStore.open()・Repository / Migrationの単体契約は変更せず、本番経路からは呼び出さない。

## 本番Startupシーケンス

1. Config検証・Logger生成、専用EX検証。
2. Routes未登録のFastifyとShutdown Handlerを準備。Close hookは初期化の終了を待つ。
3. Signal処理機会と要求確認後、BackendStore.openV3ForStartup(lock)を呼ぶ。
4. 返されたStoreを単一Close所有者へ渡し、Open中に到着したSignalを処理する。
5. Shutdown未要求ならstorage_startup_beginを記録し、再度Signal処理機会を設ける。
6. EXを再確認し、既存readOsBootId() / normalizedBootId()で検証済みBoot IDを取得する。
7. startup.execute({ bootId })を1回だけ呼び、StartupResultをDatabaseStatusへ変換する。
8. 同期Startup中に保留されたSignalを処理してから初期化完了を通知する。
9. Shutdown要求時はRoutes登録・Listenを行わず、既存Shutdownへ合流する。
10. 安全に継続可能な場合は既存Routesを登録しListen。終了時はClose hookがStoreを1回Closeする。

本番main entryはstartBackend()を1回呼び、StartupのLoop・Retry・Store再Open / 通常Runtime Storeへの切替はない。StartupTransactionService自体の同一Connectionでの再試行禁止も維持する。

## v3 Store・Boot ID・送信境界

本番は限定Facadeだけを保持する。startupComplete=falseのままで、raw Connection・任意SQL・Quota Writer・HTTP Client・Send Permitを公開しない。Store / StartupTransactionService / Schema / DDL / Migrationのコードは変更しない。

v3必須、fileMustExist、EX、WAL / synchronous FULL / FK、Schema厳密検証を既存Openへ委譲する。DBの自動生成・v2 Upgrade・同Version修復は禁止。v2からの明示Migrationは別の管理工程であり、この本番配線が実運用DBへ実行するものではない。

OS Boot IDは既存のLinux固定取得元を利用する。要求取得に失敗・不正ならStartupを実行せずBLOCKED。固定値・環境変数・乱数で代替しない。Transaction内の実OS IDとの再照合も既存実装を維持する。テストのOS入力はテストModule Mockに限定し、本番オプションとして追加しない。

## Database Status・Connectivity

| 結果                   | DatabaseStatus                        |
| ---------------------- | ------------------------------------- |
| committed              | HEALTHY（Storage Startup Commitのみ） |
| rejected               | BLOCKED / L3                          |
| database_error L1 / L2 | DEGRADED / 対応Layer                  |
| database_error L3 / L4 | BLOCKED / 対応Layer                   |
| unknown                | BLOCKED / L4、今回Startup証拠を不採用 |
| Boot ID取得不能・不正  | BLOCKED / L3、Startup未実行           |

DatabaseStatus型のLayerにL4だけを追加した。既存classifyDatabaseError()の分類ロジックは変更しない。Store Openで既存L1〜L3分類が可能なら従来どおりDegraded / Blocked起動する。未分類Storage / OS例外やLock喪失を正常化せず、従来の安全側起動失敗を維持する。StartupResultとして明示されたL4はBLOCKEDへ変換し、既存共有blocked / unresolvedを解除しない。

storage_startup_committedはcommittedのときだけ記録する。database_statusとstartup_completeはStorage状態とHTTP Listenの記録であり、Clock / History Trust・Recovery承認・Provider送信可能性を示さない。

GET /pingは従来の200 / {"message":"pong"}を維持する。安全にHTTPを継続できるDEGRADED / BLOCKEDでもConnectivityを提供する。Health / Readiness・Published State APIは追加しない。返り値にもStore・Trust・Permitを追加しない。

## Shutdown・所有権

返されたStoreは、Openが非同期テスト注入で遅延した場合もClose hookだけが所有する。hookは初期化完了まで待ち、所有変数から切り離してCloseする。これによりShutdownと一時的な取得Storeのfinallyが別々にCloseする経路をなくし、Close漏れ・二重Close・Close失敗の消失を防ぐ。

Close成功時だけdatabase_closedを記録する。Close例外はFastify CloseのRejectとしてinstallShutdownへ伝え、shutdown_failed / exit 1を維持する。Closeの自動再試行はしない。

同期SQLite実行をOS SignalやJS Timerで即時中断できるとは扱わない。Open前後・Startup直前・直後で既存のsetImmediateによるSignal処理機会とrequested確認を行う。同期処理中に到着したSignalは処理後に受け、Listenへ進まない。Shutdownの期限はJSが要求を処理した時点からの既存全体10秒であり、同期処理自体の実時間上限ではない。installShutdown()・Signal Listener・Timeout値は変更しない。

## テスト・品質確認

追加33件のRuntime StartupテストとLinux実Process 4件。テストは既存Fastifyを用い、単体試験だけListen / Lock / OS取得を差し替える。実SQLiteの本番Openとexecute経路、COMMIT前後throwを検証する。Linux試験は一時専用Directory・実EX・実OS Boot・実HTTP /pingでGen 1→2→3を確認する。実運用DB・外部APIへはアクセスしない。

- committed / rejected / L1〜L4 / unknown、Boot失敗、v2拒否、SchemaError、未分類Open失敗と機密非露出。
- Open前 / Open中 / Startup直前 / 同期Startup直後のShutdown、Close所有権、Close失敗、Listen失敗、10秒期限・Listener解除。
- 実SQLiteのCommit unknown前後で成功不採用・1回試行・Generationの保存有無を検証。
- Linux：本番v3再起動・v2無変更、SIGTERM / SIGINTをAtomic Startup中にQueueしてListenしないこと、EX解放。
- 既存Linuxの正常Lifetime・Listen失敗・取得後Shutdown・Timeout試験は明示的v3準備へ適合。v1→v2明示Migrationのデータ保持は維持し、v2本番起動はBLOCKEDであることを確認。旧「v3通常起動拒否」の期待は今回採用したGen 2 Startupへ更新する。

ローカル全体：1,082 PASS・Linux専用56 Skip（計1,138件）。Lint / Format Check / Type Check / Backend Build / git diff --check成功。Linux CIの実測結果はPR本文に記録する。

| 正本・条件                    | 今回の検証                                                     | 未完了                     |
| ----------------------------- | -------------------------------------------------------------- | -------------------------- |
| D-02 / H54-01・19〜21・29〜32 | 既存Atomic Startupの本番接続・Boot・v3限定・結果不採用・再起動 | Trust / Recovery適格性     |
| PR-A / H54-18関連             | Signal・所有権・Close・既存Deadline・Connectivity              | CLEAN・全Recovery Shutdown |
| D04-R01 / R05                 | 既存全Provider / Fingerprint回帰                               | Range・Plan D・管理者操作  |

H54全体をPASSと宣言しない。

## 残余リスク・PR-C-2B-4Bへの引継ぎ

- Storage HEALTHYでもProvider送信は未実装・禁止。Clock / History Trust、Recovery / Plan D、管理者承認・25時間隔離、保守的Quota計上は独立した後続条件。
- Runtime Provisioning境界・CLEAN Transaction・Send Gate / Permit・Provider HTTP配線は未着手。終了時LifecycleはRUNNINGを維持する。
- 同期SQLiteによるSignal / Timer遅延、長期履歴の走査時間、Pi性能・耐久は未検証。全体10秒をNative処理の中断保証としない。
- 実運用v2→v3 Migration・Provisioning・Pi Deployは実施しない。UI / Frontend・共通設計正本・依存・Workflow・Schemaは無変更。
- PRは未Merge・通常Chatレビュー待ち、Issue #16はOpen・全体未完了とする。
