# Backend開発手順（Issue #16 PR-A）

単一PackageのNode.js 24 LTS / TypeScript ESM Backend。Fastify・Pino・TypeBoxを利用する。PR-AはHTTP起動・終了とConfig / Secret Loaderまでで、Weather・Schedule・SQLite・Published State APIは実装しない。

## Build・起動・疎通

リポジトリのルートで実行する。

```sh
npm ci
npm run build:backend
npm run start:backend
```

`tsc -p tsconfig.backend.json`で`src/backend/`のみを`dist/backend/`へCompileする。テストはBuild成果物に含めず、Bundlerや別Packageを追加しない。実行時依存はdependenciesに分けている。

```sh
curl http://127.0.0.1:3000/ping
```

応答は`{"message":"pong"}`。このEndpointは疎通確認専用であり、System Health / Readinessの契約ではない。外部API・DB・Secretファイルがなくても起動できる。

## Config

一般Configは運用時に`/etc/home-digital-signage/backend.env`からsystemd EnvironmentFileでProcess環境変数として供給する。Backend自身はEnvironmentFileを読み込まず、起動時に一度だけ取得した環境変数をTypeBoxで検証し、固定されたConfigを利用する。変更は再起動で反映する。systemd UnitやPi設定はこのPRでは作成しない。

| 環境変数                    | デフォルト・制約                                           |
| --------------------------- | ---------------------------------------------------------- |
| SIGNAGE_BACKEND_HOST        | 127.0.0.1固定                                              |
| SIGNAGE_BACKEND_PORT        | 3000、整数1〜65535                                         |
| SIGNAGE_LOG_LEVEL           | info。fatal / error / warn / info / debug / trace / silent |
| SIGNAGE_SHUTDOWN_TIMEOUT_MS | 10000固定                                                  |

未指定はデフォルト、空文字は不正。未知の`SIGNAGE_`変数も拒否する。PATH等のOS環境変数は許容する。不正ConfigではListen前にERRORを記録して終了コード1で終了する。名前・値・Validationの入力はログへ出さない。INFOログは指定したLog Levelのフィルタに従う。

開発時は環境変数を指定するか、Node.jsの開発用`--env-file`を利用できる。

```sh
node --env-file=config/backend.env.example dist/backend/main.js
```

例ファイルにSecretを記載しない。Node.jsのenv-file利用は開発用の供給方法であり、運用EnvironmentFileの代替実装ではない。

## 終了

TerminalでCtrl+C（SIGINT）。Linuxでは直接Nodeを起動し、そのPIDに`kill -TERM <PID>`または`kill -INT <PID>`を送る。npm等の親ProcessではなくBackendのNode Processが対象。

両Signalは同じ一度だけのShutdownを実行する。Fastifyのcloseで新規受付を終了し、処理が完了したらINFOを記録して自然終了する。猶予10秒のTimerは正常終了時に解除する。close失敗または10秒TimeoutではERRORを記録し終了コード1で強制終了する。後続リソースの終了はFastifyのonClose Hookへ追加できる。Event Loop自体が停止した場合の10秒保証・Watchdogは対象外。

WindowsのChildProcess.killはPOSIX Signalの配送と同一ではないため、子ProcessのSIGTERM / SIGINT試験はLinux CIで行う。共通Shutdown関数の重複抑止・Timeout・例外はWindowsでも検証する。

## Secrets

運用時の配置は以下。実ファイルはGit・Release Directoryの外へ置き、Backend実行ユーザーを所有者にする。

```text
/etc/home-digital-signage/backend.env
/etc/home-digital-signage/secrets/              0700
/etc/home-digital-signage/secrets/weather.json  0600
/etc/home-digital-signage/secrets/schedule.json 0600
```

Linuxでは上記modeと実行UIDの一致を検査する。Linuxの`/proc/self/fd`とO_NOFOLLOWでディレクトリを順に開いて固定し、祖先を含むシンボリックリンクを拒否する。ファイルも開いたハンドルの種類・所有者・modeを検証して同じハンドルから読み、読込前後のサイズ・更新時刻等が変われば拒否する。`/proc`が利用できない環境では安全性を緩めず読込失敗とする。親ディレクトリは管理者が管理し、Secret更新は信頼された管理者のみが行う前提。同じUIDやrootによる悪意ある書換えまで隔離する仕組みではない。

Windows等ではPOSIX mode / UIDの検証を行わない。リンク・通常ファイル・読込前後の同一性を確認するが、ACLやLinuxと同等の競合防御は保証しない。開発用の合成データに限って使用し、本番の権限確認はLinuxで行う。

`loadSecret("weather")`または`loadSecret("schedule")`を、それぞれ必要なDomainの初期化から呼び出す（`weather.json`はTomorrow.ioのAPIキー用で、[Issue #93](https://github.com/rinYamano211/home-digital-signage/issues/93)で使う。Open-MeteoはSecretを使わない）。片方を読むために他方は不要で、PR-Aの起動処理はどちらも呼び出さない。テスト用に専用ディレクトリを渡せるが、ファイル名はDomainの固定対応である。

LoaderはJSON Objectであることまで確認する。欠損・構文不正・Permission不正などは分類済みの固定Errorを返し、本文・パス・元例外を含めない。Provider固有Schema・認証確認・Domain単位の障害分離は後続実装であり、今回のLoader成功だけで認証可能とは扱わない。

## Schedule Service（Issue #10、実装済み・実機確認済み）

設計の正本は[技術スタック選定 18.7](technology-stack.md#schedule-issue-10-design)。共通基盤の拡張はPR #88、Google Calendar Providerは`src/backend/schedule/`（`jst.ts`・`google-auth.ts`・`google-calendar.ts`・`schedule-data.ts`・`provider.ts`・`setup.ts`）。本節はConfig・Secretの配置、ログ、開発・テストの手順を記す。Raspberry Pi・実APIでの確認結果（2026-11-08）と、確認していない事項は[Issue #10の検証記録](verification/issue-10-schedule.md)に記す。

### Config・Secret

| 項目                           | 配置                                                      | 備考                                                                        |
| ------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `SIGNAGE_SCHEDULE_CALENDAR_ID` | `/etc/home-digital-signage/backend.env`                   | 未設定ならSchedule Providerを登録しない。空文字は不正Configとして起動しない |
| Service AccountのJSON鍵        | `/etc/home-digital-signage/secrets/schedule.json`（0600） | ダウンロードした鍵をそのまま置く。パスは固定で、環境変数では指定しない      |

- カレンダーIDは鍵がなければ利用できない識別子のため一般Configとするが、Git・Issue・PR・ログには書かない。`config/backend.env.example`には値を書かない。
- Secretの読込失敗・鍵の不正ではSchedule Providerだけを無効にし、他のStateとBackendの起動は止めない。変更はBackend再起動で反映する。
- 鍵・トークン・カレンダーID・Secretのパスはログに出さない。
- カレンダーIDの形式は、空白を含まない表示可能なASCII（1〜1024文字）。それ以外は不正Configとして起動しない。

### ログ

固定のEvent名と分類コードだけを記録する（技術スタック選定 18.7）。

| Event                         | レベル                       | 項目                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schedule_provider_enabled`   | info                         | なし                                                                                                                                                                                                                                                                                                                                                                                                   |
| `schedule_provider_disabled`  | 未設定はinfo、それ以外はwarn | `reason`：`calendar_id_unset`、Secret Loaderの分類（`missing`・`permission`・`unsafe_path`・`invalid_json`・`invalid_object`・`read_failed`）、`invalid_credentials`                                                                                                                                                                                                                                   |
| `schedule_acquisition_failed` | warn                         | `reason`：`auth_failed`（Token取得の失敗、Calendar APIの401）、`forbidden`（403・404。共有されていない等）、`rate_limited`（429）、`server_error`（5xx）、`http_error`（その他のHTTPステータス）、`network_error`、`timeout`、`invalid_response`（応答・正規化・Validationの失敗、ページ数上限超過）、`clock_moved_back`（取得中に時計が戻り日付が前日になった）。`httpStatus`（HTTP応答があった場合） |
| `schedule_result_discarded`   | info                         | `reason`：`date_rolled_over`（取得中に日付が変わった結果を破棄）                                                                                                                                                                                                                                                                                                                                       |
| `schedule_acquired`           | debug                        | `pages`・`events`（件数）                                                                                                                                                                                                                                                                                                                                                                              |

Shutdownで中止した取得は記録しない。

### ユーザーが行う準備（AIは鍵を扱わない）

1. Google Cloud：Google Calendar APIの有効化を確認する。Service Accountに、Raspberry Pi用の新しいJSON鍵を作る。検証用の古い鍵が不要なら削除する。
2. Googleカレンダー：サイネージ専用の非公開カレンダーを、Service Accountのメールアドレスへ「予定の表示（すべての予定の詳細）」（reader）で共有する。カレンダーIDを控える。
3. Raspberry Pi：鍵を`schedule.json`として、上記の権限・所有者（Backend実行ユーザー）で配置する。`<user>`はBackendを実行するユーザー、`<pi-host>`はPiのホスト名に置き換える。

   ```sh
   # Development PC：ダウンロードした鍵をPiのホームへ一時的に転送する
   scp <ダウンロードした鍵>.json <user>@<pi-host>:~/schedule-key.json

   # Raspberry Pi
   sudo install -d -m 0755 /etc/home-digital-signage   # root所有の親。既にある場合はこの行を省く
   sudo install -d -m 0700 -o <user> -g <user> /etc/home-digital-signage/secrets
   sudo install -m 0600 -o <user> -g <user> ~/schedule-key.json /etc/home-digital-signage/secrets/schedule.json
   shred -u ~/schedule-key.json
   sudoedit /etc/home-digital-signage/backend.env   # SIGNAGE_SCHEDULE_CALENDAR_ID=<カレンダーID> を追記
   ```

   - Loaderは、ディレクトリ0700・ファイル0600・所有者が実行ユーザーであること、シンボリックリンクがないことを検査する。条件を満たさないと`schedule_provider_disabled`（`permission`・`unsafe_path`）になる。
   - 配置後、Development PCのダウンロード先の鍵は削除する（必要になれば鍵を作り直す）。鍵の内容をチャット・Issue・PRに貼らない。
   - 変更はBackend再起動で反映する。Piでの起動・確認の結果は[Issue #10の検証記録](verification/issue-10-schedule.md)に記す（systemdでの常駐は#12）。

### テスト

- 外部API・実鍵は使わない。Google応答は合成データ、鍵はテスト内で生成したRSA鍵を使う。
- テスト：`schedule-domain`（JST・URL・正規化・Domain Validation）、`schedule-provider`（認証・Token Cache・ページング・失敗の分類・破棄・ログ非露出・起動時の登録判断）、`schedule-startup`（起動時の配線。`loadSecret`はMockし、実際のSecretディレクトリは読まない）、`coordinator`（実Coordinator・SQLiteとの結合）。
- better-sqlite3 13はWindows用のバイナリを同梱しているため、`npm ci --ignore-scripts`のWindowsでもSQLiteを使うテストを実行できる（PR #88で確認）。Linux専用のテスト（mode・Signal等）はLinux CIで確認する。

## Weather Service（Issue #9、設計確定・未実装）

設計の正本は[技術スタック選定 16.6](technology-stack.md#weather-issue-9-design)。対象はOpen-MeteoのCurrentWeather・HourlyWeather・WeeklyWeather。RainForecast（Tomorrow.io、`weather.json`のSecret）は[Issue #93](https://github.com/rinYamano211/home-digital-signage/issues/93)で扱う。本節はConfig、ログ、ユーザーが行う準備、テストの方針を記す。実装は`src/backend/weather/`に置く予定（PR2）。

### Config

| 項目                        | 配置                                    | 備考                                                                              |
| --------------------------- | --------------------------------------- | --------------------------------------------------------------------------------- |
| `SIGNAGE_WEATHER_LATITUDE`  | `/etc/home-digital-signage/backend.env` | 緯度（−90〜90）。経度と両方未設定ならWeather Providerを登録しない                 |
| `SIGNAGE_WEATHER_LONGITUDE` | `/etc/home-digital-signage/backend.env` | 経度（−180〜180）。片方だけの設定・形式の不正・範囲外は不正Configとして起動しない |

- 形式は10進の小数に限る（符号は`-`のみ、整数部1〜3桁、小数部は任意で1〜6桁）。指数表記・`Infinity`・`NaN`・前後の空白・`+`は拒否する。
- 小数点以下2桁への丸めは、位置情報のプライバシーを守るための利用者の運用ルールとする。Config Validationは2桁への丸めを強制せず、小数部1〜6桁を許容する。Backendは自動で丸めない。
- 自宅の位置のため、Git・Issue・PR・チャット・ログに書かない。`config/backend.env.example`には値を書かない。Open-MeteoはAPIキー不要で、Secretは使わない。
- 変更はBackend再起動で反映する。

### ログ

固定のEvent名と分類コードだけを記録する（技術スタック選定 16.6）。地点・Request URL・Response Bodyは記録しない。

| Event                        | レベル | 項目                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `weather_provider_enabled`   | info   | なし                                                                                                                                                                                                                                                                                       |
| `weather_provider_disabled`  | info   | `reason`：`location_unset`                                                                                                                                                                                                                                                                 |
| `weather_acquisition_failed` | warn   | `stateKey`、`reason`：`rate_limited`（429）、`server_error`（5xx）、`http_error`（その他のHTTPステータス。400を含む）、`network_error`、`timeout`、`invalid_response`（応答の構造・値・UTCオフセットの不正）、`stale_data`（鮮度外・必須範囲の不足）。`httpStatus`（HTTP応答があった場合） |
| `weather_acquired`           | debug  | `stateKey`、件数                                                                                                                                                                                                                                                                           |

Shutdownで中止した取得は記録しない。

### ユーザーが行う準備

1. Open-Meteoの利用条件（[規約](https://open-meteo.com/en/terms)・[ライセンス](https://open-meteo.com/en/licence)）を確認する。
2. 対象地点の緯度・経度を決め、小数点以下2桁に丸める（運用ルール。Backendは丸めを検査しない）。
3. Raspberry Piで`sudoedit /etc/home-digital-signage/backend.env`を実行し、`SIGNAGE_WEATHER_LATITUDE=<緯度>`・`SIGNAGE_WEATHER_LONGITUDE=<経度>`を追記する。Backend再起動で反映する。

### テスト

- 外部APIは使わない。Open-Meteoの応答は合成データ、地点はテスト用の値を使う。
- 確認すること：URLの組み立て、Response Validation（配列・値・時刻・UTCオフセット）、2段階Validation（取得中の正時・0時、Fake Timer）、Currentの鮮度の境界（過去30分・未来5分）、失敗の分類と429のRetry-After、ログ・Published Stateに地点が出ないこと、Config（未設定・片方だけ・形式・範囲）、Coordinator・SQLiteとの結合。

## Logging・テスト

PinoのJSONログを標準出力へ出す。固定Event名で起動開始・完了、Config不正、Listen失敗、正常終了、Shutdown失敗・Timeoutを識別する。HTTPのURL・Header・Bodyや任意の例外本文は記録しない。機密キーのRedactionも設定するが、任意の深さ・任意キー・自由文に入った機密情報まで自動検出するものではない。SecretオブジェクトをLoggerへ渡さない。journald構築は運用Issueで扱う。

```sh
npm run check
npm test -- tests/backend
npm run build:backend
```

Config境界、実Loopback HTTP、コンパイル済みProcessの起動失敗、重複Shutdown・10秒境界（Fake Timer）、合成Secret・ログ非露出を確認する。Linux CIではmode・リンク拒否と両Signalによる実Process終了も確認する。実Credential・外部Providerへの接続は不要。

PR-BではSQLite・Published State・Cacheを追加し、その初期化や終了処理、Domain固有Schema・エラー処理を既存の責務境界へ接続する。Scheduler・Quota・Pending等はIssue #16の後続段階へ引き継ぐ。Pi Deploy・systemd・ARM64・72時間試験はこのPRの検証完了には含めない。
