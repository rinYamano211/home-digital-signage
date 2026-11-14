# Frontend開発手順（Issue #7・#8・#9・#10）

単一PackageのReact + TypeScript + Vite Frontend。Issue #7では、基本画面（レイアウト・時計・日付・曜日）と、その開発基盤・実機確認手順までを扱う。コンテンツの切替、天気・予定の表示、表示用APIとの接続は実装しない。

状態：Issue #7で実装済み（PR #80・#81、2026-11-07）。Issue #7の検討（D1〜D13）で確定した事項と、実装時に確定した依存・設定・コマンドを記録する。Raspberry Piでの確認結果は[検証記録](verification/issue-7-clock-screen.md)を参照。

Issue #8（コンテンツの自動切替）は第10章に記す（PR #84で実装済み、2026-11-07）。Raspberry Piでの確認結果は[検証記録](verification/issue-8-content-rotation.md)を参照。

Issue #10（予定の表示、表示用APIのPolling）は第11章に記す（実装済み、Raspberry Pi・実データで確認済み）。

Issue #9（天気の表示）は第12章に記す（実装済み、Raspberry Pi・実データで確認済み。一部繰越）。

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
  content/               コンテンツの定義・切替のロジック・表示時間の設定・インジケーター（Issue #8、第10章）
  published-state/       表示用APIのPolling・Published Stateの検証（Issue #10、第11章）
  schedule/              予定のComponent State・並び順・件数の集約・予定パネル（Issue #10、第11章）
  weather/               天気のDomain検証・Component State・天気パネル（Issue #9、第12章。PR #96で追加）
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
- 左45%に時計タイル、右55%にコンテンツ領域を置く（L1）。#7のコンテンツ領域は空のタイルとし、文言やダミーデータは表示しない。#8以降はコンテンツの切替領域とする（第10章）。
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
- #7では、OS・RTC・時刻同期の状態に基づく正式な判定を実装しない。判定元がないため、通常の画面では常に`available`として扱う。正式な判定はIssue #65で扱い、通常の画面へ渡す値は第13章に従う。
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

- OS・RTC・時刻同期の状態に基づく、正式な時刻利用可否の判定（Issue #65）。設計は第13章で確定し、実装は未完了。
- フォントのライセンス（SIL Open Font License）の表記の扱い（5.4）。
- 等幅数字が効かないことによる、時刻の右端の動きの見え方（5.2。Issue #13で確認）。

## 9. 後続Issueへの引き継ぎ

- #8：コンテンツの切替・インジケーター・切替アニメーション。時刻未同期中にコンテンツ領域へ1枚表示して巡回を止める動作（[UI設計 6.3](ui-design.md#63-時刻未同期)）。設計は第10章。
- #9・#10（#8からの引き継ぎ）：各コンテンツが表示できるかの判定と、ContentSwitcherへの受け渡し。仮パネルの差し替え。起動直後の`予定と天気を取得しています`の1枚表示（第10章 10.5）。#10の範囲は第11章で定めた。
- #9・#10：天気・予定の表示データ。表示用APIのPolling、Published Stateの型とRuntime Validation、取得中・取得不可の表示。Polling・共通の検証・1枚表示は#10で作り、#9は天気のDomain部分を追加する（第11章）。
- #12：nginxによる本番配信、Chromium Kioskの自動起動、Deploy手順。
- #13：MVP全体の受入確認（判読性、起動時間、時刻・日付テスト、長時間稼働）。時刻が変わったときに右端が動く見え方が気にならないか（5.2）も確認する。
- #16：Backend共通基盤と表示用API（Published State API）。
- #65：OS・RTCに基づく表示用時刻の利用可否判定。判定に使う情報、判定を行う場所、Frontendへの渡し方を決めて実装し、#7の状態入力へ接続する。設計は第13章・[技術スタック選定 第25章](technology-stack.md#display-time-availability)に記録し、判定方法の参照先（アーキテクチャ 10.2・技術スタック選定 24.3）も#65へ整理した。

## 10. コンテンツの自動切替（Issue #8）

状態：PR #84で実装済み（2026-11-07）。Issue #8の検討（S1〜S8）で決めた事項と、実装時に確定した事項を記録する。Raspberry Piでの確認結果は[検証記録](verification/issue-8-content-rotation.md)を参照。切替の順序・表示時間の初期値・動き・巡回への参加の考え方は[UI設計 4.2・6.2・6.3・第7章](ui-design.md#42-コンテンツの切替)、責務の分担は[アーキテクチャ 6.2・6.3](architecture.md#62-content-switching)に従う。本章は実装方針のみを記す。

### 10.1 範囲

| #8で扱う                                                                                    | #8で扱わない                                                              |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| ContentSwitcher（順序・表示時間・現在位置・次に表示するコンテンツの決定）                   | 予定・天気の表示データと描画（#9・#10）                                   |
| 固定表示（時計）と切替領域の分離                                                            | 表示用APIのPolling・Runtime Validation・Component State生成（#9・#10）    |
| インジケーター・切替アニメーション                                                          | 各コンテンツが表示できるかの具体的な判定（予定の`data: null`等。#9・#10） |
| 表示できるコンテンツが0件のときの1枚表示（UI設計 6.2）、時刻未同期中の1枚表示（UI設計 6.3） | 起動直後の`予定と天気を取得しています`の判定と表示（UI設計 6.5。#9・#10） |
| コンテンツ名だけの仮パネルと、検証画面での確認                                              | 時刻利用可否の正式な判定（#65）、Backend（#16）                           |

### 10.2 責務と構成（S1）

- 切替の判断（次にどれを表示するか、いつ切り替えるか）は、Reactに依存しない純粋なロジックとして`src/frontend/content/`に置く。ReactのHookはTimerの管理と描画への受け渡しだけを行う。
- コンテンツは「識別子・名前・描画・表示時間」を持つ定義の配列（Registry）で管理する。配列の順が巡回の順序になる。MVPの順序は`今日の予定 → 今日の天気 → 週間天気`で固定する。
- コンテンツを追加するときは、定義を1件作って配列に加える。ContentSwitcherのロジックは変更しない。利用者によるON/OFF・順序・表示時間の変更はFutureとし、実装しない（Issue #8 Future）。
- 時計タイル（`ClockTile`）はContentSwitcherを経由せず、Layout（`Screen`）が直接配置する（アーキテクチャ 6.3）。`ClockTile`は変更しない。

### 10.3 インジケーターの配置（S2）

- インジケーターは時計とは別のComponentとし、`Screen`が時計タイルの下部に重ねて配置する。時計のComponentがContentSwitcherの情報に依存しないようにするため。
- 表示の仕様はUI設計 4.1・4.2に従う（3つの点、表示中は横長のアクセント色、巡回から外れたコンテンツは白抜き、約0.5秒で位置を移す）。
- 時刻未同期中・表示できるコンテンツが0件の1枚表示中は、点を表示し、表示中の点（横長）は出さない。表示できないコンテンツの点は白抜きにする（UIモックと同じ）。

**比較した案**：`ClockTile`がインジケーターを子として受け取る。配置は簡単だが、時計がContentSwitcherの情報に依存する形になるため採用しない。

### 10.4 表示時間（S3・S4）

- 表示時間は、Frontendの設定専用モジュール（`src/frontend/content/rotation-config.ts`）に定数として置く。切替のロジック・描画とは別のファイルにし、設定値だけを変更できるようにする（要件 R-04・R-08「MVPの動作設定は本体と分離して保持」）（S3）。
- 表示時間はコンテンツごとに持つ。初期値はUI設計 4.2・第11章のとおり、すべて10秒とする（暫定採用）。実機で読みやすさを確認して調整する（S4）。
- 変更はソースの修正 → Build → Raspberry Piへの転送で反映する。利用者が変更する機能・設定UIはFutureとする。

**比較した案**：

- Build成果物とは別のJSONをBrowserが起動時に読む。Pi上で書き換えられるが、読み込みの失敗時の既定値・検証が増えるため、MVPでは採用しない。
- Backend Config（systemd EnvironmentFile）に置き、表示用APIで渡す。表示用APIの契約とBackendの変更が必要になり、#8の範囲を超えるため採用しない。
- 全コンテンツで共通の1値にする。単純だが、予定の件数が多いときだけ長くする等の調整ができないため採用しない。

### 10.5 巡回への参加の受け口（S5）

- ContentSwitcherは、各コンテンツが現在表示できるかを真偽値として外から受け取る。表示できるかの具体的な判定（UI設計 6.2の条件）は、各コンテンツのComponent State生成側（#9・#10）が行う。
- Component Stateに共通の状態enum（Full / Partial / Unavailable等）を保持しない原則は維持する（アーキテクチャ 7.7）。真偽値は、その時点のComponent Stateから導出して渡す。
- 時刻の利用可否は、時計タイルと同じ`available` / `unavailable`の状態を受け取る（5.3）。
- 1枚表示の種類は次の2つを#8で実装する。起動直後の`予定と天気を取得しています`（UI設計 6.5）は、Pollingの状態が必要なため#9・#10で追加する。#8では、表示できるコンテンツが0件のときの1枚表示を外から差し替えられるようにしておく。

| 状態                                         | コンテンツ領域                                                       | 巡回   |
| -------------------------------------------- | -------------------------------------------------------------------- | ------ |
| 時刻が`unavailable`                          | `時刻を確認できるまで`／`予定と天気は表示しません`（UI設計 6.3）     | 止める |
| 時刻が`available`で、表示できるものが0件     | `予定と天気を取得できません`／`自動で再試行しています`（UI設計 6.2） | 止める |
| 時刻が`available`で、表示できるものが1件以上 | 表示できるコンテンツだけを順に表示する                               | 続ける |

### 10.6 巡回の細かい動作（S6）

UI設計に記載のない動作は、UIモック（[ui-mock/signage-mock.html](ui-mock/signage-mock.html)）の動作を基に次のとおりとする。

1. 表示時間は、コンテンツが切り替わった時点から数える。コンテンツごとにTimerを設定し直し、一定周期のTimerは使わない。
2. 表示中のコンテンツが表示できなくなった場合は、表示時間の途中でも、すぐに次の表示できるコンテンツへ切り替える。
3. 巡回から外れていたコンテンツが表示できるようになった場合は、表示中のコンテンツを中断せず、順番が来たときに表示する。
4. 表示できるコンテンツが1つだけの場合は、同じコンテンツを表示し続け、切替のアニメーションを繰り返さない。
5. 1枚表示（時刻未同期・0件）から戻る場合は、`今日の予定`から順に、表示できる最初のコンテンツから始める（UI設計 6.3）。
6. コンテンツと1枚表示の間の切替も、コンテンツ間と同じ動き（フェード＋少し上へ、約0.6秒、`opacity`と`transform`のみ）を使う（UI設計 4.2・第7章）。

### 10.7 通常画面と検証画面（S7）

- 経緯（#8の実装時点）：#9・#10が入るまでは、通常画面でコンテンツ名だけの仮パネル（`今日の予定`・`今日の天気`・`週間天気`）を巡回させ、3つとも表示できるものとして扱っていた。予定や天気の偽のデータは表示しない方針とした。
- 現在：仮パネルはない。予定は#10（第11章）、天気は#9のPR #96（第12章）で実際のコンテンツに差し替え、仮パネルは撤去した。各コンテンツの表示可否は、表示用APIの状態から判定する（11.6・12.5）。
- 通常画面では、時刻は`available`を固定で渡す（5.3。正式な判定は#65）。
- 検証画面（5.3）を拡張し、各コンテンツの表示可否と時刻の利用可否をキーボードで切り替えられるようにする。これにより、一部のコンテンツが表示できない場合・0件の場合・時刻未同期の場合の巡回をBrowserとRaspberry Piで確認する。キー割り当ては、Spaceキーで時刻の利用可否、1・2・3キーで今日の予定・今日の天気・週間天気の表示可否を切り替える（画面右下のボタンでも切り替えられる）。
- 通常のエントリーポイントから検証専用のコードをimportしない方針（5.3）は維持する。

### 10.8 テストと確認（S8）

- Vitest（Node環境）とFake Timerで、切替のロジックをダミーのコンテンツ定義を使って単体テストする（4章 D5）。描画テスト環境は導入しない。
  - 固定順で繰り返し切り替わること、設定した表示時間で切り替わること。
  - 一部のコンテンツが表示できなくても、残りのコンテンツで巡回が続くこと。
  - 0件・時刻未同期で1枚表示になり巡回が止まること、そこから`今日の予定`から再開すること。
  - 10.6の各動作。
  - コンテンツ定義を追加すると、ロジックを変えずに巡回の対象になること。
- 描画（インジケーター・アニメーション・1枚表示）は、開発PCのBrowserとRaspberry Piの検証画面で目視確認する（第6・7章と同じ手順）。
- 表示時間は、#8の時点でRaspberry Piの通常Buildの仮パネルを使って確認し、結果を`docs/verification/`へ記録した（[Issue #8の検証記録](verification/issue-8-content-rotation.md)）。予定・天気の実際の情報量での最終調整は、#9・#10の実装後とIssue #13で行う。

### 10.9 実装時に確定した事項

- ファイル構成（`src/frontend/content/`）：切替のロジック（`rotation.ts`）、Reactへの接続（`useContentRotation.ts`）、Registry（`registry.tsx`）、表示時間（`rotation-config.ts`）、インジケーター（`Indicator.tsx`・`indicator-dots.ts`）、切替アニメーション（`ContentArea.tsx`・`transition.ts`）、1枚表示（`NoticeCards.tsx`）。通常画面と検証画面は`src/frontend/SignageScreen.tsx`で同じ画面を組み立てる。
- `indicator.ts`と`Indicator.tsx`は大文字・小文字だけの違いでWindowsで衝突するため、点の状態の計算は`indicator-dots.ts`とした。
- 表示の正本は`ContentRotation`とし、Reactの表示はその通知だけで更新する。StrictModeのEffect再実行などで作り直すときは、最後に表示した内容から続ける（PR #84のレビュー対応）。
- 切替アニメーション中にさらに表示が変わった場合は、重ねるのを「抜けていく表示」と「現在の表示」の最大2枚とし、それまで抜けていた表示はすぐに外す。
- 全コンテンツ取得不可の1枚表示のアイコンは、Tabler Iconsの`wifi-off`（MIT）を同梱した（UIモックと同じ）。文字色はUIモックの値（`#8d877e`）を`--color-text-unavailable`として定義した。

## 11. 予定の表示（Issue #10）

状態：実装済み（Issue #10のPR4）。Raspberry Pi・実データでの確認結果と、確認していない事項は[Issue #10の検証記録](verification/issue-10-schedule.md)に記す。Backend側の設計は[技術スタック選定 18.7](technology-stack.md#schedule-issue-10-design)、画面仕様は[UI設計 5.1・第6章](ui-design.md#51-今日の予定)を正本とする。本章はFrontendの実装方針のみを記す。

### 11.1 範囲

| #10で扱う                                                                                              | #10で扱わない                                                            |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 表示用APIのPolling（7.3の仕様）と、Response共通部分（下記の外枠と各Stateの`data`・`meta`の構造）の検証 | 天気の表示データ・検証・描画（#9）                                       |
| Scheduleの`data`の検証、予定のComponent State、予定パネル                                              | 時刻利用可否の正式な判定（#65）。`time="available"`固定を維持する（5.3） |
| 予定の巡回への参加（`displayable`）、起動直後の取得中表示（UI設計 6.5）                                | nginxでの本番配信（#12）                                                 |
| 検証画面での予定の合成データ、開発時の`/api` Proxy                                                     |                                                                          |

### 11.2 構成

- Pollingは`App`の直下に1つだけ置き、取得したResponseを各コンテンツへ渡す。コンテンツのComponentは切替のたびに作り直されるため、そこでは取得しない。
- 通信（`published-state/`）、予定の判定（`schedule/`の純粋関数）、描画（予定パネル）を分ける。判定はReactに依存しない純粋関数とし、Vitestで確認する。
- 型とRuntime ValidationにはTypeBox（既に`dependencies`にある）を使う。依存は追加しない。FrontendからBackendのコードはimportしない（第2章）。
- Component Stateは`Polling`のResponseと現在時刻から導く派生Stateで、Backendへ戻さない（アーキテクチャ 7.4）。
- Responseの階層（技術スタック選定 10.2・10.4・10.7）：トップレベルは`schemaVersion`（数値`1`）と`states`だけを持つ。`states`はState Key（`schedule`等）ごとの`{ data, meta }`で、`meta`（共通Metadataの6項目）は**各Stateの内部**にある。トップレベルに`meta`はない。本章で「外枠」と呼ぶのはトップレベルの`schemaVersion`・`states`、「State共通部分」は各Stateの`data`（ObjectまたはNull）と`meta`、「Domain部分」は`data`の中身（予定は技術スタック選定 18.1）とする。

```text
{ schemaVersion: 1,
  states: {
    schedule: { data: { date, events: [...] } | null,
                meta: { dataUpdatedAt, expiresAt, lastAttemptAt, lastAttemptResult, publishedAt, dataSource } },
    ...（他のStateも同じ形。未公開のStateはKeyごと省略） } }
```

### 11.3 Polling

7.3の仕様（初回即時、完了から30秒後、Timeout 5秒、同時1件、即時Retryなし、Unmount時に停止）に従う。

検証の結果に応じて、保持するResponseを次のように扱う。

| 場合                                                                                    | 扱い                                                                                                                                     |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP取得の失敗（通信失敗・Timeout・503等の200以外・JSONとして読めない・外枠の検証失敗） | Polling失敗。最後に正常取得したResponseをそのまま保持する。HTTP失敗を「更新待ち」の判定に使わない（UI設計 6.4）                          |
| HTTP取得の成功（200で外枠が正しい）                                                     | 今回のResponseを採用し、保持している`states`全体を置き換える。省略されたStateは削除する（7.3）                                           |
| 上記の成功のうち、特定のStateだけがState共通部分またはDomain部分の検証に失敗            | そのStateだけを今回のResponseから除外し、省略されたものとして扱う（「取得できません」）。他の正常なStateは今回のResponseの内容へ更新する |

- Stateの検証失敗はPolling失敗ではない。除外したStateを、過去に正常取得したResponseから自動で復元しない（古いデータを表示し続けないため）。次のPollingで正常なら表示に戻る。
- 最後に正常取得したResponseを保持するのは、HTTP取得そのものが失敗した場合（上表の1行目）に限る。
- Pollingの状態として「最初の応答を待っている」「一度も正常取得できないまま失敗した」を区別し、UI設計 6.5の1枚表示に使う。

### 11.4 予定のComponent State

1分ごと、およびResponseの更新時に、現在時刻（Asia/Tokyo、時計と同じ方法）で再評価する。Pollingを待たない（技術スタック選定 18.4）。

| 条件                                                   | 状態                                 | 巡回 |
| ------------------------------------------------------ | ------------------------------------ | ---- |
| `schedule`がない（未公開・検証失敗）                   | 取得できません                       | 外す |
| `data: null`、`lastAttemptAt: null`                    | 取得中（`予定を取得しています`）     | 外す |
| `data: null`、`lastAttemptAt`あり                      | 取得できません                       | 外す |
| `now >= expiresAt`、または`data.date`がJSTの今日でない | 取得できません                       | 外す |
| 有効で`events: []`                                     | 予定なし（`本日の予定はありません`） | 残す |
| 有効で予定あり                                         | 予定一覧                             | 残す |

- 有効なデータで`lastAttemptResult === "failure"`なら、「更新待ち」の札（`meta.dataUpdatedAt`の時刻）を付ける。`dataSource`の値は使わない（技術スタック選定 18.7）。
- 進行中・終了済み・次の予定は`startAt`・`endAt`と現在時刻で判定する。終了済みは`endAt <= now`、進行中は`startAt <= now < endAt`。
- 時刻が`unavailable`の間は、既存の1枚表示（10.5）が優先する。

### 11.5 並び順・表記・件数

- 並び順：Backendの`events`の順は使わない。時刻指定は`startAt`、同じなら`id`の昇順。終日は`startDate`、同じなら`id`の昇順。終日と時刻指定は別枠（UI設計 5.1）。同じ時刻の予定の順番がPollingのたびに変わらないようにするため。
- タイトル：`trim()`して空なら`（タイトルなし）`と表示する。Reactの通常のテキストとして描画する（HTMLとして解釈しない）。
- 日付またぎ・終了表記：UI設計 5.1に従う。
- 件数：UI設計 5.1の行の高さの目安と、コンテンツ領域の高さから、何行入るかを計算で決める。DOMの計測は使わない（描画テスト環境を入れない方針、10.8）。行の高さ等の値は設定用の定数にまとめ、実機で調整する。

### 11.6 1枚表示と巡回

UI設計 6.5の判定を次の優先順で行う。

1. 時刻が`unavailable`：時刻未同期の1枚表示（既存、10.5）
2. 表示用APIの最初の応答を待っている：`予定と天気を取得しています`
3. 一度も正常取得できないまま最初のPollingが失敗した：`予定と天気を取得できません`（既存、6.2）
4. 表示できるコンテンツが0件：表示できない理由がすべて「取得中」なら`予定と天気を取得しています`、それ以外は`予定と天気を取得できません`
5. それ以外：表示できるコンテンツを巡回する

- 天気（#9）は、PR #96で天気の判定（12.5）に置き換え、仮パネルの扱いをなくした。
- 4の判定では、`rainForecast`を数えない。#93が終わるまでは本番で未実装のため、終わった後も恒久の扱い（UI設計 6.5、12.5）。
- 1枚表示の差し替えは、既存の`renderNoContent`（10.5）を使う。

### 11.7 開発・検証

- 開発時の接続：Vite開発サーバーに`/api`のProxy（`127.0.0.1:3000`）を追加する。開発サーバーだけの設定で、Build成果物には含まれない。Raspberry PiのBackendには、SSHのポート転送（`ssh -L 3000:127.0.0.1:3000 <user>@<pi-host>`）でつなぐ。WindowsではBackendを起動できない（Lockに`sh`・flockを使い、better-sqlite3も入らない）。
- 検証画面：予定の合成データ（多件・進行中・次の予定・日付またぎ・前日から継続・終日・同時刻・長いタイトル・タイトルなし・予定なし・取得中・取得できません・更新待ち）と、Pollingの状態（最初の応答待ち・一度も取得できない）を切り替えられるようにする。キー割り当ては実装時に決めて本章へ記録する。
- 単体テスト（Vitest、Fake Timer）：Polling（間隔・Timeout・同時1件・失敗時の保持・省略Stateの削除）、外枠・予定の検証、11.4の各状態、日付の照合・期限切れ、並び順の安定性、表記、件数の集約、11.6の優先順。
- Raspberry Pi：合成データの検証画面を、第7章と同じ一時HTTPサーバーとChromium Kioskで確認する。実データの画面表示はPCのBrowser（上記のポート転送）で確認する。結果は`docs/verification/`へ記録する。

### 11.8 実装時に確定した事項

- ファイル構成：通信は`published-state/`（`schema.ts`：外枠・State共通部分の検証とDomain検証の呼び出し、`polling.ts`：Polling、`usePublishedStates.ts`：Reactへの接続と1分ごとの時刻）。予定は`schedule/`（`schedule-data.ts`：Domain Dataの検証、`schedule-state.ts`：表示状態・並び順・表記、`fit.ts`：件数の集約、`layout-config.ts`：行の高さの目安、`SchedulePanel.tsx`：描画）。巡回の入力は`signage-model.ts`（11.6の優先順）で導く。
- Registryの`render`は、Component State（`ContentContext`）を引数に受け取る形にした。天気のパネルもPR #96から同じ引数を使う。
- Pollingの結果（`PollingSnapshot`）は、状態（`waiting`・`received`・`neverReceived`）、最後に正常取得した`states`、作成時刻を持つ。表示はResponseの更新時と1分ごとに、その時点の時刻で再評価する。
- 「取得しています」の砂時計アイコンは、このプロジェクトで描いたSVG（`icons/HourglassIcon.tsx`）。
- 検証画面のキー：Sキーで予定の合成データ、PキーでPollingの状態を切り替える（Space・1・2・3は10.7のまま。1・2・3は「巡回から外す」として働く）。合成データは`verify/schedule-scenarios.ts`。
- 既存の`tests/frontend/smoke.test.ts`は`App()`を関数として直接呼んでいたが、`App`がHookを使うようになったため、要素を作って確かめる形に変えた。
- Pollingの5秒Timeoutは、通信の中止（物理）と、そのRequestを失敗として終えること（論理）を分けた。中止後も通信が終わらない場合でも次のPollingへ進み、遅れて届いた結果は採用しない（PR #91のレビュー対応）。
- 日時の検証はBackendの表示用APIと同じ規則（UTC、実在する日付、時刻の範囲）を`published-state/utc-instant.ts`に持つ。予定の`startAt`・`endAt`は、Backendが出力する`toISOString()`の形だけを有効とする。
- 件数の集約で省くのは「次の予定」より後の予定だけで、3件目以降の進行中は省かない。進行中だけで収まらない場合は、パネルの下端で切れる。この場合は実機・実データで確認していない（[Issue #10の検証記録](verification/issue-10-schedule.md)「確認していないこと」）。
- 開発PCのBrowserで、検証画面の各パターン（通常・多件の集約と`ほか N件`・日付またぎ・同時刻・更新待ち・取得中の1枚表示）を目視で確認した。行の高さの目安は控えめで、多件の例では下に1〜2行分の余白が残る。Raspberry Piの画面（1280×800、合成データ）で多件の表示にはみ出しがないことを確認し、値は変更していない（検証記録 E1・E2）。

## 12. 天気の表示（Issue #9）

状態：実装済み（Issue #9のPR #96）。Raspberry Pi・実データでの確認結果と、確認していない事項・繰越事項は[Issue #9の検証記録](verification/issue-9-weather.md)に記す。Backend側の設計は[技術スタック選定 16.6](technology-stack.md#weather-issue-9-design)、各Stateの表示方針は技術スタック選定の[19.5](technology-stack.md#195-取得失敗とfrontend表示)・[20.5](technology-stack.md#205-frontend表示)・[22.5](technology-stack.md#225-frontend表示)、画面仕様は[UI設計 5.2〜5.4・第6章](ui-design.md#52-今日の天気)を正本とする。本章はFrontendの実装方針のみを記す。RainForecast（降雨帯の実データ）は[Issue #93](https://github.com/rinYamano211/home-digital-signage/issues/93)で扱う。

### 12.1 範囲

| #9で扱う                                                                                                  | #9で扱わない                                                      |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `currentWeather`・`hourlyWeather`・`weeklyWeather`の`data`の検証（第11章の`DOMAIN`へ追加）                | RainForecastの`data`の検証と降雨帯の実データ表示（#93で実装済み） |
| 今日の天気・週間天気のComponent State・パネル・アイコン・出典表示                                         | 時刻利用可否の正式な判定（#65）。`time="available"`固定を維持する |
| 天気の巡回への参加（`displayable`）、起動直後の取得中の判定（11.6）への天気の追加、仮パネル（10.7）の撤去 | Pollingと外枠・State共通部分の検証の変更（第11章のものを使う）    |
| 検証画面での天気の合成データ                                                                              |                                                                   |

### 12.2 構成

- 第11章の構成（Pollingは`App`直下に1つ、通信・判定・描画の分離、判定はReactに依存しない純粋関数、TypeBox）を使う。依存は追加しない。
- 天気の判定は`weather/`に置く。予定（`schedule/`）とは分け、共通化は同じ規則（時刻の形式、最終更新時刻の表記）に限る。

### 12.3 各Stateの表示状態

1分ごと、およびResponseの更新時に、現在時刻で再評価する（11.4と同じ）。

| 条件                                                | 状態                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| Stateがない（未公開・検証失敗）                     | 取得できません                                                                    |
| `data: null`、`lastAttemptAt: null`                 | 取得中（例：`現在の天気を取得しています`）                                        |
| `data: null`、`lastAttemptAt`あり                   | 取得できません                                                                    |
| `now >= expiresAt`                                  | 取得できません                                                                    |
| 有効で、現在時刻から選べる枠・日が0（時間別・週間） | 取得できません（API取得失敗とは内部で区別する。20.5・22.5）                       |
| 有効                                                | 表示。`lastAttemptResult === "failure"`なら更新待ちの札（`dataSource`は使わない） |

- CurrentWeather：気温・天気アイコン・天気名。昼夜は`isDay`。
- HourlyWeather：現在時刻の次の正時（正時ちょうどはその時刻）から最大12枠を選ぶ。1〜11枠なら存在する枠だけを左から並べる（20.5）。夜アイコンは18:00〜翌05:59（UI設計 5.4）。
- WeeklyWeather：現在のJST暦日から連続する最大7日を選ぶ。1〜6日なら存在する日だけ（22.5）。気温バーの幅は表示する日の最低〜最高で計算する（UI設計 5.3）。
- 最高・最低（今日の天気の上段）：WeeklyWeatherの今日（JST）が表示できる場合だけ表示する（UI設計 5.2）。
- 降雨帯（Issue #93）：`weather-state.ts`の`rainForecastView`が、取得中・取得できない（30分以上・期限切れ・未来の`dataUpdatedAt`）・更新待ち（10分以上30分未満。予報を隠し、最終更新時刻）・表示（10分未満。直近の取得が失敗なら更新待ちの札）を判定する。基準は`dataUpdatedAt`。文言は`rainBand`（UI設計 5.2）：「あと約N分」は現在時刻から再計算し、予報時刻を過ぎたら`予報時刻を過ぎました`と更新待ちの札を示す。`status`は再計算しない。

### 12.4 アイコン・天気名

- UI設計 5.4の区分ごとに、天気名を`晴れ`・`くもり`・`霧`・`雨`・`雪`・`雷雨`・`天気不明`とする。未知の天気コードは`天気不明`（アイコンは「？」）。取得失敗とは扱わない。
- アイコンはUIモックと同じTabler Icons（MIT）のSVG Pathを、既存の`ClockPauseIcon.tsx`と同じ方法でソースに同梱する。ライセンス表記をソースに残す。依存パッケージ（`@tabler/icons-react`等）は追加しない。

### 12.5 巡回への参加と1枚表示

- 今日の天気：現在の天気・時間別・降雨のどれか1つでも表示できれば巡回に残す（UI設計 6.2）。降雨は予報を表示できるとき（取得から10分未満で、予報時刻を過ぎていない）だけ数える。更新待ち・予報時刻超過は数えない。
- 週間天気：WeeklyWeatherが表示できれば残す。
- 11.6の4（表示できるコンテンツが0件）の判定では、表示できない理由がすべて「取得中」なら取得中の1枚表示とする。このとき、**`rainForecast`は数えない**（UI設計 6.5。MVPの正式仕様）。#93でRainForecastを本番に登録した後も同じで、一覧（定数）から外さない。対象は明示した一覧（定数）で持ち、他のStateの取得失敗・省略は除外しない。降雨帯には、`rainForecast`の取得中・更新待ち・取得不可を個別に表示する。#93のFrontend実装（PR 5）では、定数名・コメントの「未実装State」を、全体の取得中判定から除外するStateを表す名称に見直し、`rainForecast`だけが未設定・取得不可でも他の正常な情報が表示されることをテストする（技術スタック選定 21.9）。
- 天気の仮パネル（10.7）と、`signage-model.ts`の「天気は表示できるものとして扱う」処理は、PR #96で撤去した。

### 12.6 出典表示

今日の天気・週間天気の両パネルの下端に、`Weather data by Open-Meteo.com`を小さい灰色の文字で表示する（UI設計 5.2・5.3）。

### 12.7 開発・検証

- 検証画面：天気の合成データ（正常・更新待ち・取得中・取得できません・期限切れ・時間別の日付またぎ・枠の不足・週間の日数不足・未知の天気コード・夜）を切り替えられるようにする。キー割り当ては下記。
  - キー割り当て（PR3で決定）：Wキーで天気の合成データを順に切り替える（Space・1・2・3・S・Pは11.7のまま）。合成データは`verify/weather-scenarios.ts`。上記に加えて「現在の天気だけ取得できません」（部分取得失敗）を持つ。日付またぎ・夜は、表示の評価に使う時刻だけを今日の18:30・21:00にする（時計の表示は変えない）。
- 単体テスト（Vitest、Fake Timer）：12.3の各状態、時間別の12枠の選択（正時ちょうど・日付またぎ）、週間の7日の選択（0時の切替）、最高・最低の表示条件、天気コードの区分、12.5の巡回と1枚表示（未実装Stateの除外を含む）。
- 既存のテスト（`content-display`・`signage-model`の仮パネル前提の部分等）は、PR #96で更新した。
- Raspberry Pi・実データでの確認方法は11.7と同じ。結果は`docs/verification/`へ記録する。

## 13. 表示用時刻の利用可否（Issue #65）

状態：設計確定（2026-11-14）。実装・Pi実機での確認は未実施。判定方式と表示用APIの契約は[技術スタック選定 第25章](technology-stack.md#display-time-availability)、未同期時の表示は[UI設計 6.3・6.5](ui-design.md#63-時刻未同期)に従う。本章は、Frontendが利用可否を受け取って#7の状態入力（5.3）へ渡す方法を定める。

### 13.1 範囲

- 扱う：`GET /api/time-availability`のPolling、受け取った値から`TimeAvailability`を決めること、通常画面（`App.tsx`）の`time="available"`固定を置き換えること。
- 扱わない：OS・RTCからの判定（Backend）、時計タイル・未同期表示・巡回停止の描画（#7・#8で実装済み。変更しない）、検証画面の手動切替（D13。変更しない）。

### 13.2 Polling

- 表示用API（第11章）のPollingとは別に、`GET /api/time-availability`をPollingする。Published State APIの503やPolling失敗は、時刻の利用可否に影響させない。
- 初回は起動直後。以降は前回のRequestの完了から10秒後。Timeoutは3秒。同時に実行するRequestは1件まで。即時Retry・Backoffはしない。
- Unmount時にRequestとTimerを止める。`App`の直下で1回だけ使う。
- 既存のPolling（`published-state/polling.ts`）と同じく、Reactに依存しない部分と、Reactへつなぐ部分を分ける。Timer・fetch・単調時計は差し替えられるようにし、Fake Timerでテストする。

### 13.3 状態の決め方

- 最初の応答を受け取るまでは`unavailable`とする（UI設計 6.5）。
- 取得に成功したら、受け取った値（`available` / `unavailable`）にする。
- 取得に失敗したら（通信失敗・Timeout・200以外・JSONとして読めない・Schemaに合わない）、最後に受け取った値を保つ。ただし、最後に成功してから60秒（暫定）を過ぎたら`unavailable`にする。Backendの短い再起動では時計を消さず、Backendが止まったままなら、確認できない時刻を表示し続けないため。
- 60秒の経過は単調時計（`performance.now()`）で測る。System Timeの補正の影響を受けないようにするため（アーキテクチャ 10.4）。
- Responseは`{ "availability": "available" | "unavailable" }`だけを受け付ける（TypeBoxで検証。未知の項目があれば不正とする）。
- 時刻の表示自体は、引き続きBrowserの現在時刻（OS System Time）を使う（5.2）。APIから時刻は受け取らない。

### 13.4 表示との関係

- 決めた値を`SignageScreen`の`time`へ渡す。時計タイルとContentSwitcherは、既存の動作のまま切り替わる（`unavailable`で未同期表示と1枚表示、`available`へ戻るとフェードで表示し、巡回を再開）。
- 予定・天気の有効期限と「今日」の判定は、`available`になった後に、その時点の時刻で評価し直す（既存の1分ごとの再評価と、Responseの更新時の再評価。11.4）。
- 起動のたびに、最初の応答までの短い間、未同期表示が出る（UI設計 6.5）。

### 13.5 開発・検証

- 単体テスト（Vitest、Fake Timer）：最初は`unavailable`、成功で値が変わる、失敗で最後の値を保つ、最後の成功から60秒で`unavailable`になる、不正なResponseは失敗として扱う、10秒の間隔・3秒のTimeout・同時1件、Unmountで止まる。
- 検証画面は変更しない（Spaceキーの手動切替を維持する）。表示の切替は#7で確認済みである。
- 開発PCのBrowserでは、Development Serverの`/api`転送（11.7）でBackendにつなげる。ただし、時計はPCの時刻で描かれる。
- Raspberry Piでは、PiのChromiumで実際のFrontendとBackendをつないで確認する（PCのBrowserではPiの時刻を再現できないため）。確認するのは、起動直後（オンライン）、電源を入れたままの再起動（オフライン）、電池なしで電源を完全に切った後（オフライン）とNetworkの復旧、同期済みからの切断、Backendの停止。手順はPiでの確認の段階で決め、結果は`docs/verification/`へ記録する。
