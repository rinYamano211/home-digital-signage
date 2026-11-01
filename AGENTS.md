# AGENTS.md

Claude Code・Codex等、このリポジトリで作業するAI共通のルール。Issue #53で整備した。

## 1. プロジェクト概要

Raspberry Piを利用した家庭用デジタルサイネージ。時計・予定・天気・写真等を表示する。概要は[README](README.md)、計画は[企画書](docs/home-digital-signage-project-plan.md)を参照する。

## 2. 承認ルール

以下はユーザーの明示的な承認を得てから行う。承認は操作ごとに得て、1回の承認を後続の操作や別のブランチ・PRへ流用しない。

| 操作                                                   | ルール                                             |
| ------------------------------------------------------ | -------------------------------------------------- |
| 設計変更（Architecture・責務境界・API契約・Schema等）  | 変更内容と理由を提示し、実装前に承認を得る         |
| Commit・Push・PR作成                                   | 操作ごとに、直前にチャット上で承認を得る           |
| Issue・PRの作成・編集・コメント                        | 本文を提示し、承認を得る                           |
| `npm ci`・`npm install`・`npm run format`              | 実行前に目的と影響を説明し、確認を得る             |
| Merge                                                  | ユーザーが行う。AIは実行しない                     |
| Force Push・履歴の書換え（`reset --hard`・`rebase`等） | 原則行わない。必要な場合は理由を説明し、承認を得る |

Commit・Push・PR作成は、権限設定の確認ダイアログだけに依存しない。ダイアログはツール側の安全装置であり、ユーザーの意思確認の代わりにはならない。操作の直前に、対象（ブランチ・Commitメッセージ・PR本文等）をチャット上で提示し、明示的な承認を得てから実行する。承認後に内容が変わった場合は改めて承認を得る。

## 3. MVP範囲と正本文書

- MVP範囲は[requirements.md](docs/requirements.md)を正とする。AIが独自に範囲を広げず、範囲外の機能・改善は提案に留める。
- 設計判断は以下を正本として参照する。
  - [architecture.md](docs/architecture.md)：Service境界・State Ownership・Recovery
  - [technology-stack.md](docs/technology-stack.md)：採用技術・API契約
  - [backend-development.md](docs/backend-development.md)：Backendの構成・Config・Secrets
  - `docs/verification/`：各実装段階の検証結果
- 正本文書と実装・Issue・PRの記述が食い違う場合は、自己判断で解消せずユーザーに確認する。
- 正本文書の更新は設計変更として扱い、事前承認の対象とする。
- 作業範囲は対象Issueの記載に限る。範囲外の修正に気付いた場合は報告し、別Issueとして扱う。

## 4. 作業の進め方

- 作業ブランチは最新の`origin/main`を起点に作成する。ローカルの`main`の更新は必須としない。作成前に以下を確認し、未Commitの変更がある・同名のブランチがある・別のworktreeで作業中の場合は、作成せずユーザーに報告する。

  ```sh
  git status
  git worktree list
  git branch -a --list "*issue-<番号>*"
  ```

  問題がなければ、`git fetch origin`の実行についてユーザーの確認を得てから作成する。

  ```sh
  git fetch origin
  git switch -c <種別>/issue-<番号>-<内容> --no-track origin/main
  ```

- ブランチ名の種別は`feat`・`fix`・`docs`・`setup`・`test`等を使う。
- 対象Issue以外のブランチ・PRには触れない。進行中のPRがある場合はその変更を前提にしない。
- 1つのPRは1つの目的に絞る。設計文書（`docs:`）と実装（`feat:`）は原則として別PRにする。

## 5. 品質検証

[development-quality.md](docs/development-quality.md)に従う。

- PR作成・更新前に`npm run check`を実行し、`git diff`を確認する。AIが生成・変更したコードも同じ検証を通す。
- Lintルールの無効化やテストの削除で検証を回避しない。
- 検証結果は成功・失敗をそのまま報告する。実行できなかった検証は、その旨と理由を明記する。

## 6. Secrets

以下の実ファイルを読まない・出力しない・Commitしない。内容をログ・Issue・PR・チャットへ転記しない。

- `config/backend.env`
- `secrets/`
- `.env`・`.env.*`（`.env.example`を除く）
- `/etc/home-digital-signage/`（Raspberry Piの運用Config・Secrets）

テスト・説明には合成データと`*.example`ファイルを使う。Secretsが必要な作業はユーザーに依頼する。

## 7. AI間の担当切り替え・引き継ぎ

Claude Code・Codex間、または同じAIの別セッション間で担当を切り替える場合に従う。

### 開始時の確認

作業を始める前に以下を確認し、想定と異なる場合はユーザーに報告する。

- `git branch --show-current`・`git rev-parse HEAD`・`git status`
- `git worktree list`
- 対象Issue・関連PRの最新状況

### 引き継ぎの記録

以下のいずれかに該当する場合は、対象IssueまたはPRのコメントに引き継ぎ情報を記録する。コメントの投稿はユーザーの承認を得て行う。

- AIの担当を切り替える（Claude Code ⇔ Codex等）
- 未完了の作業・未Commitの変更・未解決の判断事項を残して作業を終える

作業が区切りまで完了している場合や、同じAIで続ける軽微なセッション終了では、GitHubへの記録は不要とする。チャット上の簡潔な報告で足りる。

記録する項目：

- 対象Issue・PR、作業ブランチ、HEAD
- 未Commitの変更の有無と対象ファイル
- 完了した作業と未完了の作業
- 承認済みの操作と未承認の操作
- 未解決の判断事項
- 検証結果（実行したコマンドと結果）

承認は引き継がない。前の担当が承認を得ていた操作も、新しい担当が改めて承認を得る。

## 8. 学習支援

ユーザーはAI駆動開発・使用技術を学習中である。

- 重要な操作（Git操作・設定変更・依存更新等）の前に、目的と影響を簡潔に説明する。
- 重要な技術判断では、採用理由・主な代替案・トレードオフを簡潔に説明する。
- 専門用語や新しく導入する概念には、必要に応じて短い補足を付ける。
- [learning-log.md](docs/learning-log.md)の更新はユーザーの指示がある場合のみ行う。
