# 技術スタック選定

## 1. このドキュメントの目的

Raspberry Pi 5を使用する家庭用デジタルサイネージ（Home Digital Signage）の、Issue #4「[Research] 技術スタックを選定する」における技術の選定結果を記録する。

本書では、Frontend開発・Build環境、Build・Deploy方式に加え、nginxによるProduction Serving・Reverse Proxy、HTTP Polling、Published State APIの契約を記録する。確定事項・暫定採用・検討中の案は各節で区別する。Issue #4全体の技術選定完了を意味しない。

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

図は概念的な責務と通信経路を示すものとし、具体的なプロセス分割、API Serverの技術、Port番号は確定させない。

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
| 取得成功 | 取得したPublished Stateを反映 |
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

HTTP Requestが成功しても、一部のPublished Stateが利用不能、またはResponseから省略されている場合は、Request全体の失敗と区別する。State Key省略時のReact側の保持・削除は未決定であり、11.2に記録する。

Stateの保持は期限切れ情報の表示継続を意味しない。基本画面の起動はBackend/API取得完了を待たない既存方針を維持する。
Node.jsの開発ツール実行用途は確定済みだが、Production側でのNode.js利用要否やProcess構成を確定するものではない。

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

一括APIのRequest全体の失敗時は7.3に従う。Request成功時の一部State利用不能・省略時の扱いは11.2の未決定事項とする。

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

### 10.4 共通Metadata：確定した5項目

以下の5項目を採用する。

```typescript
type PublishedStateMetadata = {
  dataUpdatedAt: string | null;
  expiresAt: string | null;
  lastAttemptAt: string | null;
  lastAttemptResult: "success" | "failure" | null;
  publishedAt: string | null;
};
```

API Responseとして公開済みのStateでは、`publishedAt`を日時文字列として扱う方針を暫定採用している。

| 項目 | 意味 |
|---|---|
| `dataUpdatedAt` | Backendがデータを正常取得・検証・採用した時刻 |
| `expiresAt` | Backendが決定するデータの利用期限 |
| `lastAttemptAt` | 最後に完了した取得試行の開始時刻 |
| `lastAttemptResult` | その取得試行の結果 |
| `publishedAt` | 公開対象Snapshotを生成した時刻 |

`lastAttemptAt`は、完了済みの最後の取得試行を対象とし、その試行の開始時刻を記録する。`lastAttemptResult`は同じ試行の結果を示す。両項目は試行完了後にセットで更新し、進行中の試行について先行更新しない（更新ルールの選定状況は10.5）。

### 10.5 Metadataの更新ルール

**暫定採用事項**

- 時刻形式はRFC 3339 / UTCとする。
- 外部データを正常取得・検証・採用した場合、`data`、`dataUpdatedAt`、`expiresAt`を更新する。
- 同一内容のデータでも、新たに正常取得・検証・採用した場合は更新対象とする。
- Cacheから既存データを読み出しただけの場合、`dataUpdatedAt`を新しい取得時刻として更新しない。
- 外部API取得失敗時は、既存の`data`、`dataUpdatedAt`、`expiresAt`を維持する。
- 取得完了後に`lastAttemptAt`と`lastAttemptResult`をセットで更新する。
- Published Stateの公開Snapshotを生成する際に`publishedAt`を設定する。
- Storeへの書込み失敗時は、Store上の既存Snapshotを維持する。
- Backend停止時も、Store上の最後の公開Stateを維持する。
- 期限切れだけを理由にStateのMetadataを書き換える必要はない。
- React UIは`now < expiresAt`の場合のみ、期限内と判定する。
- `now >= expiresAt`の場合、保持データを表示に利用しない。
- 最後の取得結果が`failure`でも、データが期限内なら利用可能とする。

外部APIが返す観測時刻・予報対象時刻・予定日時と、共通Metadataの更新時刻は区別する。Architectureの概念項目`dataTimestamp`と`dataUpdatedAt`を無条件に同一視しない。
既存データの保持と表示への利用可能性は別であり、期限切れデータをFallbackとして再利用しない。Cache再利用によって元データの鮮度期限を延長しない既存原則を維持する。

### 10.6 Metadataの整合条件

**状態：現在の設計案。正式確定前。**

- `data === null`なら`dataUpdatedAt`と`expiresAt`も`null`。
- `data !== null`なら`dataUpdatedAt`と`expiresAt`が存在する。
- `lastAttemptAt`と`lastAttemptResult`は両方存在、または両方`null`。
- API Responseに含まれる公開済みStateでは`publishedAt`が存在する。
- `publishedAt < expiresAt`など、常に成立するとは限らない時刻順序を無条件の必須条件にしない。
- `expiresAt > dataUpdatedAt`も、すべてのケースに強制する条件にはしない。

State自体が未公開であることと、公開済みStateのデータが未取得であることは区別する。`data: null`は後者の表現候補であり、未公開StateのKey省略を含むResponse構造は10.7の検討案として扱う。

`status`、`isValid`、`isExpired`など、既存情報から導出できる項目は追加しない。

`errorCode`、`lastSuccessAt`、`ttl`なども、明確な要件がない段階で共通Metadataへ追加しない。

### 10.7 API Response JSON構造

**以下は現在検討中の推奨案であり、まだ正式確定していない。**

```json
{
  "schemaVersion": 1,
  "states": {
    "currentWeather": {
      "data": {
        "temperatureC": 24.5,
        "condition": "cloudy"
      },
      "meta": {
        "dataUpdatedAt": "2026-10-11T03:00:00Z",
        "expiresAt": "2026-10-11T05:00:00Z",
        "lastAttemptAt": "2026-10-11T03:15:00Z",
        "lastAttemptResult": "failure",
        "publishedAt": "2026-10-11T03:15:01Z"
      }
    }
  }
}
```

検討中の方針：

- API Responseのトップレベルは`schemaVersion`と`states`。
- `states`はObjectとし、State Keyで参照する。
- 各Stateは`data`と`meta`を持つ。
- 未公開Stateは`states`からKeyを省略する。
- 公開済みだがデータ未取得の場合は`data: null`とする。
- 正常取得した結果が0件の場合は、Domainに応じた空配列などで表現する。
- `schemaVersion`はAPI Response全体で管理する。
- 各Stateに個別のSchema Versionを重複して持たせない。

上記JSONの`temperatureC`、`condition`などは構造説明用の例であり、Domain Data Schemaの正式決定ではない。

具体的なEndpoint Pathや、各Stateの`data`内部項目・型も、現時点では確定しない。

この推奨案は未確定事項として扱う。Responseで省略されたState Keyに対するReact側の更新方法は11.2で扱う。

---

## 11. 今後の検討事項

Frontend・Build・Deploy、nginxによるServingとReverse Proxy、HTTP PollingおよびAPIの確定部分は未決定事項から外す。
暫定採用・検討中の案の確定と、以下の技術選定・実装詳細を引き続き扱う。

### 11.1 Build・Deployの実装詳細

以下は今回固定しない。

- Release Directoryの具体的なパス。
- Release名の方式（日時・Git commit hash等）。
- 旧Releaseの保持世代数。
- Deploy Scriptの具体的実装。
- symbolic link切替の具体的コマンド。
- Deploy後のChromium Reload方法。
- SSH Key等の認証方式。
- CI/CDの具体的構成。

### 11.2 その他の未決定事項

- 一括APIのHTTP Request成功時に、一部のPublished Stateが利用不能、またはResponseから省略されている場合の扱い。State Key省略時にReact側の既存Stateを保持するか削除するかは未決定（7.3・10.1・10.7）。
- Shared State Storeの具体的な実装技術。
- API提供処理のRuntime・Framework・Process構成。
- API EndpointのPath・Port、nginxの具体設定。
- Domain Dataの詳細Schema、Runtime Validation Library。
- Metadata更新ルールの暫定採用（10.5）の確定、Metadata整合条件（10.6）とAPI Response JSON構造（10.7）の正式確定。
- 外部Weather API・Schedule APIの正式選定。
- 技術バージョン、その他の型・Schema、Type Check / Linter / Formatter / Test用ツール、Issue #4のその他未完了事項。

既存Architectureとの対応では、以下も具体化が必要となる。今回、新しいMetadata項目や判定方式は追加しない。

- Cache由来情報をConsumerが識別できるというArchitecture 8.6の要求と、共通Metadata 5項目との具体的な対応。`lastAttemptResult = "failure"`だけではCache由来を確定できない。識別方法は未決定とし、今回新しいMetadata項目は追加しない。
- 外部APIの観測・予報時刻と`dataUpdatedAt`の区別を踏まえた鮮度評価・`expiresAt`の決定。取得成功だけで古い元データを延命しない。

Future機能や追加ライブラリを、本選定に付随して設計・実装しない。
Issue #4のClose前には、文書・Issue間の整合性を確認する。
