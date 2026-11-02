# Frontend開発手順（Issue #7）

単一PackageのReact + TypeScript + Vite Frontend。Issue #7では、基本画面（レイアウト・時計・日付・曜日）と、その開発基盤・実機確認手順までを扱う。コンテンツの切替、天気・予定の表示、表示用APIとの接続は実装しない。

状態：実装前の方針（2026-11-02）。Issue #7の検討（D1〜D12）で確定した事項を記録する。依存のバージョンや具体的な設定値は実装時に確定し、本書を更新する。

## 1. 位置付けと関連文書

本書はFrontend固有の構成・実装方針・開発手順を扱う。他の文書と内容を重複させず、必要な箇所は参照する。

- [UI設計](ui-design.md)：画面仕様（配置・色・文言・異常時の表示）の正本。
- [開発品質・CI](development-quality.md)：品質ゲート・CIの正本。
- [アーキテクチャ](architecture.md)：Display Serviceの責務分担、State管理、Time / Date。
- [技術スタック選定](technology-stack.md)：React・TypeScript・Viteの採用理由、Production Serving、表示用APIの契約。
- [Backend開発手順](backend-development.md)：Backendの構成・Config・Secrets。

## 2. ディレクトリ構成

単一のnpm Packageを維持し、Workspacesや別Packageは作らない（D1）。

```text
src/frontend/     Frontendのソース。Viteのrootとし、index.htmlを置く
tests/frontend/   Frontendのテスト
dist/frontend/    Vite Buildの出力先（Git管理外）
```

- Backend（`src/backend/`、出力先`dist/backend/`）とはディレクトリと設定を分ける。
- FrontendからBackendのコード（`src/backend/time/`等）をimportしない。実行環境（BrowserとNode.js）が異なるため。
- Frontendの依存はすべて`devDependencies`に置く。FrontendはDevelopment PCでBuildし、成果物だけをRaspberry Piへ配置するため（[技術スタック選定 第8章](technology-stack.md#8-frontend-build実行場所)）。Piの`npm ci --omit=dev`には影響しない。

## 3. 開発基盤

`npm create vite`等のテンプレートは使わず、必要な依存だけを手動で追加し、既存と同じくバージョンを完全に固定する（D2）。

追加を予定する依存：

- `react`、`react-dom`、`@types/react`、`@types/react-dom`
- `vite`、`@vitejs/plugin-react`
- `eslint-plugin-react-hooks`、`globals`
- `@fontsource/zen-maru-gothic`

具体的なバージョンと互換性は未検証であり、実装時に確認する。確認対象：

- Vite・`@vitejs/plugin-react`と、既存のVitest 5.0.5・TypeScript 6.0.3
- `eslint-plugin-react-hooks`と、既存のESLint 10
- `globals`パッケージの追加
- Node.js 24での動作

## 4. 品質検証との統合

既存の`npm run check`（Lint → Format Check → Type Check → Test）にFrontendの検証を統合する（D11）。Backendの既存の検証対象・設定は弱めない。品質ゲートとCIの正本は[開発品質・CI](development-quality.md)とする。

- TypeScript（D3）：`tsconfig.frontend.json`を追加する。BrowserのDOM型、`jsx: react-jsx`、Bundler向けのModule解決を使う。既存の`tsconfig.json`・`tsconfig.backend.json`のBackend設定（NodeNext）は維持し、`tests/frontend/`は既存の`tsconfig.json`の対象から外してFrontend側で検証する。`npm run typecheck`は両方の設定で型チェックを行う。
- ESLint（D4）：`src/frontend/`と`tests/frontend/`に限り、React HooksのルールとBrowserのglobalsを追加する。それ以外のReact向けPluginは追加しない。
- テスト（D5）：既存のVitestをNode環境のまま利用し、時計の表示文字列の生成・更新判定・時刻利用可否による表示の切替を、純粋な関数として単体テストする。現在時刻はFake Timer等で固定する。Componentの描画テスト（jsdom等）は導入しない。
- Build：Vite Buildは型チェックを行わない。Buildの成功を型チェックの完了とみなさない（[技術スタック選定 第6章](technology-stack.md#6-開発環境)）。Production BuildはCIでは行わず、手元で実行して確認する。

新しく追加する設定・ソース・テストは`.gitattributes`でLF改行に固定する（既存運用）。

## 5. 基本画面と時計

画面の配置・寸法・色・文言は[UI設計 第3・4章](ui-design.md#4-画面レイアウト)に従う。本章は実装方針のみを記す。

### 5.1 レイアウト

- 1280×800のpx固定で作る（D10）。Responsive対応は先行実装しない（[アーキテクチャ 6.3](architecture.md#63-display-component--layout--contentswitcher)）。
- 開発PCのBrowserでは、画面全体をCSS `transform`で比例縮小して全体を確認できるようにする。Raspberry Piの1280×800では等倍で表示する。
- 左45%に時計タイル、右55%にコンテンツ領域を置く（L1）。#7のコンテンツ領域は空のタイルとし、文言やダミーデータは表示しない。
- 全画面表示では、スクロールバー・余白・マウスカーソル・文字選択が出ないようにする。
- 色は[UI設計 3.3](ui-design.md#33-カラー目安)のとおりCSS変数で一か所に定義する。

### 5.2 時計・日付・曜日

- 表示形式は`11月2日（月）`と`14:30`（24時間表記、秒なし、等幅数字）。[UI設計 4.1](ui-design.md#41-構成l1左に時計)・[要件 R-01](requirements.md#r-01時計日時表示)に従う。
- 現在時刻はBrowserの現在時刻（OS System Time）から取得する。表示の整形は`Intl.DateTimeFormat`で`timeZone: "Asia/Tokyo"`を明示し、OSのTimezone設定に依存しない（[アーキテクチャ 10.3](architecture.md#103-timezone)）。
- 1秒ごとに現在時刻を確認し、表示文字列（日付・時刻）が変わった場合だけ表示を更新する（D8）。時刻の補正や日付の変更にも最大1秒で追従する。
- 時刻のコロンの点滅など、常に動く演出は使わない（[UI設計 第7章](ui-design.md#7-アニメーションの方針)）。

### 5.3 時刻利用可否の状態注入

- 時計タイルは、時刻の利用可否を`available` / `unavailable`の状態として外から受け取る（D6）。ReactのPropsなど単純な方法で渡し、専用のServiceや抽象化は設けない。
- `unavailable`のときは日付と時刻を表示せず、[UI設計 6.3](ui-design.md#63-時刻未同期)の未同期表示を出す。`available`へ変わったら、操作なしで日付と時刻をフェードで表示する。
- #7では、OS・RTC・時刻同期の状態に基づく正式な判定を実装しない。判定元がないため、通常の画面では常に`available`として扱う。正式な判定は別Issueで扱う（第9章）。
- 未同期表示と状態切替は、Vitestで検証する。
- URLのクエリパラメータ等で未同期表示へ強制的に切り替える機能を、本番の成果物に恒久的に残さない。

#7で時計を実装しても、MVP全体として時刻の正当性を保証したことにはならない。R-01の「正しい時刻を取得できていない場合はローカル時刻を表示しない」は、正式な判定の実装と実機確認（Issue #13）をもって満たす。

### 5.4 フォント・アイコン

- Zen Maru Gothicは`@fontsource/zen-maru-gothic`で管理し、Vite Buildの成果物に含める（D9）。フォントのライセンス（SIL Open Font License）の表記の扱いは実装時に確認する。
- アイコンは必要なSVG（#7では未同期表示の時計アイコン）だけをアプリに同梱する。
- 外部CDN・Webフォントサービスを参照せず、ネットワークに接続できなくても基本画面を表示できるようにする（[UI設計 第13章](ui-design.md#13-uiモック)、[要件 R-06](requirements.md#r-06電源投入再起動異常終了からの自動復旧)）。

## 6. PCでのプレビュー

開発PCでVite Development Serverを起動し、Browserで表示を確認する。5.1の比例縮小により、ウィンドウの大きさに関係なく1280×800の画面全体を確認できる。

具体的なnpm scriptsとコマンドは、実装時に本書へ追記する。

## 7. Raspberry Piでの実機確認

Issue #7の完了条件（Piのディスプレイへの表示、現在時刻の正しい表示、自動更新、全画面）を、本番Build相当の成果物で確認する（D12）。

1. Development PCでVite Buildを実行し、`dist/frontend/`を生成する。
2. 成果物をscp等でRaspberry Piへ転送する。
3. Pi上で一時的なHTTPサーバーを起動し、成果物を配信する。外部から接続できないよう`127.0.0.1`で待ち受ける。
4. ChromiumをKioskモードで手動起動し、一時サーバーのURLを表示する。
5. 以下を確認する。
   - 画面が1280×800の全画面に収まり、スクロールバー・余白・カーソルが出ない。
   - 日付・曜日・時刻がAsia/Tokyoで正しく表示され、分・日付の変化に合わせて自動更新される。
   - フォントが同梱のZen Maru Gothicで表示される。
   - Networkを切断しても基本画面を表示でき、時計が更新され続ける（オフライン動作）。
6. 確認後、一時サーバーとChromiumを停止する。確認結果は`docs/verification/`へ記録する。

- 一時HTTPサーバーに使うコマンドは実装時に確認する。本番の配信（nginx）・自動起動・Deployの手順はIssue #12で扱う。
- 実機で未同期表示を確認する必要があるが、そのための切替手段は未確定である（第8章）。
- 約3mからの判読性・長時間稼働などMVPの受入確認はIssue #13で行う。

## 8. 未解決事項

- 実機で未同期表示へ切り替える手段。恒久的な本番仕様を増やさない方法を、実装前に比較して決める（例：検証専用の一時的な状態注入、開発・検証時のみ有効な切替機構）。
- OS・RTC・時刻同期の状態に基づく、正式な時刻利用可否の判定（第9章の別Issue）。
- 依存パッケージのバージョンと互換性（第3章）。
- 一時HTTPサーバーのコマンド、npm scriptsの名前（第6・7章）。

## 9. 後続Issueへの引き継ぎ

- #8：コンテンツの切替・インジケーター・切替アニメーション。時刻未同期中にコンテンツ領域へ1枚表示して巡回を止める動作（[UI設計 6.3](ui-design.md#63-時刻未同期)）。
- #9・#10：天気・予定の表示データ。表示用APIのPolling、Published Stateの型とRuntime Validation、取得中・取得不可の表示。
- #12：nginxによる本番配信、Chromium Kioskの自動起動、Deploy手順。
- #13：MVP全体の受入確認（判読性、起動時間、時刻・日付テスト、長時間稼働）。
- #16：Backend共通基盤と表示用API（Published State API）。
- 別Issue（未作成）：OS・RTCに基づく表示用時刻の利用可否判定。判定に使う情報、判定を行う場所、Frontendへの渡し方を決めて実装し、#7の状態入力へ接続する。既存文書の判定方法の参照先（[アーキテクチャ 10.2](architecture.md#102-時刻同期rtcと利用可否)の「Issue #4」、[技術スタック選定 24.3](technology-stack.md#243-time--rtc)の「#6・#13」）との関係もこのIssueで整理する。
