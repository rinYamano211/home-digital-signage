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

- 表示対象コンテンツの決定
- 表示順序の管理
- 表示時間の管理
- 次に表示するコンテンツの決定
- 表示可能なコンテンツの扱い

独立ServiceとするとDisplayとの通信・依存関係が増え、
Content Switching Service障害時の処理も新たに必要となる。

またFutureの表示順序・ON/OFF・表示時間変更についても、
Display内部で責務を分離しておけば対応可能と考える。

将来必要になった場合に切り出せるよう、
描画処理とは責務を分離する。

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

CacheとService間で公開するPublished State、Displayが持つDisplay Stateは区別する。
所有権とデータフローは第9章に示す。

具体的な保存方式はIssue #4で決定する。

---

## 6. Config

Configは独立Config Serviceとはせず、
共通Config Moduleを利用しながら、
各Serviceが自身の設定に対する責任を持つ構成を基本とする。

MVPではローカルに保持された設定を利用する。

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
  - Published Stateの参照（Read Only）
  - Display State
  - Renderer
  - ContentSwitcher
  - 時計等の表示要素
  - Config Module
  - Logging Module

- Schedule Service（Backend）
  - schedule Published Stateの公開
  - Cache Module
  - Config Module
  - Logging Module

- Weather Service（Backend）
  - weather Published Stateの公開
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
自身のドメインにおける現在の表示可能な状態をPublished Stateとして公開する。
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
→ Display State
→ Renderer
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
- Display Service再起動時にも現在Stateを復元できる構成にしたい
- State管理専用Serviceを追加して新しい共通障害点を作りたくない

専用Serviceを設けなくてもStore自体は共通依存となる。
この点を踏まえ、Storeの障害を各Serviceの停止へ直結させない方針を9.7に示す。
News、Stock、Photo等の追加はFutureであり、MVPの実装対象には含めない。

### 9.4 Stateの所有権とデータ契約

Shared State Storeを利用しても、Stateの所有権は各Serviceに持たせる。

| Service | Published Stateへの関与 |
|---|---|
| Weather Service | weather Stateの所有者・Writer |
| Schedule Service | schedule Stateの所有者・Writer |
| Display Service | Published StateをRead Onlyで利用する |
| Futureで追加するBackend Service | 自身のPublished Stateを所有・公開する |

各Backend Serviceは他Serviceが所有するStateを書き換えない。
Backend Service内部のデータ構造とPublished Stateを分離し、
Published StateをService間のデータ契約として扱う。

### 9.5 Published Stateと有効期限

Published Stateには表示データに加え、
提供元Serviceが停止していてもDisplay側で表示可否を判断できるメタデータを含める。

現時点の概念項目は以下とする。具体的なSchemaは未確定。

- data
- updatedAt
- expiresAt
- status

データの有効期限そのものは、
そのデータの意味を理解しているBackend Serviceが決定する。
DisplayはWeatherやSchedule固有のTTLを持たず、
Published StateのexpiresAt等を基に表示可否を判断する。

具体的なSchema、各項目の厳密な意味・粒度、Schema変更管理は今後の設計で具体化する。
情報種別ごとの鮮度・期限切れ・部分取得失敗の扱いは、
[要件定義](requirements.md)のR-04/R-07を満たすものとする。
取得周期・TTLの数値は同文書の暫定値を維持し、Issue #4で再評価する。

### 9.6 Cache / Published State / Display Stateの区別

| 状態 | 所有者 | 目的 |
|---|---|---|
| Cache | 各Backend Service | 外部データ取得失敗時の再利用・復旧 |
| Published State | 各Backend Service | 他Serviceへ提供する現在状態 |
| Display State | Display Service | 表示・描画および一時的な表示継続 |

Display ServiceからBackend Service内部のCacheを直接参照しない。
Backendは自身のCacheを利用した場合もPublished Stateを通じて現在状態を提供し、
DisplayはPublished Stateから表示に必要なDisplay Stateを扱う。
Cacheの管理責任と共通Cache Moduleの責務は第5章に従う。

### 9.7 障害時の動作

Shared State Storeの障害を各Service自身の停止理由にはしない。
Storeへアクセスできない場合も、可能な範囲で以下を継続する。

- Backend Serviceは外部データ取得と自身のCache管理を継続する
- Display Serviceは保持済みの有効なDisplay Stateで表示を継続する
- 一部Stateが利用不能でも、他の正常なコンテンツは表示を継続する

Backend Service停止時も、
Shared State Storeに残るPublished Stateが有効期限内であればDisplayは利用できる。
Display Service再起動時は現在のPublished Stateを参照し、
有効な情報から表示状態を復元できる構成を目指す。

期限切れStateは表示に利用しない。
保持済みのDisplay Stateによる一時的な継続でも、この原則を変えない。

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

---

## 10. 未決定事項

A-03の基本方針は第9章で決定した。
以下の詳細およびその他のアーキテクチャ設計項目は、次回以降に具体化する。

- Published Stateの具体的なSchema、メタデータの意味・粒度、Schema変更管理
- Shared State Storeへの同時アクセスと状態更新・参照の扱い
- Store障害・Service停止時の具体的な状態判定と復旧手順
- CacheからPublished Stateへの反映、Display Stateの更新・復元の詳細
- 状態管理、起動・復旧の詳細
- その他のアーキテクチャ設計項目

Shared State Storeの実現技術を含む具体的な通信技術・保存技術等は、
Issue #4で選定する。
