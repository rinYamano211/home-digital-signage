# 技術スタック選定

## 1. このドキュメントの目的

Raspberry Pi 5を使用する家庭用デジタルサイネージ（Home Digital Signage）の、Issue #4「[Research] 技術スタックを選定する」における技術の選定結果を記録する。

今回記録するのは、確定済みの **Frontend開発・Build環境：React + TypeScript + Vite** のみである。Issue #4全体の技術選定完了を意味しない。

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
具体的なSchema、Interface、型定義は本選定では固定しない。

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
Public Web Serverが不要という判断は、Production ServingにLocal HTTP Serverを採用しないという決定ではない。Serving方式は未決定である。

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

## 7. Production Runtimeとの境界

今回確定する範囲は、**Source → Build → dist/** までである。

```text
【今回の選定範囲】
Source → Vite Build → dist/

【後続の技術選定】
dist/ → Deploy → Production Serving → Chromium Kiosk
```

Chromium Kioskは確定済みのDisplay Runtimeである。
ReactのUI実行とViteの開発・Build処理を区別する。ProductionではBuild済みJavaScriptがBrowser上で動作する。Vite Development ServerをProduction Serving方式として決定しない。

Node.jsの開発ツール実行用途は確定しているが、これによってProduction側のNode.js利用要否やDisplay Serviceの実行構造は確定しない。

また、次の論理上の責務を維持する。

```text
Shared State Store
  ↓ Display側Published State取得
Component State生成
  ↓
ReactによるDisplay ComponentのRendering
```

Browser / ReactからShared State Storeへ直接アクセスする構成は、本書では定めない。
Browser上のReact UIとDisplay ServiceのPublished State取得部分をどのように接続するかは、後続の技術選定で検討する。
上記の図は論理上の責務境界を示し、プロセス分割・API・通信方式を指定しない。

---

## 8. 今後の検討事項

Production側は以下の順序で後続の技術選定を進める。

1. **Build実行場所**：Development PC / Raspberry Pi / CI。
2. **Deploy方法**：生成した`dist/`をRaspberry Piへどう配置・更新するか。
3. **Production Serving方式**：`file://` / Local HTTP Server / その他。
4. **接続方法**：React UIとDisplay ServiceのPublished State取得部分の接続。Published State取得 → Component State生成 → Display Componentの責務境界を維持する。

そのほか、バージョン、具体的な型・Schema、Type Check / Linter / Formatter / Test用ツール、CI構成は今回未決定とする。Issue #4の他領域の技術選定も本書の対象外である。

Future機能や追加ライブラリを、本選定に付随して設計・実装しない。
Issue #4のClose前には、文書・Issue間の整合性を確認する。
