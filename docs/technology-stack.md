# 技術スタック選定

## 1. このドキュメントの目的

Raspberry Pi 5を使用する家庭用デジタルサイネージ（Home Digital Signage）の、Issue #4「[Research] 技術スタックを選定する」における技術の選定結果を記録する。

本書では、Frontend開発・Build環境、Build・Deploy方式に加え、nginxによるProduction Serving・Reverse Proxy、HTTP Polling、Published State APIの契約を記録する。Backend技術の正式採用・条件付き採用と具体的な実現方針も記録する（現在の総括は第24章）。確定事項・暫定採用・検討中の案は各節で区別する。Issue #4全体の技術選定完了を意味しない。

Issue #1〜#3の確定事項・関連文書を正本として扱う。Architectureはarchitecture.mdに従う。採用技術、比較済みの選択肢、判断理由と未決定事項を分けて記録する。

### 1.1 関連文書と役割

- [企画書](home-digital-signage-project-plan.md)：プロジェクトの目的・構想。
- [ハードウェア検討・選定結果](hardware.md)：Issue #1のハードウェア選定。
- [MVP要件](requirements.md)：Issue #2の機能・受け入れ条件。
- [システムアーキテクチャ](architecture.md)：Issue #3のLogical Architectureの正本。責務・依存方向・StateのOwnership・起動復旧方針。
- 本書：既存Architectureを実現する技術の選定結果。
- [学習記録](learning-log.md)：他プロジェクトでも再利用できる学び。

---

## 2. 前提・要件

### 2.1 プロジェクトと表示対象

Raspberry Pi 5 2GB上で、時計・日付・曜日を常時表示し、予定・本日の天気・週間天気を切り替える、軽量な単一画面のサイネージUIを構築する。
機能・受け入れ条件の詳細は要件定義に従う。

Frontendには、Component化、State管理、保守性に加え、将来的なレイアウト・Theme・Animation・天気表示等のカスタマイズに対応できる表現自由度を求める。
エコシステム・情報量・AI駆動開発との親和性も評価する。

将来の自由度を確保することは、Future機能をMVPで先行実装することを意味しない。Theme System、Animation Plugin System、Plugin Framework等を、Futureで使う可能性だけを理由にMVPへ導入しない。

### 2.2 維持するArchitecture

Issue #3では、Display側のデータ処理・描画を概念的に以下の流れで定義している。

```text
Shared State Store
  ↓ Display側のPublished State取得
Published State
  ↓ Component State生成
Component State
  ↓
Display Component
  ↓
Rendering
```

**Display ComponentはShared State Storeを直接参照しない。**
Published State取得・Component State生成を介する責務境界を維持する。
Reactの採用は、この責務境界、StateのOwnership、依存方向を変更するものではない。

Display Componentは「何を、どう表示するか」、ContentSwitcherは「切替対象の中から、いつ・どれを表示するか」、Layoutは「どこに、どの大きさで表示するか」を担う。Clock / Date / WeekdayはContentSwitcherを経由せず直接Layoutへ配置する既存方針を維持する。

---

## 3. Frontend開発・Build環境の選定結果

**状態：確定。React + TypeScript + Viteを採用する。**

| 技術 | 役割 | 採用理由の要点 |
|---|---|---|
| React | Component-based UI / Declarative UI。StateからRenderingへの変換 | Issue #3のComponent State → Display Component → Renderingと親和性が高い。Component追加や表示のバリエーションに対応しやすい |
| TypeScript | Type Safety / Data Contractの明確化 | Published State、Component State、Metadata、Config等を型として明示できる |
| Vite | Frontend開発・Build用ツール | Development Server・HMR・Module / Asset Handlingと、静的な本番配信用成果物の生成を担う |

React、TypeScript、Viteはそれぞれ別の責務を担う。React採用とNext.js採用、Build ToolとProduction Runtimeの選定は分けて考える。

---

## 4. 各技術の役割と選定理由

### 4.1 React

ReactはComponent-based UIとDeclarative UIを提供し、Stateに基づくRenderingを担う。
Issue #3のPublished State → Component State → Display Component → Renderingという流れと親和性が高いと判断した。

Component追加、レイアウト・Theme・Animation・天気表示等のカスタマイズに対応しやすいことを評価する。具体的なUI仕様や追加ライブラリは今回選定しない。

Vanilla TypeScriptでも表現自体は可能である。ただし、UI規模が拡大するとDOM更新やState同期を自前で管理する割合が増えるため、Component Modelを持つReactを選ぶ。

React Runtimeによる追加負荷はあるが、Raspberry Pi 5 2GB上の今回の軽量な単一画面のサイネージUIでは許容可能と判断した。これは選定時の判断であり、実機測定済みという意味ではない。CPU・メモリ・温度と72時間連続稼働の検証は既存要件・Issue #13に従う。

### 4.2 TypeScript

TypeScriptはType SafetyとData Contractの明確化を担う。
Published State、Component State、Metadata、Config、Data Contractを型として明示し、Architecture上の契約を実装で扱いやすくする。

今回の用途ではJavaScriptを単独採用する明確なメリットがないと判断し、TypeScriptを採用する。
Published Stateの共通構造・Metadataは第10章に選定状況を記録する。その他の具体Schema・Interface・型定義は未決定とする。

TypeScriptのソースはBuildによってJavaScriptへ変換される。Production環境のRaspberry Pi上でTypeScript Compilerを常時実行する構成を意味しない。

### 4.3 Vite

ViteはReact Frameworkではなく、**Frontend開発・Build用ツール**として採用する。

開発時には以下を担う。

- Development Server。
- Module Resolution。
- TS / TSX Transformation（Browserが扱える形への変換）。
- HMR（Hot Module Replacement：開発中の変更反映）。
- CSS / SVG / Asset Handling。

```text
React + TypeScriptのソース
  ↓ Vite Development Server
開発用Browser
```

Production Buildでは静的な本番配信用成果物を生成する。

```text
React + TypeScriptのソース
  ↓ Vite Build
dist/
```

生成物の概念例（実際のファイル名・配置はBuild設定による）：

```text
dist/
├── index.html
└── assets/
    ├── index-xxxxx.js
    ├── index-yyyyy.css
    └── ...
```

`src/`は開発用ソース、`dist/`はBrowserへ配信する本番配信用成果物として扱う。
Vite自体をProduction環境のRaspberry Pi上で常時動作させる必要はない。

---

## 5. 比較した選択肢

Frontendと開発・Build用ツールについて、以下の選択肢を比較した。

### 5.1 Frontend

| 比較対象 | 記録された判断 |
|---|---|
| Vanilla TypeScript | 実現可能だが、UI規模拡大時にDOM更新・State同期を自前で管理する割合が増える。ReactのComponent Modelを選ぶ |
| React + TypeScript | 採用。Architectureとの親和性、Component化・State管理、将来の表現自由度、型によるData Contractの明確化を評価 |
| Vue + TypeScript | 比較済み。今回はReact + TypeScriptを採用 |
| Svelte + TypeScript | 比較済み。今回はReact + TypeScriptを採用 |
| Next.js | 今回不要なFramework機能を持ち込むため非採用。理由は5.2に記録 |

### 5.2 Development / Build

| 比較対象 | 記録された判断・理由 |
|---|---|
| Vite | 採用。React + TypeScriptの標準的なSPAに必要な開発・Build機能を扱い、静的な本番配信用成果物を生成できる |
| Webpack | 高度なカスタマイズ性・大規模なエコシステムはあるが、今回特殊なBuild処理は不要。設定・学習・保守対象が増えるため非採用 |
| Parcel | Zero-configで実現可能だが、今回のSPA用途でViteを上回る明確なメリットがないため非採用 |
| Rsbuild / Rspack | Build性能に強みがあるが、今回のサイネージ規模ではBuild性能自体が要件ではないため非採用 |
| Next.js | React Framework。Routing、SSR、Server Components、Server-side functionality等を提供するが、今回のDisplayアプリケーションではSEO・SSR・Public Web Server・複雑なRouting・Server Componentsが不要であり、過剰な構成と判断して非採用 |
| Create React App | 過去の代表的なReact環境として比較。今回の新規プロジェクトで積極的に採用する理由がないため非採用 |

Next.jsの機能数ではなく、今回の要件に対する必要十分性で判断する。
Public Web Serverが不要という判断とローカルのHTTP配信は別である。Production Servingにはnginxを採用する（7.1）。

---

## 6. 開発環境

Frontend開発環境ではNode.js、npm、React、TypeScript、Viteを利用する。

| 要素 | 役割 |
|---|---|
| Node.js | Vite等の開発ツールを実行するRuntime |
| npm | React / Vite / TypeScript等のパッケージ管理 |
| package.json | プロジェクトの依存関係等の管理 |
| package-lock.json | npmの依存解決結果を記録し、依存関係の再構築に利用 |
| node_modules | パッケージの実体。通常Gitにはコミットせず、package.json / package-lock.json等から再構築 |

**ViteによるTS / TSX Transformationと厳密なType Checkは別責務**として扱う。
BuildできることをType Check完了と同一視しない。

開発品質はESLint、Prettier、tscによるType Check、Vitestを正式採用する。GitHub Actionsの標準Ubuntu RunnerでPR作成・更新時にLint / Format Check / Type Check / Testを自動検証する。無料枠内を基本とし、使用量・予算を確認する。Production Build / Deployは別とし、Buildは開発PC、PiへのDeployは手動とする。Workflow・npm scripts・設定・依存は未実装であり、CIへSecretを渡さない構成を後続で整備する。
実行順序・具体的な設定は実装時に確定する。Node.jsは24 LTSを選定し、その他の具体バージョン固定は後続で扱う。

---

## 7. Production ServingとPublished State取得

### 7.1 Production Serving

**確定事項**

- Production Servingに`nginx`を採用する。
- Development PCでViteによるProduction Buildを実行する。
- Build成果物の`dist/`をRaspberry PiへDeployする。
- Raspberry Pi上のnginxが静的ファイルをHTTP配信する。
- Chromium KioskがnginxからReact UIを取得・表示する。
- Production環境でVite Development Serverを常時稼働させない。

既存のBuild・Deploy方式（第8・9章）は維持する。

```text
Development PC
  React + TypeScript + Vite
    ↓ Production Build
  dist/
    ↓ scp
Raspberry Pi
  Release Directory
    ↓ current symbolic link
  nginx
    ↓ HTTP
  Chromium Kiosk
```

nginxの具体的な設定、Listen Port、Directory Path等は未決定とする。

### 7.2 React UIとPublished State APIの接続

**確定事項**

- nginxのReverse Proxyを利用する。
- React UIは同一OriginのHTTP APIからPublished Stateを取得する。
- nginxはAPI RequestをRaspberry Pi上のローカルなAPI提供処理へ転送する。
- React UIからShared State Storeの内部実装を直接参照しない。
- API提供処理はShared State StoreからPublished Stateを読み取り、API Responseへ変換する。
- Shared State Storeの内部構造とAPI ResponseのData Contractを分離する。
- Display ComponentはPublished State取得処理を直接担当せず、Component State生成の責務を介して表示する。

概念図：

```text
React UI（Chromium Kiosk） → nginx → API提供処理：HTTP Request
React UI（Chromium Kiosk） ← nginx ← API提供処理：HTTP Response
API提供処理 → Shared State Store：Published StateのRead
Weather Service / Schedule Service → Shared State Store：Published State公開

React UIのPublished State取得処理
    ↓ 取得したPublished State
Component State生成
    ↓
Display Component
```

図は概念的な責務と通信経路を示す。Backend技術の正式採用は第11章、MVP実行モデルはArchitecture第16章を参照する。具体的なAPI提供Process構成・Port番号は未決定。

`/api/...`はパスの例であり、具体的なEndpointは未決定。

API提供処理のためだけに新しい独立Serviceを追加することは、現時点では決定していない。

### 7.3 Published Stateの取得方式

**確定事項**

React UIによるPublished Stateの取得には、HTTP Pollingを採用する。

SSEやWebSocketはMVPでは採用しない。

Polling仕様：

| 項目 | 決定内容 |
|---|---|
| 初回取得 | React UI起動直後に実行 |
| Polling間隔 | 前回Requestの完了から30秒後 |
| Request Timeout | 5秒 |
| 同時Request数 | 最大1件 |
| HTTP取得成功 | 保持しているstates Object全体を置き換え、正常Responseで省略されたStateも削除 |
| HTTP Request全体の失敗 | 最後に正常取得したResponseを保持し、各Stateの有効期限を評価 |
| Retry | 即時Retryなし |
| Backoff | MVPでは導入しない |
| 次回取得 | 成功・失敗にかかわらず、Request完了から30秒後 |
| Cleanup | ComponentのUnmount時にRequest・TimerをCancelし、重複Pollingを防止 |

補足：

- 30秒はRequest開始間隔ではなく、Request完了後の待機時間。
- Requestの処理時間に応じて、実際の開始間隔は30秒より長くなる。
- HTTP Polling間隔とBackendの外部API取得周期は別物。
- HTTP取得失敗時も、保持済みデータの`expiresAt`による有効期限判定を継続する。
- HTTP取得失敗をBackendの`lastAttemptResult`へ反映しない。
- Backendの外部API取得Retry方針は、React UIのPolling Retry方針とは独立して扱う。

取得成功・失敗にかかわらずFrontendは`now < expiresAt`の場合のみ期限内と判定し、`now >= expiresAt`のデータを表示しない。最後の外部取得結果が`failure`でも、有効期限内のデータは利用可能とする。

Runtime JSON Validationを必須とし、TypeBoxを正式採用する（第11章）。

Stateの保持は期限切れ情報の表示継続を意味しない。基本画面の起動はBackend/API取得完了を待たない既存方針を維持する。
Frontend BuildとProduction Runtimeの境界は維持する。BackendのNode.js RuntimeとMVP実行モデルは第11章・Architecture第16章の採用状況に従う。

---

## 8. Frontend Build実行場所

### 8.1 選定結果

**MVPでは、FrontendのProduction BuildをDevelopment PCで実行する。**
React + TypeScriptのソースからVite Buildで`dist/`を生成し、成果物をRaspberry PiへDeployする。

### 8.2 選定理由

- Raspberry Pi 5 2GBへ不要なBuild負荷をかけず、Production環境としての責務に集中させる。
- Node.js / npm / TypeScript / Vite等のBuild環境をProduction Piへ必須化せず、Build環境とProduction Runtimeを分離する。
- Development PCでのBuildは、開発中の試行錯誤が容易である。
- MVPでProduction Build / DeployのCI/CDを先行導入しない。PR検証CIは第6章のとおり正式採用する。
- 将来的なCI Buildへの移行を妨げない。

### 8.3 比較した選択肢

| 比較対象 | 判断・理由 |
|---|---|
| Development PC Build | 採用。PiへのBuild負荷を避け、開発中の試行錯誤を容易にする |
| Raspberry Pi Build | 非採用。PiへのBuild負荷、Build環境のProductionへの持ち込み、責務の混在を避ける |
| CI Build | Futureでは有力な候補。MVPのProduction BuildではArtifact・Deploy認証等の負担を避け採用しない。PR検証用GitHub Actionsとは区別 |

### 8.4 Futureとの境界

FutureではDevelopment PC BuildからCI Buildへの移行を検討する。
Build主体が変わっても、以下の成果物・Deployの境界を維持する。

```text
Build
  ↓
dist/
  ↓ Deploy
Raspberry Pi
```

PR検証CIは第6章で正式採用済み。具体Workflow設定と将来のProduction自動Build / Deployは区別し、後者はMVP対象外とする。

---

## 9. Raspberry PiへのDeploy方式

### 9.1 選定結果

**MVPでは、scp + Release Directory + symbolic linkを採用する。**

Development PCで生成した`dist/`を、SSH経由の`scp`でRaspberry Pi上の新しいRelease Directoryへ転送する。
転送完了後、Productionが参照する`current` symbolic linkを新Releaseへ切り替える。
Productionが参照しているDirectoryへ直接上書きしない。

以下は配置と切替の概念例であり、`/opt/signage/`やRelease名を実装上の確定値とするものではない。

```text
Raspberry Pi
/opt/signage/
├── releases/
│   ├── release-A/  ← 現在のRelease
│   └── release-B/  ← 新しいdist/の転送先
└── current ──────→ releases/release-A/

転送完了後：currentの参照先をreleases/release-B/へ切替
```

### 9.2 選定理由

- Production Directoryへの直接上書きを避け、Deploy途中の不完全な成果物が表示対象になるリスクを抑える。
- 転送失敗時も既存Releaseを維持しやすい。
- 旧Releaseを保持することでRollback可能な構成にできる。
- Pi側でBuildする必要がない。
- DockerやBlue-Green Deploymentほど大きな構成をMVPへ持ち込まず、安全性を高められる。
- SSH / filesystem / symbolic link / permission / atomicな切替 / rollback等、Linux運用の学習につながる。
- FutureでCI/CDへ移行した場合も、同じDeploy境界を再利用しやすい。

### 9.3 転送方法の比較

| 比較対象 | 判断・理由 |
|---|---|
| scp | 採用。シンプルでMVP向き |
| rsync + SSH | 差分同期や不要ファイル削除に優れるが、Release Directory方式を採用する今回のMVPではscpで十分と判断 |
| Git pull | 非採用。ソース管理とBuild成果物のDeploy責務が混ざりやすく、Pi Buildへ戻る可能性がある |
| SFTP | 手動操作中心になりやすく、自動化・CI/CDへの発展性で劣るため今回は採用しない |
| tar/zip + scp | Artifact単位で扱えるが、今回の規模では追加手順に対するメリットが小さいため採用しない |
| CI/CDから直接Deploy | Future候補。MVPでは先行導入しない |

### 9.4 安全な切替方式の比較

以下の方式を比較した。

- Production Directoryへの直接上書き。
- Temporary Directoryからの切替。
- Release Directory + symbolic link。
- Blue-Green Deployment。
- Container/Image単位のDeploy。
- A/B・Canary Deployment。

1台のRaspberry Piによる家庭用サイネージでは、**Release Directory + symbolic link**が安全性と構成の単純さのバランスに優れると判断した。
atomicな切替やRollbackの具体的な実装は、後続の実装設計で扱う。

---

## 10. Published State APIのData Contract

### 10.1 一括取得方式

**確定事項**

- MVPでは複数のPublished Stateを1回のHTTP GETでまとめて取得する方式を採用する。
- 各Published StateはShared State Store内で独立して管理する。
- 一括取得APIを採用しても、複数State間の厳密なTransactional Snapshot Consistencyは要求しない。
- 一部のStateが未公開・利用不能でも、他のStateを取得できる構成とする。
- 将来、必要に応じて個別State取得APIを追加できるようにする。

一括APIの取得成功・失敗時のFrontend更新ルールは7.3、公開・省略ルールは10.7に従う。

### 10.2 Published Stateの共通構造

**確定事項**

各Published Stateを以下の構造とする。

```typescript
type PublishedState<T> = {
  data: T | null;
  meta: PublishedStateMetadata;
};
```

- `data`：Domain Data
- `meta`：共通Metadata

Domain固有の情報は`data`へ保持する。

Metadataには共通の意味を持つ情報のみを保持し、Domain固有の項目を無理に共通化しない。

### 10.3 Published Stateの情報単位

既存Architectureで決定済みの以下の情報単位を維持する。

Weather Service：

- CurrentWeather
- HourlyWeather
- RainForecast
- WeeklyWeather

Schedule Service：

- Schedule

各情報単位は独立した鮮度・有効期限・取得失敗状態を管理する。

Service境界とPublished State境界、Display Component境界を無理に一致させない。

### 10.4 共通Metadata：確定した6項目

**確定事項**

```typescript
type PublishedStateMetadata = {
  dataUpdatedAt: string | null;
  expiresAt: string | null;
  lastAttemptAt: string | null;
  lastAttemptResult: "success" | "failure" | null;
  publishedAt: string;
  dataSource: "externalApi" | "cache" | null;
};
```

| 項目 | 型 | 意味 |
|---|---|---|
| `dataUpdatedAt` | `string \| null` | 外部データを正常取得・検証・採用した時刻 |
| `expiresAt` | `string \| null` | 採用したデータの有効期限 |
| `lastAttemptAt` | `string \| null` | 最後に完了した外部取得試行の開始時刻 |
| `lastAttemptResult` | `"success" \| "failure" \| null` | 上記取得試行の結果 |
| `publishedAt` | `string` | Published StateのSnapshot生成時刻 |
| `dataSource` | `"externalApi" \| "cache" \| null` | 保存Snapshotでは生成時に採用した供給経路、表示用API Responseでは現在提供するデータの供給経路 |

日時はRFC 3339形式のUTCとする。`publishedAt`はStoreへの書込み完了時刻ではなく、Snapshot生成時刻を表す。

`lastAttemptAt`は完了済みの最後の外部取得試行を対象とし、その試行の開始時刻を記録する。`lastAttemptResult`は同じ試行の結果を示す。両項目は試行完了後にセットで更新し、進行中の試行について先行更新しない。

#### dataSourceと保存Snapshot・表示用APIの区別

保存Published StateのSnapshotでは、`dataSource`はSnapshot生成時に採用したデータの供給経路を表す。期限切れデータが内部に残っている場合も、元の供給経路を保持できる。

- `externalApi`：外部APIから取得したデータを使用。
- `cache`：Backend Cacheから読み出したデータを使用。
- `null`：表示用APIで提供するデータが存在しない。

表示用API Responseでは、`dataSource`は現在APIで提供するデータの供給経路を表す。期限切れで`data: null`へ変換するときは、`dataSource`も`null`へ変換する（10.8）。
`dataSource`と`lastAttemptResult`は独立した情報である。最後の外部取得が失敗していても、有効Cacheからデータを提供できる。取得結果だけでCache由来を判定しない。

### 10.5 外部データ取得時の更新ルール

**確定事項**

| 状況 | データ・取得履歴・供給経路の更新 |
|---|---|
| 正常取得・検証・採用 | データ、`dataUpdatedAt`、`expiresAt`を更新。試行完了後に`lastAttemptAt`と`lastAttemptResult: "success"`を更新し、`dataSource: "externalApi"`とする。Snapshot生成時に`publishedAt`を更新 |
| 取得失敗・有効Cacheあり | 有効Cacheのデータを使用。`dataUpdatedAt`と`expiresAt`は元の値を維持。試行完了後に`lastAttemptAt`と`lastAttemptResult: "failure"`を更新し、`dataSource: "cache"`とする。Snapshot生成時に`publishedAt`を更新 |
| 取得失敗・有効Cacheなし | 表示用APIでは利用可能データを提供しない。内部に期限切れデータが残っていても、APIでは`data: null`、`dataSource: null`とする。最終正常取得履歴を維持し、完了した最後の試行の開始時刻と結果（`failure`）を反映 |
| Backend停止 | 停止だけを理由に既存Metadataを変更しない |
| Store書込み失敗 | Store上では以前のSnapshotを維持する。表示用APIの期限判定は保存されたSnapshotに対して実施 |

取得内容が前回と同じでも、新たに正常取得・検証・採用した場合は`dataUpdatedAt`を更新する。
Cacheから既存データを読み出しただけの場合は、`dataUpdatedAt`を新しい取得時刻にせず、元の`expiresAt`も延長しない。

外部APIが返す観測時刻・予報対象時刻・予定日時と、共通Metadataの更新時刻は区別する。Architectureの概念項目`dataTimestamp`と`dataUpdatedAt`を無条件に同一視しない。
取得成功だけで古い元データを延命しない既存原則を維持する。

### 10.6 表示用API ResponseのMetadata整合条件

**確定事項**

- `data === null`でも、`dataUpdatedAt`と`expiresAt`が非`null`の場合がある。期限切れデータをResponseから除外しても取得履歴は維持する。
- 一度も正常取得していない場合、`dataUpdatedAt`と`expiresAt`は両方`null`。
- 正常取得履歴がある場合、`dataUpdatedAt`と`expiresAt`は両方非`null`。
- `data !== null`の場合、`dataUpdatedAt`と`expiresAt`は両方非`null`。
- 表示用API Response生成時点で`data !== null`の場合、`now < expiresAt`が成立する。
- `lastAttemptAt`と`lastAttemptResult`は両方`null`、または両方非`null`。
- API Responseに含まれるPublished Stateの`publishedAt`は非`null`。
- `data === null`なら`dataSource === null`。
- `data !== null`なら`dataSource`は`externalApi`または`cache`。
- 各Timestamp間に無条件の前後関係は強制しない。`publishedAt < expiresAt`や`expiresAt > dataUpdatedAt`をすべてのケースに要求しない。
- 正常取得したScheduleが空の場合は`data: {date, events: []}`とし、利用可能データのない`data: null`と区別する。

State自体が未公開であることと、公開済みStateのデータが未取得であることは区別する。公開・省略ルールは10.7に従う。

`status`、`isValid`、`isExpired`など、既存情報から導出できる項目は追加しない。
`errorCode`、`lastSuccessAt`、`ttl`なども、明確な要件がない段階で共通Metadataへ追加しない。

### 10.7 API Response JSON構造と公開・省略ルール

**確定事項**

- トップレベルに`schemaVersion`を配置し、初期値は数値の`1`とする。
- `states`はPublished Stateを格納するObjectとする。
- 対象State Keyは`currentWeather`、`hourlyWeather`、`rainForecast`、`weeklyWeather`、`schedule`の5種類。
- 各Stateは`data`と`meta`で構成する。
- State単位の`schemaVersion`は設けない。
- 未公開Stateは`states`からKey自体を省略する。
- 公開済みだが一度も正常取得していないStateは`data: null`で返す。この場合、`dataUpdatedAt`、`expiresAt`、`dataSource`は`null`で、`publishedAt`はSnapshot生成時刻を持つ。
- 各Published Stateの更新は独立しており、全Stateが同一時刻のSnapshotであることは要求しない。

公開済み・未取得StateのResponse例：

```json
{
  "schemaVersion": 1,
  "states": {
    "currentWeather": {
      "data": null,
      "meta": {
        "dataUpdatedAt": null,
        "expiresAt": null,
        "lastAttemptAt": null,
        "lastAttemptResult": null,
        "publishedAt": "2026-10-11T03:00:00Z",
        "dataSource": null
      }
    }
  }
}
```

Schedule Domain Dataは18.1、CurrentWeatherは第19章、HourlyWeatherは第20章、RainForecastは第21章、WeeklyWeatherは第22章で設計方針を定義済みである。Endpointの正式なPathも未決定とし、`/api/display-state`は例示として扱う。
FrontendのResponse取得・更新ルールは7.3に従う。

### 10.8 期限切れデータの表示用APIでの扱い

**確定事項：B案（期限切れデータを表示用APIでは公開しない方式）を採用する。**

Backend Cacheでは期限切れデータを保持してもよい。保存Published Stateも、期限切れを理由に直ちに削除・変更する必要はない。
表示用API Response生成時に保存Snapshotの期限を評価し、`now >= expiresAt`の場合は以下の変換を行う。

- Responseの`data`と`dataSource`を`null`にする。
- `dataUpdatedAt`と`expiresAt`は最終正常取得履歴として維持する。
- `lastAttemptAt`と`lastAttemptResult`を維持する。
- `publishedAt`は元のSnapshot生成時刻を維持する。

Scheduleについては、API Response生成時にも`data.date`とAsia/Tokyo基準の今日を照合する。日付が一致しない場合はTTL内でも`data: null`、`dataSource: null`とし、旧日の予定を公開しない。この変換でも`dataUpdatedAt`、`expiresAt`、`lastAttemptAt`、`lastAttemptResult`、`publishedAt`の既存値を維持する。
API Response生成時の期限・Schedule日付判定による変換だけでは、新しいSnapshotを生成したものとは扱わない。
APIから期限切れデータを除外しても、Frontendでの`expiresAt`判定は引き続き必須とする。API取得後に期限を迎えたデータも表示に利用しない。


### 10.9 Database全体利用不能時のAPI応答

SQLite全体が利用不能な場合、Published State APIは`503 Service Unavailable`を返す。DB破損・Schema非互換によるBLOCKEDも503とし、DB障害を`200 OK`と空データで表現しない。

SQLiteが正常な場合、State単位の未公開・期限切れ・不正は既存契約に従い、正常な他Stateの提供を妨げない。Frontendは503をPolling失敗として扱い、保持済みの有効なComponent Stateを既存TTLルールに従って利用する。

PR-Aの`/ping`は疎通確認専用であり、DB HealthやReadinessを意味しない。Published State APIの正式Endpoint Pathと503時のJSON Error Schemaは未決定である。

---

## 11. Backend技術スタック

### 11.1 正式採用一覧

以下は技術選定として**正式採用**であり、実装・実機検証済みを意味しない。Raspberry Pi 5 2GB上の性能・互換性は未検証である。FrontendのReact + TypeScript + Viteと、第7・10章の確定API契約は維持する。

| 分野 | 技術・方式 | 役割・採用理由 |
|---|---|---|
| Runtime | Node.js 24 LTS | 非同期取得TaskとAPI提供を実行する共通Runtime |
| Language | TypeScript | Domain Data・Metadata・Module間の型契約を明示 |
| API Framework | Fastify | nginxの転送先となるHTTP API提供処理 |
| Database | SQLite | Published State・Cache・取得制御をローカルDBで永続化し、短いTransactionで更新 |
| SQLite Driver | better-sqlite3 | Node.jsからSQLiteへアクセス。Native Dependencyの配置条件を確認する必要がある |
| Runtime Validation | TypeBox | FrontendのRuntime JSON Validation、BackendのSchema Validation、Config検証。DomainのSemantic Validationとは分離 |
| Scheduler | 標準setTimeout | Stateごとの非同期取得・待機を実行する標準機構 |
| HTTP Client | Node.js標準fetch | 外部HTTP取得。Domainの変換・Cache採用判断は担当しない |
| Process管理 | systemd | Backendの自動起動・再起動 |
| Package Manager | npm | Node.js依存Packageの管理 |
| Backend Build | tscによるCompile、原則Bundlingなし | 開発PCでTypeScriptをCompileし、Runtime依存を分けて配置 |
| Module System | ESM | BackendのModule方式 |
| Test | Vitest | State契約・取得制御・永続化・Recoveryの検証 |
| Logging | Pino + journald | Structured JSON LoggingとOS側のログ収集 |
| Config | systemd EnvironmentFile + TypeBox Validation | 一般Configを供給し起動時検証。変更はBackend再起動で反映。SecretはGit・Release外のアクセス制限付き専用ローカルファイル |

### 11.2 比較上の判断と制約

Backend Buildは原則Bundlingせず、開発PCでCompileする。Native Dependencyまで開発PCの成果物だけで完結させず、Pi側でnpm ci --omit=devによりProduction DependencyをInstallする方式を正式採用する。
Scheduler・HTTP Clientは標準機構を利用し、汎用Pipeline FrameworkやPlugin Framework、不要な独立ServiceをMVPへ追加しない。
SQLiteはローカル保存とTransactionの実現手段として正式採用し、物理故障への自動復旧を保証するものとは扱わない。

本書では、BuildのBundling有無・Native Dependencyの配置、標準機構と汎用Frameworkの導入、Backup APIとDB本体の単純コピーの比較判断を記録する。

### 11.3 Backend Build / Deploy

**正式採用方式（未実装・実機未検証）**

1. 開発PCでTypeScriptを`tsc`によりCompileする。
2. SSHでRaspberry Piへ成果物を転送する。
3. Release Directoryとsymbolic linkによる切替を使用する。
4. better-sqlite3等のNative DependencyはPi側でnpm ci --omit=devを実行し準備する。
5. Backendの再起動・自動起動をsystemdで管理する。

永続DBはRelease Directoryの外に配置する。Deploy失敗時に旧ReleaseへRollbackできる構成を目指す。
Directory Path、Unit定義、Port、Deploy Script・切替の詳細手順は未決定である。新Release準備失敗時は旧Releaseを維持し、RollbackはDB Schema互換性を確認してから行う。DB変更時はBackup / Restoreと整合させる。MVPは手動Deployとし、自動Deployは導入しない。

### 11.4 Backendの責務分担

HTTP Client、Scheduler / Retry実行機構、Cache I/O、Store I/O、Config、Logging、TimeをCommon Moduleとして扱う。
Weather・Schedule固有のValidation、Data変換、Cache採用、Freshness、Published State生成はDomain側が担当する。
MVPの実行モデル・State Ownership・取得制御・Recoveryは[Architecture第16章](architecture.md#16-issue-4backendの具体的な実現方式)を参照する。

### 11.5 Stateごとの暫定取得周期・有効期限

[要件定義 R-07](requirements.md)の暫定値を維持する。Provider条件・実機評価を踏まえて確定する。

| Published State | 外部取得周期（暫定） | 有効期限（暫定） |
|---|---|---|
| CurrentWeather | 15分 | 2時間 |
| HourlyWeather | 30分 | 2時間（第20章で暫定値を更新） |
| RainForecast | 5分 | 30分 |
| WeeklyWeather | 6時間 | 12時間 |
| Schedule | 10分 | 6時間 |

Frontendの30秒Pollingとは別の設定である。5 Stateは独立して更新・復元・公開でき、複数State間の厳密な同時点整合性は要求しない。

---

## 12. SQLiteの保存・WAL運用

### 12.1 保存方針と採用状況

SQLite・better-sqlite3は正式採用とする（Pi性能・ARM64互換性は未検証）。Published State、Backend Cache、Acquisition Control Stateを1つのDatabaseの別Tableとして管理し、Published StateのDataとMetadataを1つのJSON Snapshotとして保存する。

| 論理Table | 保存対象 |
|---|---|
| published_state_snapshots | 最新・直前のPublished State Snapshot |
| backend_cache | Published State単位のBackend Cache |
| acquisition_control | Backendの取得制御用永続状態 |

Published Stateの**最新と直前の2世代保持**と、**世代ごとに別Rowで保存する方式**は、いずれも暫定採用とする。具体DDL・Index・Generation採番・個別Migrationは未決定である。Schema Version管理とMigrationの適用条件は12.4で定義する。
State単位のAtomicityを確保し、複数State間の厳密なAtomicityは必須としない。Tx-Q / Tx-A / Tx-P / Tx-C分離とState単位の部分成功はArchitecture 16.4に従う。

### 12.2 SQLite設定・注意点

SQLiteの実現方式として以下を採用方針に記録する。Database技術は正式採用だが、実測前である。

- `journal_mode=WAL`、`synchronous=NORMAL`。
- SQLite標準の自動Checkpointを利用し、`wal_autocheckpoint=1000`。
- 定期的な強制TRUNCATE Checkpointは実施しない。
- WAL肥大化時は原因調査のうえ、必要時に手動対応する。
- 原則としてBackend内で共有DB Connectionを使用する。
- `foreign_keys=ON`と`busy_timeout=5000ms`は初期設定候補。特にbusy_timeoutは実測に応じて見直す。

WAL + NORMALは直近Commitの電源断耐久性を完全保証しない。突然の電源断で直近Commitが失われる可能性は許容するが、不完全なSnapshotは公開しない。
CheckpointによってWALの物理ファイルサイズが必ず縮小するわけではない。Lock・Checkpoint異常時の詳細運用は未決定である。
microSD自体の物理故障からの自動復旧は保証しない。


### 12.3 初回DB Provisioningと通常起動

初回DB作成は、管理者が明示的に実行するProvisioningだけで許可する。通常Backend起動はbetter-sqlite3の`fileMustExist: true`を用い、DBを自動新規作成しない。

Provisioning時に既存DBがあれば上書きせず中止する。失敗後にDBが残っても、自動削除・再作成しない。初期Schema・Index・Schema VersionはTransactionで整合性を保って構築する。

DB欠損時は既存DB消失・Mount異常・権限異常等を考慮し、無条件に初回起動とは判断しない。ファイルの存在だけで正常とせず、VersionとSchema構造を確認する。

DBはRelease Directory外に配置し、`/var/lib/home-digital-signage/signage.db`は候補Pathとして扱う。具体Path・Provisioning CLI名・実装詳細は未決定である。Directory作成・Permission・実機Deploy手順はIssue #12と連携する。

Provisioningの同時実行防止、Provisioning中の通常Backend起動との競合、DB存在確認から新規作成までの競合、および排他的DB作成・既存DB保護の具体方式は、PR-B / B-2の未決定・検討事項とする。Lock方式・CLI構成・実装APIは今回確定しない。

### 12.4 Schema VersionとMigration

SQLiteの`PRAGMA user_version`をDB Schema Version管理に採用する。APIやCache EntryのschemaVersionとは区別する。Version 0を無条件に新規DBと判断せず、現在VersionとSchema実態を確認する。

- 既知Version間で、互換性検証済みかつ明示的に許可された個別Migrationだけを自動実行する。
- DDLとVersion更新は同一Transactionで行う。DDL失敗・Rollback成功時は、DBのVersionとSchema実態を再検証し、失敗原因を分類する。
- Rollback失敗時は、DBの整合性を確認できるまでDB利用機能を停止し、正常扱いにしない。
- Commit結果不明時はVersionとSchema実態の両方を照合し、Migrationが適用済みか未適用かを確認する。Rollback失敗・Commit結果不明時は、根拠なくMigrationを再実行しない。
- Migration定義・SQL自体の不正は自動再試行せず、BLOCKEDとして手動確認を要求する。
- 未知・新しすぎるVersion、Schema不整合はBLOCKEDとする。一時的なSQL障害はRecovery対象として分類する。
- 旧Releaseとの読出し・書込み互換性を確認できないMigrationは自動実行しない。
- 自動Downgrade MigrationはMVPでは実装しない。非互換MigrationはBackup・Deploy・Rollback手順と連携して別途管理する。

自動適用の可否はDDLの種類だけで決めず、個別Migrationの検証結果で判断する。初期MVPでは汎用Migration Frameworkを過剰に構築せず、必要最小限の仕組みとする。具体DDL・Index・Migration内容・Snapshot世代管理の詳細はPR-B / B-2で設計する。既存の2世代保持・世代別Rowの暫定方針は変更しない。

### 12.5 Lifecycleの技術的制約と後続工程

ConnectionはBackendStoreが所有し、起動・終了順序と工程ごとの責務は[Architecture 16.8](architecture.md#168-sqlite初期化とbackend-lifecycle)に従う。PR-AのShutdown契約を維持するが、better-sqlite3の同期APIを長時間実行するとEvent LoopやShutdown Timerをブロックし得る点を考慮する。

B-1では初期化時の障害分類までを定義する。継続的なRecovery・再試行・復旧後の再検証はPR-E、Schedulerと終了順序はPR-C、実機設定・受入試験はIssue #12・#13へ引き継ぐ。

---

## 13. Backup方式

SQLite Backup APIは正式採用する。頻度・保持数等は下表の初期方針であり、実装・復元検証は未完了である。

| 項目 | 方針 |
|---|---|
| 方式 | SQLite Backup API |
| 頻度 | 1日1回 |
| 保存先 | 同一microSD内の専用Directory |
| 保持数 | 3世代 |
| 復元 | 手動 |
| 検証 | Backup作成後に整合性確認 |
| 物理故障対策 | MVP対象外 |

稼働中のSQLite DB本体だけを単純コピーする方式は採用せず、WALと整合する方法で取得する。
同一microSDのBackupは物理故障対策ではない。Database HealthとBackend Service Healthを分け、一時障害は第23章のRecoveryで可能機能を継続する。DB破損・Schema非互換等はBLOCKEDとし、安全性確認・手動復元を行う。
実行時刻・Path・Backup用Scheduler・失敗時再試行・復元コマンドは未決定とする。

---

## 14. Logging・Test・運用

### 14.1 Logging

Pino + persistent journaldを正式採用する。Structured JSON LoggingでService / Taskの識別情報を記録し、Secret・Tokenは出力しない。
API取得失敗、Fallback、Validation失敗、Recovery、Transaction失敗、Backup失敗、WAL異常を調査可能にする。
journald容量100MiB・保存7日・Production INFO以上は実機前の初期設定案であり、性能保証値ではない。具体Rate Limit等は第24章の引継ぎ事項とする。

### 14.2 Testの観点

Vitestを正式採用する。以下は検証すべき観点であり、実装・試験完了を意味しない。

- Published State / CacheのSchema ValidationとSemantic Validation。
- Expiry境界（`now == expiresAt`）、Cache Fallbackと鮮度期限の非延長。
- Backoff復元、正常なControl StateのnextAttemptAt尊重。
- 分離TransactionごとのCommit / Rollback、複数State生成時の部分成功、Tx-C失敗時の公開継続。Scheduler異常系観点は23.8を参照。
- 最新Snapshot不正時の旧世代復元、2世代とも不正な場合の隔離。
- Database利用不能時の異常扱い。
- 起動時の復元と外部取得待ちなしのAPI提供、Graceful Shutdown。
- Backup作成・整合性確認・手動復元、WAL運用。
- Raspberry Pi実機での再起動・電源断・72時間連続稼働（Issue #13）。

---

## 15. 採用状況と今後の検討事項

### 15.1 確定・暫定採用・候補の区別

| 状態 | 対象 |
|---|---|
| 確定 | Frontend / Build / Deploy、nginx / Reverse Proxy / Polling、Published State API契約（第3〜10章）、Google Calendar + Service AccountによるSchedule取得方針（第17章） |
| 設計方針：HourlyWeather | Domain Data・24〜36枠の連続採用・採用直前の再確認・Frontend再選択（第20章）。Provider・周期・TTLは暫定 |
| 設計方針：CurrentWeather | 4項目Domain Data・State全体の採用／不採用・取得時鮮度と公開TTLの分離（第19章）。Provider・取得周期・未来許容は暫定 |
| 設計方針：Schedule Step 5 | Schedule Domain Data・全ページ取得と正規化・JST日付制御・Cache条件（第18章）。未確定詳細は18.6に区別 |
| 正式採用 | Backend主要技術・Build / Deploy、Config / Secrets方式、開発品質 / PR検証CI、Pino / persistent journald・OS標準監視、SQLite Backup API（第24章） |
| 暫定採用：Snapshot世代管理 | Published Stateの最新＋直前の2世代保持、世代ごとに別Rowで保存する方式（12.1・Architecture 16.6） |
| 暫定採用：Backend実行・取得制御 | 1 Backend Process内の複数非同期Task、State単位の独立Scheduler、即時Retryなし・有界指数Backoff（Architecture 16.1・16.3） |
| 暫定採用：Transaction | Tx-Q / Tx-A / Tx-P / Tx-Cの分離、複数State生成時の部分成功（Architecture 16.4・第23章） |
| 暫定採用：検証・Recovery | State単位のApplication Data検証・隔離、Control State不正・欠損時の保守的待機、Database利用不能時は正常稼働扱いにしない方針（Architecture 16.6・16.7） |
| 暫定値・初期候補 | State取得周期・有効期限、foreign_keys / busy_timeout初期設定候補 |
| 正式採用：CurrentWeather Provider | Open-Meteo（第19章）。実装・実機検証は未完了 |
| 正式採用：WeeklyWeather | Open-Meteo Daily Forecast。周期6時間・TTL12時間はMVP暫定値（第22章） |
| 正式採用：HourlyWeather | Open-Meteo（第16・20章）。周期・TTLは暫定 |
| 条件付き正式採用：RainForecast | Tomorrow.io Timelines API、rainIntensity、1m。周期5分・TTL30分・表示鮮度10分は暫定（第21章） |
| 暫定採用：Provider取得制御 | Tomorrow.ioのQuota Guard・送信前SQLite永続記録・Provider同時取得最大1件（16.4） |
| 暫定値：Quota安全上限 | ローリング24時間400回・60分20回・1秒1回。正式制限確認後に再評価（16.4） |
| 合意済み詳細設計 | Tx-Q / Tx-A / Tx-P / Tx-C、SQLite障害Recovery、Scheduler時刻・Backoff・HTTP10秒・429、Pending Publication（第23章）。未実装・未検証 |
| 未決定 | 下記の実装詳細・条件付き採用の条件確認・具体値 |

技術の正式採用、既存詳細設計の合意状態、運用値・実装方式の暫定状態を区別する。現在の横断採用状況は第24章に従う。設計内容は既存本文・Architectureの記載を維持し、具体値・実装詳細の未決定事項と区別する。確定API契約はこれらの暫定採用に依存して変更しない。

### 15.2 Build・Deployの実装詳細

- Release Directoryの具体Path・命名方式・保持世代数。
- Deploy Script・symbolic link切替コマンド・Chromium Reload方法。
- SSH認証、systemd Unit・Port、Production自動DeployはMVP対象外。PR検証Workflow等の具体設定は後続実装。

### 15.3 Backend・外部連携の未決定事項

- Open-Meteoの追加・長期検証と商用利用時の利用条件再確認、Tomorrow.ioの降雨時予測品質・独立した分単位予測精度・降り始め／降り終わり推定精度。
- Tomorrow.ioの無料枠超過時の課金条件、正式なリセット境界、継続的な無料利用条件。
- Google Calendarの秘密鍵配置・アクセス制御・失効／ローテーション、API／認証エラー復旧、取得中変更の一貫性・未検証status・日付競合の実装詳細・大量予定の取得制御、無料利用条件、長期無人運用、個別予定の非公開設定時の挙動（17.4）。
- Provider正式Rate Limit仕様・Quota GuardのSQLite DDL／具体SQL、1 HTTP Responseと複数Stateの対応、Open-MeteoのRequest共有、Provider単位の詳細Backoff。Tomorrow.ioの暫定制御方針は第16章。
- WeeklyWeatherは第22章の設計方針・未検証事項に従う。RainForecastは第21章の設計方針・残課題に従う。HourlyWeatherは第20章、CurrentWeatherは第19章、Scheduleは第18章の設計方針と残課題に従う。取得成功だけで古いデータを延命しない。
- 正式SQLite DDL・Index・個別Migration・Generation採番（Version管理と適用条件は12.4で定義済み）、Provisioning CLI、DBの具体Path、503時のJSON Error Schema。 PendingのP-04 / P-05用永続取得識別子・同値処理・Commit結果不明時照合方法は未決定（23.5）。
- Cache不正時の物理削除。
- Backoff・HTTP Timeout・429・Control State待機は第23章に具体化済み。SCH-01〜33は23.8に個別定義済み。Recovery・競合制御は未実装・未検証。
- Backend ModuleのDirectory構成、API提供Processの詳細構成、Health Check Endpoint。
- API Endpoint正式Path・nginx設定。
- Backup実行時刻・Path・Scheduler・失敗時再試行・復元コマンド。
- SQLite Lock・Checkpoint異常時の詳細運用。
- Config・Secret詳細管理、Runtime変更への適用方式。
- Log Rotation等の実装、初期保持値の実機確認・Rate Limit、未選定の別領域の詳細・具体バージョン。ESLint / Prettier等は正式採用済みで設定は未実装。

Future機能を先行実装しない。Issue #4のClose前には文書・Issue間の整合性を確認する。

---

## 16. Weather API選定とTomorrow.ioの取得制御

### 16.1 Provider採用状態

家庭用MVPでは月額0円で継続運用できるAPIを優先し、一般的な天気予報と短時間降雨予測を別Providerから取得することを許容する。
当初の暫定候補比較を経て、CurrentWeather / HourlyWeather / WeeklyWeatherのOpen-Meteoは正式採用、RainForecastのTomorrow.ioは条件付き正式採用とする（第24章）。取得周期・TTL等の合意値と暫定状態は維持する。

| Published State | Provider候補 | 取得周期（暫定） | TTL（暫定） |
|---|---|---|---|
| CurrentWeather | Open-Meteo | 15分 | 2時間 |
| HourlyWeather | Open-Meteo | 30分 | 2時間（第20章） |
| RainForecast | Tomorrow.io | 5分 | 30分 |
| WeeklyWeather | Open-Meteo | 6時間 | 12時間 |

Open-Meteoを基本的な天気予報の取得候補、Tomorrow.ioを分単位降雨予報の取得候補とする。
Open-Meteo currentの限定的な手動検証は19.7に記録する。第20・22章にも限定的な検証記録がある。長期安定性等の追加検証は未完了であり、将来の商用利用時は条件を再確認する。
既存Published Stateの論理分割を維持し、外部HTTP Requestとの1対1対応は要求しない。Open-Meteoの複数State取得Request共有方式は後続設計とする。

R-03の分単位短時間降雨予測、雨の降り始め・降り終わりの見込みというMVP要件は維持する。1時間単位の予報を単に分換算したものは要件を満たす短時間降雨予測と扱わない。
Frontendの30秒Pollingは変更しない。

### 16.2 Tomorrow.ioの検証実績と未検証事項

**ユーザーによる検証実績**：Windows PowerShellの検証スクリプトからTimeline APIを呼び出し、日本国内の指定地点について以下を確認した。

- 5分間隔・1分間隔の将来予報レコード取得に成功。
- `precipitationIntensity`に対応する数値を取得し、検証時は0mm/h。
- API Keyによる認証に成功。

API Response取得と時間間隔指定は実証済みだが、降雨時の予測品質、分単位データの独立した予測精度、降り始め・降り終わりの推定精度は未検証である。
これはユーザーの検証結果の記録であり、今回の文書更新でAPIへアクセスしたものではない。API Key・認証情報・正確な地点は記載しない。

### 16.3 利用枠の確認内容

ユーザーのダッシュボード画面で、以下を確認した。Providerの正式仕様・将来の継続条件を最終確認したものではない。

| 項目 | ユーザー確認値 |
|---|---|
| API Server Calls / day | 500回 |
| API Server Calls / hour | 25回 |
| API Server Calls / second | 3回 |
| 利用可能Data Layers | Core、Severe Weather Hazards |

RainForecastを5分周期・1 Request / 取得で運用すると、通常取得分は288回/日・12回/時となる。
無料利用を優先するが、無料枠超過時の課金条件、制限のリセット境界、継続的な無料利用条件は未確認である。枠内であれば無条件に継続無料と保証しない。

### 16.4 Quota Guardの暫定採用方針

以下を**暫定採用**とし、既存SQLite Acquisition Control・Scheduler・Backoffへ組み合わせる。Quota GuardはProvider単位の送信許可であり、State単位の取得制御や取得失敗後のRetry / Backoffとは別の責務である。

- Tomorrow.ioの通常取得周期は5分、Providerへの同時取得は最大1件とする。
- 即時Retryは行わず、Request送信前にQuota Guardを通す。
- 送信予定をSQLiteに永続記録してからHTTP Requestを開始する。
- 通信失敗・Timeoutでも、消費枠を安易に取り消さない。
- Backend再起動後も送信履歴・Backoff・取得制御状態を復元する。
- 日次・時間・秒間の制限をそれぞれ判定する。
- Providerリセット境界が未確定の間は、ローリングウィンドウで保守的に管理する。
- Quota不足による送信抑止と、実際に送信したHTTP Requestの失敗を区別する。
- HTTP 429は取得失敗とし、BackoffとRetry-Afterの遅い方まで待機する。具体ルールは23.3に従う。

送信前の永続記録は、外部HTTPをDB Transactionの外で行う既存境界を変更しない。Tx-Qによる送信前Commitと解除時刻判定は第23章に従う。具体SQL・DDLは未決定である。

| 対象 | Provider公称上限（ユーザー画面確認） | Backend安全上限（暫定） |
|---|---|---|
| 24時間 | 500回 | 400回 |
| 60分 | 25回 | 20回 |
| 1秒 | 3回 | 1回 |

安全上限は実装前の暫定値であり、Providerの正式な制限仕様を確認して再評価する。ローリング24時間・60分・1秒の管理をProvider側の正式なリセット仕様と同一視しない。

Backend外で同一API Keyを利用するRequest数は、このBackendのSQLiteだけでは把握できない。手動検証、複数インスタンス、他のAPI経路による消費は運用上の制約として扱う。

### 16.5 既存契約と後続設計

API停止中もCacheのTTL・有効CacheのFallback・Metadata・期限切れMaskを維持する。Quota不足やBackoffを理由に古いデータの期限を延長しない。
Startupは外部取得完了を待たず保存Stateを復元してAPI提供を開始し、利用可能データは期限内に限って提供する。

Open-MeteoのHTTP Request共有、詳細Domain Schema、SQLite DDL、Quota Guard具体SQL、Provider正式制限は後続確認とし、429待機計算は23.3に従う。CurrentWeather Domain Dataの設計方針は第19章を参照する。
State単位の取得制御とProvider単位のRate Limitの区別はArchitecture 16.3に従う。

---

## 17. Schedule API選定

### 17.1 正式採用方針

| 項目 | 選定内容・状態 |
|---|---|
| 予定管理サービス | Google Calendar：正式採用方針 |
| 対象カレンダー | サイネージ専用の非公開カレンダー |
| 認証方式 | Google Cloud Service Account |
| 共有権限 | reader |
| API Scope | calendar.events.readonly |
| 取得API | Google Calendar API events.list |
| 登録・編集 | GoogleカレンダーのWeb・スマートフォンアプリ |
| Backend取得 | Node.js / TypeScriptから取得。Backend技術スタックの正式採用状態は11.1に従う |
| 取得周期・TTL | 10分・6時間：既存の暫定値 |
| 保存 | 既存SQLite構成に従う。SQLiteは正式採用、実機検証は未完了 |

Published State `Schedule`、Frontendの30秒Polling、取得・Cache・Recovery・Metadata契約は変更しない。
API接続検証の成功と、長期無人運用の検証完了は区別する。Issue #4全体は未完了である。

### 17.2 ユーザーによる実動作検証

2026年10月12日、日本時間を対象としてWindows PCで検証した。
環境はWindows PowerShell、Node.js v24.14.0、google-auth-library、Google Cloud Service Account、Google Calendar APIである。これは検証環境の記録であり、依存Libraryの正式選定や今回の実装を意味しない。

- Service Account認証、専用カレンダーへのアクセスに成功。
- `accessRole: reader`を確認。
- `events.list`で以下の予定をすべて`status: confirmed`として取得。

| 種別 | 検証結果（日本時間） |
|---|---|
| 通常予定 | 2026/10/12 19:00〜20:00 |
| 終日予定 | 2026/10/12。API終了日付は10/13で排他的 |
| 繰り返し予定 | 2026/10/12 12:00〜12:30のインスタンス |
| 日付またぎ予定 | 2026/10/11 23:00〜10/12 01:00 |

MVPに必要な基本予定種別の取得を実証した。その後のT01〜T07検証は第18章に記録する。長期無人稼働は引き続き未検証である。
予定タイトル・参加者・カレンダーID・認証情報は記載しない。

### 17.3 選定理由と代替案

- 専用非公開カレンダーで、個人の他の予定と分離できる。
- reader共有権限と読み取り専用Scopeで最小権限にできる。
- 個人アカウントのOAuth Refresh TokenをBackendで管理せずに済む。
- 既存のWeb・スマートフォンUIで予定を登録・編集でき、専用入力画面の自作が不要。
- Raspberry Piの無人定期取得に適した構成で、R-02 / R-10に適合する。
- 実際にAPI接続と主要予定種別の取得に成功した。

| 比較対象 | 判断 |
|---|---|
| Google Calendar + Service Account | 正式採用方針 |
| ユーザーOAuth 2.0 | 代替候補として残す |
| 公開カレンダー | プライバシー保護の観点で非採用 |

Service Account採用でも秘密鍵の安全な管理は必要であり、認証情報の保守が不要になるわけではない。

### 17.4 残課題

以下を実装・運用設計へ引き継ぐ。

- Service Account JSON秘密鍵の安全な配置・アクセス制御・失効・ローテーション。
- APIエラーと認証エラーの検出・復旧。
- ページネーションの基本動作は18.2で検証済み。取得中の変更に対する一貫性、予定件数・ページ数上限は未決定。
- 繰り返しの時刻変更・別日移動・削除、通常予定削除は18.2で検証済み。イベント自体のstatus:tentativeは未検証。
- 終日・日付またぎの正規化と日付制御は第18章の方針に従う。競合防止の実装詳細・時刻同期未完了時の復旧は未決定。
- 無料利用条件の最終確認、長期無人運用の確認。
- 個別予定の非公開設定時の取得挙動。
- Schedule Domain Schema・取得制御は第18章に記録。JSON Schemaバリデータ設定・実装検証、Timeout等の具体値は後続確認。

取得周期10分・TTL6時間は暫定値のまま維持する。Weather API候補・Tomorrow.io Quota Guardは第16章の採用状態と方針を変更しない。

---

## 18. Step 5：Schedule Domain Data・詳細取得制御

本章はGoogle Calendarの検証とSchedule設計レビューに基づく設計方針を記録する。アプリ実装・バリデータ実装検証の完了を意味しない。

### 18.1 Schedule Domain Data Schema

```typescript
type ScheduleData = {
  date: string; // YYYY-MM-DD、Asia/Tokyo基準の表示対象日
  events: ScheduleEvent[];
};

type ScheduleEvent =
  | {
      id: string;
      title: string;
      allDay: false;
      startAt: string; // UTC RFC3339
      endAt: string;   // UTC RFC3339
    }
  | {
      id: string;
      title: string;
      allDay: true;
      startDate: string;        // YYYY-MM-DD
      endDateExclusive: string; // YYYY-MM-DD
    };
```

`date`は取得日ではなく、JST基準の表示対象日である。MVPでは今日のみを対象とする。
正常な0件は`data: {date, events: []}`、取得不可は`data: null`とする。従来のSchedule正常空データ`data: []`をこのDomain構造へ更新する。他Stateの契約・共通Metadataは変更しない。
時刻指定と終日はallDayで判別し、時刻指定日時をUTC RFC3339へ正規化する。終日終了日は排他的に扱う。

JSON Schema Draft 2020-12を想定する。ScheduleDataのdate・events、各イベントのid・title・allDayと分岐ごとの日時をrequiredとする。
イベント分岐はoneOfとallDayの固定値で表現し、ScheduleDataと各イベントObjectにadditionalProperties:falseを適用する。
date・startDate・endDateExclusiveはdate形式、startAt・endAtはdate-time形式として、実在する日付・UTC RFC3339を検証する。format検証の有効化・設定・実装確認は未完了である。

Schema Validationに加え、以下のSemantic Validationを行う。

- 時刻指定はstartAt < endAt、終日はstartDate < endDateExclusive。
- 時刻指定・終日とも、実際の期間がJSTの対象日と重なること。
- data.dateが取得試行のtargetDateに一致し、採用時に今日であること。
- events内のID一意性。同時刻でも異なるIDは保持する。

### 18.2 Google Calendar取得・正規化と実測

- events.listでsingleEvents=trueとして繰り返し予定を展開する。
- showDeleted=falseを基本とし、cancelledイベントは通常イベントの日時必須検証より前に除外する。
- nextPageTokenで全ページを取得し、完了後に一括で正規化・検証・反映する。途中ページ失敗は取得試行全体の失敗とする。
- 識別にはevent.idを用いる。同時刻の異なるIDは両方保持し、同じIDの重複は整合性エラーとする。
- 繰り返し変更・別日移動は実際のstart / endを使う。originalStartTimeを対象日判定に使わない。
- 参加者のresponseStatus:tentativeは除外条件にしない。
- summary欠落時はtitleを空文字へ正規化する。
- 時刻指定・終日ともJST対象日に重なるイベントを含める。正常イベントの日時不正は原則として取得試行全体の失敗とする。
- iCalUID、recurringEventId、originalStartTime、attendeesはMVP公開Domain Dataに含めない。

**ユーザーによる実API検証：全7ケースPASS。**

| ケース | 確認内容 |
|---|---|
| T01 | 同時刻の異なる予定2件 |
| T02 | 繰り返し予定の1回だけ時刻変更 |
| T03 | 繰り返し予定の1回だけ別日移動 |
| T04 | 繰り返し予定の1回だけ削除 |
| T05 | 通常予定の削除 |
| T06 | 参加者の未定回答がattendees[].responseStatus:tentativeとなる |
| T07 | 14件を7ページで取得し、1ページ取得時とID集合が一致 |

event.status:tentative自体は未実測であり、参加者のresponseStatus:tentativeと混同しない。複数ページ取得中の予定変更に対する一貫性も未検証である。

### 18.3 JST日付切替・競合制御

表示対象はAsia/Tokyoの今日とする。JST 0時に前日のSchedule Snapshotを公開対象から除外し、新日の取得を開始する。
前日開始の予定でも新日に実際の期間が重なるイベントは、新日の取得・正規化の対象である。
API Response生成時もdata.dateとJSTの今日を照合し、不一致ならTTL内でもdata:null、dataSource:nullとする。Metadataの既存値を維持する変換は10.8に従う。

取得試行は開始時に確定したtargetDateを保持する。23:59開始・00:01完了の旧日取得結果を、新日のPublished Stateとして採用しない。
同一対象日の競合でも古い取得結果が新しい結果を上書きしないようにする。防止の具体的実装は未決定である。
Frontendもdata.dateと今日のJST日付を照合する。Piのシステム時刻が信頼できない場合、Scheduleを公開不可とする。時刻信頼性の具体判定・復旧手順は既存Time原則に従って後続で具体化する。

### 18.4 Cache・取得失敗・Frontend表示

通常取得10分・Cache TTL6時間は暫定値を維持する。Cache採用には以下すべてを要求する。

- data.dateが今日のJST日付に一致。
- TTL内。
- 保存DataのSchema・Semantic Validationに合格。
- システム時刻が信頼できる。

取得失敗時は同日の有効Cacheを公開し、有効Cacheがなければdata:null、dataSource:nullとする。前日のCacheを今日へ流用しない。
失敗でdataUpdatedAt・expiresAtを延長しない。lastAttemptAt・lastAttemptResultは試行完了時に更新し、publishedAtはSnapshot生成時刻とする。
全ページ取得・正規化・検証成功前に既存Cacheを部分上書きしない。保存・公開は既存Transaction境界に従う。

| Frontendが利用できる状態 | 表示 |
|---|---|
| 今日の有効data、events:[] | 本日の予定はありません |
| 今日の有効data、events:[...] | 予定一覧 |
| data:null | 予定を取得できません |

日付照合・期限判定はFrontendでも継続する。前日Dataを今日の予定や正常な0件として表示しない。

### 18.5 障害監視

MVPではPinoログと既存Published State Metadataで管理する。必要に応じて対象日、試行開始時刻・処理時間、件数・ページ数、HTTPエラー・Timeout・Validationエラー、Cache Fallback状況を記録する。
外部メール・スマートフォン通知はMVPに追加せず、Published Stateのstatus・errorCodeも追加しない。
認証情報・アクセストークン・Service Account秘密鍵をログや文書へ出力しない。

### 18.6 未検証・詳細設計待ち

- event.status:tentativeの実API動作。
- 複数ページ取得中に予定が変更された場合の一貫性。
- Retry回数・Timeout・ページ数上限の具体値。既存Backendの即時Retryなし・有界Backoff方針は維持する。
- 日付変更・同日取得結果の競合防止の実装詳細。
- 時刻同期未完了時の具体的復旧処理。
- JSON Schemaバリデータ設定・実装検証。

Step 5のSchedule設計記録までを対象とし、別Domainの詳細設計やコード実装には進まない。

---

## 19. CurrentWeather Domain Data設計

### 19.1 目的・Providerと採用状態

MVPでは、単一の自宅周辺エリアの屋外現在気温と天気アイコンを表示する。
Open-Meteoは技術選定として**正式採用**する。長期安定性・Pi実機検証の完了とは扱わない。Forecast APIのcurrentを使用し、temperature_2m、weather_code、is_day、current.time、current.intervalを取得対象とする。
本章は合意済み設計の記録であり、アプリ実装・異常ケース検証完了を意味しない。

### 19.2 Domain Data Schema

```typescript
type CurrentWeatherData = {
  temperatureC: number;
  weatherCode: number;
  isDay: boolean;
  validAt: string;
};
```

4項目すべて必須で、MVPではnullを許容しない。追加のProviderフィールドは無視し、必要項目のみを変換する。

| 項目 | 意味・変換 |
|---|---|
| temperatureC | 摂氏の現在気温 |
| weatherCode | Open-MeteoのWMOベース天気コード。未知の整数コードも保持可能 |
| isDay | 昼夜区分。APIの数値0 / 1をbooleanへ変換 |
| validAt | 気象Dataの対象時刻。Providerタイムゾーンを考慮しUTC RFC3339へ正規化 |

current.intervalはProvider Response Validationに使い、Domain Dataには含めない。
validAtと、Backendが外部Dataを正常取得・検証・採用した時刻dataUpdatedAtは別の意味である。

### 19.3 ValidationとState単位の採用

| API項目・観点 | 条件 |
|---|---|
| temperature_2m | 有限の数値 |
| weather_code | 整数。未知の整数コードも許容 |
| is_day | 数値の0または1 |
| current.time | 実在する正しい日時で、タイムゾーンを考慮してUTC RFC3339へ変換可能 |
| current.interval | 正の整数。900秒には固定しない |
| 取得時鮮度 | validAtが取得時点の過去30分〜未来5分以内 |

null、型不正、必須項目欠損、実在しない日時はValidation失敗とする。未来5分の許容は時刻ずれ等への対処としての暫定値である。

必須項目の1つでも不正ならCurrentWeather全体を不採用とし、正常な気温だけの部分採用は行わない。
これはCurrentWeather内部の採用方針であり、他のPublished Stateの正常取得・更新を停止させない。複数Stateを生成する取得結果の保存は既存Transaction・部分成功方針に従う。

### 19.4 取得周期・Cache・鮮度判定

| 項目 | MVP運用値・状態 |
|---|---|
| 取得周期 | 15分（暫定） |
| Cache TTL | 2時間 |
| 取得時の過去方向許容 | 30分 |
| 取得時の未来方向許容 | 5分（暫定） |

第11.5・16.1の共通表は従来の暫定値の記録であり、CurrentWeatherについては本章の運用値・採用状態を参照する。他Stateの暫定値は変更しない。
取得時はvalidAtで採用可否を判断し、公開時は既存Published StateのexpiresAtとCache TTLに従う。公開時に取得時の30分制限を再適用しない。
失敗時は期限内Cacheを利用し、TTLを延長しない。期限切れは既存API契約に従いdata:null、dataSource:nullへMaskし、既存Metadataを保持する。

### 19.5 取得失敗とFrontend表示

通信失敗、Response異常、Validation失敗、鮮度失敗はいずれもCurrentWeatherの取得失敗として扱い、新Dataを採用しない。
期限内Cacheがあれば維持し、なければdata:nullとする。lastAttemptAt・lastAttemptResult等は既存契約に従って更新し、既存CacheのdataUpdatedAt・expiresAtを延長しない。

| 状態 | 表示方針 |
|---|---|
| 正常取得 | 気温と天気アイコン。更新日時は表示しない |
| 直近取得失敗・TTL内Cacheあり | 気温・天気アイコンを維持し、「更新待ち」と最終更新日時を両方表示 |
| TTL切れ・有効Cacheなし | 「取得できません」 |
| 未知の整数天気コード | 「天気不明」。取得失敗とは扱わない |
| 更新時刻 | 正常時には表示せず、取得異常時に有効Cacheを表示する場合は最終更新日時を表示 |

isDayは昼夜アイコン選択に利用する。「更新待ち」は最後の取得が失敗して有効Cacheを表示する場合の案内である。
約3mから気温・天気を読めることを意識し、アイコンデザイン・Component実装は今回対象外とする。

最終更新日時にはPublished State Metadataの`dataUpdatedAt`（Backendが外部Dataを正常取得・検証・採用した時刻）を使用する。気象Dataの対象時刻`validAt`とは区別する。具体的な表記・位置・文字サイズはIssue #5で決定する。

**既存要件との整合確認：解消済み。** 取得異常時の有効Cache表示で「更新待ち」と最終更新日時を両方表示する合意により、R-07およびArchitecture 5.6との整合を確認した。「更新時刻を常時表示しない」は正常時の方針であり、異常時の日時表示は維持する。

### 19.6 Future

項目単位の部分採用、欠損表示・Fallback、体感温度・湿度・風速等の追加、詳細画面の更新時刻表示、運用実績による周期・TTL・鮮度閾値調整はFutureの検討事項とする。MVP必須機能へ追加しない。

### 19.7 実API検証範囲と残課題

既に実施された限定的な手動検証として、次を記録する。今回API検証は再実行していない。

- Open-Meteo currentから必要な基本項目を取得し、型・存在を確認。
- Asia/Tokyoの日時をUTCへ変換できた。
- 15分の時刻境界をまたぐ複数回の取得を確認。
- 観測サンプルでは未来時刻の返却は発生しなかった。

長期安定性、全気象条件、すべての異常ケースは未検証である。将来的な商用利用条件の再確認、Validation実装・時刻設定の詳細は後続へ残す。異常時日時表示の具体的な表記・配置・文字サイズはIssue #5で決定する。
Issue #4全体は未完了であり、CurrentWeather設計の完了扱いはGitHub差分のChatGPTレビュー合格後とする。

---

## 20. HourlyWeather Domain Data設計

### 20.1 SchemaとProvider

```typescript
type HourlyWeatherData = {
  hours: HourlyWeatherItem[];
};

type HourlyWeatherItem = {
  validAt: string;
  temperatureC: number;
  weatherCode: number;
  precipitationProbability: number;
};
```

全フィールド必須でMVPではnullを許容しない。hoursは時刻昇順、採用時は24〜36枠とする。
単一のdateは設けず、各枠のvalidAtで日付を管理する。

| 項目 | 条件・意味 |
|---|---|
| validAt | 予報対象時刻。実在する日時をUTC RFC3339へ正規化 |
| temperatureC | 摂氏気温。有限数値 |
| weatherCode | WMOベース整数コード。未知の整数も許容 |
| precipitationProbability | 0〜100の有限数値。降水確率 |

Open-Meteoは技術選定として**正式採用**する（運用値・実装検証は未完了）。
取得対象はhourly.time、hourly.temperature_2m、hourly.weather_code、hourly.precipitation_probabilityとする。

| 項目 | 方針・採用状態 |
|---|---|
| API取得周期 | 30分（暫定） |
| Cache TTL | 2時間（暫定） |
| Backend保持範囲 | 取得基準時刻から最大36枠 |
| Frontend選択範囲 | 現在時刻の次の正時から最大24枠 |
| 同時表示枠数・レイアウト | Issue #5で決定 |

36枠は経過時間への余裕を含む保持範囲であり、すべてを同時表示する意味ではない。
R-07のHourlyWeather暫定TTLを3時間から2時間へ更新し、本章との不一致は解消済みとする。取得周期30分・TTL2時間の最終運用検証は未完了である。

### 20.2 取得基準時刻と切り出し

1. API取得処理の開始時刻を取得基準時刻として固定する。
2. timezone=Asia/Tokyoを指定し、hourly.timeをJSTとして解釈してUTC RFC3339へ変換する。
3. 取得開始時点の次の正時から最大36枠を切り出す。正時ちょうどならその時刻を含める。
4. 取得中に正時・日付をまたいでも取得基準時刻を変更しない。
5. 採用直前に、その時点の現在時刻を基準とする必要24枠が連続して存在し、正常であることを再確認する。

例：10:25開始なら11:00〜翌22:00の36枠を抽出する。
10:59:58開始・11:00:03採用判定では、取得基準を固定したまま、採用時に12:00以降の24枠を再確認する。
UTC / JSTの混同や日付またぎを避け、時刻比較は正規化済み時刻で行う。

### 20.3 Provider Response Validation

**第1段階：配列構造**

hourly.time、hourly.temperature_2m、hourly.weather_code、hourly.precipitation_probabilityの4配列について存在・配列型・要素数一致を確認する。
構造不正はHourlyWeather全体を不採用とする。配列長が一致して36枠未満でも、それだけを理由に不採用としない。

**第2段階：時間枠**

- 必要な先頭24枠は1時間間隔で連続し、すべての必須値が正常であること。
- 24枠内の欠損・不正値・時刻不連続はState全体の不採用とする。
- 25〜36枠は正常な連続範囲だけ採用し、余裕枠で最初の異常が見つかった時点で打ち切る。
- 欠損時刻を詰めず、前回Cacheから個別枠を補完しない。
- 気温は有限数値、天気コードは整数（未知も許容）、降水確率は0〜100の有限数値。
- null・欠損・型不正・実在しない日時は認めない。

取得開始時の必要24枠と採用直前の必要24枠の両方が正常であることを採用条件とする。
配列構造のValidationと各枠の値・時間的連続性を分けて確認する。

### 20.4 State更新とCache

HourlyWeather単位で検証・採用する。不採用時は新Dataへ置換せず、TTL内の正常Cacheを維持する。
失敗でdataUpdatedAt・expiresAtを延長せず、lastAttemptAt・lastAttemptResult等は既存API契約に従う。
他Stateの正常更新を妨げず、TTL切れはdata:null、dataSource:nullとして扱う。
採用時の24枠確保と、経過後のFrontendで利用できる枠数は区別する。

### 20.5 Frontend表示

現在時刻を基準として次の正時から最大24枠を再選択する。正時ちょうどではその時刻を含める。

| 状態 | 表示方針 |
|---|---|
| 正常取得・将来24枠以上 | 最大24枠を選択。更新日時は表示しない |
| 取得失敗・TTL内Cacheあり | 有効予報を維持し、「更新待ち」と最終更新日時を両方表示 |
| TTL内・将来1〜23枠 | 存在する将来予報のみ表示。取得失敗中なら更新待ち・最終更新日時も表示 |
| TTL内・将来0枠 | 「取得できません」 |
| TTL切れ・初回未取得 | 「取得できません」 |

最終更新日時はMetadataのdataUpdatedAtを用い、各予報対象時刻validAtを最終更新日時として使わない。
予報枠不足とAPI取得失敗は内部状態として区別し、枠不足だけを取得失敗と扱わない。
表示情報は天気アイコン・気温・降水確率。アイコン、同時表示枠数、日時表記・配置・文字サイズはIssue #5で決定する。
R-07・Architecture 5.6の正常時注記なし、取得異常時の更新状態・最終更新日時、有効期限評価を維持する。

**要件との整合確認：解消済み。** R-03を翌日を含む将来24時間の時間別予報へ更新し、本章の選択範囲と整合した。R-04の「今日の天気」はコンテンツ名として維持し、予報期間を当日内に限定しない。巡回構成は変更しない。

### 20.6 未検証・後続確認

- Open-Meteoは正式採用済み。将来的な商用利用条件は再確認する。
- API周期30分・TTL2時間の運用値最終検証（R-07との値の整合は解消済み）。
- 実APIのResponse形式・配列・時刻境界の検証。
- 異常系を含む実装・テスト。
- Issue #5のFrontend同時表示枠数・レイアウト・日時等の表示詳細。

今回、実API検証・実装・テストは実施していない。HourlyWeather設計の完了扱いはGitHub実差分のChatGPTレビュー合格後とし、Issue #4全体も未完了である。

---

## 21. RainForecast設計

### 21.1 Provider・API・採用状態

Tomorrow.ioを**条件付き正式採用**とする。プラン・無料枠／課金・Rate Limit・継続条件・規約／商用条件・予測品質／安定性を確認し、条件不成立なら代替Providerを再検討する。Timelines APIのPOST /v4/timelinesを利用し、timestepは1m、unitsはmetric、startTimeはnow、endTimeはnowPlus65mを要求する。
雨に対象を絞るためrainIntensityを使用する。precipitationIntensityも取得可能だが、MVP判定には使わない。
採用時点から将来60分間を必要とし、取得周期5分、Cache TTL30分、表示鮮度制限10分はいずれも暫定値である。Quota Guardは第16章を維持する。

### 21.2 ユーザーによる疎通検証

2026年10月21日、Windows PowerShellから取得済みAPI Keyを用いて検証した結果を記録する。今回API呼出しは実施していない。

| 確認項目 | 結果 |
|---|---|
| HTTP | 200 |
| スロット数 | 66件 |
| 間隔・連続性 | 連続1分間隔、時刻連続性True、Basic interval check PASS |
| 先頭時刻 | 2026-10-21T13:20:00Z |
| 先頭5件の強度 | rainIntensity・precipitationIntensityとも数値0 |
| 時刻形式 | UTC RFC3339 |

使用したAPI Keyで1分間隔予報を取得できたことは確認済みである。API Key・位置・認証情報は記載しない。
全66件の強度正常性、採用時点から厳密に将来60分を確保できること、実降雨時の正値、5分Polling長期運用の制限・エラー、プラン／仕様変更の制約は未検証とする。疎通PASSをこれらの検証完了と扱わない。

### 21.3 Domain Data Schema

```typescript
type RainForecast = {
  status: "dry" | "raining";
  intensity: "light" | "moderate" | "heavy" | null;
  rainStartAt: string | null;
  rainEndAt: string | null;
  forecastUntil: string;
};
```

| 項目 | 意味 |
|---|---|
| status | 採用時点の起点予報スロットによる現在降雨状態の近似。実測値ではない |
| intensity | 対象となる直近降雨イベントの予測範囲内最大強度の分類。イベントなしはnull |
| rainStartAt | 次の降り始め、または短い途切れ後の再開見込み。現在降雨中はnull |
| rainEndAt | 対象イベントの終了見込み。予測範囲内で確定できなければnull |
| forecastUntil | 検証・採用した予報期間の排他的終端 |

時刻はBackendでUTC RFC3339へ正規化し、FrontendでJST表示する。Domain内のstatusは降雨状態であり、共通Metadataへのstatus追加ではない。
rainResumeAt追加や強度推移の時系列表示はFuture候補とし、今回は追加しない。

### 21.4 降雨イベント判定

降雨イベント判定は検証・採用した有効な予報範囲内に限定する。範囲外の降雨・再開・強度を推測せず、イベント統合は取得済みスロットで確認できた情報だけで行う。intensityはその範囲内の対象イベントの最大強度から算出する。

0.1 mm/h以上を雨、未満を雨なしとする。閾値はMVP暫定値である。
連続降雨を1イベントとし、5分未満の雨なしの途切れは同一イベントに統合、5分以上は別イベントとする。
扱うのは直近1件のみで、現在降雨中は現在イベント、雨なしなら次イベントを対象とする。
短い途切れ中はstatusをdryとし、rainStartAtには次の再開見込みを設定する。イベント統合と現在statusは分離し、雨なしスロットをrainingへ変えない。

rainEndAtは、止まり始めから5分以上連続して閾値未満であることを確認できた場合に、止まり始めの時刻を設定する。
5分未満で再開した場合はイベント継続、終端で確認不足または終端まで降雨が続く場合はnullとする。nullは「止まらない」ではなく「終了時刻を確定できない」を意味する。

| intensity | 対象イベントの予測範囲内最大降水強度 | 表示 |
|---|---|---|
| light | 0.1以上、1.0 mm/h未満 | 弱い雨 |
| moderate | 1.0以上、10.0 mm/h未満 | 普通の雨 |
| heavy | 10.0 mm/h以上 | 強い雨 |

MVP独自の表示区分であり、気象庁公式区分ではない。最大がheavyでも降り始めから強いとは限らず、UIで誤認を避ける。

例：予報範囲が13:00まで（排他的）で、12:55・12:56は雨、12:57〜12:59が雨なしなら、確認できる雨なしは3分間だけである。この場合rainEndAt:nullとし、intensityは範囲内の対象イベントの最大強度から算出する。13:00以降の再開・強度・終了時刻は推測しない。

### 21.5 時刻処理・Validation

API Request開始時刻を記録する。現在時刻が分境界ならその分、それ以外は次の分境界を起点とし、連続60個の1分スロットを必要とする。
forecastUntilは最後の採用スロットの終了時刻とする。 判定範囲はこの排他的終端までとし、その外を補完しない。終端までに5分連続の閾値未満を確認できなければrainEndAt:nullとする（21.4の境界例参照）。
採用直前に採用時点の時刻で将来60分間を再検証し、必要期間不足は取得失敗とする。statusは採用時点の起点スロットの強度で近似する。

必須60スロットを以下の条件で検証する。

- 強度は0以上の有限数値。null・欠損・文字列・NaN・Infinity・負数は不正。
- 時刻は1分間隔で連続し、欠損・重複・逆順がない。
- 必要な将来60分間をカバーする。

必須Dataに1件でも異常があればRainForecast全体を取得失敗とし、補間・推測・0置換は行わない。
60分超の返却Dataは採用に必要な範囲を検証し、余剰処理はAdapterで整理する。Providerの時刻が表す期間・スロット境界・単位もAdapterで扱い、設計上の1分スロットとして正しく解釈できるか実装時に確認する。

### 21.6 Cache・Frontend鮮度

State単位の独立更新、取得失敗時のTTL内Cache維持、失敗によるTTL非延長、期限切れMaskを維持する。
期限切れはdata:null、dataSource:nullとし、既存6項目Metadata契約に従う。
表示鮮度はdataUpdatedAtを基準とし、Frontendは表示中も時間経過を評価する。

| 状態 | RainForecast表示方針 |
|---|---|
| 取得から10分未満・直近更新成功 | 通常の降雨予報。異常注記・最終更新日時は表示しない |
| 取得から10分未満・直近更新失敗 | 有効予報＋「更新待ち」＋最終更新日時 |
| 取得から10分以上30分未満 | 予報非表示。「更新待ち」＋最終更新日時 |
| TTL30分以上 | 予報非表示。「取得できません」 |

10分経過だけではBackend Cacheを削除しない。表示鮮度とTTLは別の概念である。
statusは採用時の予報に基づき、Frontendは時間経過で再計算せず、定期取得で更新する。

**既存要件との整合確認：解消済み。** R-07でCache TTLと情報種別ごとの表示鮮度制限を区別し、RainForecastのみ10分以上の実データ非表示を許容した。最終更新日時はdataUpdatedAtを使用する。他Stateへの自動適用は行わない。Backendがdataを返していてもFrontendは10分以上の予報を現在状態・今後の見込みとして表示せず、再取得待ちなしで時間経過を評価する。「更新待ち」「取得できません」は仮文言とし、最終文言・レイアウトはIssue #5で決定する。

### 21.7 更新競合・原子性

Request開始順を判定する単調増加連番を推奨する（具体実装の確定ではない）。
新結果採用後に到着する古い結果は破棄し、古い成功でdataを、古い失敗でlastAttemptAt・lastAttemptResultを上書きしない。
成功・失敗に同じ競合制御を適用し、RainForecast更新をState単位で原子的に行う。他Stateには影響させない。

### 21.8 後続確認

21.2の未検証事項、Providerの期間・スロット境界・単位の解釈、余剰Data処理、Issue #5の表示詳細、競合制御実装を後続へ残す。
今回の対象はRainForecast設計Markdownのみであり、WeeklyWeatherやBackend残詳細には進まない。Issue #4全体およびRainForecastの最終レビュー完了を意味しない。

---

## 22. WeeklyWeather設計・API検証

### 22.1 Provider・取得仕様

Open-Meteo Forecast APIのDaily Forecastを**正式採用**する。
GET https://api.open-meteo.com/v1/forecast にtimezone=Asia/Tokyo、forecast_days=9を指定し、緯度・経度は既存の設定地点を使用する。今回のユーザー検証ではAPI Keyは不要だった。
Provider固有の配列はBackend Adapterで検証・変換し、FrontendへDomain Dataを公開する。

| Providerフィールド | Domain Data |
|---|---|
| daily.time | date |
| daily.weather_code | weatherCode |
| daily.temperature_2m_max | temperatureMaxC |
| daily.temperature_2m_min | temperatureMinC |
| daily.precipitation_probability_max | precipitationProbability |

precipitation_probability_maxは日内最大降水確率であり、「その日に一度でも雨が降る確率」と同義に扱わない。
取得周期6時間・Cache TTL12時間はMVP暫定値とする。Backendは最大9日、Frontendは今日（JST）から最大7日を対象とする。共通API・Metadata契約は維持する。

### 22.2 Domain Data Schema

```typescript
type WeeklyWeatherData = {
  days: WeeklyWeatherItem[];
};

type WeeklyWeatherItem = {
  date: string;
  weatherCode: number;
  temperatureMaxC: number;
  temperatureMinC: number;
  precipitationProbability: number;
};
```

全項目必須でnullは許容しない。dateは予報対象のJST暦日（YYYY-MM-DD）で、UTC日時へ変換しない。
weatherCodeはWMOベース整数（未知整数も許容）、気温は℃、precipitationProbabilityはその日の最大降水確率（%）を示す。未知コードの表示FallbackはIssue #5で扱う。

### 22.3 Provider Response Validation

第1段階では22.1の5配列について存在・配列型・要素数一致を確認する。配列構造不正はWeeklyWeather全体を不採用とする。

第2段階は取得開始日のJST暦日から連続7日を必須範囲、8〜9日目を余裕範囲とする。

- 必須7日は全項目正常、日付昇順・1日間隔とする。欠損・重複・逆順・不正値はState全体の不採用。
- 欠損日を詰めず、前回Cacheから個別日を補完しない。
- 余裕日は正常な連続範囲だけ採用し、最初の不正日で打ち切る。
- 8日目正常・9日目不正なら8日を採用。8日目不正なら9日目が正常でも7日までとする。
- 余裕日個別の不正だけで正常な必須7日を破棄しない。配列全体の構造不正とは区別する。

| 項目 | 正常条件 |
|---|---|
| date | 実在するJST暦日、YYYY-MM-DD |
| weatherCode | 整数。未知コードも許容 |
| temperatureMaxC | 有限数値 |
| temperatureMinC | 有限数値、temperatureMinC <= temperatureMaxC |
| precipitationProbability | 0〜100の有限数値 |

null・欠損・型不正・非有限数値は不正。正常系実API検証では最高／最低の大小関係に問題はなかったが、あらゆる条件で保証されたとは扱わない。

### 22.4 取得開始時・採用直前の2段階Validation

1. API取得開始時刻を記録し、その時点のJST暦日を取得基準日として固定する。
2. 基準日から9日分を要求し、必須7日を検証する。余裕2日は正常な連続範囲のみ採用候補にする。
3. 採用直前に現在のJST暦日を再評価し、その日から連続7日が採用候補内で正常に存在することを確認する。
4. 取得開始時・採用直前の両条件に合格した場合だけ採用し、不足は取得失敗とする。

例：2026-10-21 23:59:58 JST開始なら必須範囲は10/21〜27。10/22 00:00:03 JSTの採用判定では10/22〜28を再確認する。取得中の日付変更で開始時の基準日を書き換えない。

### 22.5 Frontend表示

現在のJST暦日から連続する最大7日をdaysから選択する。日付変更時はAPI再取得を待たず再選択する。

- 今日から7日あれば7日表示し、1〜6日なら存在する連続日数だけ表示する。
- 今日から連続する予報が0日なら「取得できません」とする。
- 過去の日を今日として表示せず、欠損日を飛ばして詰めたり推測・補完したりしない。
- 予報日数不足だけでAPI取得失敗とは判定しない。
- 取得失敗・TTL内有効Cacheありでは、R-07に従い有効予報＋「更新待ち」＋最終更新日時を表示する。
- 最終更新日時はdataUpdatedAtを使い、予報対象日dateとは混同しない。
- TTL切れ・初回未取得は「取得できません」。正常時は異常注記・最終更新日時なし。

表示は天気アイコン・最高／最低気温・降水確率。アイコン対応表・レイアウト・文字サイズ・最終文言はIssue #5で決定する。
RainForecast固有の10分表示鮮度制限は適用しない。

### 22.6 State更新・Cache・競合制御

WeeklyWeather単位で独立取得・検証・採用する。不正時は新Dataを採用せずTTL内正常Cacheを維持する。
失敗でdataUpdatedAt・expiresAtを延長しない。TTL切れはdata:null、dataSource:nullとし、lastAttemptAt・lastAttemptResult等は共通Metadata契約に従う。他Stateの正常更新を妨げない。

開始順を管理して古い成功結果によるdata上書き、古い失敗による試行Metadata巻き戻りを防ぐ。成功・失敗に同じ制御を適用し、State単位の整合した原子的更新を行う。単調増加連番等の具体実装は実装段階で決定する。

### 22.7 2026-10-21ユーザー実API検証

ユーザーがWindows PowerShellからOpen-Meteo Forecast APIを呼び出した正常系検証の記録である。今回API再呼出しは行っていない。

| 項目 | 実測 |
|---|---|
| HTTP Status | 200 |
| Timezone / UTC Offset | Asia/Tokyo / 32400秒 |
| Day Count | 9 |
| First / Last Date | 2026-10-21 / 2026-10-29 |

Daily Response：

```json
{
  "time": ["2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"],
  "weather_code": [53, 2, 3, 63, 53, 80, 81, 3, 3],
  "temperature_2m_max": [28.7, 22.5, 22.1, 20.8, 23.3, 22.4, 27.2, 20.3, 18.0],
  "temperature_2m_min": [19.6, 14.8, 13.2, 16.3, 19.7, 19.7, 15.7, 9.0, 9.0],
  "precipitation_probability_max": [100, 35, 31, 100, 70, 76, 73, 8, 7]
}
```

5配列存在・各9件一致、JST日付昇順・連続、天気コード整数、気温有限値、最高>=最低、降水確率0〜100、必須7日・余裕2日の正常性はすべてPASS。
**正常系の実API疎通・Response検証はPASS**である。Backend Validation・Cache・競合制御の実装検証完了とは区別する。

### 22.8 未検証・後続テスト

以下は実装時のVitest単体テスト、および結合・運用テストへ引き継ぐ。

- 取得中のJST日付変更と2段階Validation。
- 必須7日の欠損・重複・逆順・不正値。
- 余裕8〜9日の不正時打ち切り。
- 最高気温が最低気温を下回る異常Data。
- 取得失敗時のCache維持・TTL非延長。
- 競合時の古い成功・失敗結果破棄。
- 6時間Polling・TTL12時間の長期運用。

今回コード実装・テストは行っていない。将来的な商用利用条件の再確認とIssue #5の表示詳細も後続に残し、Issue #4全体やWeeklyWeatherのレビュー完了と扱わない。

---

## 23. Backend Scheduler・SQLite Recovery・Pending Publication

本章はIssue #4で合意済みの詳細設計を記録する。Backend技術の正式採用・Tomorrow.io条件付き採用とQuota安全上限等の暫定状態を区別し、実装・試験完了とは扱わない。Domain Data第18〜22章は変更しない。

### 23.1 SQLite障害分類とRecovery

Database HealthとBackend Service Healthを区別する。

| 分類 | 内容・方針 |
|---|---|
| L1 | 一時的SQL操作失敗（SQLITE_BUSY等）。外部取得失敗と区別 |
| L2 | 一時的Database全体利用不能。可能な機能は継続し、通常Schedulerを保留してRecoveryへ移行 |
| L3 | 整合性異常。State単位Snapshot不正とDB全体破損を区別。安全な自動復旧判断ができないDB破損・Schema非互換はBLOCKED |
| L4 | Storage / OS等の致命障害。安全な復旧を保証しない |

HEALTHY / DEGRADED / RECOVERING / BLOCKEDは概念状態であり、全Service共通のenumや具体型を追加する決定ではない。
一時障害でProcessを無条件終了せず、DBの自動削除・初期化・根拠のない修復は行わない。

- 復旧可能な障害は前回チェック完了から固定5秒後に再確認し、RecoveryをSingle-flightとする。
- 復旧可能なL2の確認回数に上限を設けない。
- 毎回重い整合性検査を行わず、同一障害ログの大量出力を抑制する。
- 接続・Schema互換性・Read・実際のWrite / Commit・Published State復元Validation・Acquisition Control State復元Validationを確認する。
- Quota永続履歴を安全に検証できるまでTomorrow.ioはFail Closed。
- SQLite利用可能後、原則1分以内のPublish / Read再開を初期目標とする。外部API成功・最新Data取得はDB復旧条件ではない。

### 23.2 Transaction分離

外部HTTP・Validation・Domain変換はSQLite Transaction外で行う。

| Transaction | 内容 | タイミング |
|---|---|---|
| Tx-Q | Tomorrow.io Quota消費予定の永続記録 | HTTP送信前 |
| Tx-A | Acquisition Control State更新 | HTTP取得・Validation後 |
| Tx-P | Published State Data＋Metadata保存 | Tx-A成功後 |
| Tx-C | Backend Cache更新 | Tx-P成功後 |

Tx-Q Commit失敗ならTomorrow.ioへ送信しない。Tx-A失敗ならTx-Pへ進まない。
Tx-P Commit成功後のみ新Stateを公開し、失敗時は旧Snapshotを維持する。Tx-C失敗でCommit済み公開を取り消さない。
Transaction失敗と外部API取得失敗は区別する。各Transaction内の変更は失敗時Rollbackするが、別Transactionの成功を一括取消ししない。
複数State生成時のDomain単位の部分成功は維持し、特定State失敗で正常Stateを一律に不採用としない。Cache I/O失敗でPublished State公開を妨げないArchitecture 8.5と整合させる。

### 23.3 Scheduler・nextAttemptAt・Backoff

MVPは単一Backend Process、5 Stateは論理的に独立取得・更新する。State単位setTimeoutで次回判定を予約し、発火時は保存状態と実際の現在時刻で再評価する。遅延Timerで予定時刻を現在時刻の代用にしない。
State単位inFlightで重複を防ぎ、Task終了後に解除して次回判定を予約する。SQLite利用不能時は通常Schedulerを保留し、Recoveryへ移る。Startupは強制取得せず通常判定を利用する。

nextAttemptAtは**次のHTTP取得を開始してよい最も早い時刻**とする。

| 結果 | nextAttemptAt・制御 |
|---|---|
| 成功 | 取得開始時刻＋取得周期 |
| 失敗 | 失敗処理完了時刻＋指数Backoff |
| Quota不足で送信抑止 | nextAttemptAt・失敗回数を変更しない |
| Tx-A成功後のTx-P失敗 | 取得成功として記録したnextAttemptAtを維持 |

未取得・期限切れ・周期到達等で取得対象を判定したうえ、Backoff・Quota・Provider制約・inFlightも確認する。
5 State共通Backoffは初回1分、係数2、上限30分（1、2、4、8、16、30分……）。MVPはJitterなし・即時Retryなし。
HTTP 429は失敗とし、通常BackoffとRetry-Afterの遅い方まで待つ。Retry-Afterは秒数・HTTP Date形式に対応し、有効値が30分超でも尊重する。不正・欠損なら通常Backoffを適用する。

全Providerの外部HTTP Timeoutは10秒とし、Node.js標準fetchとAbortSignal.timeout()を使用する方針。Frontend Pollingの5秒Timeoutとは別である。
Timeoutは取得失敗とするがProvider処理・Quota消費取消しとは判断しない。周期を超えるTaskも重複起動せず、inFlightはTask終了後に解除する。
Task全体の一律TimeoutはMVPに導入せず、HTTP TimeoutとSQLite Transaction・同期処理の停止を同一視しない。

### 23.4 Tomorrow.io Quota判定

Provider同時取得最大1件、Tx-Q送信前記録、失敗・Timeout時の消費非取消し、再起動後の履歴復元を維持する。
Tx-Q失敗・履歴不正・確認不能ではFail Closed。
ローリング24時間・60分・1秒ごとに保存履歴から最早解除見込み時刻を求め、複数制限ではその最大値を次回判定に使う。Timer発火時に全条件を再評価する。
Quota不足だけではnextAttemptAt・失敗回数を変えない。
安全上限400回 / 24時間、20回 / 60分、1回 / 1秒は**暫定Backend上限**であり、正式Provider制限ではない。

### 23.5 Pending Publication保持と再公開

Tx-A成功・Tx-P失敗時、Stateごと最大1件をメモリ保持する。永続Pending Queueは追加しない。
保持情報はstateKey、Validation済みDomain Data、dataUpdatedAt、expiresAt、attemptStartedAt、Process内の取得順序識別子を少なくとも含む。
元expiresAtを保持期限とし、Pending保持だけでは公開せず、Tx-P失敗だけで外部APIを即時再取得しない。

| 条件 | 再公開に必要な確認 |
|---|---|
| P-01 | SQLiteがHEALTHY |
| P-02 | PendingのSchema・Semantic Validation成功 |
| P-03 | now < expiresAt |
| P-04 | 既存Published Stateより古い取得結果ではない |
| P-05 | 同一Stateにより新しい取得結果がない |
| P-06 | State固有の採用条件を再確認可能 |

すべてを満たす場合のみ再公開し、Schedule・WeeklyWeather等は復旧時JST日付で再Validationする。

P-04・P-05は既存条件を維持する。publishedAtは既存契約どおりSnapshot生成時刻であり、取得順序の比較に単独使用しない。
dataUpdatedAtは取得Dataの鮮度比較に利用できるが、再起動・同時刻取得を含む厳密な順序比較は未決定である。Process内取得順序識別子だけでは再起動をまたぐ比較を保証できない。
永続取得識別子、Generation採番、比較同値時の扱い、Commit結果不明時の照合方法はSQLite DDL・実装詳細設計で確定する。安全に比較条件を検証できない場合、自動再公開を行わず古いPendingによる上書きを防ぐ。

SQLite復旧 → Published / Control State復元検証 → Pending検証 → Tx-P保存 → Commit後公開 → Tx-C Cache更新 → 通常Scheduler再開の順とする。同一StateのPending処理と新規HTTPは直列化する。

再公開では元dataUpdatedAt・expiresAtを維持し、lastAttemptAtは元試行開始、lastAttemptResultはsuccess、dataSourceはexternalApi、publishedAtは新Snapshot生成時刻とする。
再公開・Pending破棄だけでは失敗回数・nextAttemptAt・Quota消費を変更しない。

### 23.6 Pending障害・破棄

TTL切れ、Validation失敗、新しいSnapshot存在、固有採用条件不成立なら破棄する。
| Tx-P失敗原因 | 対応 |
|---|---|
| DB全体の一時的利用不能（L2） | Pending保持、通常Scheduler保留、SQLite Recoveryへ移行 |
| 一時SQL操作失敗（L1） | 原因分類後、適切な再確認・再試行経路へ移行。外部API即時再取得なし |
| State固有の制約違反・Validation不備 | DB全体を無条件に障害扱いせず、対象Stateを隔離・ログ記録 |
| Commit結果不明 | DBの最新Snapshot・世代を照合し、Commit済みか確認してから再試行を判断 |
| DB全体破損・Schema非互換（L3） | BLOCKED。自動修復・初期化・再公開を行わない |

Tx-P失敗だけでProvider取得失敗回数を加算せず、Tx-AでCommit済みの取得成功記録をRollbackしない。新State公開はTx-P Commit成功後だけとし、旧SnapshotのTTL判定を継続する。PendingはStateごと最大1件とし、DB全体RecoveryとState隔離を分ける。L4の致命障害に安全な自動復旧を仮定しない。
Commit結果不明ならDB Snapshotを照合してから再試行する。Process CrashでメモリPendingが消失したら通常Schedulerで再開する。

### 23.7 Control State復元

正常nextAttemptAtはStartup / Recovery後も尊重する。既存StateのControl State不正・欠損ではmin(acquisitionPeriod, 5分)の保守的待機を採用する。現行5 Stateでは5分となる。
真の新規Stateは通常Schedulerで初回取得を許可する。Quota履歴不正は5分経過だけでは解除せず、保存Backoff・Quota無視の強制取得をしない。

### 23.8 Scheduler異常系テスト観点

SCH-01〜SCH-33の33件をMVPの正式なテスト観点として扱う。33個の独立テスト関数を要求するものではない。今回試験は実施していない。

### A. HTTP取得・Timeout

| ID | テスト条件 | 期待結果 |
|---|---|---|
| SCH-01 | HTTP応答が10秒を超える | Timeoutとして失敗を記録し、Backoffを適用 |
| SCH-02 | HTTP 500が返る | 即時Retryせず、失敗回数を加算 |
| SCH-03 | HTTP 429、Retry-Afterあり | BackoffとRetry-Afterの遅い方まで待機 |
| SCH-04 | HTTP成功、Validation失敗 | 不正データを公開しない |
| SCH-05 | 取得Taskが通常周期を超える | 同一StateのTaskを重複起動しない |
| SCH-06 | HTTP成功後、Tx-Aが失敗 | Tx-Pに進まず、新Stateを公開しない |

### B. SQLite・Transaction

| ID | テスト条件 | 期待結果 |
|---|---|---|
| SCH-07 | Tx-PのCommit失敗 | 旧Published Stateを維持 |
| SCH-08 | Tx-CのCommit失敗 | Commit済みの新Published Stateを維持 |
| SCH-09 | SQLiteが一時的に利用不能 | 通常Schedulerを保留し、5秒間隔の復旧処理へ移行 |
| SCH-10 | SQLiteが復旧 | Snapshot・取得制御情報を検証し、通常Schedulerを再開 |
| SCH-11 | 最新Snapshotが不正、前世代が正常 | 前世代を復元し、期限は延長しない |
| SCH-12 | 一部StateのSnapshotのみ不正 | 他の正常Stateを継続して提供 |
| SCH-13 | DB全体の整合性異常 | 自動初期化・削除せず、BLOCKEDとして隔離 |

### C. Quota Guard

| ID | テスト条件 | 期待結果 |
|---|---|---|
| SCH-14 | 60分Quotaが上限到達 | HTTP送信せず、解除見込み時刻に再判定 |
| SCH-15 | 24時間・60分・1秒の複数制限に到達 | 最も遅い解除見込み時刻を採用 |
| SCH-16 | Quota履歴が不正・確認不能 | Fail Closed。HTTP送信しない |
| SCH-17 | Tx-QのCommit失敗 | HTTP送信しない |
| SCH-18 | HTTP Timeout後に再起動 | 送信前に記録したQuota消費を維持 |
| SCH-19 | Quota不足による取得抑止 | 失敗回数・nextAttemptAtを変更しない |

### D. Scheduler・再起動

| ID | テスト条件 | 期待結果 |
|---|---|---|
| SCH-20 | Timerが予定より遅れて発火 | 現在時刻で条件を再評価 |
| SCH-21 | Task中に再判定要求が発生 | inFlightにより重複実行を防止 |
| SCH-22 | Taskが例外終了 | inFlightを解除し、適切な次回判定または復旧処理へ移行 |
| SCH-23 | 保存済みnextAttemptAtが未来 | Startup直後も取得しない |
| SCH-24 | 既存Acquisition Control Stateが欠損・不正 | 5分の保守的待機を適用 |
| SCH-25 | 明示的ProvisioningとSchema検証を済ませた新規DBで取得制御記録が存在しない | 正常な初回起動として扱い、通常Schedulerで判定。DB欠損を自動新規作成する意味ではない |
| SCH-26 | 再起動時にPublished Stateが期限切れ | DataをMaskし、取得条件を再評価 |
| SCH-27 | Tx-A成功後、Tx-P失敗 | Provider取得成功と公開失敗を区別し、不要な即時再取得を防止 |

### E. 複合障害

| ID | テスト条件 | 期待結果 |
|---|---|---|
| SCH-28 | HTTP TimeoutとSQLite保存失敗が連続 | 保存できていないBackoffを信用せず、安全側に取得を保留 |
| SCH-29 | Quota不足中にBackend再起動 | SQLite履歴からQuota解除見込み時刻を再計算 |
| SCH-30 | SQLite復旧直後に複数Stateが取得対象 | State単位の重複を防ぎ、各取得制限を尊重 |
| SCH-31 | Tx-P失敗後にBackend再起動 | メモリ上の未公開データは失われても、通常Schedulerで再開 |
| SCH-32 | TTL切れと外部API障害が同時発生 | 期限切れDataを公開せず、Metadataを保持 |
| SCH-33 | 1つのStateの取得・Validation失敗 | 他のStateの正常な取得・公開を妨げない |

### Pending Publication関連の追加検証

次の内容を既存テストIDの詳細条件として追加してください。

**SCH-07**
- Tx-P Commit失敗時に旧Snapshotを維持する。
- Commit結果不明時はDB内Snapshotを照合し、二重公開や世代不整合を防ぐ。

**SCH-27**
- Tx-A成功・Tx-P失敗時にPendingを最大1件保持する。
- 外部APIを即時再取得しない。
- SQLite復旧後、有効なPendingをTx-Pで公開できる。
- TTL切れ、Validation不正、JST日付変更、より新しいSnapshot存在時はPendingを破棄する。

**SCH-30**
- SQLite復旧後のPending再公開処理と通常Schedulerが競合しない。
- 同一Stateの新規取得とPending再公開を直列化する。

**SCH-31**
- Process再起動でPendingが消失する。
- 再起動後は保存済みnextAttemptAt・Backoff・Quotaを尊重し、通常Schedulerで再開する。


Vitest Fake Timer、HTTP Mock（Timeout / 429 / 500 / Validation）、SQLite統合Commit / Rollback、固定Quota履歴の境界値、Startup / Recovery再起動相当テスト、Pi実機Process Crash・systemd復旧・72時間試験を予定する。

---

## 24. Issue #4最終反映：採用結果・検証状態・後続引継ぎ

### 24.1 現在の採用状態

本章は2026-10-24の合意を反映した採用状態の総括である。技術選定の正式採用は実装完了・Pi実機検証完了を意味しない。既存の検討理由・過去の検証結果、Domain Data、取得周期・TTL・Backoff・Quota合意値は維持する。

| 状態 | 技術・方式 |
|---|---|
| 正式採用 | Node.js 24 LTS、TypeScript、Fastify、SQLite、better-sqlite3、TypeBox、systemd、標準setTimeout / fetch、npm、ESM、tsc（原則Bundlingなし）、Vitest、Pino + persistent journald |
| 正式採用：Weather | CurrentWeather / HourlyWeather / WeeklyWeatherはOpen-Meteo |
| 条件付き正式採用 | RainForecastのTomorrow.io。プランのTimelines API 1m rainIntensity可用性、無料枠・課金・Rate Limit・継続条件、規約・商用条件、実降雨品質・安定性の確認が必要。不成立なら代替Provider再検討 |
| 第一候補・最終判断待ち | systemd-timesyncd。Pi OS実構成を確認して最終判断 |
| 初期方針・設定案 | Backup原則1日1回・3世代。journald100MiB・7日、Production INFO以上、72時間試験計測60秒 |
| 未検証 | Pi 5 2GBの性能・ARM64互換性・Native Build負荷、実装・障害復旧・長期運用・CI動作 |

Open-Meteoの正式採用後も、将来の商用利用時は利用条件を再確認する。Tomorrow.ioの既存疎通成功は、将来の利用条件・降雨品質を保証しない。
Snapshot2世代保持・世代別Row、State単位Scheduler、Tx-Q / Tx-A / Tx-P / Tx-C、Pending、Recovery、WAL / NORMAL・Backup APIは既存詳細設計に従い、具体DDL・SQL・Migration・Module構成は今回追加決定しない。

### 24.2 Config / Secrets

一般Configはsystemd EnvironmentFile、SecretはGitとRelease Directory外のアクセス制限付き専用ローカルファイルとし、起動時にTypeBoxで検証する。設定変更はBackend再起動で反映する方式を正式採用する。
秘密情報をGitHub・ログへ出さない。具体Path・Permission・更新手順・Rotation・Recoveryは実装設計に残す。
これはMVPの供給・適用方式の選定であり、Desired / Persisted / Actual Configuration、Config Recovery・Ownership・将来Runtime変更を許容する既存境界は維持する。

### 24.3 Time / RTC

systemd-timesyncdは第一候補とし、Pi OS実構成を確認して最終判断する。Pi 5内蔵RTCとRTC Backup Batteryを利用する。
保存・通信はUTC / ISO 8601を基本とし、既存Published StateのUTC RFC3339、Schedule / WeeklyWeatherのJST暦日表現は維持する。画面はAsia/Tokyo、経過時間・Timeout等はMonotonic Clockを利用する。
RTCが適切に動作しているなら、NTP未同期だけを理由にSystem Timeを利用不可としない。利用可能性の判定原則はArchitecture第10章を維持する。
RTC初期化・同期状態・OS設定・実機確認は#6・#13へ引き継ぐ。

### 24.4 開発品質・CI

ESLint / Prettier / tsc / Vitestと、PR作成・更新時のGitHub Actionsを正式採用する。標準Ubuntu RunnerでLint、Format Check、Type Check、Testを実行し、無料枠内運用を基本とする。
Production Buildは開発PC、PiへのDeployは手動。PR検証CIはProduction Build / Deployの自動化とは別である。
Dependency・設定ファイル・npm scripts・Workflow、PASS / FAIL確認、失敗時調査、使用量・予算、SecretをCIへ渡さない構成は後続Issueで整備する。今回ファイルやWorkflowを実装しない。

### 24.5 Logging / Monitoringと初期設定案

Pino、persistent journald、OS標準Monitoringを正式採用する。外部監視基盤はMVPに導入しない。
72時間試験はsystemd timer + 軽量スクリプトで定期計測する方式を正式採用する。容量100MiB・保持7日・Production INFO以上・計測60秒は実機前の初期設定案であり、性能保証・受入閾値ではない。
CPU・メモリ・温度・Disk・Service状態・再起動／障害履歴を計測する。ログ項目・Rate Limit・機密情報対策・CSV Schema・Script・合否判定・回収方法は#12・#13で具体化する。R-06 / R-09の既存受入条件は変更しない。

### 24.6 Backend Deploy / Rollback

開発PCでtsc Compile、原則Bundlingなし、SSH / scp転送、Piでnpm ci --omit=dev、Release Directory / symbolic link切替、systemd再起動を正式採用する。
新Release準備に失敗したら稼働中旧Releaseを維持する。DB・Config・SecretはRelease外へ置く。
RollbackはDB Schema互換性を確認して旧Releaseへ戻し、DB変更を伴う場合はSQLite Backup / Restore方針との整合を確認する。MVP自動Deployは採用しない。
better-sqlite3 ARM64互換性・Native Build負荷・Deploy Script・Health確認・Rollback手順・Release保持数は未実装・実機確認待ち。

### 24.7 後続Issueへの引継ぎ

技術選定フェーズは[Issue #4](https://github.com/rinYamano211/home-digital-signage/issues/4)で完了し、[PR #14](https://github.com/rinYamano211/home-digital-signage/pull/14)はmainへMerge済みである。#15・#16も作成済みであり、後続作業は以下で管理する。技術選定完了は実装・実機検証完了を意味しない。

| 引継ぎ先 | 主な担当範囲 |
|---|---|
| [#5](https://github.com/rinYamano211/home-digital-signage/issues/5) | UI設計・Domain表示・視認性・RainForecast鮮度 |
| [#6](https://github.com/rinYamano211/home-digital-signage/issues/6) | Raspberry Pi環境・OS・ARM64・Native Dependency・RTC・時刻同期 |
| [#7](https://github.com/rinYamano211/home-digital-signage/issues/7) | 基本画面・時計・System Time・JST表示 |
| [#8](https://github.com/rinYamano211/home-digital-signage/issues/8) | コンテンツ切替・異常時の独立性 |
| [#9](https://github.com/rinYamano211/home-digital-signage/issues/9) | Open-Meteo・条件付きTomorrow.io・Weather固有処理 |
| [#10](https://github.com/rinYamano211/home-digital-signage/issues/10) | Google Calendar・Service Account・Schedule固有処理 |
| [#11](https://github.com/rinYamano211/home-digital-signage/issues/11) | 写真スライドショー。Future扱いを維持 |
| [#12](https://github.com/rinYamano211/home-digital-signage/issues/12) | systemd・起動復旧・手動Deploy・Rollback・Logging |
| [#13](https://github.com/rinYamano211/home-digital-signage/issues/13) | MVP結合・実機性能・障害復旧・72時間試験 |
| [#15](https://github.com/rinYamano211/home-digital-signage/issues/15) | ESLint・Prettier・Type Check・Vitest・GitHub Actions |
| [#16](https://github.com/rinYamano211/home-digital-signage/issues/16) | Backend共通基盤・SQLite・Cache・Scheduler・Quota・Transaction・Pending・Recovery・Backup |

#### 責務・依存関係

- #15を開発品質・CI基盤として先行する。Backend未作成でも検証対象を段階的に追加する。
- #6のPi環境確認は、独立する範囲で#15と並行可能。
- #16はBackend共通基盤を1 Issueで管理し、実装PRを段階的に分割する。#15・#6と連携し、#9・#10は#16の共通機構を利用する。
- #5のUI設計を踏まえて#7〜#10を進める。Productionのsystemd・Deploy・Rollback・Loggingは#12、アプリケーション内部Recoveryは#16が担当する。
- 実機結合・障害復旧・性能・72時間試験は#13が担当する。Deploy運用手順の独立Issueは作成せず、#12に統合済みである。

#### 条件付き採用・未検証事項

- Tomorrow.ioのAPIプラン、1分粒度rainIntensity、無料枠・課金・Rate Limit・継続条件・規約／商用条件は#9で利用開始前に確認する。不成立なら代替Providerを再検討する。実降雨品質・安定性は#9・#13で検証する。
- Open-Meteoの将来商用利用条件は#9で再確認する。
- better-sqlite3のARM64 Native Build・動作確認は#6で行う。
- systemd-timesyncdの最終判断、RTC・時刻同期の環境確認は#6で行う。
- Raspberry Pi 5 2GBの性能・長期安定性・72時間試験は#13で検証する。
- DDL・Migration・世代管理・取得結果の順序識別・Pending Publication・Quota Guard・分離Transaction・Recovery等の詳細実装と共通テストは#16で具体化する。SCH-01〜33の共通基盤該当ケースは#16、結合・実機ケースは#13へ引き継ぐ。
- Config / Secretsの安全な供給は#16で具体化する。
- Backupの初期設定案は#16、Logging・Monitoringの初期設定案は#12・#13で検証する。初期設定案を性能保証値や検証済みの値として扱わない。
- 開発品質・CIの設定、Workflow、PASS / FAIL・Secret非供給・使用量確認は#15で具体化・検証する。
- DeployのRelease準備失敗・Health確認・DB互換性を確認したRollback・Backup / Restoreの運用手順は#12で整備し、#13の実機受入前に確認する。
- UIの時間別予報の表現は#5で将来24時間要件と照合する。
- RainForecast固有の表示鮮度10分・TTL30分の例外は#13で既存受入条件と照合する。
