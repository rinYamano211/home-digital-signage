# システムアーキテクチャ設計

## 1. このドキュメントの目的

Home Digital Signage のMVP要件を実現するため、
システム全体の構成、各コンポーネントの責務、
データ・状態の流れ、障害時の動作などを設計する。

具体的な技術・ライブラリ・外部サービスの選定は、
原則として Issue #4「技術スタックを選定する」で行う。

---

## 2. 設計方針

### 2.1 MVPとFuture

MVPではRaspberry Pi上で動作するHome Digital Signageを中心に構築する。

Futureでは、iPadやPC等のWeb管理画面から、
表示内容・配置・サイズ・各種設定などを変更できる構成を想定する。

MVPの段階でCloud/Web管理機能そのものを実装するのではなく、
将来の追加・変更時に既存機能への影響を小さくできるよう、
責務の境界を意識して設計する。

### 2.2 サービス分割方針

各主要機能についてMSAの考え方を取り入れ、
責務・変更理由・外部依存・障害境界・ライフサイクルを基準に
サービス境界を決定する。

独立ServiceはRaspberry Pi上でそれぞれ独立した実行単位とし、
個別に起動・停止・再起動できる構成を目指す。

ただし、機能が異なることだけを理由にService化せず、
独立した実行単位にするメリットがあるかを判断する。

判断の基本方針は以下とする。

| 分類 | 判断基準 |
|---|---|
| 独立Service | 独立した責務を持ち、独立起動・停止や障害分離に意味がある |
| Service内部Module | 責務は分離したいが、独立実行するメリットが小さい |
| Common Module | 複数Serviceで共通利用したいが、共通障害点にはしたくない |

---

## 3. 現時点のシステム構成

### 3.1 独立Service

| Service | 主な責務 |
|---|---|
| Display Service | Frontend。Published Stateに基づく表示判断・描画 |
| Schedule Service | Backend。予定情報の取得・加工・管理とPublished Stateの公開 |
| Weather Service | Backend。天気情報の取得・加工・管理とPublished Stateの公開 |

Display / Schedule / Weather は、
責務・変更理由・外部依存・障害原因などが異なるため、
独立Serviceとして扱う。

### 3.2 Common Module

| Module | 主な責務 |
|---|---|
| Cache Module | キャッシュの保存・読出し・削除等の共通処理 |
| Config Module | 設定の読出し・保存等の共通処理 |
| Logging Module | ログ出力形式・保存等の共通処理 |

Common Moduleは独立プロセスとはせず、
必要なServiceから共通利用する。

---

## 4. Display Service

### 4.1 時計表示

Clock Serviceは設けない。

時刻を必要とする各ServiceはOSが管理するシステム時刻を利用する。
時計・日付・曜日の描画はDisplay Serviceの責務とする。

Clock Serviceを共通の依存先にすると、
Clock Serviceの障害が他Serviceへ波及する可能性があるため、
不要なService間依存を作らない。

Futureでは時計を含む表示要素の位置・サイズ等を
利用者がカスタマイズできることを想定する。

そのため、Display Service内部でも時計等の表示要素を
分離可能な構造を検討する。

具体的なUI構造はIssue #5および実装設計で決定する。

### 4.2 Content Switching

Content Switchingは独立Serviceにせず、
Display Service内部の独立した責務として持つ。

ContentSwitcherは主に以下を担当する。

- 切替対象内で表示するコンテンツの決定
- 表示順序の管理
- 表示時間の管理
- 次に表示するコンテンツの決定
- 表示可能なコンテンツの切替対象としての扱い

独立ServiceとするとDisplayとの通信・依存関係が増え、
Content Switching Service障害時の処理も新たに必要となる。

またFutureの表示順序・ON/OFF・表示時間変更についても、
Display内部で責務を分離しておけば対応可能と考える。

将来必要になった場合に切り出せるよう、
描画処理とは責務を分離する。

### 4.3 Display Component / Layout / ContentSwitcher

Display Service内部では、以下の責務を分離する。

| 責務 | 担当すること |
|---|---|
| Display Component | 内容。「何を、どう表示するか」 |
| ContentSwitcher | 時間軸。「切替対象の中から、いつ・どれを表示するか」 |
| Layout | 空間軸。「どこに、どの大きさで表示するか」 |

Display ComponentはLayoutから与えられた表示領域・サイズに応じ、
情報量や内部UIを適応させる。
Futureでは利用者がComponentのサイズを変更した場合も、
その領域に適したUIをComponent側で構成できるようにする。
具体的なサイズ区分やレスポンシブ方式は現時点では決定しない。

LayoutはComponentの配置位置と割り当て領域を管理し、
WeatherやScheduleなどのドメイン固有の表示判断は持たない。

MVPのContentSwitcherはSchedule、TodayWeather、WeeklyWeatherを切替対象とし、
切替順序、表示時間、現在の切替位置などを扱う。
Clock / Date / Weekdayなどの常時表示Componentは、
ContentSwitcherを経由せず直接Layoutへ配置する。

ただし、常時表示か切替表示かは画面構成上の扱いとし、
「Clockは常時表示Componentである」という性質をComponent自体には持たせない。
Futureで同じComponentを別の画面構成でも利用できる余地を残す。

### 4.4 Published State取得とComponent用State生成

Display Component自身はShared State Storeを直接参照しない。
Display Service内部にPublished Stateを取得する共通責務を設け、
取得したStateをDisplay内部へ渡す。
これにより、Storeの実装・取得方式が変わった場合のComponentへの影響を抑える。

さらに、Published StateをそのままComponentへ渡して状態解釈をすべて任せるのではなく、
Componentが表示に利用するStateを生成する責務を分離する。

概念的な流れ：

```text
Published State
→ Published State取得責務
→ Component用State生成責務
→ Display Component
```

例えばTodayWeatherではCurrentWeather、HourlyWeather、RainForecastなど、
複数のPublished StateからComponent用Stateを生成できる。

- Backend Service：他Serviceへどの情報を提供するか
- Component用State生成責務：その情報からComponentが何を表示できるか
- Display Component：渡された表示情報をどう描画するか

Component用Stateは以降、仮称としてComponent Stateと呼ぶ。
意味変化ベースの再評価と部分障害時の状態表現は第11章に示す。
具体的なクラス名、取得方式、Component StateのSchemaや表示可否interfaceは後続設計で決定する。

---

## 5. Cache

Cacheは独立Serviceにしない。

Schedule ServiceやWeather Serviceなど、
各Serviceが自身のキャッシュに対する管理責任を持つ。

一方、ドメインに依存しないキャッシュ処理は
共通Cache Moduleとして再利用する。

### 各Serviceの責務

- 何をキャッシュするか
- データをいつまで有効とするか
- 期限切れデータをどう扱うか

### Cache Moduleの責務

- 保存
- 読出し
- 更新
- 削除
- 指定された有効期限に基づく期限判定

これにより、保存処理を共通化しながら、
Cache Serviceという共通障害点を作らない構成とする。

Cache State、Published State、Component State、Display Runtime Stateは区別する。
所有権とデータフローは第9章、永続化方針は第10章に示す。

具体的な保存方式はIssue #4で決定する。

---

## 6. Config

Configは独立Config Serviceとはせず、
共通Config Moduleを利用しながら、
各Serviceが自身の設定に対する責任を持つ構成を基本とする。

MVPではローカルに保持された設定を利用する。
ConfigとDisplay Runtime Stateの区別、再起動を跨ぐ保持方針は第10章に示す。

FutureではiPad等のWeb管理画面から、
レイアウト・表示内容・各種設定を変更し、
Raspberry Piへ反映できる構成を想定する。

そのため各Serviceがローカル設定ファイルやCloudへ直接依存せず、
設定の供給元と設定を利用するServiceの間に境界を設ける。

概念的には以下を想定する。

MVP:

Local Config
→ Config
→ 各Service

Future:

Web / Cloud
→ Config Provider
→ Config
→ 各Service

Web管理からの変更を反映操作で適用するか、
リアルタイム同期するか、
またCloud-Pi間の具体的な通信方式はFutureの設計で決定する。

---

## 7. Logging

Loggingは独立Logging Serviceとはせず、
各Serviceが共通Logging Moduleを利用する。

各Serviceは自身で発生したイベント・エラー等のログを生成する。

Logging Moduleは、
ログの形式や保存等の共通処理を担当する。

ログにはServiceを識別できる情報を含め、
Service単位・ログレベル等で調査できる構造を目指す。

これによりログを統一的に管理しながら、
Logging Serviceを全Serviceの共通依存先にすることを避ける。

FutureではローカルログをCloudへ転送し、
Web管理・監視等から確認できる構成への拡張を想定する。

---

## 8. 現時点の構成イメージ

Raspberry Pi

- Display Service（Frontend）
  - Published State取得責務（Read Only）
  - Component State生成責務・Component State（仮称）
  - Display Component（時計等の表示要素を含む）・Renderer
  - Layout
  - ContentSwitcher
  - 各責務が持つDisplay Runtime State（仮称）
  - Config Module
  - Logging Module

- Schedule Service（Backend）
  - schedule Published Stateの公開
  - Cache Module
  - Config Module
  - Logging Module

- Weather Service（Backend）
  - CurrentWeather / HourlyWeather / RainForecast / WeeklyWeatherのPublished State公開
  - Cache Module
  - Config Module
  - Logging Module

- Shared State Store
  - 各Backend Serviceが所有するPublished Stateの共有先
  - State管理専用Serviceは設けない。実現技術はIssue #4で決定

- OS
  - System Time

---

## 9. A-03：データフロー／Service間連携

2026-09-16時点の設計判断として、MVPでは共有State方式を採用する。

### 9.1 Frontend / Backendの責務

Display Serviceを表示を担当するFrontendとして扱う。
Schedule Service、Weather Service等を、データ取得・加工を担当するBackendとして扱う。

Backend ServiceはDisplayへ表示命令を出さず、
自身のドメインにおける現在提供可能な情報をPublished Stateとして公開する。
Display ServiceはPublished Stateを利用し、
何を・いつ・どのように表示するかを自身で判断する。
表示対象・切り替えの判断は第4章のDisplay Serviceの責務と整合させる。

### 9.2 比較した連携方式と採用判断

以下の3方式を比較した。

| 方式 | MVPでの判断 |
|---|---|
| 直接連携 | 採用しない |
| Pub-Sub | MVPの中心となる連携方式には採用しない。Futureの更新通知として検討可能 |
| 共有State | 採用。BackendがShared State Storeへ公開し、Displayが必要なPublished Stateを参照する |

概念的なデータフローは以下とする。

```text
External API
→ Backend Service
→ Published State
→ Shared State Store
→ Display Service
→ Component State生成
→ Display Component / Renderer
```

Shared State StoreはService間で現在状態を共有するための保存先として扱う。
State管理専用Serviceは追加しない。
具体的な実現技術はIssue #4で決定し、
HTTP、DB、ファイル、MQTT等をここでは採用決定しない。

### 9.3 採用理由とデメリット

共有State方式には以下のデメリットがある。

- Shared State Storeが共通依存になる
- Schemaを介してProducerとConsumerが密結合になる可能性がある
- Stateの所有権が曖昧になる可能性がある
- 同時アクセスを考慮する必要がある
- CacheとShared Stateの責務が混同される可能性がある
- Published StateのSchema変更管理が必要になる
- MVPだけを考えれば直接連携より構成が複雑になる

それでも、以下の理由から採用する。

- FutureでNews、Stock等のBackend Service追加を想定している
- Service追加によってDisplayと各Backend Serviceの直接依存を増やしたくない
- Backend Service停止時にも最後の有効なPublished Stateを利用したい
- Display Service再起動時にも現在のPublished Stateから表示に必要なStateを再構築できる構成にしたい（表示位置の復元とは区別する）
- State管理専用Serviceを追加して新しい共通障害点を作りたくない

専用Serviceを設けなくてもStore自体は共通依存となる。
この点を踏まえ、Storeの障害を各Serviceの停止へ直結させない方針を9.7に示す。
News、Stock、Photo等の追加はFutureであり、MVPの実装対象には含めない。

### 9.4 Stateの所有権とデータ契約

Shared State Storeを利用しても、Stateの所有権は各Serviceに持たせる。

| Service | Published Stateへの関与 |
|---|---|
| Weather Service | 天気の各Published Stateの所有者・Writer |
| Schedule Service | schedule Stateの所有者・Writer |
| Display Service | Published StateをRead Onlyで利用する |
| Futureで追加するBackend Service | 自身のPublished Stateを所有・公開する |

各Backend Serviceは他Serviceが所有するStateを書き換えない。
Backend Service内部のデータ構造とPublished Stateを分離し、
Published StateをService間のデータ契約として扱う。

### 9.5 Published Stateの情報単位と有効期限

Published StateはService単位や外部APIレスポンス単位ではなく、
「鮮度・有効期限・障害状態を独立して管理する意味がある情報単位」で分割する。

Weather Serviceでは概念的に以下を持ち、それぞれ独立して鮮度・有効期限・状態を管理できる。

- CurrentWeather
- HourlyWeather
- RainForecast
- WeeklyWeather

Schedule Serviceなど独立管理する必要がない場合は無理に細分化しない。
細かくすること自体が目的ではなく、時間的・状態的に独立管理する意味がある単位で分ける。
Service境界、Published State境界、Display Component境界は一致する必要がない。
これらは概念上の情報単位であり、具体的なクラス名やAPIを確定するものではない。

Published Stateには表示データに加え、
提供元Serviceが停止していてもDisplay側で利用可能性を判断できるメタデータを含める。

A-03ではdata / updatedAt / expiresAt / statusを概念項目として挙げた。
A-05では、異なる意味の時刻を単一のupdatedAtへまとめず、必要なmetadataを区別する方針へ具体化した。
具体例と論理Schema原則は11.5に示す。具体Schemaやstatusの値は引き続き未確定。

データの有効期限そのものは、
そのデータの意味を理解しているBackend Serviceが決定する。
DisplayはWeatherやSchedule固有のTTLを持たず、
Published StateのexpiresAt等を基に、各Published Stateが利用可能かを判断する。
その上で、Componentとして何を表示できるかは、Display Service内部のComponent State生成責務で整理する。

情報単位の分割方針と、具体的なSchema・各メタデータの厳密な意味や粒度は区別する。
後者とSchema変更管理は今後の設計で具体化する。
情報種別ごとの鮮度・期限切れ・部分取得失敗の扱いは、
[要件定義](requirements.md)のR-04/R-07を満たすものとする。
取得周期・TTLの数値は同文書の暫定値を維持し、Issue #4で再評価する。

### 9.6 Stateの分類と所有権

A-03までの検討では表示側の状態をDisplay Stateと総称していた。
2026-09-17の整理では、その責務をComponent StateとDisplay Runtime Stateに分け、
Stateを以下の4種類として扱う。表示側2種類の名称は仮とする。

| State | 所有者 | 目的 | 生成・更新 | 実行中の保持先 |
|---|---|---|---|---|
| Cache State | 各Backend Service | 外部API等の取得失敗時のデータ再利用とBackend自身の復旧・継続動作 | 各Backend Service | 各Backend Service配下のCache |
| Published State | 各Backend Service | 他Serviceへ現在提供可能な情報を公開するService間データ契約 | 各Backend Service | Shared State Store |
| Component State（仮称） | Display Service | Published State等をComponentが描画に利用しやすい状態へ整理 | Display内部のComponent State生成責務 | Display Service内部 |
| Display Runtime State（仮称） | Display Service内部の各責務 | Display自身の現在の動作状態 | 原則としてそのStateを必要とする責務 | Display Service内部の各責務 |

Common Cache Moduleは保存・読込等の共通機構を提供し、
Cache Stateそのものの所有者にはならない。Cacheの管理責任は第5章に従う。

各Backend Serviceは自身のPublished Stateのみを書き込み、
Display ServiceはRead Onlyで利用する。
DisplayからBackend内部のCacheを直接参照しない。
BackendがCacheを利用した場合も、Published Stateを通じて現在状態を提供する。

Component StateはShared State Storeへ戻さず、Backendからも参照しない。
Display Runtime Stateはcurrent component / current switch index / next switch timeなどを指し、
一つの巨大なRuntime State Managerへ集約しない。

Component State / Display Runtime Stateの正式名称と具体構造は後続設計で決定する。

### 9.7 障害時の動作

Shared State Storeの障害を各Service自身の停止理由にはしない。
Storeへアクセスできない場合も、可能な範囲で以下を継続する。

- Backend Serviceは外部データ取得と自身のCache管理を継続する
- Display Serviceは保持済みの有効なComponent Stateで表示を継続する
- 一部Stateが利用不能でも、他の正常なコンテンツは表示を継続する

Backend Service停止時も、
Shared State Storeに残るPublished Stateが有効期限内であればDisplayは利用できる。
Display Service再起動時は現在のPublished Stateを参照し、
有効な情報からComponent Stateを再生成できる構成とする。
システム再起動後のPublished State再生成とRuntime State初期化は第10章に示す。

期限切れStateは表示に利用しない。
保持済みのComponent Stateによる一時的な継続でも、この原則を変えない。

表示の継続は[要件定義](requirements.md)のR-04/R-06/R-07に従う。
正常取得時は不要な異常状態の注記や最終更新日時を表示しない。
Backend ServiceがCacheを利用してPublished Stateを生成した場合も、
Display ServiceはBackend内部のCacheを直接認識・参照せず、Published Stateを利用する。
取得異常であること、および必要な最終更新日時等を、
DisplayがPublished State経由で識別・表示できる構成とする。
具体的なPublished State Schemaやstatusの値・粒度は今回確定せず、
今後の状態管理設計で具体化する。
期限切れ・利用可能なデータがない場合は取得失敗状態とし、
複合コンテンツの一部だけが失敗しても正常・有効な情報は表示を継続する。
外部情報の取得・利用可否によって基本画面の起動や正常な別コンテンツの表示を妨げない。

Store障害・Service停止を含む具体的な状態判定、再アクセス・再公開・復旧の手順は今後の設計で具体化する。

### 9.8 Futureの更新通知

MVPではShared Stateを中心とする。
Futureでリアルタイム更新通知が必要になった場合は、
Shared StateとPub-Sub等の更新通知を組み合わせる構成を検討できる。

- Shared State：現在どうなっているか
- Event：何が起きたか

具体的な通知方式は現時点では決定しない。

### 9.9 一方向のStateフロー

Stateの依存方向は原則として以下とする。

```text
Backend
→ Published State
→ Display
→ Component State
→ Display Component
```

下流側から上流側のStateを書き換えない。
DisplayはPublished Stateを読み取るが書き換えず、
Display ComponentもPublished Stateを直接変更しない。

---

## 10. Stateの永続化と再構築

### 10.1 永続化の基本方針

すべてのStateを永続化するのではなく、
「再生成できない、または再生成するために必要なStateを永続化する」ことを基本とする。

| State | 再起動を跨ぐ保持方針 |
|---|---|
| Cache State | 再起動後の外部取得失敗に備えて保持する。有効なCacheからBackendがPublished Stateを再生成できる |
| Published State | 実行中はShared State Storeに保持する。システム再起動を跨ぐ永続化はMVPでは必須とせず、有効なCache State等からBackendが再生成する |
| Component State | 永続化しない。必要に応じてPublished State等から再生成可能な派生Stateとして扱う |
| Display Runtime State | 原則として永続化しない。MVPではContentSwitcher等を初期状態から開始してよく、再起動直前の表示位置の復元は要求しない |

Backend Service単体が停止した場合は、Shared State Storeに最後にPublishされたStateを残せる構造とする。
Displayは有効期限内のStateを利用できる。
これはシステム再起動を跨ぐPublished Stateの永続化を必須としない方針とは区別する。

switch order、display duration、将来の利用者指定Layoutなど、
「現在どう動いているか」ではなく「どう動くべきか」を表す情報はRuntime StateではなくConfigとして扱う。
必要なConfigは永続化し、MVPの保存済み設定は再起動後も保持する。
利用者指定Layoutの機能自体はFutureのままとする。

### 10.2 再起動時の基本的な再構築

概念的には以下の流れで、必要最小限の永続Stateから現在の正しい状態を再構築する。
再起動前の派生Stateをすべて復元する方針ではない。

```text
永続化されたConfig / Cache State
↓
Backend Service起動
↓
Published State再生成
↓
Display ServiceがPublished Stateを取得
↓
Component State再生成
↓
Display Runtime Stateを初期化
↓
画面表示
```

この図はStateの再構築を示すもので、基本画面の起動をBackendの再生成・外部取得完了まで待たせる順序指定ではない。
[要件定義](requirements.md)のR-01/R-06に従い、基本画面は外部情報取得を待たずに起動し、
時刻未同期時は未同期状態を表示する。外部情報が利用できない場合の表示はR-07に従う。
具体的な起動・再構築のタイミングや同期方式は後続設計で決定する。

---

## 11. A-05：State Management

2026-09-19時点でState Managementの設計方針を確定した。
State分類・所有権・一方向フローは第9章、永続化と再構築は第10章に統合し、
本章では再評価・利用可能性・部分障害・論理Schema・State間整合性を定める。
具体技術と詳細Schemaの確定は含まない。

### 11.1 Component Stateの再評価

MVPでは固定周期を基本とせず、
Component Stateの表示上の意味に影響する変化を契機に必要なStateを再評価する
「意味変化ベース」を採用する。

概念的な再評価契機：

- Published Stateの更新
- expiresAt到達など、時間経過によるPublished Stateの利用可能性変化
- Config変更
- 現在時刻・日付の変化によるComponent上の意味変化
  - Scheduleの「現在の予定 / 次の予定」の切り替わり
  - 日付変更など

MVPでは更新契機の取りこぼしに対する周期的な再評価を必須としない。
周期再評価をArchitecture上禁止するものではなく、
Futureで自己回復性が必要になった場合には追加可能とする。
時間による意味変化をtimer / scheduler / polling等でどう検出・起動するかは今回決定しない。

### 11.2 再評価の責務分担

Display内部で「共通的な変化の検出」と
「Component固有の再評価判断・Component State生成」を分離する。
共通責務はComponent固有の表示ロジックを持たない。

各Component State生成責務が、自身に必要なPublished State、
Current Time / Date、Config等を基に、
再評価要否と生成するComponent Stateを判断する。
共通のTime側が「Scheduleを更新する」といったComponent固有知識を持つ構造にはしない。

具体的な変更検出・通知・スケジューリング方式は技術選定・詳細設計で決定する。

### 11.3 Published Stateの利用可能性

Backendはデータ本体と、利用可能性の判断に必要なmetadataを提供する。
DisplayはPublished Stateと現在のEvaluation Contextを基に、利用時点で利用可能性を判断する。

Backend内部のAPI取得成功／失敗、Cache利用有無、Retry状況など、
内部処理の事情にDisplayを依存させない。
例えばBackendがAPI取得に失敗しても、有効なCacheから利用可能なPublished Stateを生成できれば、
DisplayはそのPublished Stateを通常の利用可能な情報として扱える。

Shared State Store上に存在することと、現在利用可能であることは別概念とする。
期限到達時にStoreから必ず削除することは要求せず、
Displayが利用時点で利用可能性を評価する。

**既存要件との照合事項**

今回の「通常の利用可能な情報」という表現は、
既存9.7およびR-07が要求する取得異常時の更新状態・最終更新日時の注記まで
不要にする意味にも読める。
A-05以前の決定は変更せず、注記要件は維持する。
利用可能性と利用者向け更新状態の表現を結ぶ具体的なデータ契約は後続設計で具体化する。
注記要件自体の変更を意図する場合は、別途判断が必要となる。

### 11.4 部分障害時のComponent State

一部のPublished Stateが利用不可でも、
利用可能なPublished Stateから可能な範囲でComponent Stateを生成する。
すべてのPublished Stateが揃うことを成立の共通条件にはしない。

各Component State生成責務が以下を判断する。

- どの情報があればComponent Stateを成立させられるか
- 一部情報が欠落した場合に何をComponent Stateへ含めるか

MVPではFull / Partial / Unavailableのような共通状態enumを
Component Stateに明示的には保持しない。
含まれる利用可能な情報そのもので状態を表現する。

TodayWeather Component Stateの概念例：

```text
currentWeather = data
hourlyWeather = data
rainForecast = null
```

これは一部情報が利用できない状態の例であり、具体的なSchema・型を確定するものではない。
Component Stateを成立させられない場合の具体的UI
（非表示、エラー表示、代替表示等）はA-05では決定しない。
既存R-04/R-07の正常情報の継続表示・取得失敗状態の伝達は維持する。

### 11.5 Stateの論理Schema原則

すべてのStateに同一Schemaを強制せず、各責務に必要な情報のみ保持する。

| State | 保持する情報 |
|---|---|
| Cache State | Backendが再利用・復旧するために必要な情報 |
| Published State | 他Serviceが利用するデータ本体と、利用可能性・鮮度・更新等の判断に必要なmetadata |
| Component State | Display Componentの描画に必要な情報。Published Stateのmetadataを無条件にコピーせず、UIとして必要な場合のみ含める |
| Display Runtime State | Display内部の各責務が現在の動作を継続するために必要な情報 |

Published Stateの時刻metadataは、
意味の異なる情報を曖昧な単一のupdatedAt等へ統合しない。
必要に応じ、例えば以下の意味を区別する。

| 概念例 | 意味 |
|---|---|
| dataTimestamp | データ自体が基準とする時刻 |
| publishedAt | Published Stateを生成／公開した時刻 |
| expiresAt | 利用可能期限 |

すべてを全Published Stateの必須項目とはせず、各Stateに必要なmetadataのみ保持する。
具体的なSchema・型・serialization形式・必須／Optionalは詳細設計で決定する。

### 11.6 Published State間の整合性

MVPでは複数Published State間の厳密な時点整合性・transactional consistencyを要求しない。
それぞれ独立した情報単位として扱い、
Component State生成時には各Published Stateを個別に利用可能性評価し、
その時点で利用可能なものを使用する。

TodayWeatherのCurrentWeather / HourlyWeather / RainForecastについても、
dataTimestampや更新タイミングが完全に一致することは要求しない。
複数Published Stateのatomicな取得・更新もMVP要件とはしない。

State間の整合性を要求しないことは、
個々のPublished Stateの利用可能性確認を省略することではない。

---

## 12. 未決定事項・後続設計への申し送り

A-05の設計方針は第9〜11章に反映した。以下の具体技術・詳細は後続のIssue #3設計またはIssue #4以降で扱う。

- Component State / Display Runtime Stateの正式名称
- Published State / Component Stateの具体Schema・型・serialization形式、metadataの必須／Optional
- Published Stateのstatus等の具体表現、利用可能性と利用者向け更新状態のデータ契約
- displayable等の具体的な表示可否interface（MVPのComponent Stateに共通状態enumを持たせない方針は確定）
- Componentごとの具体的な表示成立条件・欠落情報の扱いと、成立しない場合の具体UI
- Shared State Storeの具体技術、State取得方式（polling / notification等）
- 共通変化検出とComponent State生成の具体クラス構造・連携方式
- timer / scheduler等による時間変化検出・再評価起動の実装
- State更新・通知の具体タイミング・同期方式
- Concurrent access、個々のPublished Stateの読み書きの扱い、schema versioning
- 複数Stateの厳密な時点整合性・atomic取得更新をMVPで要求しない方針を踏まえた具体実装
- Store障害・Service停止時の状態判定、再公開・復旧手順
- CacheからPublished Stateへの反映、Component State再生成、起動・復旧の具体処理
- Futureの周期再評価による自己回復性、Cloud連携方式
- Futureの具体的なLayoutカスタマイズ、Componentのサイズ区分・レスポンシブ方式
- その他のアーキテクチャ設計項目

HTTP / DB / MQTT、framework、transaction実装等の採用は今回決定しない。
