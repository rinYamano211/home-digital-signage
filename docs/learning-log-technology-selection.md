# Learning Log - Technology Selection

Home Digital Signageの技術選定を通して学んだことを記録する。

本書では、特定の製品やFrameworkの使い方だけではなく、Architectureや要件から技術を比較・選定するときに得た、他プロジェクトでも再利用可能な考え方を中心に記録する。

---

## 2026-10 Frontend開発・Build環境の技術選定

### ArchitectureとTechnology Selectionを分ける

技術選定を始めると、具体的なFramework、Library、Runtime、Database等を決める過程で、既に決めたArchitectureまで変更したくなることがある。

しかし、

```text
Architecture
↓
責務・境界・依存方向・State Ownership等を決める

Technology Selection
↓
そのArchitectureを何の技術で実現するかを決める
```

では目的が異なる。

今回のFrontend技術選定では、Issue #3で既に、

```text
Shared State Store
↓
Published State
↓
Component State
↓
Display Component
↓
Rendering
```

という論理的なStateの流れを決めていた。

そのためReactを採用する場合も、

```text
Reactを使う
↓
ArchitectureをReactに合わせて変更する
```

のではなく、

```text
既存Architecture
↓
その責務境界をReactでどのように実現できるか
```

という順序で考えた。

特に、

```text
Display ComponentはShared State Storeを直接参照しない
```

というArchitecture上の依存方向は、Frontend Frameworkを選定しても維持する。

技術選定では、採用したい技術にArchitectureを引っ張らせるのではなく、まず既存Architectureとの適合性を評価することが重要。

---

### 技術は名前ではなく責務で理解する

Frontend開発環境を検討するとき、React、TypeScript、Viteをまとめて一つのFrontend技術として捉えやすい。

しかし、それぞれの責務は異なる。

今回の構成では、

```text
React
→ Component-based UI / Declarative UI

TypeScript
→ Type Safety / Data Contract

Vite
→ Frontend Development / Build
```

として整理した。

ReactはStateからUIを構成するためのComponent Modelを提供する。

TypeScriptはPublished State、Component State、Config、Metadata等のData Contractを型として表現する。

ViteはDevelopment Server、Module Resolution、TS / TSX Transformation、HMR、Asset Handling、Production Build等を担当する。

このように役割を分けると、

```text
Reactを採用したからViteを採用する
```

のように技術名を一つのセットとして判断するのではなく、

```text
必要な責務
↓
その責務を実現する技術
```

として個別に評価できる。

複数技術から構成されるTechnology Stackでは、「何を使うか」だけでなく「その技術が何の責務を持つのか」を明確にすることが重要。

---

### Frameworkは機能の多さではなく必要十分性で選ぶ

Frontend候補としてReact + Viteだけでなく、Next.js等のFrameworkも検討した。

Next.jsには、

- Routing
- SSR
- Server Components
- Server-side functionality
- Full-stack Application向けの機能

等がある。

これらはWeb Applicationによっては大きなメリットになる。

しかし今回のサイネージでは、

```text
SEO
Public Web Server
複雑なRouting
SSR
Server Components
```

等を必要としていない。

そのため、

```text
多くの機能を持っている
=
今回のシステムに適している
```

とは判断しなかった。

必要のない機能を持つFrameworkを導入すると、

```text
学習対象
設定
Dependency
Upgrade
Troubleshooting
```

等の対象も増える。

Technology Selectionでは機能数の多さではなく、

```text
要件
+
Architecture
+
運用条件
↓
必要な機能
↓
必要十分な技術
```

という順序で評価する。

高機能な技術を選ぶことより、不要な責務や複雑性を持ち込まないことも重要な判断基準になる。

---

### Futureの表現自由度とFuture機能の先行実装は別

Frontendには将来的に、

- Layout変更
- Theme
- Animation
- Weather表示のVariation
- Component追加

等の表現自由度を持たせたい。

そのため、Component ModelやUI Ecosystem等はFrontend技術を選定する際の評価対象になる。

一方、

```text
将来Themeを変更したい
↓
MVPでTheme Systemを作る
```

あるいは、

```text
将来Animationを増やしたい
↓
MVPでAnimation Plugin Systemを作る
```

必要はない。

Futureへの備えとして必要なのは、Future機能そのものを先行実装することではなく、現在の技術選定によって将来の選択肢を不必要に制限しないこと。

これはArchitecture設計で学んだ、

```text
Futureへの備え
=
Future機能の先行実装ではなく
変更しやすい境界を作る
```

という原則をTechnology Selectionにも適用したものになる。

---

### Declarative UIではStateから表示を考えやすい

Reactを検討する中で、Declarative UIの考え方を整理した。

ImperativeなUI更新では、

```text
状態Aになった
↓
このDOMを削除
↓
このDOMを追加
↓
このClassを変更
```

のように、UIをどのように変更するかを記述する割合が増える。

一方Declarative UIでは、

```text
現在のState
↓
このUIであるべき
```

という関係を中心に記述する。

今回のArchitectureでは、

```text
Published State
↓
Component State
↓
Display Component
↓
Rendering
```

というStateから表示への一方向の流れを既に設計していた。

そのため、

```text
Component State
↓
UI
```

として扱えるDeclarative UIはArchitectureとの親和性が高い。

Technology Selectionでは、単に人気や情報量だけでなく、採用するProgramming Modelが既存Architectureの考え方と合っているかも評価対象になる。

---

### Type Safetyは単なるCoding補助ではなくData Contractにも利用できる

TypeScriptのメリットを考えると、補完やTypo防止等の開発効率へ目が向きやすい。

しかし今回のArchitectureでは、

- Published State
- Component State
- Metadata
- Config
- Service間のData Contract

等、複数の境界でデータ構造を扱う。

これらをTypeとして表現することで、

```text
Architecture上のData Contract
↓
TypeScript Type / Interface等
↓
Implementation
```

という関係を作りやすくなる。

そのためTypeScriptは単なるFrontend開発の便利機能ではなく、Architecture上の契約をImplementationへ反映する手段としても利用できる。

ただし、

```text
TypeScriptを採用した
=
具体的なSchemaやInterfaceが確定した
```

わけではない。

技術を採用するDecisionと、その技術を使った具体的な設計を分けることも重要。

---

### TransformationとType Checkは別の責務

ViteはTS / TSXをBrowserで実行できるJavaScriptへ変換できる。

しかし、

```text
Vite Buildが成功した
=
TypeScriptの厳密なType Checkが完了した
```

とは限らない。

ここから、

```text
Transformation
→ 実行可能な形式へ変換する

Type Check
→ 型として正しいか検証する
```

という責務の違いを理解した。

将来的な開発フローでは、

```text
Lint
↓
Type Check
↓
Test
↓
Build
```

のように別工程として扱うこともできる。

ただし、具体的なToolや実行順序をTechnology Stack選定時点で固定する必要はない。

「Buildできること」と「品質検証が完了していること」を同一視しないことが重要。

---

### Development ToolとProduction Runtimeを分ける

Viteを採用すると、

```text
Vite Development Server
```

をそのままRaspberry Pi上でも動かす構成を考えやすい。

しかしViteのDevelopment Serverは、開発時の、

- HMR
- Source Transformation
- Module Resolution
- Development用Asset Handling

等を提供するためのもの。

Productionでは、

```text
React + TypeScript Source
↓
Vite Build
↓
dist/
```

としてBuild済みのArtifactを生成できる。

そのため、

```text
開発時に必要なTool
=
Productionで常時動作させるTool
```

ではない。

今回の構成では、

```text
Development
React + TypeScript
↓
Vite
↓
Development Browser
```

と、

```text
Production
dist/
↓
Production Serving
↓
Chromium Kiosk
```

を分けて考える。

Production Servingに何を利用するかは、Vite採用とは別のTechnology Selectionになる。

Development EnvironmentとProduction Runtimeの責務を分けることで、Production環境へ不要なToolやDependencyを持ち込むことを避けられる。

---

## 2026-10 Frontend Build・Deploy方式の技術選定

### Buildできる場所とBuildすべき場所は別

FrontendのProduction Buildは、

- Development PC
- Raspberry Pi
- CI

等、複数の場所で実行できる。

Raspberry PiにもNode.js、npm、Vite等を導入すれば、Pi自身でBuildすることは技術的には可能。

しかし、

```text
実行できる
=
そこで実行すべき
```

ではない。

今回のRaspberry PiはProduction Deviceであり、2GB RAMというResource制約もある。

そのため、

```text
Raspberry PiでBuildできるか
```

ではなく、

```text
Raspberry PiにBuildという責務を持たせる理由があるか
```

という観点で判断した。

結果としてMVPでは、

```text
Development PC
↓
Vite Build
↓
dist/
↓
Deploy
↓
Raspberry Pi
```

とする。

これにより、

- Piへの不要なBuild負荷を避ける
- Production RuntimeへResourceを集中する
- Production PiへBuild Toolを必須化しない
- Build EnvironmentとProduction Environmentを分離する

ことができる。

Technology Selectionでは「できるか」だけではなく、「その責務をどこへ配置するのが適切か」を考える必要がある。

---

### Resource制約のあるEdge Deviceでは不要な処理を外へ出す

Raspberry PiのようなEdge Deviceでは、PCやServerと比較してCPU、Memory、Storage等のResourceが限られる場合がある。

そのため、Device上で実行する必要がない処理は、Development PCやCI等へ移すことが選択肢になる。

今回のFrontend Buildは、

```text
Build時には必要
↓
Production Runtimeでは不要
```

な処理。

したがってBuildをDevelopment PCへ出すことで、Production Deviceは、

```text
Build済みArtifactを受け取る
↓
Serving
↓
Browserで実行する
```

ことへ集中できる。

Edge Systemでは、

```text
Deviceで実行可能か
```

だけではなく、

```text
Deviceで実行する必要があるか
```

を考えることでResourceを有効に利用できる。

---

### Build Artifactを境界にするとBuild主体を変更しやすい

MVPではDevelopment PC Buildを採用したが、FutureではCI Buildを利用したい。

ここで、

```text
Development PC固有のDeploy構造
```

を作ってしまうと、CIへ移行するときにProduction側まで変更する必要がある。

そこで、

```text
Build
↓
dist/
↓
Deploy
↓
Raspberry Pi
```

というArtifact境界を維持する。

MVP：

```text
Development PC
↓
Build
↓
dist/
↓
Deploy
↓
Raspberry Pi
```

Future：

```text
CI
↓
Build
↓
dist/
↓
Deploy
↓
Raspberry Pi
```

Production側から見ると、

```text
誰がBuildしたか
```

ではなく、

```text
正しいBuild Artifactを受け取る
```

ことが重要になる。

このように境界を設けることで、Build主体を変更しても影響範囲を小さくできる。

Futureへの拡張性は、FutureのCI/CDをMVPから導入することではなく、後からBuild主体を交換できる境界を作ることで確保できる。

---

### CI/CDを将来使いたいこととMVPで導入することは別

CI Buildには、

- Buildの再現性
- 自動Test
- 自動Build
- Artifact生成
- 自動Deploy

等のメリットがある。

一方、CI/CDを導入するには、

- Workflow
- Node.js Version
- Artifact管理
- Secrets
- SSH Key等のDeploy認証
- Trigger
- Failure Handling
- Raspberry PiへのNetwork到達方法

等も検討する必要がある。

今回のMVPでは、これらを先に解決しなくてもDevelopment PCからBuild・Deployできる。

そのため、

```text
将来CI/CDを使いたい
↓
今すぐCI/CDを導入する
```

とはしない。

代わりに、

```text
MVP
Development PC → Artifact → Production

Future
CI → Artifact → Production
```

という交換可能な境界を作る。

FutureのTechnologyを先行導入するのではなく、Futureで置き換えやすい構造を現在作るという考え方は、Technology Selectionでも有効。

---

### Source管理とDeployを分ける

Raspberry PiへApplicationを配置する方法として、

```text
Pi上でgit pull
```

する方法も考えられる。

しかしGitとDeployでは目的が異なる。

```text
Git
→ Source CodeのVersion Control

Deploy
→ Productionで実行するArtifactを配置する
```

今回のFrontendでは、

```text
Source
↓
Vite Build
↓
dist/
```

というBuild工程が存在する。

Piで`git pull`したSourceからBuildする場合、

```text
Git pull
↓
Pi Build
↓
Production
```

となり、Production Piへ再びBuild Environmentが必要になる。

一方、`dist/`をGitへCommitしてPiから取得する方法では、Source RepositoryへBuild Artifactを含める責務が発生する。

そのため今回のMVPでは、

```text
Git
→ Source管理

Vite
→ Build

scp
→ Build Artifactの転送

Raspberry Pi
→ Production Runtime
```

として分離する。

Source管理の仕組みとDeployの仕組みを同じにする必要はない。

---

### ファイル転送方法とDeploy方式は別のDecision

Raspberry PiへのDeployを検討したとき、

- scp
- rsync
- SFTP

等を比較した。

しかし、これらは主に、

```text
Artifactをどのように転送するか
```

を決める技術。

一方、

- Production Directoryへ直接上書き
- Temporary Directoryから切替
- Release Directory + symbolic link
- Blue-Green Deployment

等は、

```text
新Versionへどのように安全に切り替えるか
```

を決める方式。

つまり、

```text
scp / rsync
=
Transfer Method

Release Directory / symbolic link / Blue-Green
=
Deployment Strategy
```

として別のDecisionになる。

例えば`scp`を採用しても、

```text
scp
↓
Production Directoryへ直接上書き
```

するのか、

```text
scp
↓
新Release Directory
↓
Production参照先を切替
```

するのかで安全性は異なる。

Technology Selectionでは、複数の問題を一つの「Deploy方法」という言葉へまとめず、何を決めているDecisionなのかを分解することが重要。

---

### 単純な直接上書きには中間状態が存在する

Production DirectoryへBuild Artifactを直接コピーする方法は単純だが、複数ファイルを転送する場合、すべてのファイルが同時に置き換わるわけではない。

例えば、

```text
index.html
assets/app-xxxxx.js
assets/app-yyyyy.css
```

がある場合、

```text
新index.html転送
↓
新JavaScript転送
↓
新CSS転送
```

という途中状態が発生し得る。

この途中でBrowserが読み込むと、

```text
新index.html
+
旧Asset
```

あるいは、

```text
新index.html
↓
まだ存在しない新Assetを参照
```

といった不整合が発生する可能性がある。

特にBuildごとにHash付きAsset名が変わるFrontendでは、この問題を考慮する必要がある。

また転送途中で失敗すると、Production Directoryに新旧ファイルが混在する可能性もある。

Deployでは、

```text
ファイルを転送できるか
```

だけではなく、

```text
転送途中の状態を利用者から見えないようにできるか
```

も考える必要がある。

---

### Release単位でDeployすると不完全なArtifactをProductionから分離できる

直接上書きの問題を避けるため、今回のMVPでは、

```text
scp
+
Release Directory
+
symbolic link
```

を採用した。

概念的には、

```text
releases/
├── release-A/
└── release-B/

current
→ releases/release-A/
```

という状態から、新Versionを、

```text
releases/release-B/
```

へ完全に転送する。

転送中はProductionが参照している、

```text
current
→ release-A
```

を変更しない。

転送完了後に、

```text
current
→ release-B
```

へ切り替える。

これによって、

```text
Build
↓
Transfer
↓
Switch
```

を分離できる。

Transferに失敗しても、現在のProduction Releaseを維持しやすい。

安全なDeployでは、新しいVersionを作る処理と、新しいVersionを利用者へ公開する処理を分離することが有効。

---

### Rollbackを考えるとRelease単位の管理が有効

Production Directoryへ直接上書きした場合、新Versionに問題があったとき、旧Versionへ戻すには、

```text
旧Artifactを再転送
```

等が必要になる可能性がある。

一方、Release Directory方式で旧Releaseを保持していれば、

```text
current
→ new-release
```

から、

```text
current
→ previous-release
```

へ参照先を戻すことでRollbackできる構成を作れる。

つまりRelease Directoryには、

```text
Deploy時の安全性
+
Rollbackしやすさ
```

という2つのメリットがある。

ただし、

- Release名
- 保持世代数
- symbolic link切替の具体的方法
- Rollback Script

等はImplementation Detail。

Technology Selectionでは、

```text
Release単位で配置し
参照先を切り替えられる構造にする
```

という方針までを決め、具体的なMechanismは実装設計へ残す。

---

### 安全性を高める方式にも規模に応じたトレードオフがある

安全なDeploy方式として、

- Temporary Directoryからの切替
- Release Directory + symbolic link
- Blue-Green Deployment
- Container / Image単位のDeploy
- A/B Deployment
- Canary Deployment

等が考えられる。

Blue-GreenやContainerを利用すれば、より高度なDeployや環境管理を実現できる場合がある。

しかし今回のシステムは、

```text
1台のRaspberry Pi
+
1画面の家庭用Digital Signage
```

である。

高度なDeployment Infrastructureを導入すると、そのInfrastructure自体の、

- 設定
- Resource Consumption
- Failure Mode
- Learning Cost
- Maintenance

も増える。

今回必要なのは、

```text
Deploy途中の不完全状態を避ける
+
Rollback可能にする
```

こと。

そのためRelease Directory + symbolic linkは、必要な安全性と構成の単純さのバランスが良いと判断した。

安全性を高める場合も、最も高度な方式を選ぶのではなく、システム規模と要求する安全性に対して必要十分なMechanismを選ぶことが重要。

---

### Linuxの学習目的とArchitecture上の必要性を混同しない

今回のプロジェクトには、Raspberry Pi / Linuxを学ぶ目的もある。

そのため、

```text
PiでBuildすればLinuxの学習になる
```

という考え方もできる。

しかし、学習目的だけを理由にProduction Piへ不要なBuild責務を持たせると、Architecture上は不自然な構成になる。

Linuxについては、

- SSH
- filesystem
- symbolic link
- permission
- Process Management
- systemd
- Logs
- Network
- RTC
- Service Supervision
- Watchdog

等、Production運用の中でも十分に学ぶことができる。

学習プロジェクトでも、

```text
学びたい技術を使うためにArchitectureを歪める
```

のではなく、

```text
Architecture上妥当な構成を作り
その中で必要になる技術を深く学ぶ
```

という進め方が重要。

---

### Technology SelectionではDecisionとImplementation Detailを分ける

今回のDeploy検討では、

```text
scp + Release Directory + symbolic link
```

までをTechnology Selectionとして決定した。

一方、

- Raspberry Pi上の具体的なDirectory Path
- Release名を日時にするかGit commit hashにするか
- Release保持世代数
- Deploy Scriptの具体的な実装
- symbolic linkを切り替える具体的なCommand
- Deploy後のChromium Reload方法
- SSH認証方式

等は固定していない。

これらまでTechnology Selectionで決めると、具体的なImplementationへ早く入りすぎる可能性がある。

逆に、

```text
安全にDeployする
```

だけではImplementation時の判断材料として抽象的すぎる。

そのため、

```text
Technology Selection
→ 採用する方式・責務・境界を決める

Implementation Design
→ その方式を具体的にどう実現するか決める
```

として分ける。

「今決める必要があること」と「後で具体化できること」を区別することで、過剰な先行設計を避けながら、後続工程に必要なDecisionを残すことができる。

## 2026-10 Backend・State管理・永続化の技術選定

### Backend FrameworkとRuntimeは異なる責務を持つ

Backendの技術選定では、Node.js、TypeScript、Fastify、TypeBoxを採用した。

これらは一つのBackend Stackを構成するが、それぞれの責務は異なる。

```text
Node.js
→ JavaScriptのServer-side Runtime

TypeScript
→ Type Safety / Data Contract

Fastify
→ HTTP Server / Routing / Request・Response処理

TypeBox
→ Schema定義 / Runtime Validation
```

FrontendでReact、TypeScript、Viteの責務を分けたのと同様に、Backendでも必要な機能を分解して技術を選定することが重要だと学んだ。

特に、TypeScriptによる静的な型検査だけでは、外部APIや設定ファイルから実行時に受け取る値の正しさは保証できない。

```text
TypeScript
→ 開発時の型検査

Runtime Validation
→ 実行時に入力データを検証
```

という違いがある。

Data Contractを安全に扱うには、型定義と実行時のValidationを区別する必要がある。

---

### 同じSQLiteを利用してもStateの責務は統合しない

今回のArchitectureでは、次の3種類の論理Stateを区別している。

```text
Published State
→ Frontendへ公開する確定済みデータ

Backend Cache
→ 外部APIから取得・検証したデータ

Acquisition Control State
→ 取得周期・Retry・Backoff・Quota等の制御情報
```

これらをSQLiteへ保存するとしても、論理的には異なる責務を持つ。

例えば、外部APIからデータを取得できたことと、そのデータをFrontendへ公開できたことは同じではない。

また、公開処理に失敗した場合でも、次回取得時刻やQuotaの管理が失われてよいわけではない。

```text
同じDatabaseを利用する
≠
同じStateとして扱う
```

物理的な保存先を統合することと、Architecture上の責務を統合することは別の判断になる。

---

### Transactionは処理全体ではなく整合性を守る単位で考える

Databaseを利用すると、複数の処理を一つのTransactionへまとめれば安全になると考えやすい。

しかし、外部API通信やRetry待機まで長いTransactionに含めると、DatabaseのLockや処理の独立性に影響する可能性がある。

今回の設計では、取得制御・取得結果の保存・公開・後処理を分離する方針とした。

```text
Tx-Q
→ 取得制御・Quota関連

Tx-A
→ 取得結果の保存

Tx-P
→ Published Stateへの公開

Tx-C
→ 後処理
```

ここから、Transactionは単に処理をまとめる仕組みではなく、**どの整合性を、どの範囲で保証するかを定義する境界**だと理解した。

Transactionを分割する場合は、途中失敗時の状態とRecoveryも合わせて設計する必要がある。

---

### 保存成功と公開成功は別の状態になる

外部APIから取得したデータを保存できても、その後のPublished State更新が失敗する可能性がある。

```text
外部API取得成功
↓
Backend Cache保存成功
↓
Published State更新失敗
```

この場合、取得したデータを即座に捨てて再取得すると、不要なAPI呼び出しやQuota消費につながる。

そのため、今回の設計ではPending Publicationを扱う方針とした。

Pending Publicationは、保存済みだが公開できていないデータを、条件が成立する場合に再公開するための仕組みである。

ただし、Pendingを無条件に再公開してはいけない。

- TTLが切れていないか
- Validation結果が有効か
- JST日付が変わっていないか
- より新しいSnapshotが存在しないか

などを確認する必要がある。

また、DatabaseのCommit結果が不明な場合は、失敗と即断して再実行するのではなく、保存済みの状態を照合する必要がある。

**障害復旧では、処理を再実行することだけでなく、現在の永続状態を正しく判断することが重要**だと学んだ。

---

## 2026-10 外部API・Scheduler・取得制御の技術選定

### データの取得周期と表示鮮度は同じではない

外部APIからデータを取得する間隔と、画面に表示してよいデータの鮮度は別の概念になる。

```text
取得周期
→ いつ外部APIへ問い合わせるか

TTL
→ 取得データをいつまで有効とするか

表示鮮度
→ 利用者にどの程度新しい情報として表示できるか
```

今回のWeatherでは、Domainごとに必要な更新頻度が異なる。

特にRainForecastは、他の天気情報と同じ鮮度条件では扱えない。

このことから、取得処理を一括して管理するのではなく、DomainごとのScheduler・Cache・鮮度条件を設計する必要性を理解した。

**データを取得できていることと、そのデータを現在の情報として表示してよいことは別**である。

---

### RetryだけでなくQuotaとBackoffを合わせて考える

外部APIで通信エラーが発生した場合、Retryすれば回復することがある。

しかし、Retryを無制限に実行すると、障害時ほどAPIへのアクセスが増加する。

その結果、Rate LimitやQuota超過、さらなる障害につながる可能性がある。

```text
取得失敗
↓
Retry可否の判定
↓
Backoff
↓
Quota・Rate Limit確認
↓
次回取得
```

という取得制御が必要になる。

特にHTTP 429のような利用制限に関する応答は、通常の一時的な通信失敗と同じ扱いにしない。

また、あるDomainの取得が失敗しても、他のDomainの正常な取得や公開を妨げない設計が重要になる。

外部API連携では、正常系の取得処理だけでなく、**失敗時に外部サービスと自システムの双方へ過剰な負荷を与えないこと**も設計対象になる。

---

### APIが利用できることと継続利用できることは別

Weather Providerの検討では、Open-MeteoをCurrentWeather・HourlyWeather・WeeklyWeatherに正式採用し、Tomorrow.ioをRainForecastに条件付き正式採用した。

ここで重要だったのは、APIへの疎通成功だけでは採用条件を満たしたとはいえないこと。

確認すべき条件には、次のようなものがある。

- 必要なData Fieldと時間粒度
- APIプランによる利用可能範囲
- 無料枠・課金条件
- Rate Limit
- 利用規約・商用利用条件
- 実際のデータ品質・安定性

Tomorrow.ioについては、1分粒度のrainIntensityなど、利用開始前に確認すべき条件が残っている。

したがって、技術選定では、

```text
正式採用
→ 現時点で必要な採用判断が成立

条件付き正式採用
→ 明示した条件の確認が必要

未検証
→ 実際の動作・性能等は未確認
```

を区別する。

外部サービスの選定は、技術的に接続できるかだけでなく、継続的に利用できる条件まで含めて判断する必要がある。

---

## 2026-10 Raspberry Pi運用・品質保証の技術選定

### System TimeとMonotonic Timeを使い分ける

時間を扱う処理には、現在日時が必要なものと、経過時間が必要なものがある。

```text
System Time
→ 現在日時・予定時刻・データの有効期限

Monotonic Time
→ Timeout・処理時間・経過時間
```

System TimeはNTP等による時刻補正の影響を受ける可能性がある。

一方、Monotonic Clockは経過時間の計測に適している。

今回のサイネージでは、保存・通信にUTCを基本として使用し、画面表示ではAsia/Tokyoを利用する。

また、Pi 5のRTCとBackup Batteryを利用する方針としたが、RTCの存在だけで時刻の正確性が保証されるわけではない。

RTC・OSの時刻同期・Applicationによる時刻利用可否は、それぞれ区別して考える必要がある。

---

### ConfigとSecretsは同じ設定情報でも管理方法が異なる

Applicationには一般的な設定値と、API Keyなどの秘密情報が存在する。

どちらも実行時に読み込む値だが、必要な保護は異なる。

今回の構成では、

```text
一般Config
→ systemd EnvironmentFile

Secrets
→ Git・Release Directory外の
   アクセス制限付きローカルファイル
```

とする方針を採用した。

ConfigとSecretsを分離することで、Gitへの誤登録、Deploy時の上書き、ログへの漏えいなどを防ぐ設計を考えやすくなる。

また、設定ファイルを読み込めたことと、その内容が正しいことも別である。

そのため、起動時のRuntime Validationを行う。

**設定の供給方法・検証方法・変更の反映方法は、それぞれ設計すべき責務**になる。

---

### Logging・Monitoring・Testは目的が異なる

運用の信頼性を高める仕組みとして、Logging、Monitoring、Testがある。

```text
Logging
→ 発生した事象や障害の調査

Monitoring
→ 稼働状態やResourceの変化の把握

Test
→ 定義した条件を満たすかの検証
```

今回の構成では、Pinoとpersistent journald、OS標準のMonitoringを採用した。

72時間連続稼働試験では、CPU・Memory・Temperature・Disk・Service状態などを計測する方針とした。

ただし、ログを保存するだけでは安定稼働を証明できない。

また、計測周期やログ保持容量を決めたことも、性能検証の完了を意味しない。

```text
計測できる
↓
状態を記録できる
↓
受入条件と照合できる
```

という段階を区別する必要がある。

---

### CIによる品質確認とProduction Deployは別

Frontendの技術選定では、将来的なCI/CDとMVPのDeployを分けて考えた。

その後の検討で、MVPからPR検証用CIを導入することを決定した。

今回採用した品質確認は、

```text
ESLint
→ Lint

Prettier
→ Format Check

tsc
→ Type Check

Vitest
→ Test

GitHub Actions
→ PR時の自動実行
```

である。

一方、Production BuildとRaspberry PiへのDeployは、開発PCと手動操作を基本とする。

```text
PR検証の自動化
≠
Production Deployの自動化
```

という区別が重要になる。

CIは、変更を統合する前に品質上の問題を発見するための仕組みであり、必ずしもProductionへの自動配布を伴う必要はない。

必要な品質保証を段階的に導入し、SecretsをCIへ不要に渡さないことも重要な判断になる。

---

### 技術選定完了と実装・検証完了を区別する

今回の技術選定では、Raspberry Pi 5 2GBを対象とする構成や、Backend・Database・Scheduler・運用方式を決定した。

しかし、採用技術を決定したことは、その技術が実機上で期待どおりに動作することを証明したわけではない。

```text
Technology Selection
→ 採用方式と理由を決定する

Implementation
→ 決定した方式を実装する

Verification
→ 実装が要件・受入条件を満たすか確認する
```

これらは別の工程になる。

例えば、better-sqlite3のARM64互換性、Pi 5 2GBの性能、障害復旧、72時間連続稼働は、後続の環境構築・実機試験で確認する。

技術選定の段階ですべての実機検証を完了条件にすると、後続工程で初めて確認できる内容まで先行して要求することになる。

一方、未検証事項を曖昧に残すと、実装段階で確認が漏れる。

そのため、

```text
採用状態
+
未検証事項
+
確認するタイミング
+
担当Issue
```

をセットで記録することが重要になる。

**技術選定は、すべての不確実性を解消する工程ではなく、残る不確実性を明示して次の工程へ引き継ぐ工程でもある。**
