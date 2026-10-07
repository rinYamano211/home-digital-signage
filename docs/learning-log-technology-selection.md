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

---

## 今回の技術選定から得た考え方

Frontend開発・Build・Deploy方式の検討を通して、特に以下を今後のTechnology Selectionでも意識する。

- ArchitectureとTechnology Selectionを分け、採用したい技術に既存Architectureを不要に引っ張らせない。
- 技術名だけで比較せず、それぞれが担う責務を明確にする。
- Frameworkは機能数の多さではなく、要件に対する必要十分性で選ぶ。
- Futureへの自由度を確保することと、Future機能を先行実装することを混同しない。
- Programming ModelがArchitecture上のState Flowや責務境界と適合するか確認する。
- Type SafetyをCoding補助だけでなくData Contractを明確にする手段として考える。
- Transformation、Type Check、Test、Build等、似て見える工程でも責務を分けて考える。
- Development ToolとProduction Runtimeを分離する。
- 「実行できる場所」と「その責務を持たせるべき場所」を分けて判断する。
- Resource制約のあるEdge Deviceでは、Productionで不要な処理を外部へ出すことを検討する。
- Build Artifactを明確な境界にすると、Development PCからCI等へBuild主体を変更しやすい。
- FutureでCI/CDを使いたいことと、MVPでCI/CDを導入することは別のDecisionとして考える。
- Source Code ManagementとArtifact Deploymentの責務を分ける。
- Artifactの転送方法とProduction Versionの切替方法を別のDecisionとして考える。
- Production Directoryへの直接上書きでは、Deploy途中の中間状態が利用者から見える可能性を考慮する。
- 新Versionを別Releaseとして完成させてから切り替えることで、Transfer FailureとProductionへの影響を分離できる。
- Rollbackを考慮すると、Release単位でVersionを保持する構成が有効になる。
- Deployの安全性を高める場合も、システム規模に対して過剰なInfrastructureを導入しない。
- 学習目的を理由にArchitecture上不要な責務を追加しない。
- Technology Selectionでは方式・責務・境界を決め、具体的なCommandやPath等のImplementation Detailは必要な段階まで固定しない。
- Futureへの備えはFuture技術の先行導入ではなく、後から交換できる境界を作ることで実現する。