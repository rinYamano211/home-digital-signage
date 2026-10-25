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

`loadSecret("weather")`または`loadSecret("schedule")`を、それぞれ必要なDomainの初期化から呼び出す。片方を読むために他方は不要で、PR-Aの起動処理はどちらも呼び出さない。テスト用に専用ディレクトリを渡せるが、ファイル名はDomainの固定対応である。

LoaderはJSON Objectであることまで確認する。欠損・構文不正・Permission不正などは分類済みの固定Errorを返し、本文・パス・元例外を含めない。Provider固有Schema・認証確認・Domain単位の障害分離は後続実装であり、今回のLoader成功だけで認証可能とは扱わない。

## Logging・テスト

PinoのJSONログを標準出力へ出す。固定Event名で起動開始・完了、Config不正、Listen失敗、正常終了、Shutdown失敗・Timeoutを識別する。HTTPのURL・Header・Bodyや任意の例外本文は記録しない。機密キーのRedactionも設定するが、任意の深さ・任意キー・自由文に入った機密情報まで自動検出するものではない。SecretオブジェクトをLoggerへ渡さない。journald構築は運用Issueで扱う。

```sh
npm run check
npm test -- tests/backend
npm run build:backend
```

Config境界、実Loopback HTTP、コンパイル済みProcessの起動失敗、重複Shutdown・10秒境界（Fake Timer）、合成Secret・ログ非露出を確認する。Linux CIではmode・リンク拒否と両Signalによる実Process終了も確認する。実Credential・外部Providerへの接続は不要。

PR-BではSQLite・Published State・Cacheを追加し、その初期化や終了処理、Domain固有Schema・エラー処理を既存の責務境界へ接続する。Scheduler・Quota・Pending等はIssue #16の後続段階へ引き継ぐ。Pi Deploy・systemd・ARM64・72時間試験はこのPRの検証完了には含めない。
