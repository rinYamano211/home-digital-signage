# Frontend開発手順（Issue #7）

単一PackageのReact + TypeScript + Vite Frontend。Issue #7では、基本画面（レイアウト・時計・日付・曜日）と、その開発基盤・実機確認手順までを扱う。コンテンツの切替、天気・予定の表示、表示用APIとの接続は実装しない。

状態：Issue #7で実装済み（PR #80・#81、2026-11-07）。Issue #7の検討（D1〜D13）で確定した事項と、実装時に確定した依存・設定・コマンドを記録する。Raspberry Piでの確認結果は[検証記録](verification/issue-7-clock-screen.md)を参照。

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
src/frontend/            Frontendのソース。Viteのrootとし、index.htmlを置く
  clock/                 時計の整形・更新規則・利用可否・時計タイル
  layout/                1280×800の画面と比例縮小
  icons/                 同梱するSVGアイコン
  styles/                CSS変数・フォントの読み込み
  verify/                検証専用エントリーポイント（index.html・main.tsx・VerifyApp.tsx・verify.css）
tests/frontend/          Frontendのテスト
dist/frontend/           通常Buildの出力先（Git管理外）
dist/frontend-verify/    検証用Buildの出力先（Git管理外）
vite.frontend.config.ts  Viteの設定
```

- 時刻未同期表示の検証専用エントリーポイント（D13、5.3）は`src/frontend/verify/`に置き、検証用Buildのrootとする。出力先は`dist/frontend-verify/`で、通常Buildと分ける。
- Viteの設定ファイルを`vite.config.ts`としないのは、Vitestが自動で読み込まないようにするため。
- Backend（`src/backend/`、出力先`dist/backend/`）とはディレクトリと設定を分ける。
- FrontendからBackendのコード（`src/backend/time/`等）をimportしない。実行環境（BrowserとNode.js）が異なるため。
- Frontend専用の依存（React等）はすべて`devDependencies`に置く。理由は次のとおり。
  - FrontendはDevelopment PCでVite Buildを行い、React等の依存を成果物へ組み込む（[技術スタック選定 第8章](technology-stack.md#8-frontend-build実行場所)）。
  - Raspberry Piでは静的な成果物を配信するだけなので、Frontend専用のnpm依存をインストールする必要がない。Piの`npm ci --omit=dev`には含まれない。
  - 単一Package構成のまま、BackendのProduction依存（`dependencies`）とFrontend専用の依存を区別する。
- この分類は本プロジェクトのBuild・Deploy構成に基づく判断であり、npmの一般的な依存分類の考え方を変えるものではない。

## 3. 開発基盤

`npm create vite`等のテンプレートは使わず、必要な依存だけを手動で追加し、既存と同じくバージョンを完全に固定する（D2）。

追加した依存（すべて`devDependencies`、PR #80）：

| パッケージ                         | バージョン |
| ---------------------------------- | ---------- |
| `react`・`react-dom`               | 19.3.1     |
| `@types/react`・`@types/react-dom` | 19.3.0     |
| `vite`                             | 8.3.5      |
| `@vitejs/plugin-react`             | 6.2.1      |
| `eslint-plugin-react-hooks`        | 7.1.1      |
| `globals`                          | 17.14.0    |
| `@fontsource/zen-maru-gothic`      | 5.3.1      |

- Viteは、既存のVitest 5.0.5が依存するものと同じバージョンにそろえ、二重に入らないようにした。
- 既存のTypeScript 6.0.3・ESLint 10・Node.js 24で、`npm run check`とBuildが通ることを確認した。
- `eslint-plugin-react-hooks`は`configs.flat.recommended`を使う。

npm scripts：

| コマンド                        | 役割                                   |
| ------------------------------- | -------------------------------------- |
| `npm run dev:frontend`          | 通常画面のDevelopment Server           |
| `npm run build:frontend`        | 通常Build（`dist/frontend/`）          |
| `npm run dev:frontend:verify`   | 検証画面のDevelopment Server           |
| `npm run build:frontend:verify` | 検証用Build（`dist/frontend-verify/`） |

検証用は`vite.frontend.config.ts`の`--mode verify`で、rootと出力先を切り替える。

Windowsでは、better-sqlite3のNative Build（Visual Studio C++が必要）で通常の`npm ci`が失敗することがある。その場合、Frontendの開発・Buildには`npm ci --ignore-scripts`を使う。Frontendはbetter-sqlite3を使わない。

## 4. 品質検証との統合

既存の`npm run check`（Lint → Format Check → Type Check → Test）にFrontendの検証を統合する（D11）。Backendの既存の検証対象・設定は弱めない。品質ゲートとCIの正本は[開発品質・CI](development-quality.md)とする。

- TypeScript（D3）：`tsconfig.frontend.json`を追加する。BrowserのDOM型、`jsx: react-jsx`、Bundler向けのModule解決を使う。既存の`tsconfig.json`・`tsconfig.backend.json`のBackend設定（NodeNext）は維持し、`tests/frontend/`は既存の`tsconfig.json`の対象から外してFrontend側で検証する。`npm run typecheck`は両方の設定で型チェックを行う。
- ESLint（D4）：`src/frontend/`と`tests/frontend/`に限り、React HooksのルールとBrowserのglobalsを追加する。それ以外のReact向けPluginは追加しない。
- テスト（D5）：既存のVitestをNode環境のまま利用し、時計の表示文字列の生成・更新判定・時刻利用可否による表示の切替を、純粋な関数として単体テストする。現在時刻はFake Timer等で固定する。jsdom・React Testing Library等の描画テスト環境は導入しない。そのため、Reactコンポーネントの実際の描画結果は自動テストでは保証できず、Browserでの目視確認で補う（5.3・第7章）。
- Build：Vite Buildは型チェックを行わない。Buildの成功を型チェックの完了とみなさない（[技術スタック選定 第6章](technology-stack.md#6-開発環境)）。Production BuildはCIでは行わず、手元で実行して確認する。

新しく追加する設定・ソース・テストは`.gitattributes`でLF改行に固定する（既存運用）。

## 5. 基本画面と時計

画面の配置・寸法・色・文言は[UI設計 第3・4章](ui-design.md#4-画面レイアウト)に従う。本章は実装方針のみを記す。

### 5.1 レイアウト

- 1280×800のpx固定で作る（D10）。Responsive対応は先行実装しない（[アーキテクチャ 6.3](architecture.md#63-display-component--layout--contentswitcher)）。
- 開発PCのBrowserでは、画面全体をCSS `transform`で比例縮小して全体を確認できるようにする。倍率は`scale = min(viewportWidth / 1280, viewportHeight / 800, 1)`とする。
  - 表示領域が1280×800より小さい場合は、縦横比を保って縮小する。
  - 表示領域が十分に大きい場合は等倍とし、拡大しない。Raspberry Piの1280×800では等倍になる。
  - 余白が生じる場合は、画面全体を中央に配置する。スクロールバーは発生させない。
  - 縮小は画面全体の倍率だけを変える。Responsiveレイアウトやブレークポイントは追加しない。
- 左45%に時計タイル、右55%にコンテンツ領域を置く（L1）。#7のコンテンツ領域は空のタイルとし、文言やダミーデータは表示しない。
- 全画面表示では、スクロールバー・余白・マウスカーソル・文字選択が出ないようにする。
- 色は[UI設計 3.3](ui-design.md#33-カラー目安)のとおりCSS変数で一か所に定義する。

### 5.2 時計・日付・曜日

- 表示形式は`11月2日（月）`と`14:30`（24時間表記、秒なし、等幅数字）。[UI設計 4.1](ui-design.md#41-構成l1左に時計)・[要件 R-01](requirements.md#r-01時計日時表示)に従う。
- 現在時刻はBrowserの現在時刻（OS System Time）から取得する。表示の整形は`Intl.DateTimeFormat`で`timeZone: "Asia/Tokyo"`を明示し、OSのTimezone設定に依存しない（[アーキテクチャ 10.3](architecture.md#103-timezone)）。
- 1秒ごとに現在時刻を確認し、表示文字列（日付・時刻）が変わった場合だけ表示を更新する（D8）。時刻の補正や日付の変更にも最大1秒で追従する。
- 時刻のコロンの点滅など、常に動く演出は使わない（[UI設計 第7章](ui-design.md#7-アニメーションの方針)）。
- Zen Maru Gothicは等幅数字（`tnum`）を持たないため、`tabular-nums`を指定しても数字の幅は揃わない。時刻は時計タイルに収まり欠けないが、時刻が変わると右端が最大約80px動く。#7では変更せず、Issue #13の実機確認で見え方を確認する（[検証記録](verification/issue-7-clock-screen.md#等幅数字が効かない件)）。

### 5.3 時刻利用可否の状態注入

- 時計タイルは、時刻の利用可否を`available` / `unavailable`の状態として外から受け取る（D6）。ReactのPropsなど単純な方法で渡し、専用のServiceや抽象化は設けない。
- `unavailable`のときは日付と時刻を表示せず、[UI設計 6.3](ui-design.md#63-時刻未同期)の未同期表示を出す。`available`へ変わったら、操作なしで日付と時刻をフェードで表示する。
- #7では、OS・RTC・時刻同期の状態に基づく正式な判定を実装しない。判定元がないため、通常の画面では常に`available`として扱う。正式な判定は別Issueで扱う（第9章）。
- 未同期表示の検証には、通常のエントリーポイントとは分離した**検証専用エントリーポイント**を使う（D13）。
  - 通常画面と検証画面は、同じ時計コンポーネントを使う。検証画面で時計コンポーネントを再実装しない。
  - 通常のエントリーポイントは、#7の段階では`available`を固定で渡す。
  - 検証専用エントリーポイントは、`available` / `unavailable`を手動で切り替えて時計コンポーネントへ渡す。
  - 通常のエントリーポイントから検証専用のコードをimportしない。
  - 通常Buildと検証用Buildは別の出力先にする。通常Buildの成果物には、検証用のHTML・JavaScript・切替UIを含めない。実装時に、通常Buildの成果物に検証専用コードが含まれないことを確認する。
  - 検証専用エントリーポイントは、今後の回帰確認にも使えるようソースコードとして保持する。本番の成果物には含めない。
- 未同期表示と状態切替の検証は、次の3つを組み合わせる。
  - Vitest（Node環境）：表示内容を決める純粋関数を単体テストする。Componentの実際の描画結果までは保証しない。
  - 開発PCのBrowser：検証画面で、実際の画面の表示と切替を目視で確認する（第6章）。
  - Raspberry Pi：検証用Buildで、実際の画面の表示と切替を確認する（第7章）。
- この検証は未同期表示のUI動作を確認するものであり、OS・RTC・NTP等に基づく正式な時刻利用可否の判定を保証しない。
- URLのクエリパラメータ等で未同期表示へ強制的に切り替える機能を、本番の成果物に恒久的に残さない。

#7で時計を実装しても、MVP全体として時刻の正当性を保証したことにはならない。R-01の「正しい時刻を取得できていない場合はローカル時刻を表示しない」は、正式な判定の実装と実機確認（Issue #13）をもって満たす。

### 5.4 フォント・アイコン

- Zen Maru Gothicは`@fontsource/zen-maru-gothic`で管理し、Vite Buildの成果物に含める（D9）。読み込むのはウェイト500・700のみ（`src/frontend/styles/fonts.ts`）。フォントのライセンス（SIL Open Font License）の表記の扱いは未確定（第8章）。
- アイコンは必要なSVG（#7では未同期表示の時計アイコン）だけをアプリに同梱する。時計アイコンはTabler Icons（MIT）のclock-pauseのPathを使い、ライセンス表記をソース（`src/frontend/icons/ClockPauseIcon.tsx`）に残している。
- 外部CDN・Webフォントサービスを参照せず、ネットワークに接続できなくても基本画面を表示できるようにする（[UI設計 第13章](ui-design.md#13-uiモック)、[要件 R-06](requirements.md#r-06電源投入再起動異常終了からの自動復旧)）。

## 6. PCでのプレビュー

開発PCでVite Development Serverを起動し、Browserで通常画面を確認する。5.1の比例縮小により、ウィンドウが1280×800より小さくても画面全体を縮小して確認できる。大きいウィンドウでは等倍で中央に表示する。

時刻利用可否の表示は、検証画面（検証専用エントリーポイント、D13・5.3）で確認する。

- `available`と`unavailable`それぞれの時計コンポーネントの表示内容。
- `unavailable`で日付と時刻が表示されず、未同期表示になること。
- `available`へ切り替えたときに、日付と時刻がフェードで表示されること（復帰時の表示）。

通常画面は`npm run dev:frontend`、検証画面は`npm run dev:frontend:verify`で起動する。検証画面は未同期表示（`unavailable`）で始まり、画面右下のボタンまたはSpaceキーで切り替える。

通常Buildの成果物（`dist/frontend/`）に、検証専用のHTML・JavaScript・切替UIが含まれないことを確認した（PR #81）。

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

未同期表示は、検証用Buildを使って確認する（D13）。

1. Development PCで、通常Buildと検証用Buildを別々に生成する。両者の出力先は分ける。
2. 通常Buildの成果物に、検証専用のHTML・JavaScript・切替UIが含まれないことを確認する。
3. 検証用Buildの成果物を、Raspberry Piへ一時的に転送する。本番の配信先には配置しない。
4. 一時HTTPサーバー（`127.0.0.1`で待ち受け）とChromium Kioskで検証画面を表示する。
5. `available` / `unavailable`それぞれの表示と、その切替を確認する（確認内容は第6章と同じ）。
6. 確認後、一時サーバーとChromiumを停止し、Pi上の検証用成果物を削除する。確認結果は`docs/verification/`へ記録する。

#7で使ったコマンド（`<user>`・`<pi-host>`・`<port>`は環境に合わせる）：

```sh
# Development PC（リポジトリのルート）
npm run build:frontend
npm run build:frontend:verify
scp -r dist/frontend <user>@<pi-host>:~/signage-check/
scp -r dist/frontend-verify <user>@<pi-host>:~/signage-check/

# Raspberry Pi（デスクトップのターミナル）。検証画面は配信先をfrontend-verifyに変える
python3 -m http.server <port> --bind 127.0.0.1 --directory ~/signage-check/frontend
chromium-browser --kiosk --incognito http://127.0.0.1:<port>/

# 確認後
rm -rf ~/signage-check
```

- Pi OSによっては、Chromiumのコマンド名が`chromium`の場合がある。Chromiumは`Alt+F4`で閉じ、一時サーバーは`Ctrl+C`で止める。
- 本番の配信（nginx）・自動起動・Deployの手順はIssue #12で扱う。
- 約3mからの判読性・長時間稼働などMVPの受入確認はIssue #13で行う。

## 8. 未解決事項

開発PCと実機で未同期表示へ切り替える方式は、D13（検証専用エントリーポイント）で確定した。依存のバージョン、npm scripts、Buildの出力先、検証用のファイル構成、一時HTTPサーバーのコマンドは、#7の実装で確定した（第2・3・6・7章）。以下は未確定である。

- OS・RTC・時刻同期の状態に基づく、正式な時刻利用可否の判定（Issue #65）。
- フォントのライセンス（SIL Open Font License）の表記の扱い（5.4）。
- 等幅数字が効かないことによる、時刻の右端の動きの見え方（5.2。Issue #13で確認）。

## 9. 後続Issueへの引き継ぎ

- #8：コンテンツの切替・インジケーター・切替アニメーション。時刻未同期中にコンテンツ領域へ1枚表示して巡回を止める動作（[UI設計 6.3](ui-design.md#63-時刻未同期)）。
- #9・#10：天気・予定の表示データ。表示用APIのPolling、Published Stateの型とRuntime Validation、取得中・取得不可の表示。
- #12：nginxによる本番配信、Chromium Kioskの自動起動、Deploy手順。
- #13：MVP全体の受入確認（判読性、起動時間、時刻・日付テスト、長時間稼働）。時刻が変わったときに右端が動く見え方が気にならないか（5.2）も確認する。
- #16：Backend共通基盤と表示用API（Published State API）。
- #65：OS・RTCに基づく表示用時刻の利用可否判定。判定に使う情報、判定を行う場所、Frontendへの渡し方を決めて実装し、#7の状態入力へ接続する。既存文書の判定方法の参照先（[アーキテクチャ 10.2](architecture.md#102-時刻同期rtcと利用可否)の「Issue #4」、[技術スタック選定 24.3](technology-stack.md#243-time--rtc)の「#6・#13」）との関係もこのIssueで整理する。
