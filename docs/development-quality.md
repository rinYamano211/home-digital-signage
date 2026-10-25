# 開発品質・CIの利用手順

Issue #15では、ルートのnpm環境にESLint・Prettier・TypeScript・Vitestによる品質検証を用意する。Frontend / BackendのアプリケーションやProduction Build・Deployは対象外。

## 開発環境と実行

Node.js 24 LTSとnpm 11を使用する。リポジトリのルートで実行する。

```sh
node --version
npm --version
npm ci
npm run check
```

`package-lock.json`をコミットし、ローカル・CIとも`npm ci`で再現する。依存更新時はpackage.jsonとlockfileを同時に更新し、全検証を通す。TypeScriptはtypescript-eslintの対応範囲内の6.0系を採用している。

| コマンド               | 役割                                                 |
| ---------------------- | ---------------------------------------------------- |
| `npm run lint`         | JS / TSの静的解析。警告も失敗扱い                    |
| `npm run format:check` | 整形の検証のみ                                       |
| `npm run format`       | 対象ファイルを整形するローカル用操作                 |
| `npm run typecheck`    | `tsc --noEmit`で型検証。成果物は生成しない           |
| `npm test`             | Vitestを一度実行して終了する                         |
| `npm run check`        | lint → format:check → typecheck → test。失敗時に停止 |

PR作成・更新前は`npm ci`と`npm run check`を実行し、diffを確認する。AIで生成・変更したコードも同じ検証を通す。

## 現在の検証範囲

- ESLint：リポジトリのJS / MJS / CJSとTS / MTS / CTS / TSX。現時点では設定JS・Backend実装・検証用TSが対象。React固有ルールや実行環境別globalsはまだ追加しない。
- Prettier：JS / TS / JSON / YAML / Markdown等の対応形式。新規Markdownも対象。既存のREADMEと7つの設計・学習文書のみ`.prettierignore`で個別除外し、Issue #15での一括整形を避ける。lockfileはnpmが生成するため対象外。
- TypeScript：`src/backend/**/*.ts`と`tests/**/*.ts`。空の対象で成功させず、検証用コードを実際に型チェックする。
- Vitest：既存のSmoke Testと`tests/backend/`のConfig・Secrets・HTTP・Lifecycleテスト。実Credential・外部APIには依存しない。HTTPはLoopbackを利用する。Processテスト内でtscによるBackendのCompileと起動を検証し、成果物は配布・Deployしない。Linux固有のPermission・Signal確認はUbuntu CIで実行する。詳細は[Backend開発手順](backend-development.md)を参照。
- `node_modules/`、`dist/`、`coverage/`、TypeScriptの生成キャッシュはLint / Format対象外。新しい生成物が増えた際は除外設定も更新する。

新規の設定・テスト・本手順書は`.gitattributes`でLF改行に固定し、WindowsでのCheckout後もPrettierとの改行差を避ける。既存設計文書の改行設定は変更しない。

## GitHub Actions

`.github/workflows/ci.yml`は、main向けPRの作成・更新・再オープンで動く。1つの`Quality checks` Jobが標準`ubuntu-latest`、Node.js 24で、インストールと4検証を順次実行する。自動整形・Production Build・Deploy・PiへのSSHは行わない。

権限は`contents: read`。外部APIキーや独自Secretを渡さない。Checkoutの標準認証以外に認証情報を使わず、Git認証情報も保持しない。依存パッケージ取得にはネットワークが必要だが、テスト自体はオフラインで実行可能。

Jobの上限は10分。同じPRが更新されたら古い実行をキャンセルし、不要な実行時間を抑える。Actionsの実行時間は各Runで確認し、利用量・予算はGitHubのBilling設定で管理者が確認する。この構成自体はアカウントの無料枠や予算残高を保証しない。

## 失敗時の確認

PRのChecksまたはActionsタブから、失敗したStepのログと対象ファイル・行番号を確認する。手元で同じnpmコマンドを実行し、修正後は全検証をやり直す。

| 失敗Step             | 確認する内容                                                       |
| -------------------- | ------------------------------------------------------------------ |
| Install dependencies | Node / npmバージョン、lockfileとpackage.jsonの一致、ネットワーク   |
| Lint                 | 指摘されたルールとコード。ルールを無効化して回避しない             |
| Check formatting     | `npm run format`後にdiffを確認する                                 |
| Type check           | 型の不一致・import解決・検証対象の設定。Viteの変換成功で代替しない |
| Test                 | 期待値と実際値、テストの独立性                                     |

検証環境を変更した際は、一時的な未使用変数、整形違反、型エラー、期待値不一致を別々に入れて各検証が非ゼロで終了することも確認する。確認後は必ず元に戻し、意図的な違反をPRへ残さない。

## 後続Issueへの引き継ぎ

- #7：Frontend追加時にReact / TSX用Lintルール、Browser環境、Frontend用型チェック・テストを追加する。Vite Buildと型チェックを分離する。
- #16：PR-AのBackend起動・Config・Secretsは検証対象へ追加済み。SQLite・Scheduler・Recovery等のテストは後続PRで具体化する。外部サービスは実APIやSecretをCIへ持ち込まずに検証できるようにする。
- Package構成が決まった時点で各対象の設定とルートの検証コマンドを拡張する。現段階ではWorkspacesや空のアプリケーションディレクトリを作らない。
- #6 / #12 / #13：Pi環境、Deploy運用、実機性能・72時間試験は別途実施する。今回のCI成功とは区別する。

既存ArchitectureのService境界・State Ownership・Recovery設計は変更しない。[技術選定第6章](technology-stack.md#6-開発環境)のPR検証CIを実装し、Productionの自動Build / Deployとは分ける。requirements.mdのFuture「CI/CD」という広い表現よりも、Issue #4と#15の具体的なPR検証の採用方針を今回の根拠とする。
