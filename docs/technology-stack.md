# 技術スタック選定

## 1. このドキュメントの目的

Raspberry Pi 5を使用する家庭用デジタルサイネージ（Home Digital Signage）の、Issue #4「[Research] 技術スタックを選定する」における技術の選定結果を記録する。

本書では、Frontend開発・Build環境、Build・Deploy方式に加え、nginxによるProduction Serving・Reverse Proxy、HTTP Polling、Published State APIの契約を記録する。Backend技術・SQLite・Backupの暫定採用と具体的な実現方針も記録する。確定事項・暫定採用・検討中の案は各節で区別する。Issue #4全体の技術選定完了を意味しない。

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

将来的なCIでは、以下のように分離する可能性がある。

```text
Lint → Type Check → Test → Build
```

これは検討例であり、CI構成・実行順序・具体的なツール・コマンドは今回確定しない。
各技術やNode.jsのバージョンも本選定では固定しない。

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

図は概念的な責務と通信経路を示す。Backend技術の暫定採用は第11章、MVP実行モデルはArchitecture第16章を参照する。具体的なAPI提供Process構成・Port番号は未決定。

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

Runtime JSON Validationを必須とし、TypeBoxを暫定採用する（第11章）。

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
- MVPでCI/CDを先行導入して構成を複雑化しない。
- 将来的なCI Buildへの移行を妨げない。

### 8.3 比較した選択肢

| 比較対象 | 判断・理由 |
|---|---|
| Development PC Build | 採用。PiへのBuild負荷を避け、開発中の試行錯誤を容易にする |
| Raspberry Pi Build | 非採用。PiへのBuild負荷、Build環境のProductionへの持ち込み、責務の混在を避ける |
| CI Build | Futureでは有力な候補。MVPではCI Workflow、Artifact、Secrets、Deploy認証等の検討事項が増えるため採用しない |

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

CI/CDの具体的な構成は本選定では固定しない。

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
- 正常取得したScheduleが空の場合は`data: []`とし、利用可能データのない`data: null`と区別する。

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

Domain Dataの具体的なJSON構造は未決定である。Endpointの正式なPathも未決定とし、`/api/display-state`は例示として扱う。
FrontendのResponse取得・更新ルールは7.3に従う。

### 10.8 期限切れデータの表示用APIでの扱い

**確定事項：B案（期限切れデータを表示用APIでは公開しない方式）を採用する。**

Backend Cacheでは期限切れデータを保持してもよい。保存Published Stateも、期限切れを理由に直ちに削除・変更する必要はない。
表示用API Response生成時に保存Snapshotの期限を評価し、`now >= expiresAt`の場合は以下の変換を行う。

- Responseの`data`と`dataSource`を`null`にする。
- `dataUpdatedAt`と`expiresAt`は最終正常取得履歴として維持する。
- `lastAttemptAt`と`lastAttemptResult`を維持する。
- `publishedAt`は元のSnapshot生成時刻を維持する。

API Response生成時の期限判定・変換だけでは、新しいSnapshotを生成したものとは扱わない。
APIから期限切れデータを除外しても、Frontendでの`expiresAt`判定は引き続き必須とする。API取得後に期限を迎えたデータも表示に利用しない。

---

## 11. Backend技術スタック

### 11.1 暫定採用一覧

以下はすべて**暫定採用**であり、実装・実機検証済みを意味しない。FrontendのReact + TypeScript + Viteと、第7・10章の確定API契約は維持する。

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
| Config | 環境変数 + TypeBox Validation | 起動時の設定供給・検証。Config / Secret詳細管理は未決定 |

### 11.2 比較上の判断と制約

Backend Buildは原則Bundlingせず、開発PCでCompileする。Native Dependencyまで開発PCの成果物だけで完結させず、Pi側でProduction DependencyをInstallする方式を暫定採用する。
Scheduler・HTTP Clientは標準機構を利用し、汎用Pipeline FrameworkやPlugin Framework、不要な独立ServiceをMVPへ追加しない。
SQLiteはローカル保存とTransactionの実現手段として暫定採用し、物理故障への自動復旧を保証するものとは扱わない。

本書では、BuildのBundling有無・Native Dependencyの配置、標準機構と汎用Frameworkの導入、Backup APIとDB本体の単純コピーの比較判断を記録する。

### 11.3 Backend Build / Deploy

**暫定採用方式**

1. 開発PCでTypeScriptを`tsc`によりCompileする。
2. SSHでRaspberry Piへ成果物を転送する。
3. Release Directoryとsymbolic linkによる切替を使用する。
4. better-sqlite3等のNative DependencyはPi側でProduction DependencyをInstallする。
5. Backendの再起動・自動起動をsystemdで管理する。

永続DBはRelease Directoryの外に配置する。Deploy失敗時に旧ReleaseへRollbackできる構成を目指す。
Directory Path、Unit定義、Port、具体コマンド、依存Install・切替の詳細手順は未決定である。

### 11.4 Backendの責務分担

HTTP Client、Scheduler / Retry実行機構、Cache I/O、Store I/O、Config、Logging、TimeをCommon Moduleとして扱う。
Weather・Schedule固有のValidation、Data変換、Cache採用、Freshness、Published State生成はDomain側が担当する。
MVPの実行モデル・State Ownership・取得制御・Recoveryは[Architecture第16章](architecture.md#16-issue-4backendの具体的な実現方式)を参照する。

### 11.5 Stateごとの暫定取得周期・有効期限

[要件定義 R-07](requirements.md)の暫定値を維持する。Provider条件・実機評価を踏まえて確定する。

| Published State | 外部取得周期（暫定） | 有効期限（暫定） |
|---|---|---|
| CurrentWeather | 15分 | 2時間 |
| HourlyWeather | 30分 | 3時間 |
| RainForecast | 5分 | 30分 |
| WeeklyWeather | 6時間 | 12時間 |
| Schedule | 10分 | 6時間 |

Frontendの30秒Pollingとは別の設定である。5 Stateは独立して更新・復元・公開でき、複数State間の厳密な同時点整合性は要求しない。

---

## 12. SQLiteの保存・WAL運用

### 12.1 保存方針と採用状況

SQLite・better-sqlite3は暫定採用とする。Published State、Backend Cache、Acquisition Control Stateを1つのDatabaseの別Tableとして管理し、Published StateのDataとMetadataを1つのJSON Snapshotとして保存する。

| 論理Table | 保存対象 |
|---|---|
| published_state_snapshots | 最新・直前のPublished State Snapshot |
| backend_cache | Published State単位のBackend Cache |
| acquisition_control | Backendの取得制御用永続状態 |

Published Stateの**最新と直前の2世代保持**と、**世代ごとに別Rowで保存する方式**は、いずれも暫定採用とする。具体DDL・Index・Generation採番・Migrationは未決定である。
State単位のAtomicityを確保し、複数State間の厳密なAtomicityは必須としない。取得結果単位のTransactionと部分成功の関係はArchitecture 16.4に従う。

### 12.2 SQLite設定・注意点

SQLiteの実現方式として以下を採用方針に記録する。Database技術全体は暫定採用であり、実測前である。

- `journal_mode=WAL`、`synchronous=NORMAL`。
- SQLite標準の自動Checkpointを利用し、`wal_autocheckpoint=1000`。
- 定期的な強制TRUNCATE Checkpointは実施しない。
- WAL肥大化時は原因調査のうえ、必要時に手動対応する。
- 原則としてBackend内で共有DB Connectionを使用する。
- `foreign_keys=ON`と`busy_timeout=5000ms`は初期設定候補。特にbusy_timeoutは実測に応じて見直す。

WAL + NORMALは直近Commitの電源断耐久性を完全保証しない。突然の電源断で直近Commitが失われる可能性は許容するが、不完全なSnapshotは公開しない。
CheckpointによってWALの物理ファイルサイズが必ず縮小するわけではない。Lock・Checkpoint異常時の詳細運用は未決定である。
microSD自体の物理故障からの自動復旧は保証しない。

---

## 13. Backup方式

以下はすべて**暫定採用**である。

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
同一microSDのBackupは物理故障対策ではない。Database利用不能時は正常稼働扱いにせず、停止・検証・手動復元を行う。
実行時刻・Path・Backup用Scheduler・失敗時再試行・復元コマンドは未決定とする。

---

## 14. Logging・Test・運用

### 14.1 Logging

Pino + journaldを暫定採用する。Structured JSON LoggingでService / Taskの識別情報を記録し、Secret・Tokenは出力しない。
API取得失敗、Fallback、Validation失敗、Recovery、Transaction失敗、Backup失敗、WAL異常を調査可能にする。
Rotation・Retention・Rate Limitの具体値は未決定である。

### 14.2 Testの観点

Vitestを暫定採用する。以下は検証すべき観点であり、実装・試験完了を意味しない。

- Published State / CacheのSchema ValidationとSemantic Validation。
- Expiry境界（`now == expiresAt`）、Cache Fallbackと鮮度期限の非延長。
- Backoff復元、正常なControl StateのnextAttemptAt尊重。
- SQLite Transaction Rollback、複数State生成時の部分成功と全更新Rollback。
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
| 暫定採用：技術・Deploy・Backup | Backend技術スタック全項目（11.1）、Backend Deploy方式、Backup全項目 |
| 暫定採用：Snapshot世代管理 | Published Stateの最新＋直前の2世代保持、世代ごとに別Rowで保存する方式（12.1・Architecture 16.6） |
| 暫定採用：Backend実行・取得制御 | 1 Backend Process内の複数非同期Task、State単位の独立Scheduler、即時Retryなし・有界指数Backoff（Architecture 16.1・16.3） |
| 暫定採用：Transaction | 取得結果単位のSQLite Transaction、複数State生成時の部分成功（Architecture 16.4） |
| 暫定採用：検証・Recovery | State単位のApplication Data検証・隔離、Control State不正・欠損時の保守的待機、Database利用不能時は正常稼働扱いにしない方針（Architecture 16.6・16.7） |
| 暫定値・初期候補 | State取得周期・有効期限、foreign_keys / busy_timeout初期設定候補 |
| 暫定採用候補：Weather API | CurrentWeather / HourlyWeather / WeeklyWeatherはOpen-Meteo、RainForecastはTomorrow.io（第16章） |
| 暫定採用：Provider取得制御 | Tomorrow.ioのQuota Guard・送信前SQLite永続記録・Provider同時取得最大1件（16.4） |
| 暫定値：Quota安全上限 | ローリング24時間400回・60分20回・1秒1回。正式制限確認後に再評価（16.4） |
| 未決定 | 下記の実装詳細・Provider正式採用・具体値 |

Backendの技術・実行・Transaction・Recovery方針はいずれも上表の暫定採用として扱う。設計内容は既存本文・Architectureの記載を維持し、具体値・実装詳細の未決定事項と区別する。確定API契約はこれらの暫定採用に依存して変更しない。

### 15.2 Build・Deployの実装詳細

- Release Directoryの具体Path・命名方式・保持世代数。
- Deploy Script・symbolic link切替コマンド・Chromium Reload方法。
- SSH認証、systemd Unit・Port、CI/CDの具体構成。

### 15.3 Backend・外部連携の未決定事項

- Weather API Providerの正式採用、Open-Meteoの実データ検証・利用規約最終確認、Tomorrow.ioの降雨時予測品質・独立した分単位予測精度・降り始め／降り終わり推定精度。
- Tomorrow.ioの無料枠超過時の課金条件、正式なリセット境界、継続的な無料利用条件。
- Google Calendarの秘密鍵配置・アクセス制御・失効／ローテーション、API／認証エラー復旧、ページネーション、例外日・キャンセル、内部Data変換・日本時間日付境界・大量予定の取得制御、無料利用条件、長期無人運用、個別予定の非公開設定時の挙動（17.4）。
- Provider正式Rate Limit仕様・Quota GuardのSQLite DDL／具体SQL、1 HTTP Responseと複数Stateの対応、Open-MeteoのRequest共有、Provider単位の詳細Backoff。Tomorrow.ioの暫定制御方針は第16章。
- Domain Data詳細Schema、外部の観測・予報時刻を踏まえた鮮度評価・expiresAt決定。取得成功だけで古いデータを延命しない。
- 正式SQLite DDL・Index・Migration、Generation採番。
- Cache不正時の物理削除。
- Backoffの係数・上限・Jitter・Retry-After、Control State復元失敗時の待機時間。
- Backend ModuleのDirectory構成、API提供Processの詳細構成、Health Check Endpoint。
- API Endpoint正式Path・nginx設定。
- Backup実行時刻・Path・Scheduler・失敗時再試行・復元コマンド。
- SQLite Lock・Checkpoint異常時の詳細運用。
- Config・Secret詳細管理、Runtime変更への適用方式。
- Log Rotation・Retention・Rate Limit、未選定の別領域の技術・バージョン・Linter / Formatter等。

Future機能を先行実装しない。Issue #4のClose前には文書・Issue間の整合性を確認する。

---

## 16. Weather API選定とTomorrow.ioの取得制御

### 16.1 暫定採用候補

家庭用MVPでは月額0円で継続運用できるAPIを優先し、一般的な天気予報と短時間降雨予測を別Providerから取得することを許容する。
以下は**暫定採用候補**であり、正式採用済みではない。取得周期・TTLも既存の暫定値を維持する。

| Published State | Provider候補 | 取得周期（暫定） | TTL（暫定） |
|---|---|---|---|
| CurrentWeather | Open-Meteo | 15分 | 2時間 |
| HourlyWeather | Open-Meteo | 30分 | 3時間 |
| RainForecast | Tomorrow.io | 5分 | 30分 |
| WeeklyWeather | Open-Meteo | 6時間 | 12時間 |

Open-Meteoを基本的な天気予報の取得候補、Tomorrow.ioを分単位降雨予報の取得候補とする。
Open-Meteoの実データ検証・利用規約の最終確認は未完了である。
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
- HTTP 429時は即時再試行せず、`Retry-After`等を考慮して待機する。詳細待機計算は後続設計とする。

送信前の永続記録は、外部HTTPをDB Transactionの外で行う既存境界を変更しない。Quota記録の具体SQL・DDL・Transaction実装は今回確定しない。

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

Open-MeteoのHTTP Request共有、詳細Domain Schema、SQLite DDL、Quota Guard具体SQL、Provider正式制限、429待機計算は後続設計に残す。
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
| Backend取得 | Node.js / TypeScriptから取得。Backend技術スタックの暫定採用状態は11.1を維持 |
| 取得周期・TTL | 10分・6時間：既存の暫定値 |
| 保存 | 既存SQLite構成に従う。SQLiteの暫定採用状態は維持 |

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

MVPに必要な基本予定種別の取得を実証した。繰り返し例外日、キャンセル予定、ページネーション、長期無人稼働は未検証である。
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
- ページネーション、予定件数が多い場合の取得制御。
- 繰り返し予定の例外日・キャンセル予定。
- 終日・日付またぎ予定の内部Data変換、日本時間の日付境界。
- 無料利用条件の最終確認、長期無人運用の確認。
- 個別予定の非公開設定時の取得挙動。
- Domain Data詳細Schema・詳細取得制御設計。

取得周期10分・TTL6時間は暫定値のまま維持する。Weather API候補・Tomorrow.io Quota Guardは第16章の採用状態と方針を変更しない。
