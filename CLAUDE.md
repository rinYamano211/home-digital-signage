# CLAUDE.md

@AGENTS.md

## Claude Code固有の補足

- 共通ルールは上記のAGENTS.mdに従う。このファイルにはClaude Code固有の事項のみ記載する。
- 権限設定は`.claude/settings.json`で管理する。allow・ask・denyのルールは誤操作を減らすための安全装置であり、AGENTS.mdの承認ルールの代わりにはならない。
- `.claude/settings.local.json`は個人用の設定で、Gitの管理対象外とする。Gitから除外しても権限の強制力は変わらない。個人設定のallowで共通のask・denyは緩和されないが、共通ルールを迂回する許可を追加しない。
- Claude CodeのMemoryに記録した内容は補助情報とする。ルール・設計の正本はリポジトリ内の文書とする。
