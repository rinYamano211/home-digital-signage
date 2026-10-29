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
| state_generation_counters | State単位の最終Generation（内部管理） |

初期Schemaは上記4 Tableを正式採用する。最初の3 Tableは既存の論理State、4つ目はGeneration用の内部管理である。将来の全永続データを網羅するものではない。Tomorrow.ioのProvider単位Quota履歴はTx-Qに従って別途具体化し、acquisition_controlへ組み込むか専用Tableを追加するかは未決定とする。
Published Stateは**最新1世代＋直前1世代＝合計2世代**と世代別Row方式を正式採用する。DataとMetadataを1 JSONで一体保存し、State単位に管理する。初期DDL・Index・Generationは12.6〜12.8、VersionとMigration方式は12.4に従う。
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

**単一専用LockファイルのLinux flock排他Lock（EX）＋SQLite Transaction**を正式採用する。Backendは起動から終了までEXを保持し、同じLockで多重起動も防ぐ。ProvisioningはDB作成・初期化中、MigrationはBackend起動時のEX保持中に実行する。共有Lock（SH）、EX→SH変換、別のInstance Lockは使用しない。旧共有／排他方式を置き換える決定であり、PoCの履歴は[検証記録](poc/linux-flock-validation.md)に残す。

ShellでファイルをOpen → `flock -x`で有界Timeout付き取得 → execで同じFDをNode.jsへ継承し、Node.jsが稼働中保持する。FD番号や具体Script・Timeout値は実装時に具体化する。Lock取得失敗はDB Open前に起動中止し、LockなしでDEGRADED起動しない。Lock競合・操作失敗はSQLite障害と区別する。Node.js Logger生成前に失敗し得るため、Shell側では失敗種別ごとの定義済み終了コードと機密を含まないstderrを基本とし、systemd等が収集する。Pino初期化前のPino出力を必須としない。

Lockファイルは安全な管理Directoryに配置し、稼働中に削除・置換しない。ファイルの存在だけで保持判定しない。systemd・手動・Provisioningを含む全起動経路で同一Lockを必須とし、迂回する直接起動を許可しない。子・孫への不用意なFD継承を防ぎ、正常終了・SIGTERM・SIGKILL後に別ProcessのFD保持が残らないようにする。FD所有と終了順序はArchitecture 16.8に従う。

OS Lockはadvisoryであり、協調しないProcessのDB操作まで防止しない。DBファイルの排他的作成とは別の保証である。Path・Directory・Permission・Symlink対策、Lock付き起動経路の具体Script、CLI名・配置、Timeout値、Shell側終了コードの具体値・stderr形式は実装前に定義・検証する。既存DB・Secret等のPathやPermissionを今回新たに固定しない。

Provisioningは次の順序とする。

1. 明示的な管理コマンドからBackendと同一LockのEXを取得する。
2. EX取得後にDB存在を再確認し、既存DBがあれば上書きせず拒否する。
3. Node.jsの`fs.open(dbPath, "wx", 0o600)`で排他的に作成し、作成用FDをCloseする。
4. SQLiteでOpenし、初期4 Tableと`user_version=1`を同一Transactionで設定する。
5. 完了後にSchemaを検証し、SQLite ConnectionをCloseしてからLockを解放する。

途中失敗で不完全DBが残っても自動削除・再作成しない。`wx`はDB完成や安全な親Directoryを保証しないため、DB・LockのPathと権限・Symlink対策を整合させる。

### 12.4 Schema VersionとMigration

初期MVP Schema Versionは**1**とし、SQLiteの`PRAGMA user_version`をDB Schema Version管理に採用する。APIやCache EntryのschemaVersionとは区別する。Version 0を無条件に新規DBと判断せず、現在VersionとSchema実態を確認する。通常起動で既存Version 0を自動初期化しない。Table欠損・不正構造を検出し、state_generation_countersのTable欠損はDB全体のBLOCKEDとする。Counter Rowの整合性・State隔離とは区別する。

- 明示的に登録された個別MigrationのAllowlist方式を正式採用する。既知Version間で旧Releaseとの読出し・書込み互換性を検証済みのMigrationのみ、通常Backend起動時の自動適用を許可する。Backend起動時のEX保持中に実行し、適用前後にVersionとSchema実態を検証する。
- DDLとVersion更新は同一Transactionで行う。DDL失敗・Rollback成功時は、DBのVersionとSchema実態を再検証し、失敗原因を分類する。
- Rollback失敗時は、DBの整合性を確認できるまでDB利用機能を停止し、正常扱いにしない。
- Commit結果不明時はVersionとSchema実態の両方を照合し、Migrationが適用済みか未適用かを確認する。Rollback失敗・Commit結果不明時は、根拠なくMigrationを再実行しない。
- Migration定義・SQL自体の不正は自動再試行せず、BLOCKEDとして手動確認を要求する。
- 未知・新しすぎるVersion、Schema不整合はBLOCKEDとする。一時的なSQL障害はRecovery対象として分類する。
- 旧Releaseとの読出し・書込み互換性を確認できないMigrationは自動実行しない。
- 自動Downgrade MigrationはMVPでは実装しない。非互換MigrationはBackup・Deploy・Rollback手順と連携して別途管理する。

自動適用の可否はDDLの種類だけで決めず、個別Migrationの検証結果で判断する。汎用Migration Frameworkは導入しない。現時点では初期Version 1のみを具体化し、架空のv1→v2 Migrationは作成しない。継続的なRecoveryの詳細実装はPR-Eへ引き継ぐ。

### 12.5 Lifecycleの技術的制約と後続工程

ConnectionはBackendStoreが所有し、起動・終了順序と工程ごとの責務は[Architecture 16.8](architecture.md#168-sqlite初期化とbackend-lifecycle)に従う。PR-AのShutdown契約を維持するが、better-sqlite3の同期APIを長時間実行するとEvent LoopやShutdown Timerをブロックし得る点を考慮する。

B-1では初期化時の障害分類までを定義する。継続的なRecovery・再試行・復旧後の再検証はPR-E、Schedulerと終了順序はPR-C、実機設定・受入試験はIssue #12・#13へ引き継ぐ。


### 12.6 初期DDL

以下をB-2で確定した初期Schema設計とする。SQLite上で実装・検証済みという意味ではない。

```sql
CREATE TABLE published_state_snapshots (
    state_key TEXT NOT NULL CHECK (length(state_key) > 0),
    generation INTEGER NOT NULL CHECK (generation > 0),
    snapshot_json TEXT NOT NULL,
    PRIMARY KEY (state_key, generation)
);

CREATE TABLE backend_cache (
    state_key TEXT PRIMARY KEY NOT NULL
        CHECK (length(state_key) > 0),
    cache_json TEXT NOT NULL
);

CREATE TABLE acquisition_control (
    state_key TEXT PRIMARY KEY NOT NULL
        CHECK (length(state_key) > 0),
    control_json TEXT NOT NULL
);

CREATE TABLE state_generation_counters (
    state_key TEXT PRIMARY KEY NOT NULL
        CHECK (length(state_key) > 0),
    last_generation INTEGER NOT NULL
        CHECK (last_generation >= 0)
);
```

state_keyは空文字列禁止、Generationは正の整数、最終採番値は0以上、各JSONはNULL禁止とする。State識別子の許可リストは原則アプリケーション側で検証し、JSON構造はTypeBox Schema ValidationとSemantic Validationで検証する。JSON内のMetadataは第10章の既存契約を維持する。`json_valid()`等の追加SQLite制約は実行環境の互換性確認前に必須化しない。DDLの制約に加え、整数性・範囲を含むアプリケーション側Validationとの整合は実装時に検証する。

### 12.7 Indexと想定Query

MVPは主キーに対応するIndexを基本とし、追加の明示的Indexは原則設けない。State単位の最新・直前Snapshot取得、古い世代削除、Cache・Acquisition Control・最終Generation取得を想定する。

```sql
SELECT generation, snapshot_json
FROM published_state_snapshots
WHERE state_key = ?
ORDER BY generation DESC
LIMIT 2;
```

実装時にSQLite Query PlanでIndexの利用を検証する。

### 12.8 GenerationとCounterの不変条件

GenerationはState単位の正の整数で、新しい公開Snapshotほど大きくする。Stateごとの最終採番値を永続化し、Snapshotが0件でも保持する。新Snapshotの保存Transaction内で採番し、Snapshot追加・Counter更新・保持数超過分の削除を同一Transactionで行う。最新SnapshotはState内のGeneration最大Rowである。

- Snapshotが存在するStateにはCounterが存在する。
- `last_generation >= MAX(generation)`。古いSnapshot削除等によりCounterが最大Generationより大きい場合は許容する。
- Snapshotが存在する特定StateのCounter Row欠損、保存済みGenerationより小さいCounter等の値不整合は、そのStateのみ隔離する。Counterを無条件に再作成・リセットしない。
- SnapshotとCounterの両方が存在しないAllowlist登録済みStateは、初回Tx-P内でAtomicに初期化可能とする。既存StateのCounter欠損を新規Stateと混同しない。
- Counterだけが存在するStateは最終採番値を保持し、Generationの連続性を維持する。
- Generationは1以上、Counterは0以上のJavaScript安全整数とし、上限は`Number.MAX_SAFE_INTEGER`（9,007,199,254,740,991）とする。SQLite INTEGERは`bigint`で読出し・検証し、安全範囲確認後に`number`へ変換する。上限到達・範囲外では安全側で採番を停止し、リセット・循環しない。

Counter整合性異常とSnapshot JSONのState単位Validation失敗を区別する。既存L1〜L4に従い、DB全体の破損・Schema非互換はBLOCKED、State固有JSON不正は対象State隔離とする。Counter Table自体の欠損は12.4のSchema不整合としてDB全体BLOCKEDとする。Counter TableのSchema破損もDB全体BLOCKEDとする。一方、特定StateのCounter Row異常はそのStateのみ隔離し、正常な他Stateへ波及させない。Counter Row整合性チェックはB-3A-1に含めず、B-3BのRepository実装で行う。Counter不整合ではSnapshot Fallbackを行わない。

GenerationはSnapshotの保存・公開順序であり、外部Dataの鮮度や取得結果の新旧を示さない。永続取得識別子・同値時処理・Pending P-04 / P-05の比較は23.5〜23.6に従い、Generation単独では古い結果の上書きを防げない。

### 12.9 B-3A-1の実装範囲と検証条件

B-3A-1はSQLite永続化基盤の実装であり、PR-B全体の完了ではない。

| 区分 | 内容 |
|---|---|
| 対象 | 単一EX・Shell exec FD継承・多重起動防止、Provisioning CLI、BackendStoreの単一Connection、WAL / NORMAL、初期4 Table・Version 1・Schema検証、Migration Allowlist基盤、起動・Shutdown連携、DB障害分類、Unit Test・Linux Process結合テスト |
| 対象外 | Published State API、Generation採番・Snapshot世代管理・Counter Row整合性チェックの実装、Cache TTL / Fallback、Scheduler、Quota Guard、Pending Publication、継続Recovery・Backup、Pi実機運用検証完了 |

第10章のAPI・503契約やSnapshot等の既存設計は維持し、実装対象外という理由で削除・変更しない。PR-CのScheduler、PR-Eの継続Recovery・Backupの責務は維持する。

実装時に以下を検証する。

- 正常ProvisioningとBackend起動、既存DBの上書き拒否、同時Provisioning競合。
- Backend多重起動拒否、稼働中のProvisioning拒否、Lock取得TimeoutとDB操作抑止。
- 正常終了・SIGTERM・SIGKILLでの解放、Lock FDの子孫への意図しない継承防止、Connection・FD・Processの後始末。
- DB欠損時の自動作成禁止、不完全DBの自動削除・再作成禁止。
- Schema Version・DDL構造、Table欠損・Counter Table欠損、WAL / NORMAL、DDL・Version初期化のAtomicity。
- Migration失敗時のRollbackと12.4の安全側処理。

Linux固有Lock結合テストはMockだけで完了判定せず、実Processで行う。PoCの成功は本実装検証の代わりとしない。Raspberry Pi OS・ARM64・systemd・電源断はIssue #12・#13等の実機確認へ引き継ぐ。


### 12.10 B-3B Repository・Transaction・Generation設計

以下はB-3Bの確定設計である。B-3B-1の保存系実装はPR #31でMerge済みだが、B-3B-2のRead・Validation・Fallback・条件付き保存はInterface設計段階であり、実装・テスト完了を意味しない。既存BackendStoreの単一Connectionを利用し、独立Connectionや別Storeを導入しない。Storeの内部ConnectionをRepositoryへ接続する具体Interfaceは実装時に整理する。

#### Repository責務とValidation

Published State RepositoryはSnapshot保存・取得、Generation、Counter整合性、Tx-P、最大2世代保持を担当する。既存5 StateのKey Allowlistを検証し、共通・Domain固有Validatorを利用する。Domain固有ルールのOwnership、外部HTTP・Domain変換・採用判断・Scheduler・TTL判定・表示用API生成はApplication側に維持する。

JSON Parse・Schema・Semantic Validationの失敗を区別してログへ記録し、Snapshot不正のFallback判定に使用する。State固有異常は対象Stateを隔離し、DB全体破損・Schema非互換はBLOCKED、一時SQL・DB利用不能は既存L1 / L2に従う。隔離専用Tableは追加せず、整合性再確認で解除し、時間経過だけでは解除しない。Counterを自動修復・リセットしない。

#### Tx-Pと同一Stateの直列化

公開候補の事前Validation・Domain変換・外部HTTPはTransaction外で行う。State単位の単一Transaction内で、次の順序をAtomicに実行する。

1. Counter・Snapshot整合性を検証する。
2. 次Generationを採番する。
3. state_generation_countersを更新する。
4. published_state_snapshotsへ確定済みSnapshot JSONをINSERTする。
5. 最新＋直前の最大2世代を残して旧SnapshotをDELETEする。
6. Commitする。

途中失敗で部分更新を残さない。backend_cache・acquisition_controlはTx-Pに含めず、Tx-Q / Tx-A / Tx-P / Tx-Cの分離を維持する。新SnapshotはCommit成功確認後だけ公開する。同一StateのTx-Pは直列化し、結果不明の照合が終わるまで後続Tx-Pを開始しない。共有ConnectionのTransaction状態が不明なら通常処理へ戻さず、安全に処理できる正常な別Stateのみ可能な範囲で継続する。Pendingと新規取得の競合制御はPR-C・PR-Dに維持する。

#### 保存・照合結果の契約

結果は以下の3分類を区別する。具体的なType名やInterfaceは実装時に整理し、失敗と結果不明を単一の失敗へ潰さない。

| 結果 | 判定・呼出し側の扱い |
|---|---|
| 成功 | Commit完了または下記照合で保存成功を確認。公開可能な保存結果として返す |
| 失敗確定 | Rollback等と照合によって未保存を確認。既存Snapshotを維持し、再試行可否は既存採用条件・障害分類に従う |
| 結果不明 | 保存されたか未判定。同一Stateの後続Tx-Pを止め、無条件の再試行・公開をしない |

Commit例外だけでRollback確定と判断しない。例外後はSQLite Transaction状態を確認して必要に応じRollbackを試みる。Transaction状態不明のConnectionを通常処理へ戻さない。

照合用にState Key、保存前Counter、候補Generation、保存予定Snapshot JSON、保存前Snapshotの世代構成・内容を保持し、照合時点のCounter・Snapshotと比較する。候補確定後のSnapshot JSONは保持した同じ内容を使用し、照合時に再生成しない。

- 成功判定は、SQLite Transactionが未完了・状態不明ではなく解決済みであり、DB照合結果が一貫していることを前提とする。Counterが候補Generationと一致し、該当Snapshot JSONが保存予定内容と一致することに加え、保存前Snapshotの世代構成・内容を基準に、今回のTx-PによるINSERT・DELETE後に期待される保持・削除結果を照合する。保存後の世代構成が最新＋直前の最大2世代保持と整合し、期待する保存後状態に矛盾がない場合だけ成功とする。Counter・候補Snapshotだけの部分一致では成功確定しない。
- Counter・Snapshot構成・内容が保存前と一致し、未完了Transactionが存在しないことを確認できれば未保存とする。
- 不一致・想定外Generation・DB照合不能は判定不能として保留し、自動再試行・公開しない。

MVPではTx-P専用の永続操作IDを追加しない。Process Crashや外部DB変更をまたぐ操作単位の完全識別は保証しない。照合設計は取得結果の新旧を証明する仕組みではなく、Pending P-04 / P-05の再起動をまたぐ順序識別・同値処理を解決しない。

#### 復元結果とFallback

Repositoryの復元結果は以下を区別する。いずれも表示用API Responseではなく、Applicationが期限・利用可能性を判断するための結果である。

| 結果 | 条件・扱い |
|---|---|
| 最新候補 | Counter整合性と最新SnapshotのParse・Schema・Semantic Validationが正常。期限切れでも、その理由だけでは直前へ戻さない |
| 直前候補 | Counter正常、最新がParse・Schema・Semantic Validationで不正、直前が正常 |
| Snapshotなし | Snapshotが存在しない。12.8に従い新規StateまたはCounterのみを区別 |
| State隔離 | Counter不整合、両世代Snapshot不正等。Counter不整合ではFallbackしない |
| DB全体障害 | Schema非互換・DB破損等はBLOCKED、利用不能等は既存分類に従う。State単位の空データと混同しない |

復元だけではGeneration・publishedAt・dataUpdatedAt・expiresAtを変更しない。不正Snapshotを自動削除・無条件修復しない。最新正常なら最新候補を返し、Applicationが既存APIの期限Mask等を適用する。

Fallback中の新規Tx-Pは、次のすべてを満たす場合だけ許可する。

1. DB全体が利用可能でSchema整合性を確認できる。
2. Counter Rowが正常で最大Snapshot Generation以上である。
3. 最新不正がState固有のJSON・Schema・Semantic Validation異常に限定される。
4. 新候補のSchema・Semantic Validationが成功する。
5. 既存採用条件に基づき新しい取得結果と確認できる。
6. 同一Stateに未解決のCommit結果不明操作がない。
7. Tx-P内でCounter整合性を再検証できる。

新旧比較不能なら自動保存を許可しない。不正な最新Snapshotから取得順序・鮮度比較に必要な情報を信頼できる形で取得できなければ、候補が新しいと推測しない。既存のState固有採用条件に基づいて新旧比較を検証できない場合は、新規Tx-Pの自動実行を保留する。Generation・publishedAtだけを取得順序の証拠としない。これは上記7条件の明確化であり、条件を満たすFallback中の保存を全面禁止するものではない。最大2世代保持により新規Tx-Pが唯一正常だった直前Snapshotを削除し得る。これは保存方針の制約として明記し、後述のテストで確認する。

#### B-3B-2 ValidatorとRead Interface

ValidatorはApplicationが所有し、Read時の引数としてRepositoryへ渡す。以下は概念Interfaceであり、TypeScript実装を追加するものではない。

```ts
type ValidationResult<T> =
  | { valid: true; value: T }
  | { valid: false; reason: string };

interface SnapshotValidator<T> {
  schema(value: unknown): ValidationResult<T>;
  semantic(value: T): ValidationResult<T>;
}

type ValidationStage = "json_parse" | "schema" | "semantic";

type ReadResult<T> =
  | {
      outcome: "latest";
      generation: number;
      snapshot: T;
    }
  | {
      outcome: "previous";
      generation: number;
      snapshot: T;
      latestInvalid: {
        generation: number;
        stage: ValidationStage;
        reason: string;
      };
      evidence: ReadEvidence;
    }
  | { outcome: "empty"; kind: "new" | "counter_only" }
  | { outcome: "isolated"; reason: string }
  | {
      outcome: "database_error";
      reason: string;
      layer: "L1" | "L2" | "L3" | "L4";
    }
  | {
      outcome: "validator_error";
      stage: "schema" | "semantic";
      reason: string;
    };
```

RepositoryはJSON Parse → schema() → semantic()の順で実行し、失敗段階を区別する。Validatorは同期・副作用なし・DB再入なしとし、Domain固有ルールはApplicationが所有する。schema()またはsemantic()の予期しない例外は、該当stage（schema / semantic）とreasonを持つvalidator_errorとして返す。valid: falseによる通常の検証失敗やdatabase_errorとは区別する。Validator例外だけで直前SnapshotへFallback・State隔離せず、ReadEvidenceも発行しない。例外詳細はログで調査可能にするが、機密情報やSnapshot全文を無条件に出力しない。

ReadEvidenceは、最新Snapshotが通常のValidation失敗で不正・直前Snapshotが正常なpreviousのRead時だけ発行する。latest・empty・isolated・database_error・validator_errorでは発行しない。emptyはSnapshotとCounterが両方ないAllowlist登録済みのnewと、Counterのみ存在するcounter_onlyを区別する。Counter不整合ではFallbackしない。正常な最新はTTL切れだけでpreviousにせず、TTL判定・期限Mask・API生成はApplicationに維持する。隔離専用Tableを追加せず、再Read時に整合性を再確認し、時間経過だけで隔離を解除しない。Read・復元でGeneration・Metadataを書き換えず、不正Snapshotを自動削除・修復しない。

#### ReadEvidenceの意味と有効範囲

ReadEvidenceはRead時と条件付き保存時のDB状態一致を確かめる不透明な証跡であり、取得結果の鮮度・新旧を証明しない。

```ts
declare const evidenceBrand: unique symbol;

interface ReadEvidence {
  readonly [evidenceBrand]: true;
}

interface EvidenceRecord {
  connection: Database.Database;
  stateKey: StateKey;
  image: StateImage;
  source: "previous";
  consumed: boolean;
}
```

Repositoryがpreviousの正常Readで発行し、呼出し側の任意生成・改変は拒否する。内部記録に発行元sourceを保持し、previous由来であることを実行時にも検証する。TypeScriptのBrandだけに依存せず、WeakMap等の内部管理で実行時の正当性を検証し、既存Connection共有Coordinationと整合させる。同一Process・同一Connection・同一Stateでのみ有効とする。imageにはCounter Rowの有無・値、Snapshot件数・各Generation・保存済みJSON文字列を対応付ける。

証跡は原則1回使用とし、Tx-P保存試行で消費する。保存成功・Rollback・DB状態不一致・Commit結果不明の後は再利用不可とする。Connection終了・Process再起動後は無効で、永続化しない。時間経過だけを失効条件にせず、DB変更はTx-P内の再照合で拒否する。

#### 一貫したReadと条件付き保存

短いSQLite Read Transaction内でSchema・Counter・Snapshotを取得し、CounterとSnapshotを同一DB状態から観測する。共有Connectionの排他管理を適用し、Transaction終了後に取得済みJSONへValidatorを実行する。ValidatorからのDB再入は禁止する。ReadでDB更新は行わず、Transaction終了状態が不明ならReadEvidenceを発行せず、未解決Connectionを通常処理に戻さない。

```ts
type AdoptionDecision =
  | { outcome: "newer" }
  | { outcome: "not_newer" }
  | { outcome: "unknown" };

interface ConditionalSaveRequest {
  stateKey: StateKey;
  snapshotJson: string;
  evidence: ReadEvidence;
  adoption: AdoptionDecision;
}
```

概念的なRepositoryメソッドは`saveConditionally(request: ConditionalSaveRequest): SaveResult`とし、previous由来の有効な証跡のみを受け付ける。Applicationが候補Validationと既存Domain採用条件による新旧判定を行い、newerだけを保存候補とする。not_newer・unknownは保存しない。Repositoryは新旧判定の正しさ自体を保証しない。

最新不正Snapshotから必要情報を信頼できる形で比較できなければ保存せず、正常な直前より新しいというだけで最新不正Snapshotより新しいと推測しない。Generation・publishedAtだけを根拠にせず、Fallback中は既存7条件をすべて要求する。

条件付きTx-Pは以下の順序とする。

1. Applicationが候補Validation・新旧比較を完了する。
2. Repositoryが証跡の正当性・previous由来・State・Connection・未解決操作を確認する。
3. BEGIN IMMEDIATEを実行する。
4. Schemaを確認する。
5. Counter・Snapshotを再読出しする。
6. 証跡のimageと完全一致することを確認する。
7. 一致時だけGenerationを採番する。
8. Counterを更新する。
9. SnapshotをINSERTする。
10. 最大2世代保持のDELETEを行う。
11. Commitする。
12. 既存SaveResult契約に従って結果を返す。

完全一致はCounter Rowの有無と値、Snapshot件数、各Generation、保存済みJSON文字列を対象とする。不一致なら保存せずnot_savedと専用理由（例：stale_read_evidence）を返し、Applicationへ再Read・再判定を要求する。Commit結果不明時はB-3B-1の保存前後照合・Transaction状態確認を維持し、無条件再試行・公開をしない。

#### 既存save()との互換性と制約

既存`save(stateKey, snapshotJson)`・`reconcile()`の契約とB-3B-1テスト・挙動を維持し、条件付き保存は専用経路として追加する。Fallback中のApplication経路ではprevious由来の証跡でsaveConditionally()を使う。通常の最新Snapshot更新は既存save()とApplication側採用条件に従い、B-3B-2では通常更新全体へ楽観的競合制御を導入しない。将来の拡張は否定しないが、今回の完成条件に含めない。通常save()を直接呼び出してFallback条件を迂回できる可能性は既知のInterface制約であり、Repository単体で完全防止を保証しない。Application統合時に保存呼出しを一元化し、迂回がないことを検証する。

#### B-3B-2 Interfaceのテスト受入条件

以下は未実装のB-3B-2の受入観点であり、検証結果ではない。既存B-3B-1の保存・照合テストを回帰確認に利用し、観点は削除しない。

| ID | テスト観点 |
|---|---|
| I-01 | JSON Parse・Schema・Semanticの順序と失敗分類 |
| I-02 | schema / semanticの予期しない例外はvalidator_error。通常Validation失敗・DB障害と区別し、Fallback・隔離・証跡発行を行わない |
| I-03 | 最新正常・TTL切れでもlatestを返し、ReadEvidenceは発行しない |
| I-04 | 最新が通常Validationで不正・直前正常の場合のみpreviousへFallbackし、ReadEvidenceを発行 |
| I-05 | 両世代不正でState隔離 |
| I-06 | Counter不整合でFallback禁止 |
| I-07 | Read時に一貫したDB状態を取得 |
| I-08 | 偽造証跡・別Stateへの流用・previous以外に由来する証跡を拒否 |
| I-09 | 別Connection・消費済み証跡を拒否 |
| I-10 | Read後のCounter・Snapshot変更を検出 |
| I-11 | 新旧比較不能なら保存禁止 |
| I-12 | previous由来の有効な証跡とFallback保存7条件を満たす場合のみ条件付き保存を許可 |
| I-13 | Commit結果不明の既存照合契約維持 |
| I-14 | 正常な別Stateへの障害非波及 |
| I-15 | 最大2世代保持による直前Snapshot削除 |
| I-16 | 通常save()・reconcile()の既存契約を維持し、通常更新全体を証跡必須へ変更しない |

#### 実装PR分割とテスト受入条件

| 工程 | 設計上の予定範囲 |
|---|---|
| B-3B-1（PR #31で実装済み） | Repository基盤、Counter Validation、Generation採番、Tx-P Atomic保存、2世代保持、Commit結果不明照合、保存系Unit / SQLite統合テスト |
| B-3B-2（Interface設計・未実装） | 最新・直前Read、JSON / Schema / Semantic Validation、State隔離、Fallback候補、Fallback中の条件付き保存、読出し・復元系テスト |

以下はB-3B全体の設計上の受入条件である。B-3B-1の実装・検証記録はIssue #16の完了記録を参照し、B-3B-2のRead・Fallback等は未実装として区別する。B-3B-2の受入観点は未検証であり、B-3B-1の検証成功だけで充足扱いにしない。

- 初回・連続採番、State間独立性、Counterのみ存在する場合、Counter欠損・不整合・安全整数上限超過、初回Tx-P内のAtomic初期化。
- Tx-P途中失敗のRollbackと部分更新防止、成功・未保存・結果不明の照合、Commit成功後の例外通知で重複保存しないこと、DB照合不能時のFail Closed。
- 最新＋直前の最大2世代、最新不正のFallback、正常最新が期限切れでもFallbackしないこと、両世代不正のState隔離。
- Fallback中の条件付き保存、新旧比較不能時の保存禁止、新規保存で唯一正常な直前世代が削除されるケース。
- 他Stateへの障害非波及、DB全体のSchema不整合・利用不能、Process Crash後の永続操作ID不在による識別制約。

SCH-07は保存失敗・結果不明、SCH-11は最新不正時Fallback、SCH-12は正常な別Stateの継続という既存観点の具体化として扱い、別の矛盾する条件を追加しない。Domain固有の新旧比較・Scheduler・Pendingの完成をB-3Bだけで保証しない。Quota Guardの保存構造・具体SQL、Cache・TTL・Fallback、継続Recovery・Backupは後続工程に維持する。



### 12.11 B-3C Backend Cache Repository設計

B-3Cは設計レビュー完了・実装未着手とする。B-3B-1 / B-3B-2はPR #31 / #33で実装済みであり、Published StateのInterface・Generation・最大2世代・条件付き保存を変更しない。CacheEntryはArchitecture 16.5の既存構造、Cache固有schemaVersion: 1、backend_cache Tableを維持し、専用Generation / Revisionを追加しない。外部ProviderのRaw Responseを一律保存せず、Published State単位で保存する。

#### 責務とRead契約

Application / 各Backend ServiceはDomain Schema・Semantic Validation定義、TTL設定、Cache採用・新旧比較・Fallback可否、Published State再生成、Tx-P成功結果とTx-C候補の対応確認を担当する。共通Cache Moduleは共通CacheEntry構造・Version、期限判定、Repository Read結果を用いた利用可否判断、不正と期限切れの区別を担当する。RepositoryはSQLite Read・条件付きSave、JSON Parse・Validator実行、既存5 State Keyの検証、証跡・DB状態確認、Tx-C・照合・障害分類を担当する。Module / Repositoryの独立Class・ファイル分割は今回固定しない。

```ts
type CacheEntry<T> = {
  schemaVersion: 1;
  data: T;
  dataUpdatedAt: string;
  expiresAt: string;
};

type CacheReadResult<T> =
  | {
      outcome: "found";
      entry: CacheEntry<T>;
      evidence: CacheReadEvidence;
    }
  | {
      outcome: "invalid";
      stage: "json_parse" | "schema" | "semantic";
      reason: string;
      evidence: CacheReadEvidence;
    }
  | { outcome: "empty"; evidence: CacheReadEvidence }
  | {
      outcome: "validator_error";
      stage: "schema" | "semantic";
      reason: string;
    }
  | {
      outcome: "database_error";
      layer: "L1" | "L2" | "L3" | "L4";
      reason: string;
    }
  | {
      outcome: "pending";
      reason: "commit_result_unknown";
    };
```

JSON Parse → Cache共通Schema・Domain Schema → Semantic Validation → 共通Cache ModuleでTTL判定、の順とする。Repository Readにexpiredを追加せず、TTL切れだけでinvalidにしない。Validator例外は通常Validation失敗と分離し、validator_error / database_error / pendingでは証跡を発行しない。invalidの証跡はDB Row同一性の確認専用であり、Fallback利用の根拠ではない。不正Cache・期限切れCacheは公開用Fallbackに使わない。

dataUpdatedAt・expiresAtは元の値を保持し、Cache更新・FallbackによってTTLを延長しない。APIの期限Mask・Metadata保持・publishedAt更新条件は既存契約に従う。

#### CacheReadEvidenceの拘束と消費

CacheReadEvidenceは、Applicationが内部状態を参照・偽造できない不透明トークンとする。Repository内部でConnection識別、State Key、Read時のRow存在有無、存在時のcache_jsonの正確な文字列、消費状態、Process内での有効性を管理する。found / invalid / emptyの場合のみ発行し、同一Connection・同一Stateに拘束する。同じConnectionを共有する別のCache Repositoryインスタンスでも安全に照合できるようにし、別Connection・別Stateへの流用、偽造、消費済み証跡を拒否する。Process再起動後は復元しない。

入力の共通検証・採用判断・証跡の事前検証で拒否され、保存試行を開始しない場合は、有効な証跡を消費しない。事前検証通過後、Transaction開始を試みる前に証跡を消費して保存試行を開始する。その後はTransaction開始失敗を含む成功・失敗・結果不明のいずれでも再利用せず、unchangedでも消費する。invalid由来の証跡はRow同一性だけを示し、データの正当性や新旧を保証しない。B-3Bのprevious専用ReadEvidence契約は変更しない。

#### 条件付き保存とunchanged

```ts
type CacheAdoptionDecision =
  | { outcome: "adopt" }
  | { outcome: "reject" }
  | { outcome: "unknown" };

interface CacheConditionalSaveRequest<T> {
  stateKey: StateKey;
  entry: CacheEntry<T>;
  evidence: CacheReadEvidence;
  adoption: CacheAdoptionDecision;
}

type CacheSaveResult =
  | { outcome: "saved"; reconciled: boolean }
  | { outcome: "unchanged" }
  | {
      outcome: "not_saved";
      scope: "input" | "state" | "database";
      reason: string;
      layer?: "L1" | "L2" | "L3" | "L4";
    }
  | {
      outcome: "unknown";
      scope: "state" | "database";
      reason: string;
    };
```

保存候補のDomain Schema・Semantic Validation、Domain固有の取得順序・新旧比較、Cache採用判断、Tx-P成功結果と候補の対応確認はApplicationが担当する。Repositoryは保存時にDomain Validatorや採用判断を重複実装しない。

RepositoryはTransaction開始前にState Key Allowlist、JSONとしての直列化可能性、CacheEntry共通構造、schemaVersion: 1、必須Field、dataUpdatedAt・expiresAtの共通日時形式を検証する。日時は既存のUTC / ISO 8601契約に従うUTC RFC3339形式とし、独自形式を設けない。ApplicationのDomain Validatorが省略しても、Repositoryの共通構造検証は必ず行う。共通検証に合格した保存予定JSONを一度確定し、Tx-CとCommit照合で同じ文字列を再利用して再生成しない。証跡とDB状態の一致はTx-C内でも検証し、Atomicに保存する。

概念Interfaceであり、具体Type名・Reasonは実装時に既存コードと整合させられるが、結果の意味上の分類を統合・削除しない。通常更新の無条件Blind Saveは設けない。

保存には、正常候補、Applicationのadopt判断、有効なCacheReadEvidence、Tx-C内でRead時Rowと現在Rowが一致、同一Stateに未解決Tx-Cなし、共有Connectionの正常な利用可能性をすべて要求する。reject / unknownでは採用しない。証跡の偽造・別State / Connection流用・消費済み再利用を拒否する。証跡はDB状態一致を確認するもので、Domainの鮮度を保証しない。

| ケース | 保存条件 |
|---|---|
| 初回 | Read時・Tx-C時ともRowが存在しない場合のみ |
| 不正Cache置換 | 正常候補で、Applicationが信頼できる情報から置換の安全性を確認できる場合のみ。不正Cacheの元の取得順序が不明なら、正常なPublished Stateがあるだけで新しいと推測しない |
| 通常更新 | Domain固有の採用条件を満たし、Read時のRow有無・保存済みJSONと現在Rowが一致する場合のみ |

dataUpdatedAtだけを普遍的な新旧条件にしない。比較不能はFail Closed、Read後のRow変更は保存拒否とする。Read後確認だけで保存せず、書込み前のTx-C内再確認でTOCTOUを防ぐ。

adopt・有効証跡・Read時と現在Row一致を確認し、保存予定JSONと現在JSONが完全一致するときだけ書込みを省略してunchangedを返す。unchangedは「今回保存した」ではなく「同じ内容が既に保存されている」を意味し、証跡はこの場合も消費する。

#### Tx-C Atomic保存とCommit照合

Cache Rowの保存はTx-CとしてAtomicに行い、Tx-P・Tx-A・Tx-Qと統合しない。保存試行ごとにState Key、保存前Rowの有無・保存前JSON・保存予定JSONをRepository内部に保持する。保存予定JSONは一度確定し、照合時に再生成しない。

Commit例外だけで未保存と判断せず、Transaction状態確認 → 必要時Rollback → 解決済み確認 → 保存前・保存予定・現在状態の照合を行う。成功・未保存の確定には、Transaction解決、保存前後を区別可能、対象Stateへの別書込み排除、DB照合結果の一貫性を要求する。

| 照合結果 | 扱い |
|---|---|
| 一意に保存済みと判定可能 | saved（照合で確定した場合はreconciledを示す） |
| 一意に未保存と判定可能 | not_saved |
| 不一致・照合不能等で判定不能 | unknownを維持し、自動再書込みしない |

unknown時は同一Stateの後続Tx-Cに加え、通常Cache ReadもFail Closedとする。Readはpending（reason: commit_result_unknown）を返し、CacheEntry・ReadEvidenceを返さず、未確定CacheをFallbackに使わない。pendingは内容不正やDB障害そのものではなく、そのStateのTx-C保存結果が未解決であることを示す。Pending Publicationとは別の結果区分である。

Read-only reconcile()は同一Stateの未解決Attemptの保存前後情報を使って照合し、保存を再実行しない。成功または未保存が確定した場合のみ通常Readを再開し、判定不能ならpendingを維持する。Connection正常時は他Stateの通常Read・Tx-Pを不必要に停止しない。Connection自体のTransaction状態が未解決なら、既存方針どおり全Repositoryの通常DB操作を停止する。

Process再起動でAttempt情報が失われても、保存結果を自動的に成功・未保存と断定しない。再起動時の復旧・再評価の具体処理は後続Recovery工程とし、Process Crash・外部DB変更をまたぐ操作単位の完全識別はMVPで保証しない。

Tx-P成功確定後にTx-Cへ進むが、Tx-C失敗でCommit済みPublished StateをRollbackしない。Tx-CはPublished State Generationを変更せず、Tx-P成功結果とTx-C候補の対応確認はApplication / PR-D側が所有する。Cache証跡はPublished Stateの採用条件・鮮度を保証せず、Cache由来のPublished State公開も既存の条件付き保存契約に従う。

#### 共有Connection排他・障害分類・Delete

既存Published State RepositoryのWeakMapを共通内部Coordinationへ抽出する最小変更案を基本とする。共通化対象はConnection単位のbusy・connectionUnresolved・DB全体blockedとし、Tx-P / Tx-Cの未解決Attemptと各ReadEvidenceはRepository固有に管理する。

同じConnectionでTransactionを重複させず、ValidatorからのDB再入を拒否する。BackendStoreが唯一のConnection所有者であることと、Tx-P / Tx-Cの独立性を維持する。State固有異常とDB全体障害は既存L1〜L4・scopeに基づいて区別し、Layer番号だけで影響範囲を決めない。Connection正常時はState単位Tx-C未解決を正常な別Stateへ無条件に波及させず、Connection未解決なら全Repositoryを保護する。

B-3C必須Interfaceにdelete()は含めない。不正Cacheの物理削除は未決定であり、無条件DeleteはRead後の新規更新を削除し得る。将来導入時は証跡を用いた条件付きDeleteを検討するが、今回は確定しない。

#### B-3Cテスト受入条件

以下は設計上の32観点であり、実施結果ではない。Vitest・実SQLite統合・Fault Injection・既存回帰テストを想定するが、32個の独立テスト関数を要求しない。

| ID | 分類 | 条件・期待結果 |
|---|---|---|
| C-01 | Read・Validation | Row未存在 → empty＋証跡 |
| C-02 | Read・Validation | 正常Cache → found＋検証済みEntry＋Connection・State・Read時Row有無／正確なJSONに拘束された証跡 |
| C-03 | Read・Validation | JSON構文不正 → invalid(json_parse) |
| C-04 | Read・Validation | Schema不正・Version不一致 → invalid(schema) |
| C-05 | Read・Validation | Semantic不正 → invalid(semantic) |
| C-06 | Read・Validation | Validator例外 → validator_error、証跡なし |
| C-07 | Read・Validation | DB Read失敗 → database_error、証跡なし |
| C-08 | 条件付き保存・競合 | 初回保存成功。共通構造・Version・必須Field・UTC日時・直列化可能性をTransaction前に必須検証し、Domain Validatorによる省略を許さない |
| C-09 | 条件付き保存・競合 | 初回Read後の他処理によるRow作成を検出 |
| C-10 | 条件付き保存・競合 | 採用条件を満たす不正Cache置換 |
| C-11 | 条件付き保存・競合 | 不正Cacheの新旧比較不能時は保存拒否 |
| C-12 | 条件付き保存・競合 | 新しい候補を条件付き更新 |
| C-13 | 条件付き保存・競合 | 古い候補の保存拒否 |
| C-14 | 条件付き保存・競合 | 新旧比較不能時の保存拒否 |
| C-15 | 条件付き保存・競合 | Read後のCache Row変更を検出 |
| C-16 | 条件付き保存・競合 | 偽造・別Connection・別State・消費済み証跡を拒否。同一Connectionの別Cache Repositoryでは照合可能。入力拒否時は未消費、保存試行開始後は結果を問わず消費 |
| C-17 | Commit・照合 | 通常Commit成功 |
| C-18 | Commit・照合 | 同一JSONはunchanged、証跡を消費 |
| C-19 | Commit・照合 | Tx-C途中失敗でRollback・旧Cache維持 |
| C-20 | Commit・照合 | Commit成功後の例外通知を、共通検証後に確定した保存予定JSONを再生成せず再利用して照合 |
| C-21 | Commit・照合 | Commit未成立を照合 |
| C-22 | Commit・照合 | 判定不能はunknown、通常ReadはpendingとなりEntry・証跡を返さずFallback禁止 |
| C-23 | Commit・照合 | reconcile()はRead-onlyで再書込みなし。成功・未保存確定後のみ通常Read再開、判定不能ならpending維持 |
| C-24 | 共有Connection・障害 | Tx-P中のTx-C重複開始を防止 |
| C-25 | 共有Connection・障害 | Tx-C中のTx-P重複開始を防止 |
| C-26 | 共有Connection・障害 | ValidatorからのDB再入を拒否 |
| C-27 | 共有Connection・障害 | State単位pendingを局所化し、Connection正常時は他Stateの通常Read・Tx-Pを継続 |
| C-28 | 共有Connection・障害 | ConnectionのTransaction未解決時は全Repositoryの通常DB操作を停止・保護 |
| C-29 | 共有Connection・障害 | State固有異常とDB全体障害を区別 |
| C-30 | TTL・回帰 | RepositoryはTTLを判定せず、Cache Moduleで期限判定 |
| C-31 | TTL・回帰 | Tx-C失敗でもPublished State維持 |
| C-32 | TTL・回帰 | 既存B-3Bの全テスト契約を維持 |

#### 実装への引継ぎ

Domain固有の取得順序・新旧比較、再起動をまたぐ同値・順序識別、Scheduler / Acquisition Control、全Txオーケストレーション、Pendingとの対応、CacheからのPublished State再公開、継続Recovery・Backup、不正Cache物理削除、Pi実機検証は後続工程とする。これらをB-3Cの実装完了条件へ拡大しない。


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
| 正式採用：Snapshot世代管理 | 最新1世代＋直前1世代＝合計2世代、世代別Row、State単位Generation Counter（12.1・12.8・Architecture 16.6） |
| 暫定採用：Backend実行・取得制御 | 1 Backend Process内の複数非同期Task、State単位の独立Scheduler、即時Retryなし・有界指数Backoff（Architecture 16.1・16.3） |
| 暫定採用：Transaction | Tx-Q / Tx-A / Tx-P / Tx-Cの分離、複数State生成時の部分成功（Architecture 16.4・第23章） |
| 暫定採用：検証・Recovery | State単位のApplication Data検証・隔離、Control State不正・欠損時の保守的待機、Database利用不能時は正常稼働扱いにしない方針（Architecture 16.6・16.7） |
| 暫定値・初期候補 | State取得周期・有効期限、foreign_keys / busy_timeout初期設定候補 |
| 正式採用：CurrentWeather Provider | Open-Meteo（第19章）。実装・実機検証は未完了 |
| 正式採用：WeeklyWeather | Open-Meteo Daily Forecast。周期6時間・TTL12時間はMVP暫定値（第22章） |
| 正式採用：HourlyWeather | Open-Meteo（第16・20章）。周期・TTLは暫定 |
| 条件付き正式採用：RainForecast | Tomorrow.io Timelines API、rainIntensity、1m。周期5分・TTL30分・表示鮮度10分は暫定（第21章） |
| MVP運用設計方針：Provider取得制御 | Tomorrow.ioのQuota Guard・送信前SQLite永続記録・Provider同時取得最大1件（16.4） |
| MVP正式運用設計値：Quota安全上限 | ローリング24時間400回・60分20回・1秒1回。Provider契約保証とは区別（16.4・23.11） |
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
- Provider正式Rate Limit仕様・Quota GuardのSQLite DDL／具体SQL、1 HTTP Responseと複数Stateの対応、Open-MeteoのRequest共有、Provider単位の詳細Backoff。Tomorrow.ioのMVP運用設計方針と外部仕様の保証境界は第16章・23.11。
- WeeklyWeatherは第22章の設計方針・未検証事項に従う。RainForecastは第21章の設計方針・残課題に従う。HourlyWeatherは第20章、CurrentWeatherは第19章、Scheduleは第18章の設計方針と残課題に従う。取得成功だけで古いデータを延命しない。
- 個別Migration・単一EXの具体ScriptとFD番号・Timeout値・起動経路の迂回防止、Provisioning CLI、DB・Lockの具体Path・Permission・Symlink対策、503時のJSON Error Schema、Quota履歴のTable構成・具体SQL。初期DDL・Index方針・Generationは12.6〜12.8で設計済みだが実装未検証。 PendingのP-04 / P-05用永続取得識別子・同値処理は未決定（23.5）。Tx-P単体のCommit結果不明時照合は12.10で設計済みだが実装未完了であり、Crashをまたぐ完全識別は保証しない。
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

本プロジェクトのTomorrow.io無料プラン利用アカウントのダッシュボードで、ユーザーが以下を確認した。利用アカウントでの確認値であり、一般的な契約保証や将来の継続条件を最終確認したものではない。

| 項目 | ユーザー確認値 |
|---|---|
| API Server Calls / day | 500回 |
| API Server Calls / hour | 25回 |
| API Server Calls / second | 3回 |
| 利用可能Data Layers | Core、Severe Weather Hazards |

RainForecastを5分周期・1 Request / 取得で運用すると、通常取得分は288回/日・12回/時となる。
無料利用を優先するが、無料枠超過時の課金条件、制限のリセット境界、継続的な無料利用条件は未確認である。枠内であれば無条件に継続無料と保証しない。

### 16.4 Quota GuardのMVP運用設計方針

以下を**MVPの正式な運用設計方針**として採用し、既存SQLite Acquisition Control・Scheduler・Backoffへ組み合わせる。実装・受入検証の完了を意味しない。Quota GuardはProvider単位の送信許可であり、State単位の取得制御や取得失敗後のRetry / Backoffとは別の責務である。

- Tomorrow.ioの通常取得周期は5分、Providerへの同時取得は最大1件とする。
- 即時Retryは行わず、Request送信前にQuota Guardを通す。
- 送信予定をSQLiteに永続記録してからHTTP Requestを開始する。
- 通信失敗・Timeoutでも、消費枠を安易に取り消さない。
- Backend再起動後も送信履歴・Backoff・取得制御状態を復元する。
- 日次・時間・秒間の制限をそれぞれ判定する。
- Backend側のローリングウィンドウで保守的に管理し、Providerの固定窓へ厳密に追従する追加機構はMVPに導入しない。
- Quota不足による送信抑止と、実際に送信したHTTP Requestの失敗を区別する。
- HTTP 429は取得失敗とし、BackoffとRetry-Afterの遅い方まで待機する。具体ルールは23.3に従う。

送信前の永続記録は、外部HTTPをDB Transactionの外で行う既存境界を変更しない。Tx-Qによる送信前Commitと解除時刻判定は第23章に従う。具体SQL・DDLは未決定である。

| 対象 | 利用アカウントのダッシュボード確認値 | Backend安全上限（MVP正式運用設計値） |
|---|---|---|
| 24時間 | 500回 | 400回 |
| 60分 | 25回 | 20回 |
| 1秒 | 3回 | 1回 |

Backend上限400 / 20 / 1は、利用アカウントの確認値500 / 25 / 3に対して余裕を持たせた、MVPの正式な運用設計値とする。ローリング24時間・60分・1秒の管理をProvider側の正式な窓定義・リセット仕様と同一視せず、契約適合の実証・保証とも扱わない。未確認事項は23.11の保証境界に残す。

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

本章はIssue #4で合意済みの詳細設計を記録する。Backend技術の正式採用・Tomorrow.io条件付き採用・Quota上限のMVP正式運用設計値と、その他の暫定値を区別し、実装・試験完了とは扱わない。Domain Data第18〜22章は変更しない。

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
安全上限400回 / ローリング24時間、20回 / ローリング60分、1回 / ローリング1秒は**MVP正式運用設計値**であり、正式Provider制限や契約保証とは区別する（16.4・23.11）。

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
Generation採番は12.8で定義するが、保存・公開順序であり取得順序の識別子ではない。Tx-P単体のCommit照合は12.10で定義するが、永続取得識別子・比較同値時の扱い・再起動をまたぐP-04 / P-05の取得順序比較は引き続き未決定である。安全に比較条件を検証できない場合、自動再公開を行わず古いPendingによる上書きを防ぐ。

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
| Commit結果不明 | 同一Stateの後続Tx-Pを停止し、12.10のCounter・Snapshot照合で成功／未保存／判定不能を区別。判定不能では再試行・公開しない |
| DB全体破損・Schema非互換（L3） | BLOCKED。自動修復・初期化・再公開を行わない |

Tx-P失敗だけでProvider取得失敗回数を加算せず、Tx-AでCommit済みの取得成功記録をRollbackしない。新State公開はTx-P Commit成功後だけとし、旧SnapshotのTTL判定を継続する。PendingはStateごと最大1件とし、DB全体RecoveryとState隔離を分ける。L4の致命障害に安全な自動復旧を仮定しない。
Commit結果不明なら12.10の条件でDB照合し、未保存確認等の結果に基づいて再試行を判断する。判定不能では保留する。Process CrashでメモリPendingが消失したら通常Schedulerで再開する。

### 23.7 Control State復元

正常nextAttemptAtはStartup / Recovery後も尊重する。既存StateのControl State不正・欠損ではmin(acquisitionPeriod, 5分)の保守的待機を採用する。現行5 Stateでは5分となる。
真の新規Stateは通常Schedulerで初回取得を許可する。欠損・不正の待機はメモリ上で単調増加時計を用い、待機後に再Readする。欠損継続と不正継続を区別し、不正Rowを5分経過だけで修復・上書きしない。初回Authorization・新規性判定・再起動の詳細は[23.10](#pr-c-c2-acquisition-control)に従う。Quota履歴不正は5分経過だけでは解除せず、保存Backoff・Quota無視の強制取得をしない。

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
| SCH-07 | Tx-PのCommit失敗・結果不明 | 失敗確定なら旧Published Stateを維持。結果不明は12.10で照合し、判定不能では再試行・公開しない |
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
- Tx-Pの失敗確定時は旧Snapshotを維持する。
- Commit結果不明は12.10の照合条件で判定し、Commit成功後に例外が通知されても重複保存・二重公開しない。判定不能ではFail Closedとする。
- SCH-11の不正最新からのFallback、SCH-12のState異常の非波及は12.10の読出し・隔離条件で具体化する。正常最新の期限切れだけではFallbackしない。

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

<a id="pr-c-c1-scheduler"></a>

### 23.9 PR-C / C-1：Scheduler・Acquisition Coordinator設計

C-1の責務分離・論理Interfaceは設計確定とする。実装・受入検証は未実施であり、PR-C全体の実装完了を意味しない。23.2〜23.8の取得周期・Backoff・Quota・Transaction・Recovery契約は維持する。

#### 責務と公開Interface

| 対象 | 責務 |
|---|---|
| State Scheduler | State単位のsetTimeout、Timer予約・取消し・再予約、inFlightによる重複防止、再判定要求の集約、Lifecycle管理、Shutdown時の新規Task禁止・実行中Task終了待機 |
| Acquisition Coordinator | runOnce()による1回の取得判定サイクル、保存済みState・Control State・実際の現在時刻の再評価、取得周期・Backoff・Provider制約・Quotaの確認、必要な取得処理の調整、次回判定時刻または停止方針の返却。Acquisition Control・Quota Guard・後続公開処理へ委譲する |

SchedulerはHTTP結果、Backoff計算、Quota履歴、SQLite Transactionの詳細を解釈しない。runOnce()はHTTPを必ず1回実行するメソッドではなく、送信しない場合を含む取得判定サイクルである。5 Stateの論理的独立性を維持する。

```typescript
type RunOnceResult =
  | {
      kind: "scheduled";
      recheckAt: string;
    }
  | {
      kind: "suspended";
      scope: "state" | "global";
      reason: "database_unavailable" | "storage_unresolved";
    }
  | {
      kind: "blocked";
      scope: "state" | "global";
      reason:
        | "invalid_recheck_at"
        | "integrity_error"
        | "schema_incompatible"
        | "unexpected_error";
    };

interface AcquisitionCoordinator {
  runOnce(stateKey: StateKey): Promise<RunOnceResult>;
}

interface StateScheduler {
  start(): void;
  requestRecheck(stateKey: StateKey): void;
  stop(): Promise<void>;
}
```

StateKeyは既存の型を使う。型名・具体的なエラー表現は実装時に既存コードと整合させられるが、結果の意味論・責務境界は変更しない。

#### 判定結果と障害範囲

| 結果 | 意味 | Schedulerの動作 |
|---|---|---|
| scheduled | 通常Schedulerを継続可能 | recheckAtを予約時に検証し、Timerを予約 |
| suspended / state | State単位の一時保留 | 該当Stateの通常Timerを停止 |
| suspended / global | 共有基盤の一時障害 | 全Stateの通常Timerを停止 |
| blocked / state | State固有の安全性・契約違反 | 該当Stateを停止 |
| blocked / global | 共通基盤の安全性を確認できない | 全Stateを停止 |

scheduledはHTTP成功を意味せず、取得周期未到達、Quota不足、HTTP失敗後のBackoffも含む。suspendedはRecovery等による安全な再開の可能性がある状態、blockedは安全確認なしに自動再開しない状態である。単なるTimer停止と既存Database Healthの分類を同一視せず、障害原因・scope・Transaction状態に従う。

scopeとreasonの組み合わせは任意ではない。共有SQLite Connection利用不能はglobal / database_unavailable、DB全体のSchema非互換はglobal / schema_incompatibleとする。storage_unresolvedは既存照合契約で対象Stateだけの未解決と確認できる場合にstate、ConnectionのTransaction状態も未解決ならglobalとする。integrity_errorはState固有と確認できる場合だけstateとし、DB全体の破損等はglobalで停止する。不正recheckAtは原則state / invalid_recheck_atとして扱う。予期しない例外の影響範囲を特定できない場合はglobal / unexpected_error相当で安全側に保留し、State固有と推測して継続しない。

想定済みHTTP失敗・Quota不足はCoordinatorが分類して返す。SchedulerはrunOnce()のRejectも捕捉し、inFlightを必ず解除する。即時Retryせず、影響範囲不明なら通常Scheduler全体を保留する。Commit結果不明は既存の照合・Fail Closedに従い、安全性が確認できるまで再実行しない。

global停止時はTimer取消しに加え、実行中の別Stateも新たなProvider送信へ進まない共通停止ゲートを必要とする。停止理由別のTx-A可否は[23.10](#pr-c-c2-acquisition-control)で定め、Provider送信開始との競合を防ぐ具体Permit方式・InterfaceはC-3で検討する。Boolean確認だけで競合防止済みとは扱わない。既に送信したHTTPの取消しやQuota消費取消しを意味しない。

#### recheckAt・Timer・時計変更

recheckAtはSchedulerの次回判定時刻であり、永続Control StateのnextAttemptAt（HTTP開始可能な最早時刻）とは別である。UTCを明示したRFC3339形式の実在する日時として厳密に検証し、Timer予約判断時点の実際の現在時刻より未来であることを要求する。不正文字列・過去・現在の時刻は契約違反として予約せず、原則該当Stateのみblocked相当で保留して調査可能なログを残す。Promise解決が遅れて予約時には過去になった場合も拒否する。Schedulerが独自に1秒・5秒を加算して救済したり、無条件に即時Retryしたりしない。

- StateごとのTimerは最大1個とし、inFlightでTask重複を防ぐ。発火時にはCoordinatorが保存状態と実際の現在時刻を再評価し、Timer予定時刻を現在時刻の代用にしない。
- Task終了後にinFlightを解除し、scheduledなら検証した次回判定を予約する。suspended・blockedでは通常Timerを予約しない。
- requestRecheck()は既存Timerの前倒し判定を要求できるが、取得制約を迂回する要求ではない。inFlight中は要求を集約して重複Taskを起動せず、終了後の判定に反映する。suspended・blockedの安全確認やRecovery再開契約を迂回しない。
- 取消し・再予約前の古いCallbackは世代識別子等で無効化する。Timerの安全な待機範囲を超える長時間待機は分割して途中で再評価する。これは取得制約の無視やHTTP送信許可を意味しない。
- 時計が進んでもTimerの即時前倒しは保証しない。発火時に現在時刻で再評価し、取得周期・Backoff・Quotaを維持する。
- 時計が戻りnextAttemptAt未到達なら取得せず、Quota履歴を消去しない。現在時刻に基づき次回判定を予約する。MVPでは時計変更専用の監視機構を追加しない。この方針はSchedulerの時計変更イベント発行・専用再スケジュール機構に適用する。Quota Guardの送信安全性確認用時計監視は23.11の別責務であり、Scheduler全体の再設計とはしない。

#### Shutdown・Lifecycle

既存PR-AのinstallShutdown()とFastify Lifecycleを継続利用し、Scheduler専用SIGTERM / SIGINT Handlerは追加しない。Shutdown開始後は新規Task・新規HTTP送信とTimer再予約を禁止する。開始前から進行中のTaskの正常既存Control Rowに対する通常UPDATEのみ、23.10の全条件を満たせば既存Lifecycle内の終了処理として許可可能である。Shutdown中の初回Authorization発行・再発行と初回INSERTは禁止し、正常既存RowのUPDATE許可条件は[23.10](#pr-c-c2-acquisition-control)に従う。stop()は冪等で、新規Task禁止、Timer取消し、実行中Taskの終了待機を担う。Task終了前に通常のSQLite Closeを行わず、Close所有権はBackendStoreと既存Lifecycleに従う。

既存Shutdown全体の10秒制限を維持し、Scheduler専用に追加の10秒待機枠やTask全体Timeoutを設けない。期限内にTaskが完了しなければ正常終了を断念し、既存の異常終了経路へ移る。HTTP Timeout 10秒は個々のHTTPの制限であり、Shutdown全体制限やTask全体の停止保証とは別である。

better-sqlite3の同期処理はEvent Loopとアプリ内Timerをブロックし得る。既存Shutdown制限はJSが終了要求を処理した時点からであり、同期処理を強制中断する保証ではない。[12.5](#125-lifecycleの技術的制約と後続工程)と[Architecture 16.8](architecture.md#168-sqlite初期化とbackend-lifecycle)を維持し、OS / systemdの停止制御・実機検証はIssue #12・#13へ引き継ぐ。

#### 既存契約と未確定事項

成功時のnextAttemptAt＝取得開始＋周期、失敗時の指数Backoff、Quota抑止時のControl State維持を変更しない。Tomorrow.ioの送信前Tx-Q Commit・Provider同時最大1件・Quota履歴不正時Fail Closedを維持する。Tx-Q → HTTP / Validation → Tx-A → Tx-P → Tx-Cの順序、HTTP Timeout 10秒・Task全体Timeoutなしも変更しない。

| 工程 | 設計状況・未確定／実装対象 |
|---|---|
| C-2 | Acquisition Control Repository・Tx-A・Backoffの設計とレビュー指摘3点の方針は23.10に確定。実装・受入検証は未着手 |
| C-3 | Quota Guardの具体Interface・Tx-Q実装、Provider送信とGlobal停止の競合を防ぐPermit方式。停止理由別Tx-A可否は23.10を参照 |
| PR-D | Tx-P / Tx-Cを含む公開処理の連携、Pending Publication |
| PR-E | 継続DB Recovery、安全確認後のScheduler再開Interface |
| Issue #12 / #13 | systemdの具体停止猶予・OS停止制御・実機検証 |

#### C-1受入条件とSCHとの対応

C1-01〜C1-29は設計上の受入条件であり、実装・テストは未実施。SCH-01〜SCH-33は23.8の既存観点を維持する。以下の対応は同じ契約の具体化・関連範囲を示し、C1とSCHを重複した独立テスト実装義務として数えない。C1のScheduler単体観点と、C-2 / C-3・PR-D / PR-Eの結合観点を区別し、後続機構を今回検証済みとしない。

| ID | 条件・期待結果 | 既存SCHとの対応・補足 |
|---|---|---|
| C1-01 | Startupで通常判定を使用し、保存済みnextAttemptAt・Control Stateを尊重。強制取得しない | SCH-23〜26 |
| C1-02 | 5 Stateを独立に判定し、正常StateのTimerを維持 | SCH-12・33 |
| C1-03 | 予約・再予約・取消しを通じてStateごとの有効Timerは最大1個 | SCH-20・21の具体化 |
| C1-04 | 遅延Timerは予定時刻でなく実際の現在時刻・保存状態を再評価 | SCH-20 |
| C1-05 | Taskが周期を超えてもState単位inFlightで重複起動しない | SCH-05・21 |
| C1-06 | inFlight中のrequestRecheckを集約し、重複Taskなしで終了後の判定に反映 | SCH-21 |
| C1-07 | Task終了時にinFlightを解除し、結果に従って次回予約または停止 | SCH-22 |
| C1-08 | scheduledをHTTP成功と誤認せず、周期・Backoff・Quota待機を維持 | SCH-02・03・14・15・19・23 |
| C1-09 | suspended / stateでは対象Timerのみ停止し、安全確認前に要求で再開しない | SCH-07・12の局所化 |
| C1-10 | SQLite利用不能・Schema非互換では通常Scheduler全体を停止・保留 | SCH-09・13。再開はPR-E |
| C1-11 | Shutdown開始後は新規Task・HTTP送信・Timer再予約を禁止し、予約を取り消す | Lifecycle追加観点。SCH-21・22に関連 |
| C1-12 | stop()は実行中Taskの終了を待ち、新規Taskを起動しない。既存TaskのTx-Aは23.10の停止理由・DB正常・終了待機内の条件で判定 | SCH-05に関連するLifecycle追加観点 |
| C1-13 | stop()を二重に要求しても停止・待機が冪等で不正な再予約を起こさない | Lifecycle追加観点 |
| C1-14 | Task終了待機後に既存所有権でDB Close。通常経路で早期Closeしない | 12.5・Architecture 16.8の追加具体化 |
| C1-15 | Task未終了でShutdown全体10秒を超えたら既存異常終了経路。追加10秒枠なし | 既存Shutdown契約。同期処理制約・実機確認は別 |
| C1-16 | HTTP Timeout 10秒とTask全体Timeoutなしを区別し、長時間Taskも重複しない | SCH-01・05 |
| C1-17 | installShutdown()・Fastify Lifecycleを利用し、専用Signal Handlerを増設しない | Architecture 16.8の追加具体化 |
| C1-18 | suspended / blockedで通常Timerを作らず、Recoveryの安全な再開を迂回しない | SCH-09・10・30。再開InterfaceはPR-E |
| C1-19 | 過去・現在のrecheckAtを拒否し、時刻加算救済・即時Retryなし | SCH-20・22の具体化 |
| C1-20 | 不正な時刻文字列を厳密検証で拒否し、ログを残してTimerを作らない | SCH-22に関連するInterface追加観点 |
| C1-21 | 不正recheckAt等のState固有異常で他Stateの正常取得・Timerを止めない | SCH-12・33 |
| C1-22 | 共有DB障害時は全Stateを保留し、安全確認まで再実行しない | SCH-07・09・13・28 |
| C1-23 | 時計進行後も即時前倒しを仮定せず、発火時に現在時刻と取得制約を再評価 | SCH-20・23、QuotaはSCH-14〜19 |
| C1-24 | 時計巻戻り後もnextAttemptAt・Backoff・Quota履歴を尊重し、消去・強制取得なし | SCH-23・29の時計変更時具体化 |
| C1-25 | runOnce Rejectを捕捉し、inFlightを必ず解除 | SCH-22 |
| C1-26 | 想定外例外で即時Retryせず、範囲不明なら全体保留 | SCH-22・28 |
| C1-27 | 取消し・再予約後の古いTimer Callbackを無効化 | SCH-20・21の具体化 |
| C1-28 | 長時間Timerを安全な範囲で分割し、途中で状態・時刻を再評価 | SCH-03・15・20に関連 |
| C1-29 | global停止後、実行中の別Stateも新たなProvider送信へ進まない | SCH-09・13・16・17。Tx-A可否は23.10、送信PermitはC-3 |

SCH-04・06〜08・11・17・18・24〜32等のValidation・Transaction・復元・Pending・Quotaの詳細は既存正本と後続工程で検証し、Schedulerへ責務を移さない。C1の対応表はSCHの観点を削除・置換せず、C1の受入条件確定をテスト成功とは扱わない。


<a id="pr-c-c2-acquisition-control"></a>

### 23.10 PR-C / C-2：Acquisition Control Repository・Tx-A・Backoff設計

C-2の以下の設計方針は確定、実装・受入検証は未着手とする。Shutdown中の初回INSERT禁止、新規Stateの判断条件、Commit照合の確定条件を含めて本節を正本とする。C-1のScheduler / Coordinator分離、PR-Bの保存・Read Evidence・Commit照合、BackendStoreの単一Connection所有権を変更しない。

#### 保存構造・責務・論理Interface

既存12.6のacquisition_control（state_key主キー、control_json NOT NULL）と12.7のIndex方針を維持する。物理カラム・専用Versionカラム・新規永続Tableを追加せず、JSONの論理構造は次の2項目とする。

```typescript
type AcquisitionControlState = {
  consecutiveFailures: number;
  nextAttemptAt: string;
};

interface AcquisitionControlRepository {
  read(stateKey: StateKey): ControlReadResult;
  saveConditionally(request: ControlSaveRequest): ControlSaveResult;
}

type ControlSaveRequest =
  | {
      mode: "update";
      stateKey: StateKey;
      evidence: ControlReadEvidence;
      nextState: AcquisitionControlState;
    }
  | {
      mode: "initialize";
      stateKey: StateKey;
      evidence: ControlReadEvidence;
      authorization: InitialControlSaveAuthorization;
      nextState: AcquisitionControlState;
    };
```

StateKeyは既存型を使う。上記は論理Interfaceであり、型名・結果の具体表現・照合操作の公開名は実装時に既存コードと整合させる。ControlReadEvidenceとInitialControlSaveAuthorizationは不透明な型であり、Applicationから内部記録を参照・偽造できない。保存・照合結果の意味論を統合・省略しない。

RepositoryはState Key Allowlist、JSON Parse → Schema → Semantic Validation、保存値の整合性を検証する。consecutiveFailuresの非負整数性、nextAttemptAtの有効なUTC日時等を確認し、既存UTC / ISO 8601・RFC3339契約に従う。nextAttemptAtは保存済み取得制約であり、Read時に過去というだけでは不正ではない。C-1の「予約時点より未来」というrecheckAt条件を流用しない。

Coordinator / Applicationが取得試行の識別・直列化、HTTP結果の分類、Backoff計算、新規性・待機完了の判定、初回保存許可管理を担当する。RepositoryはHTTP・Backoff計算を実行せず、HTTP・候補Validation・Backoff計算・保存予定JSONの確定をTransaction外で行う。Tx-A内では保存前Rowの再照合とAtomic保存を担う。

| Read結果の意味 | 返す情報・証跡 |
|---|---|
| 正常Row | 検証済みControl Stateと有効なControlReadEvidence |
| 欠損Row | Row不存在を示すControlReadEvidence。欠損だけでは新規Stateと判定しない |
| 不正Row | 不正の理由。通常保存用Evidence・初回Authorizationを発行しない |
| DB障害 | 既存分類に従う障害。正常・欠損・不正Rowと混同せずEvidenceなし |
| 同一Stateの未解決Tx-A | 通常Read・Evidence発行を保留。保存結果を確定できるまで正常Row等として返さない |

#### ControlReadEvidenceとAtomic保存

Read時のRow存在有無と、存在する場合の保存済みcontrol_jsonの正確な文字列を内部レジストリへ記録する。Evidenceは同一Process・同一Repository・同一Connection世代・同一Stateだけで有効とする。時間経過だけでは失効しないが、対象取得試行の終了、Connection再生成、Process再起動で失効する。初回Authorizationとの対応を含め、取得試行との関係を内部で管理する。別Repositoryへの流用は許可しない。これはCacheの同一Connection上の別インスタンス利用契約とは異なるControl固有の制約であり、PR-Bの契約は変更しない。

候補の事前検証・保存予定JSON確定・Evidenceと必要なAuthorizationの検証を経て、保存試行開始時（BEGINを試みる前）にEvidenceを消費する。初回はAuthorizationもともに消費する。試行開始後はBEGIN失敗・Rollback・成功・unchanged・unknownのいずれでも再利用しない。入力の事前拒否と保存試行開始は区別し、未開始なら消費せず、別途の失効条件は常に適用する。

同一Stateの取得・保存を直列化する。Tx-AはBEGIN IMMEDIATEで開始し、保存前Rowを再ReadしてEvidenceのRow有無・正確なJSONと一致した場合だけINSERTまたはUPDATEする。既存の共有Connection排他と未解決Transaction保護に従い、Repositoryが新Connectionを所有・Closeする設計にしない。

MVPは単一Writerと管理されたDBアクセスを前提とする。Row一致だけでは外部Processの直接変更や、同じJSONへ戻るABAを完全検出できない。専用Revision・操作ID・永続Tableを追加して解決済みとせず、EvidenceをDomainの鮮度や外部取得順序の証明として扱わない。

#### 初回保存Authorization

InitialControlSaveAuthorizationはApplication層の初回保存許可管理責務が発行する。独立Processや新規永続Tableは追加しない。初回保存にはRow不存在の有効Evidenceと、同一State・同一取得試行に紐づく有効Authorizationの両方を要求する。HTTP送信の許可とは別であり、Authorizationを根拠にHTTPを送信しない。

HTTP結果確定後、Tx-A直前に以下すべてを満たす場合に発行する。

- State KeyがAllowlistに存在し、下記の永続情報・State構成の確認によって真の新規Stateと判断できる、または新規性不明を含む既存State相当の保守的待機完了を確認できる。
- HTTP結果が取得制御上の成功・失敗に分類済みで、保存予定Control Stateが正常。
- 保存直前の再ReadでRow不存在を確認し、そのEvidenceを使用する。
- DB・Connectionが正常、同一Stateに未解決Tx-Aがなく、停止ゲートが当該Tx-Aを禁止していない。
- Shutdownが開始していない。開始後は新規発行・再発行しない。

AuthorizationはEvidence、State、Connection世代、取得試行へ拘束し、Evidenceとともに保存試行時に消費する。試行終了、Global停止による新規Tx-A禁止、Shutdown開始、Connection変更、Process再起動で失効する。Shutdown開始時点の既発行Authorizationも失効させ、その後の新規発行・再発行を禁止するため、Shutdown中の初回INSERTは実行しない。偽造・別試行や別Stateへの流用・消費済み再利用を拒否する。

initializeはINSERTのみで、既存RowをUPSERTで上書きしない。保存直前Read後にRowが出現した場合もTx-A内照合・INSERT競合で保存拒否とする。updateは既存の正常RowとEvidence一致を必要とし、欠損Rowを自動作成したり不正Rowを上書きしたりしない。

#### 既存Stateの欠損・不正と保守的待機

新規性の判定はApplication / Coordinatorが既存の永続情報とState構成を確認して行い、RepositoryはRowの存在・不存在・不正と保存を担当する。Control Row不存在だけで真の新規Stateと判定せず、少なくとも以下すべてを確認して初回取得と判断できる場合だけ新規Stateとして扱う。

- State KeyがAllowlistに存在する。
- 対象StateのControl Rowが存在しない。
- Published State / Snapshot / Generation Counter等の既存永続情報に、過去の取得・保存を示す記録がない。
- 初期化・Migration・Recoveryの途中ではない。
- DB・Schema・Connectionが正常である。
- 新規性判断に必要な情報が欠落・不正・読取不能ではない。正常に確認したRow不存在と、判定材料を確認できないことを区別する。

これらのRowがないことだけでは、過去のデータ消失がないと厳密には証明できない。既存情報から新規性を確実に判断できない場合は即時取得を許可せず、既存StateのControl Row欠損と同じ保守的待機へ進む。専用Table・VersionカラムやSnapshot / CounterのSchema変更で証明を補わない。DB・Connectionの安全性が確認できない場合は、待機だけで停止条件を解除せず、既存Global停止・Fail Closedを優先する。

既存Stateの欠損・不正、およびControl Row欠損で新規性を確定できない場合はmin(acquisitionPeriod, 5分)の保守的待機をメモリ管理する。現行5 Stateでは5分であり、待機中はHTTP送信・Control Rowの自動修復を行わない。待機時間は単調増加時計で測り、Process再起動後は保存状態を再Readして、必要なら待機を最初から開始する。待機完了はRowの正常性やQuotaの成立を保証しない。

待機終了後は再Readする。正常Rowなら保存済み取得制約を尊重し、欠損継続なら他の取得条件と初回Authorization発行条件を満たした後の初回保存経路へ進める。これは新規性の証明ではなく、既存State相当の保守的待機を経た経路である。不正継続なら対象Stateだけを保留し、自動削除・上書き・通常保存用Evidence発行・初回Authorization発行をしない。不正Rowの修復はPR-Eへ引き継ぐ。Quota履歴の不正・未確認は5分経過で解除しない。

#### Tx-Aの保存・Commit照合

1. HTTP結果・Validationを確定する。
2. 成功・失敗に応じてControl Stateを計算する。
3. 候補を検証し、保存予定JSONを一度確定する。
4. Evidence・必要なAuthorizationと失効・停止条件を検証する。
5. 保存試行を開始し、トークンを消費してBEGIN IMMEDIATEを試みる。
6. 保存前Rowを再Readし、Evidenceと再照合する。
7. initializeならINSERT、updateならUPDATEする。
8. Commitする。
9. 保存結果を分類する。

| 保存結果 | 意味・制約 |
|---|---|
| saved | Commit成功を直接確認できる、またはTransaction解決済み・対象Stateへの競合書込み排除・保存前後の区別可能性と一貫した照合により、今回の保存の反映を一意に確定できる |
| unchanged | 既存Rowと保存予定値が同一で、Evidence・保存条件を確認し、安全に書込み省略できる。証跡は消費する |
| not_saved | 保存前の拒否、今回の未Commit TransactionのRollback成功等により、今回の保存が反映されていないと確定できる。外部HTTP失敗と区別する |
| unknown | Transaction未解決、照合不能、競合書込み排除不能、保存前後の区別不能など、今回の保存結果を一意に確定できない。再保存・後続公開へ進まない |

初回INSERTの未実行をunchangedとしない。Commit例外だけで失敗確定とはせず、Transaction状態確認 → 必要なRollback試行 → 解決確認 → 保存前Row・確定済み保存予定JSON・保存後RowのRead-only照合を行う。Transaction未解決のConnectionで新しいTransactionを開始しない。保存予定JSONを照合のために再生成せず、無条件の再INSERT・再UPDATEもしない。Rollback操作が返っただけで未保存とせず、今回の保存が反映されていないと確定できることを要求する。

保存後RowのJSONと予定値が一致しても、同じJSONへの別書込みやABAがあり得るため、今回のTx-AがCommitされた証明にはならない。Transaction解決済み・対象Stateへの競合書込み排除・保存前後の区別可能性・照合結果の一貫性を満たして一意に判定できる場合だけ、照合によるsaved / not_savedを確定する。外部Writerや再起動をまたぐ操作識別には限界があり、今回の結果を一意に示せない場合はunknownを維持する。

unknownでは同一Stateの後続Tx-A、通常Read・Evidence発行を保留し、Tx-Pへ進まない。無条件再保存・HTTP即時再送を行わず、保持したAttemptの保存前後情報でRead-only照合する。結果確定後の再評価も保存済みControl Stateを尊重し、新たな保存には有効な証跡・必要な許可を要求する。Transaction状態未解決なら共有Connection全体を保護する。正常Connection上のState単位保留を正常な他Stateへ無条件に波及させない。既存L1〜L4と原因・scopeに従い、Layer番号だけで全体障害へ昇格させない。

PR-BのTx-P / Tx-C・Read Evidence・照合成功条件は変更しない。Tx-Aの照合は保存再実行を伴わず、再起動や外部Writerをまたぐ完全な操作識別を保証しない。Tx-A成功後の公開連携・PendingはPR-D、継続RecoveryはPR-Eが担当する。

#### nextAttemptAt・Backoff

23.3の計算契約を維持する。成功時はHTTP取得開始＋周期、失敗時は失敗処理完了＋指数Backoff（1、2、4、8、16、30分、以後30分上限）、Jitterなし。HTTP 429は通常Backoffと有効Retry-Afterの遅い方とし、30分超でも尊重する。不正・欠損Retry-Afterは通常Backoffに従う。

Quotaによる送信抑止ではControl Stateを更新しない。Tx-A成功後にTx-Pが失敗しても取得成功記録を維持し、Provider失敗として加算しない。Tx-A保存失敗を理由にHTTPを即時再送しない。Coordinatorが判定・計算し、SchedulerはrecheckAtによる次回判定予約だけを担う。

#### Global停止ゲート・Shutdown

| 停止理由・状況 | 新規取得・Provider送信 | Tx-Aの扱い |
|---|---|---|
| Shutdown開始 | 新規取得試行・HTTP送信は禁止 | Authorizationは既発行分も失効し、新規発行・再発行・初回INSERTは禁止。正常な既存Control Rowの通常UPDATEだけ、下記の全条件成立時に終了処理として許可可能 |
| DB利用不能・Transaction未解決・Schema非互換・共有DB整合性不明 | Global停止後の新規送信禁止 | 新規Tx-A禁止。未解決Transactionは既存の安全側処理に従う |
| State固有の不正Control Row | 対象Stateを保留、正常な他Stateは継続可能 | 対象Stateの保存禁止・自動修復なし |

停止ゲートは停止理由を区別してTx-A実行可否を制御する。Shutdown中の通常UPDATEは以下すべてを満たす場合に限り許可可能とする。

- Shutdown前から開始済みの取得試行である。
- DB・Connection・Transaction状態が正常である。
- 有効なRead Evidenceが存在する。
- Global停止理由にDB安全性の問題がない。
- PR-Aの既存Shutdown終了待機時間内である。
- 保存が既存Lifecycleの終了処理として実行される。

Shutdownで新規取得を禁止することと、開始済みTaskの正常既存RowへのUPDATEを許可可能なことを混同しない。C-1のstop()・Task終了待機・DB Close順序・Shutdown全体10秒の内側で扱い、追加猶予やTask全体Timeoutを設けない。中止した初回INSERTの未保存HTTP結果を理由に即時再送せず、再起動後はState分類・必要な5分待機・Quota等の取得条件を再評価する。

Global停止確定後は新たなProvider送信を開始しない。送信開始との競合を防ぐ具体Permit方式・InterfaceはC-3へ残し、単純なBoolean確認で競合防止が完成したとはしない。Tx-Q Commit後に送信を中止しても、Quota履歴を取り消さない。PR-Bの共有Connection CoordinationはDB利用保護であり、それだけでProvider送信Permitが実装済みとは扱わない。

#### C-2受入条件と既存観点の対応

以下は設計上の受入条件であり、実装・テストは未実施。既存SCH・C1の具体化・結合観点を含み、ID数を独立テスト関数の数や重複実装義務として扱わない。PR-Bの既存回帰も維持する。

| ID | 条件・期待結果 | 関連する既存観点 |
|---|---|---|
| C2-01 | 正常RowをParse・Schema・Semantic検証し、過去の正常nextAttemptAtをrecheckAt違反と誤認しない | SCH-23、C1-01・19 |
| C2-02 | Allowlist・Control不存在・Published State / Snapshot / Counter等に過去記録なし・初期化等の途中でない・DB正常・判断情報の正常性をApplicationが確認。Row不存在だけで新規性を証明したとせず、確定できなければ欠損相当の待機 | SCH-24・25、C1-01 |
| C2-03 | 偽造Evidenceを拒否しDBを変更しない | PR-B証跡観点のControl固有具体化 |
| C2-04 | 別Process・Repository・Connection世代・StateへのEvidence流用を拒否 | PR-B証跡観点。Controlは同一Repository限定 |
| C2-05 | Evidenceは時間経過だけで失効しないが、試行終了・Connection変更・再起動で失効 | SCH-23・29、取得試行との結合 |
| C2-06 | 保存試行開始時にEvidenceを消費し、BEGIN失敗・Rollback・unknown・unchanged後も再利用不可 | PR-B使い捨て観点 |
| C2-07 | 初回AuthorizationはHTTP分類後・Tx-A直前、確認できた新規性または保守的待機完了を含む全発行条件が成立し、Shutdown未開始の場合だけ発行 | SCH-24・25、初回許可追加観点 |
| C2-08 | Authorizationの偽造・別State／試行／Evidence流用、消費済み再利用を拒否 | 初回許可追加観点 |
| C2-09 | 試行終了・Tx-A禁止Global停止・Shutdown開始・Connection変更・再起動でAuthorization失効。Shutdown中の新規発行・再発行・初回INSERTは禁止 | C1-11〜15・22。Shutdownの初回保存禁止を確認 |
| C2-10 | 初回保存は不存在Evidenceと対応Authorizationの両方必須。保存試行時に同時消費 | SCH-25 |
| C2-11 | 既存State欠損・不正と新規性不明の欠損で、単調増加時計による保守的待機。待機中送信・修復なし、再起動で必要なら待機再開始 | SCH-24、C1-01・24 |
| C2-12 | 待機後に再Read。正常Rowは保存制約尊重、欠損継続は他の取得条件とAuthorization条件成立時のみ初回保存経路、不正継続はState保留 | SCH-24・25 |
| C2-13 | 不正Row継続はState単位保留、Evidence・Authorizationなし、正常な他Stateは継続 | SCH-12・33、C1-21 |
| C2-14 | 初回INSERT前に他Row作成を検出・拒否し、UPSERTで上書きしない | Atomic保存競合観点 |
| C2-15 | updateでRead後のRow不一致・消失を検出し保存拒否 | Atomic保存競合観点 |
| C2-16 | BEGIN IMMEDIATE内のTx-A Atomicity・失敗時Rollback・旧値維持。HTTP・計算はTransaction外 | SCH-06・28 |
| C2-17 | 同一既存値の安全な書込み省略のみunchanged、初回INSERT未実行は該当しない | PR-B unchangedとの役割比較 |
| C2-18 | Commit直接成功、またはTransaction解決・競合排除・保存前後区別と一貫したRead-only照合で今回の反映を一意に確認した場合のみsaved。Rollback等で非反映確定時はnot_saved | SCH-06・28、Commit照合追加観点 |
| C2-19 | 予定JSONを再生成せず保存前／予定／保存後を使用。同じJSONへの別書込み・ABA・外部Writer・再起動の限界があり、JSON一致だけでは成功確定せず、一意に判定不能ならunknown | Commit照合追加観点 |
| C2-20 | unknown Stateの後続Tx-A・通常Read・Evidence発行・Tx-Pを保留し、Read-only照合のみ。無条件の再INSERT・再UPDATEなし | SCH-06・28、C1-09 |
| C2-21 | Transaction未解決Connectionで新Transactionを開始せず共有DB全体を保留。正常ConnectionのState固有保留は局所化 | SCH-09・13・33、C1-21・22 |
| C2-22 | 成功時の周期計算、失敗Backoff・上限・Jitterなし・429 Retry-Afterを維持 | SCH-01〜03・23、C1-08 |
| C2-23 | Quota抑止でControl更新なし、履歴不正は5分で解除せず、Tx-Q後送信中止でも履歴維持 | SCH-16〜19・29 |
| C2-24 | Tx-A失敗・unknownでTx-Pへ進まず即時HTTP再送なし。Tx-P失敗で取得成功・Backoffを改変しない | SCH-06・27・28 |
| C2-25 | Shutdown中は新規HTTP・初回Authorization発行／再発行・初回INSERT禁止。開始済み試行の正常既存Row UPDATEのみ、DB・Connection・Transaction正常、有効Evidence、DB安全性の停止なし、既存終了待機内・Lifecycle終了処理の全条件で許可可能。DB Close順序維持 | C1-11〜15・29 |
| C2-26 | Global停止後に新規Provider送信なし。停止理由別Tx-A禁止とPermit競合対策を区別 | C1-22・29、SCH-09・13・17。具体PermitはC-3 |

#### レビュー指摘の解消・後続工程

- Shutdown中の初回Authorization発行・再発行と初回INSERTは禁止として確定した。開始済みTaskの通常UPDATEだけを上記全条件のもとで許可可能とし、初回保存の要確認事項は解消した。
- 新規性はApplication / Coordinatorが既存永続情報・State構成から判断し、確定できない場合は欠損相当の保守的待機へ進む方針で確定した。既存Row不存在だけで過去データ非消失を厳密に証明できない限界を残し、専用Table・VersionカラムやSnapshot / Counter Schemaは追加・変更しない。
- C-3：Quota Guard・Tx-Qの具体Interfaceと、Provider送信開始に対する停止ゲートのPermit・競合対策。C-2で定めた停止理由別Tx-A可否を接続する。
- PR-D：Tx-A確定後のTx-P / Tx-C連携、Pending・採用候補対応。PR-E：不正Control Row修復、継続Recovery、再起動時再評価、安全なScheduler再開。
- 単一Writer前提、外部Writer・ABA・再起動をまたぐ完全操作識別の限界を維持する。具体SQL・トークン管理・照合の実装検証は未実施であり、既存DDL・Schema Versionを変更しない。


<a id="pr-c-c3-quota-send-gate"></a>

### 23.11 PR-C / C-3：Quota履歴・Tx-Q・Provider Send Gate・Startup / Recovery

本節はC-3/01〜C-3/04の設計検討結果の記録であり、実装・テスト・Migration完了を意味しない。送信前の永続消費、送信権限の失効、Trust不明時のFail Closedを設計方針とし、Schemaは設計案、時計関連の数値は実機前の暫定設定案として区別する。F-01は管理者確認による初回Provisioning、U-12はMVPのQuota運用方針として設計判断を確定した。F-02は固定安全余裕と送信直前の経過時間チェックを設計方針として確定し、実装・実機検証は未完了とする。F-03は未解決とし、外部仕様の未確認事項は保証境界に残す。時計監視の責務・RTCとの境界・U-08の終端競合規則は下記の補足に従う。C-1 / C-2の既存契約を変更しない。

#### 採用状態・運用前提

| 区分 | 内容 |
|---|---|
| 設計方針 | Provider MetadataとQuota履歴の分離、送信前Tx-Q Commit、Process内Permit、停止理由の独立管理、Clock Trust / History Trust、安全確認前の送信禁止 |
| Schema設計案 | 下記2 Tableと検索Index候補。既存4 Table・user_version=1へ適用済みとはしない |
| MVP正式運用設計値 | Tomorrow.ioは400回 / ローリング24時間、20回 / ローリング60分、1回 / ローリング1秒。利用アカウントの確認値500 / 25 / 3に余裕を持たせたBackend上限であり、正式契約値ではない |
| 実機前の暫定設定案 | 時計観測・同期確認の鮮度・安定観測、F-02の最大許容遅延1秒・各窓余裕2秒・超過後Provider待機5秒。実測保証・数学的安全保証ではない |
| 運用前提 | 単一Backend Process・管理されたWriterとAPIキー利用・管理Provisioning / Restore。外部消費や過去履歴を確認できなければFail Closed |
| 設計判断確定 | F-01：管理者確認による初回Provisioning。F-02：固定安全余裕と送信直前の経過時間チェック。U-12：ローリング窓と400 / 20 / 1によるMVP運用方針。実装・実機検証・外部仕様の保証とは区別する |
| 未確定・未検証 | F-03は未解決。F-02の実装・数値妥当性と実機検証、時計関連の具体実装、外部仕様の未確認事項は後続へ維持する |

<a id="pr-c-c3-01-history"></a>

#### C-3/01：Quota履歴・Metadata

Tomorrow.ioのQuota消費履歴をSQLiteへ永続保存し、Provider Metadataとは分離する。Providerごとに連続したSequenceを管理し、Tx-QのTimestampをUTC epoch millisecondsで保存する。MVPでは履歴を自動削除・自動圧縮せず、Quota窓の外へ出た履歴も自動GCしない。

次は検討済みのSchema案である。既存12.6の初期DDLを置換・拡張する実装指示ではなく、具体Migration・Schema Version移行・適用時の検証は別途必要となる。

```sql
CREATE TABLE provider_quota_metadata (
    provider_key TEXT PRIMARY KEY,
    history_status TEXT NOT NULL
        CHECK(history_status IN ('ACTIVE', 'SUSPENDED')),
    initialized_at_ms INTEGER NOT NULL,
    last_sequence INTEGER NOT NULL DEFAULT 0
        CHECK(last_sequence >= 0)
);

CREATE TABLE provider_quota_consumptions (
    provider_key TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence > 0),
    reserved_at_ms INTEGER NOT NULL,
    PRIMARY KEY (provider_key, sequence),
    FOREIGN KEY (provider_key)
        REFERENCES provider_quota_metadata(provider_key)
);
```

provider_keyとreserved_at_msを使う検索Index（両項目の複合Index等）は検討対象とし、具体DDL・Query Planを採用済みとしない。履歴の連続性、Metadataのlast_sequenceとの整合、Timestamp、Providerとの対応を検証する。Metadata欠損・履歴不正・時刻信頼性不明では送信しない。history_statusがACTIVEであることだけを安全性の証明にしない。

新規DBの空履歴はAPIキー未使用の証明ではない。APIキー変更には管理Provisioningが必要で、旧履歴を無条件に削除・初期化したり、新キーだから使用枠が確実に空いていると推測したりしない。F-01では以下の管理者確認による初回Provisioning方式を正式採用する。初期安全性が未確認ならFail Closedを維持する。APIキーやSecretそのものを文書・ログに記録しない。

F-01の前提として、本プロジェクトではTomorrow.io無料プランのアカウントとAPIキーを新規作成し、プロジェクト初期のWindows PowerShell検証で数回使用した後は使用していない（ユーザー確認）。16.2の認証・1分／5分間隔の将来予報・precipitationIntensity取得実績は維持する。

初回Provisioningでは取得済みのAPIキーを継続使用し、以下を成立条件とする。

1. 管理者が過去のAPI使用状況を確認する。
2. 信頼できる時刻と必要な安全余裕を踏まえ、過去の使用がQuota判定期間の外にあることを確認する。具体的な安全余裕の値は今回確定しない。
3. 同じAPIキーを使用する他のSenderが存在しないことを運用上の前提とする。
4. 上記を満たす場合に限り、明示的な管理Provisioningで空のQuota消費履歴から開始する。
5. 通常起動・再起動では既存履歴を初期化せず、初期化後の送信は既存Tx-Q・Quota Guard・Send Gateで管理する。

初回の管理者確認と通常運用時のHistory Trustは別である。空履歴・history_status=ACTIVEだけを安全性の証明にせず、Clock Trust / History Trustの独立評価、履歴欠損・不整合・DB障害・Commit unknown時の安全側停止、Tx-Q Commit成功前の送信禁止を維持する。管理外Restore・巻戻しを通常起動で自動修復せず、未記録の外部Sender消費の自動把握も保証しない。初回Provisioningだけのために証拠Table・専用Service・複雑な過去履歴復元機構を追加しない。

<a id="pr-c-c3-02-tx-q"></a>

#### C-3/02：Tx-Q

HTTP送信前にQuota消費をSQLiteへCommitする。共有BackendStore ConnectionとBEGIN IMMEDIATEを使い、Provider単位のSequence採番・履歴追加・Metadata更新をAtomicに実行する。既存Tx-A・Tx-P・Tx-Cへ統合せず、HTTP・ValidationはTransaction外とする。reserved_at_msの取得と、Commit処理を含む送信前遅延の計測起点は[F-02](#pr-c-c3-f02-delay-margin)に従う。

| 結果 | 意味・送信可否 |
|---|---|
| saved | 当該Tx-QのCommit成功が確定。これだけで送信せず、C-3/03の最終Gate判定が必要 |
| not_saved | 未保存が確定。HTTP送信禁止 |
| unknown | 今回の保存結果を一意に確定できない。HTTP送信禁止、推測でsavedへ変換しない |
| quota_blocked | 安全上限等により送信抑止。Provider取得失敗とは区別し、C-2のControl Stateを更新しない |

Commit例外時はTransaction状態を確認し、必要なRollbackを試み、解決済みか確認する。未解決Connectionで別Transactionを開始しない。保存前Metadata / 履歴、確定した予定Sequence・Timestamp・保存予定内容、保存後Metadata / 履歴の証拠を使い、Read-onlyで照合する。予定内容を照合のために再生成しない。Transaction解決・競合書込み排除・保存前後の区別を含め、当該Tx-Qへの一意な帰属を確認できる場合だけ結果を確定し、単なるRow一致・Sequence一致を成功証明にしない。照合不能はunknownのままFail Closedとし、無条件再書込み・再送信をしない。

HTTP失敗・Timeout・Abort・Gateでの送信中止など、実際に送信しなかった場合もCommit済みQuota履歴を取り消さない。Process再起動後は旧Attemptを再送しない。保存済み履歴を復元して通常判定を行い、旧Sequenceを送信権限として再利用しない。単一Writer・操作識別・外部変更に関する既存の照合限界を維持する。

<a id="pr-c-c3-03-send-gate"></a>

#### C-3/03：Provider Send Gate・Permit

Providerの同時HTTP取得は最大1件とする。Tx-Q Commit成功後、HTTP開始直前にSend Gateで最終判定し、Process内のPermitを発行して即時消費する。永続Permit Tableは追加しない。

最終判定からfetch()呼出しまでの同期区間にawaitを挟まない。attemptId、quotaSequence、connectionGeneration、sendEpoch、使用状態を検証し、Commit成功確定・停止条件・Trust・同時取得制限に加え、[F-02](#pr-c-c3-f02-delay-margin)の経過時間チェックを満たす送信権限だけを使う。Permitの偽造・別Attempt / Sequence / Connection世代・失効済み権限・再利用を拒否する。具体的な型名・内部実装を本記録で追加確定しない。

Global停止理由とProvider停止理由を独立管理し、一方の解除で他方の停止を解除しない。停止・Recoveryで旧送信権限を失効させ、解除後も旧Attempt・旧Permitを復活させない。Connection世代変更後は旧予約・旧検証結果を使い回さない。

| 競合の確定順序 | 扱い |
|---|---|
| 停止確定 → fetch開始判定 | 新規fetch禁止。Tx-Q消費履歴は保持 |
| fetch開始確定 → 停止 | 既開始Requestとして扱い、必要に応じAbortを要求する。消費履歴は保持 |

保証するのはApplicationによるfetch()呼出し開始の順序であり、物理的なネットワーク送信時刻ではない。単純なBoolean確認をawaitの前後で行うだけで、停止競合対策が完成したとはしない。PR-Bの共有Connection CoordinationはDB利用の保護であり、Provider送信Permitを代替しない。

Abort要求とRequestの実際の終了は別である。Abortを要求しただけでRequestが終了したと扱わず、Provider最大1件の制約を維持する。終了・結果分類とTx-Aの関係はC-3/04に従う。

<a id="pr-c-c3-04-lifecycle"></a>

#### C-3/04：Startup・Recovery・管理停止・Restore

**Startup**

Send Gateを閉じて開始する。DB・Schema・Transaction安全性、Provider Metadata・Quota履歴を検証し、管理停止状態を復元する。Clock Trust・History Trustを確認し、StateのAcquisition Controlを復元する。いずれかが未確認なら送信しない。強制HTTP取得はせず、C-1 / C-2の通常Scheduler・nextAttemptAt・Backoff・新規性判定・保守的待機を尊重する。

**DB Recovery**

23.1の前回確認完了から5秒間隔・Single-flight Recoveryを維持する。DB復旧後はProvider Metadata・履歴・Trust・管理停止を再検証する。Connection世代が変われば旧予約・旧検証結果・旧Permitは再利用しない。共有DB異常はGlobal保護、Provider固有の履歴異常はProvider保護と区別し、DB Recoveryだけで管理停止を解除しない。既存Pending処理と通常Scheduler再開順序は23.5〜23.6、継続Recoveryの実装責務はPR-Eに維持する。

**管理停止・Resume**

停止要求を受信した時点でProvider Gateを同期的に閉じ、既開始HTTPにAbortを要求する。SUSPENDEDのCommit成功を確認して初めて停止操作完了とする。Commit unknownではGateを閉じたまま保存前・予定・保存後とTransaction状態を照合し、未確定のまま停止成功とは報告しない。

Commit未確認の停止要求について、Process Crash後の永続停止は保証しない。再起動は閉じたGateから検証するが、未Commitの停止意図が復元できたとはしない。

Resumeは明示的な管理操作であり、ACTIVEのCommit成功を確認する。停止Commit unknownが未解決のままResumeで上書き・送信再開せず、安全側の照合を優先する。停止理由とTrustが解決していなければACTIVEだけでGateを開かない。Resume成功は即時HTTP取得を意味せず、通常Schedulerで全取得条件を再評価し、新たなAttemptで判定する。旧送信権限を復活させない。

**管理Restore**

通常DB RecoveryとRestoreを分離する。Restore中はBackendの自動再起動・新規送信を運用上禁止し、SQLite DB本体・WAL等の整合性を維持して復元する。Restore後はQuota履歴の完全性を再検証し、巻戻しを否定できなければ自動Resumeしない。管理外Restore・巻戻しの完全検出はMVP保証対象外とする。自動Restore機能は追加しない。

<a id="pr-c-c3-clock-history-trust"></a>

#### Clock Trust・History Trustと暫定設定

Quota GuardはProvider送信の安全性を確認するため、Date.now()とprocess.hrtime.bigint()の経過差分、観測欠落、OS時刻情報の信頼性・同期確認の鮮度を評価する。時計異常時はProviderの新規Tx-Q・HTTP送信を抑止し、その異常だけでC-2のnextAttemptAt・consecutiveFailuresを更新しない。新しい監視Serviceを追加する決定ではない。

表示用時刻の利用可否は[Architecture 10.2](architecture.md#102-時刻同期rtcと利用可否)に従う。OS / RTCの利用可能な時刻は時計・日付表示に使え、現在ネットワーク同期できないことだけを理由に表示用時刻を無効化しない。一方、Provider送信用Clock TrustにはQuota窓を安全に判定するための追加確認が必要で、RTC時刻が表示に使えるだけでは送信を許可しない。RTCだけで送信許可できる具体条件やOS同期確認の実装方法は今回確定しない。

Clock TrustとHistory Trustを独立して評価する。壁時計が正常と見えることと、過去のQuota履歴が完全であることを区別し、History Trustは次の3要素をすべて評価する。いずれかを確認できなければFail Closedとする。

| 要素 | 確認する内容 |
|---|---|
| 内部整合性 | Provider Metadata、Sequence連続性、last_sequenceと履歴の対応等 |
| Timestamp信頼性 | 履歴生成時の時刻をQuota判定に安全に使えるか |
| 履歴完全性 | Restore巻戻し・未記録消費等による履歴欠落を否定できるか |

時計異常の影響が不明な履歴を自動修復・自動削除しない。時計が回復してもHistory Trustが回復したとは限らず、安全性を証明できなければ送信禁止を維持する。

| 項目 | 実機検証前の暫定設定案 |
|---|---|
| 時計観測周期 | 5秒 |
| 時刻差分の異常閾値 | 1秒 |
| 観測欠落の再検証閾値 | 15秒 |
| OS同期確認の鮮度上限 | 15秒 |
| 時計回復後の安定観測 | 60秒 |
| Quota窓の安全余裕 | 各窓2秒 |
| Tx-Qからfetch開始までの最大許容遅延 | 1秒 |
| 遅延超過後のProvider再評価待機 | 5秒 |

これらは数学的な安全保証・実測保証値ではない。安定観測60秒や各窓2秒の余裕だけで、時刻異常履歴や初期Quota使用状況が安全だと判断しない。F-02の方式は設計採用済みだが、1秒・2秒・5秒の安全性・妥当性は未検証である。時計異常の差分閾値1秒を絶対時刻誤差の上限と同一視しない。2秒が時刻誤差・計測誤差・送信開始遅延の合計に十分かも未実証で、詳細は[F-02](#pr-c-c3-f02-delay-margin)を実機検証する。OS同期確認の具体実装は今回固定しない。

**C-1との責務境界（R-01）**：C-1はSchedulerの再スケジュールを目的とする時計変更監視を追加しない方針を維持する。C-3はQuota Guardの送信安全性専用の監視であり、時計変更イベントの発行やScheduler専用再スケジュール機構を追加しない。表示用時刻のRTC利用可否（R-02）とも別判定とし、既存C-1・C-2受入条件は変更しない。


<a id="pr-c-c3-f02-delay-margin"></a>

#### F-02：固定安全余裕・送信直前の経過時間チェック

固定Quota安全余裕とfetch()開始直前の経過時間チェックを組み合わせる方式を設計として採用する。Tx-Qの永続消費後、Send Gateで停止条件・Permit・Trust・経過時間を最終確認し、許容遅延超過ならfetch()を開始しない。**設計方針確定・実装および実機検証未完了**であり、暫定1秒・2秒・5秒の妥当性を確認済みとはしない。

**Timestampと計測範囲**

reserved_at_msはDate.now()で取得するUTC epoch millisecondsとする。直前にprocess.hrtime.bigint()で経過時間の起点を取得し、壁時計と単調増加時計を近接して読む。Timestamp取得処理・Tx-Qの書込み／Commit・その間の待機を計測から除外しない。単調増加時計の情報はProcess内のAttemptへ保持し、SQLiteへ保存しない。具体型・変数名・関数構造は今回固定しない。Clock Trust / History Trustの既存条件を維持し、再起動後に旧Attempt・旧Permitを再利用しない。

**最終判定と境界**

Tx-Q Commit成功が確定した後、HTTP開始直前に以下すべてを確認する。

- Attempt、Quota Sequence、Connection Generation、Send Epoch、Permitが有効。
- 管理停止・Global停止・Provider停止が成立していない。
- Clock Trust・History Trustが成立し、Provider同時取得制限を満たす。
- Timestamp取得直前の起点からの経過時間が有効で、最大許容遅延以内。

暫定上限1秒について、最終判定時の経過時間が0以上1秒以下ならこの遅延条件を満たし、**1秒ちょうどを含む**。1秒超なら送信禁止とする。計測情報の欠損・不正・負の経過時間等も送信禁止とし、正常な遅延チェックを通過したと推測しない。遅延条件を満たしても他の条件を省略しない。

最終判定からfetch()呼出しまでawaitを挟まず、同期区間を最小化する。ただし、その同期処理時間はゼロではない。境界値で判定を通過したことだけで、fetch呼出し開始までの実時間が1秒以内と保証しない。最終チェック後の同期区間を含む測定と安全余裕の評価を実機検証へ残す。制御対象はApplicationのfetch()呼出し開始までであり、物理ネットワーク送信・Provider受信・Quota計上時刻を保証しない。

**Quota窓への安全余裕**

既存MVP運用上限400回 / ローリング24時間、20回 / ローリング60分、1回 / ローリング1秒を維持し、各窓へ暫定2秒を加えて履歴を保守的に算入する。窓幅をW、安全余裕をMとすると、過去のTx-Q履歴を少なくともW＋M経過まで消費に含め、境界ちょうども保持する。元の窓境界で早期除外しない。1秒窓にも同じ余裕を適用するため保守的な判定となる。複数窓の制限時は、余裕込みの各解除見込みのうち最も遅い時刻を用い、その時点でも再判定する。

Commit済み・HTTP未送信の履歴も消費として維持する。時刻異常や履歴のTrust不明時に、壁時計の進行等を根拠として履歴を誤って除外しない。U-12のBackend運用値400 / 20 / 1と、利用アカウントのダッシュボード確認値500 / 25 / 3を混同しない。Providerの実Quota窓・計上タイミングや契約適合まで保証しない。

**遅延超過とProvider単位の再評価待機**

遅延超過のみの場合、fetch()を開始せず、Tx-QでCommit済みのQuota消費履歴を保持する。当該Attemptを終了してPermitを失効させ、同じAttempt・Permit・Quota Sequenceを送信権限として再利用しない。HTTP未開始なので取得失敗とは扱わず、consecutiveFailures・nextAttemptAt・C-2 Backoffを変更しない。Tx-A・Tx-Pへ結果を流さず、Pending Publicationも作成しない。

超過判定後、Provider単位で新規Tx-Q予約を暫定5秒間抑止する。待機期限はProcess内の単調増加時計で管理し、SQLiteには永続化しない。同じTomorrow.ioを使う別Stateの取得予定が到来しても迂回できない。待機終了後はQuota・Trust・管理停止・Control State・通常Scheduler条件を再評価し、待機終了をHTTP送信許可としない。C-1のrecheckAtを過去時刻で予約したり、取得制約を迂回して即時再送したりしない。

管理停止・Shutdown・DB Recoveryは待機より優先する。停止・Recoveryを理由に待機期限を無条件に延長せず、期限が過ぎても上位の停止条件を解除しない。この5秒は再予約ループ抑制の運用制御であり、通常のProvider通信失敗やQuota不足へ無条件に適用しない。Quota安全性そのものの保証条件でもない。

Process再起動後は5秒待機期限を復元しない。Process内の一時抑止が消失することはMVPで許容し、単調増加時計の値をProcess間で再利用しない。一方、Quota履歴は永続保存されているため、StartupでDB・Quota・Trust・管理停止・Control Stateを検証する。再起動を理由に履歴初期化・Trust確認省略・旧送信権限の復活を行わない。

| 状態 | 扱い |
|---|---|
| 遅延超過のみ | HTTP中止・履歴保持・Attempt終了・Permit失効、Provider単位5秒待機 |
| Tx-Q not_saved / unknown | HTTP禁止。既存の照合・Fail Closed。遅延超過だけの経路へ置換しない |
| Quota不足 | Quota Guardで抑止し、Control Stateを更新しない |
| Clock Trust喪失 | Provider送信禁止、時計安全性を再確認 |
| History Trust喪失 | Fail Closed。待機経過だけで解除しない |
| DB異常 | 既存DB保護・Recovery |
| 管理停止 | Gate閉鎖、既存Resume条件を維持 |
| HTTP Timeout・429・通信失敗 | 既存C-2失敗・Backoff処理。遅延超過とは別分類 |

**検証計画と合否の区別**

将来のRaspberry Pi実機検証では、通常動作、SQLite書込み負荷、CPU負荷・Event Loop遅延、時計の前方／後方変更・同期状態変化について、Timestamp取得直前からfetch開始直前までと、最終判定からfetch呼出しまでの同期区間を測る。遅延超過時のFail Closed、Provider全体の5秒待機、再起動・管理停止との競合も確認する。最大値・p95・p99・超過回数等を記録する計画とし、統計的に遅延が小さいだけで安全性を証明したとはしない。実機試験は未実施である。

| 評価 | 意味 |
|---|---|
| 制御ロジックPASS | 遅延超過・Trust異常・Quota境界・停止競合で送信禁止条件が成立 |
| 制御ロジックFAIL | 許容超過でも送信、履歴の早期除外、失効Permit再利用等がある |
| 安全余裕の妥当性未確認 | 時計誤差・Provider計上時刻等の情報不足により、2秒の十分性を証明できない |

制御ロジックの評価と数値の妥当性確認を分ける。Clock Trustの差分異常閾値1秒は絶対時刻誤差の上限1秒ではなく、2秒が時刻誤差・計測誤差・送信開始遅延の合計に十分かは未実証である。上記PASS / FAILは判定基準であり、今回の実施結果ではない。

<a id="pr-c-c3-http-tx-a"></a>

#### HTTP・Abort・Tx-A連携

**U-08の終端競合規則（R-03）**：Request LifecycleはHTTP成功・通常失敗・Timeout・制御Abortを区別し、成立が確認された最初の終端結果で一度だけ確定する。後続イベントでは確定結果を変更せず、二重Tx-A・二重Backoff更新を禁止する。abort()呼出しはAbort要求であり、Request終了確定ではない。Timeout通知・Abort要求・HTTP完了の発生と、Lifecycleの終端結果確定を区別する。

| 先に成立・確定した終端結果 | 後続イベントと処理 |
|---|---|
| HTTP成功 | 後続Abortで制御Abortへ変更しない |
| 通常失敗 | 後続イベントで終端結果を変更せず、既存の失敗処理と保存条件を確認 |
| 制御Abortによる終了 | 通常Provider失敗としてBackoffを更新しない |
| Timeoutによる終了 | 既存C-2のTimeout失敗処理を適用する。保存確定はTx-A Commit条件に従う |

競合順序はJavaScript Applicationが観測・確定した順序であり、物理ネットワーク上の発生順序の保証ではない。Node.jsのAbortSignal / fetchの実装詳細から、分類が必ず特定順序になるとは断定しない。終端結果が確定してもTx-Aは自動許可されず、保存直前に停止理由・DB安全性・Evidence・Authorizationを再確認する。管理停止中のHTTP結果の保存条件はF-03として未確定のまま維持する。

- 管理停止・Shutdown・DB保護による制御Abortは通常のProvider失敗とは区別する。制御AbortではconsecutiveFailures・nextAttemptAtを変更しない。
- Timeout・HTTP 429・通信失敗は既存C-2のBackoff / Retry-Afterに従う。計算したBackoffはTx-A Commit成功後にのみ保存済みの制御として確定する。
- HTTP取得全体（必要なResponse Body読込みを含む）に10秒Timeoutを適用する。Task全体Timeoutは追加せず、AbortはProvider処理やQuota消費の取消しを保証しない。
- HTTP結果確定後もTx-Aの保存許可を確認する。これはC-2のEvidence・初回Authorization・停止理由別保存条件の確認であり、通常UPDATEに新しいAuthorization型を追加する決定ではない。Shutdown中の初回Authorization発行・再発行・INSERT禁止、開始済み試行の正常既存Row UPDATEの全条件を変更しない。
- 管理停止中に確定したHTTP結果を保存できるかの最終詳細はF-03として未確定に残し、通常成功・失敗の結果を無条件にTx-Aへ流さない。制御AbortによるControl非更新方針とは区別する。
- DB障害中にTx-A未実施となったHTTP結果は原則破棄し、Pending Publicationとして保持しない。Tx-A成功後・Tx-P失敗時だけ、23.5〜23.6の既存Pending契約を使う。

C-2のRead Evidence・Authorization使い捨て・BEGIN IMMEDIATE内のRow再照合・Tx-A unknownのFail Closedは維持する。C-3でTx-P / Tx-Cや公開用Metadataを変更しない。

#### Tomorrow.io外部仕様の確認範囲

U-12はMVPで採用するQuota運用方針の設計判断として完了とする。16.3の500 / day・25 / hour・3 / secondは利用アカウントのダッシュボードでユーザーが確認した値である。400 / ローリング24時間、20 / ローリング60分、1 / ローリング1秒をMVPの正式なBackend運用設計値とし、Provider固定窓へ厳密に追従する追加機構は導入しない。これはTomorrow.ioの一般的な契約保証や窓境界の正式仕様と同一ではない。

[Tomorrow.io公式 Rate Limiting & Tokens](https://docs.tomorrow.io/reference/rate-limiting)を2026-10-28に確認した。公開ページにはプランに応じた時間・日単位の制限、超過時のHTTP 429、Rate Limit残数HeaderのEnterprise向け提供という一般説明がある。これは当該プロジェクトのプラン・キーでHeaderを取得できるという検証結果ではない。利用アカウントのダッシュボード確認値と公開仕様の一般説明を区別する。Providerの秒単位の厳密な窓定義、個別アカウントへの追加制限の有無、無料枠超過時の課金条件、継続的な無料利用条件・将来の契約変更、当該アカウントでのRate Limit Header提供可否は未確認の保証境界として残す。未記録の外部Senderによる消費も把握・保証しない。今回、実APIへのアクセスやQuota実測は行っていない。

<a id="pr-c-c3-open-items"></a>

#### 未確定事項・保証境界

| ID | 項目 | 状態・確認先 |
|---|---|---|
| F-01 | 初期ProvisioningのQuota安全性確認 | 設計判断確定。C-3/01の管理者確認方式を採用。個々のProvisioningでは成立条件の確認が必要で、未確認ならFail Closed。空履歴・ACTIVEだけでは成立しない |
| F-02 | Tx-Qからfetch開始までの遅延・Quota安全余裕 | 設計方針確定・実装および実機検証未完了。固定余裕と直前経過時間チェックを採用。最大許容1秒・各窓2秒・Provider待機5秒は暫定設定で保証値ではない |
| F-03 | 管理停止中に確定したHTTP結果のTx-A保存条件 | 最終詳細は未確定。C-2・制御Abort・Request終了の区別を維持 |
| U-12 | MVPのQuota運用方針 | 設計判断確定。アカウント確認値500 / 25 / 3とBackendローリング上限400 / 20 / 1を区別して採用。外部仕様の未確認事項は上記保証境界として維持 |

R-01〜R-03により、C-1 / C-3の時計監視の適用範囲、表示用RTCとProvider送信用Trustの境界、U-08の一度だけの終端競合規則を明文化した。これらの補足とは別に、今回F-01・U-12の設計判断を確定した。F-02は方式のみ設計確定で実装・実機検証は未完了、F-03は未解決とし、外部仕様の保証境界も残す。RTCだけで送信許可できる具体条件・OS同期確認の実装方法は新たに確定しない。Provider固有停止はSend Gate内部の区分として記録し、C-1のRunOnceResultへ新しいscopeを追加しない。Schedulerとの具体接続は既存Interfaceの意味論に沿って実装前に確認する。

以下はMVP保証対象外とする。

- 管理外DB Restore・巻戻しの完全検出。
- 未記録の外部SenderによるQuota消費の自動把握。
- 複数Backend Process間の分散送信制御。
- 複数APIキーの自動切替。
- Quota履歴の自動GC・圧縮。
- 自動Restore機能。

既存コードのSchema検証は4 Table・user_version=1を前提にしており、本節のSchema案をそのまま追加すれば互換性は成立しない。将来のSchema / Migration・Provisioning設計が必要だが、今回は実装・Version変更・検証条件の緩和を行わない。F-01の方式確定を、管理者確認なしで空履歴を安全と扱う許可にしない。継続DB Recovery・Backup / Restoreの実装責務はPR-E、公開・Pending連携はPR-D、OS運用・実機確認は既存Issue #12・#13へ維持する。

<a id="pr-c-c3-acceptance"></a>

#### C-3追加受入条件

以下は未実施の設計受入条件である。SCH-01〜SCH-33、C1-01〜C1-29、C2-01〜C2-26を維持し、対応する既存観点の具体化・結合検証として再利用できる。独立テスト関数の重複実装義務や、C-3実装・実機試験成功を意味しない。未確定事項は未確定のまま送信しないことを確認し、未定義の成功経路を推測でテスト仕様化しない。

| ID | 条件・期待結果 | 既存観点・追跡先 |
|---|---|---|
| QH-01 | Metadata欠損・不正、Provider対応不明で送信禁止 | SCH-16 |
| QH-02 | Provider別Sequenceの欠落・重複・last_sequence不整合を検出しFail Closed | SCH-16 |
| QH-03 | Timestamp信頼性・履歴完全性不明は、内部整合性が正常でも送信禁止 | SCH-16、CLK |
| QH-04 | MVPで履歴を自動削除・圧縮しない。未送信・失敗分の消費も維持 | SCH-18 |
| QH-05 | 各ローリング1秒・60分・24時間に余裕を適用し、余裕込み境界ちょうども保持、前後で早期除外なし。複数窓の最遅解除・未送信消費保持・時刻異常時の誤除外禁止 | F-02、SCH-14〜19 |
| TQ-01 | BEGIN IMMEDIATE・共有Connectionで採番・履歴追加・Metadata更新がAtomic。途中失敗で部分保存しない | SCH-17、C2-16 |
| TQ-02 | not_saved / unknownではHTTP送信なし、quota_blockedでBackoff更新なし | SCH-17・19 |
| TQ-03 | Commit例外後はTransaction解決・保存前／予定／保存後の一意な帰属を照合。照合不能はunknownを維持 | SCH-17、C2-18〜21 |
| TQ-04 | Commit成功後も最終Gateを通し、送信中止・Timeout・Abortで履歴取消しなし | SCH-18、C2-23 |
| SG-01 | Provider同時取得最大1件。Abort要求だけでRequest終了とみなさない | SCH-05、Request Lifecycle |
| SG-02 | 最終判定・Permit即時消費からfetch呼出しまでawaitなし | C1-29、C2-26 |
| SG-03 | attemptId・quotaSequence・connectionGeneration・sendEpoch・使用状態の不一致／再利用を拒否 | C1-29 |
| SG-04 | Tx-Q Commit成功後、fetch前に管理停止すると新規fetchなし、履歴は保持 | C1-29、TQ-04 |
| SG-05 | fetch開始が停止より先なら既開始Requestとして扱う。保証は呼出し順序で物理送信時刻ではない | C1-29 |
| SG-06 | Global / Provider停止を独立管理し、一方の解除で他方や旧送信権限を復活させない | C1-22・29 |
| SG-07 | 計測起点はTimestamp取得直前、Commit中の待機も含む。最終判定で1秒以下（ちょうど含む）は他条件成立時のみ許容、1秒超・計測欠損／不正は送信禁止。判定後同期区間をゼロとしない | F-02、SG-02〜04 |
| SG-08 | 遅延超過でHTTP中止・消費保持・Attempt終了・Permit失効。Provider全体で5秒新規Tx-Q禁止、別Stateで迂回不可。Control / Backoff変更・Tx-A / Tx-P移行・Pending生成なし | F-02、C2-23・24 |
| SG-09 | 待機終了後もQuota・Trust・管理停止・Control・Schedulerを再評価。停止・Shutdown・Recoveryを優先し、待機期限を無条件延長せず、通常通信失敗やQuota不足へ待機を無条件適用しない | F-02、C1-29・SG-06 |
| CLK-01 | Quota Guardが壁時計・単調増加時計の経過差、観測欠落、OS時刻情報の信頼性を評価。異常時はProviderの新規Tx-Q・HTTP送信を抑止し、C-2 Control Stateは更新しない | C1-23・24、R-01・R-02 |
| CLK-02 | OS / RTCが表示に利用可能ならネットワーク未同期だけで表示を無効化しない。表示可能なRTCだけで送信を許可せず、時計回復後もHistory Trust未回復ならFail Closed、履歴自動修復・削除なし | SCH-16 |
| CLK-03 | Clock TrustとHistory Trustを独立評価し、履歴の内部整合性・Timestamp信頼性・完全性のいずれか不明ならFail Closed | QH-03 |
| CLK-04 | 暫定閾値・安定観測・各窓2秒だけで安全確定しない。RTC単独送信許可の具体条件・OS同期確認実装を確定済みとしない | F-01・F-02 |
| REC-01 | Startupは閉じたGateからDB・Schema・Transaction・Provider・管理停止・Trust・Controlを復元し、強制HTTPなし | SCH-23〜26・29 |
| REC-02 | DB Recoveryは既存5秒・Single-flight。復旧後にProvider安全性再検証 | SCH-09・10・30 |
| REC-03 | DB Recovery後の旧Permit・旧Connection世代の予約／検証結果を拒否 | SG-03・06 |
| REC-04 | Process再起動後に旧Attemptを再送せず、Quota履歴と保存済みControlを尊重 | SCH-18・29・31 |
| REC-05 | 管理Restoreで巻戻りがある／否定不能なら自動Resumeなし。DB・WALの整合を確認 | F-01、PR-E・Issue #12 / #13 |
| REC-06 | Global DB異常とProvider履歴異常を分け、DB復旧だけで管理停止を解除しない | SCH-09・13・16 |
| REC-07 | 再起動でProvider待機期限を復元しないが、Quota履歴・Startup安全確認は維持。旧Attempt・Permit・Sequenceを送信権限として再利用しない | F-02、REC-01・04 |
| ADM-01 | 停止要求で同期的にGateを閉じ、既開始HTTPへAbort要求。SUSPENDEDのCommit確認まで完了扱いしない | SG-04 |
| ADM-02 | 管理停止Commit unknown後のResume要求でGateを開かず、照合を優先 | TQ-03の照合原則、F-03 |
| ADM-03 | ACTIVEのCommit成功でも、他停止理由・Trust未確認なら送信なし。Resume成功で即時HTTPなし | SCH-23、SG-06 |
| ADM-04 | 未Commit停止意図のProcess Crash後の永続保持を保証済みとしない | 保証境界 |
| HTTP-01 | 必要なBody読込みを含むHTTP全体10秒Timeout。Task全体Timeoutとは区別 | SCH-01・05、C1-16 |
| HTTP-02 | JavaScript Applicationで成立を確認した最初の終端結果を一度だけ確定。成功後Abortで変更せず、Timeout通知・Abort要求だけを終了確定とみなさず、二重Tx-A・Backoff更新なし | SCH-01・22、F-03 |
| HTTP-03 | 制御Abort終了が先に確定した場合は失敗回数・nextAttemptAtを変更しない。Timeout終了が先ならC-2 Timeout失敗処理。要求と実際の終了を区別 | C2-22〜25 |
| HTTP-04 | Timeout・429・通信失敗はC-2 Backoff、更新確定はTx-A Commit成功後 | SCH-01〜03・06 |
| HTTP-05 | DB障害中にHTTP成功してTx-A不能なら原則破棄。Tx-A未実施結果をPending保持しない | SCH-06・28、C2-24 |
| HTTP-06 | Tx-A成功後のTx-P失敗だけ既存Pendingを使い、取得成功記録とQuotaを取消さない | SCH-27、C2-24 |
| HTTP-07 | 終端結果確定後も保存直前の停止理由・DB安全性・Evidence・Authorizationを再確認。自動Tx-A許可なし。管理停止中保存条件はF-03未確定、Shutdown初回INSERT禁止 | C2-09・25、F-03 |
| KEY-01 | 新規DB空履歴をキー未使用証明とせず、Provisioning安全性未確認ならFail Closed | F-01 |
| KEY-02 | APIキー変更後に旧履歴を無条件初期化せず、管理Provisioningを要求 | F-01・U-12 |
| KEY-03 | 外部Senderの未記録消費・別キー自動切替・分散制御を保証済みとしない | MVP保証境界 |

Quota窓の複数制限・最遅解除見込みとControl State非更新はSCH-14〜19を引き続き正本とする。利用アカウントの確認値とMVP正式Backend上限を、未確認の窓境界や追加制限を含むProvider契約適合の実証結果としない。

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
Snapshot2世代保持・世代別Row、State単位Scheduler、Tx-Q / Tx-A / Tx-P / Tx-C、Pending、Recovery、WAL / NORMAL・Backup APIは既存詳細設計に従い、初期DDL・Index・Generation・Migration方式は第12章で具体化済みであり、Quota等の具体SQL・個別Migration・Module構成は未決定である。

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
