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
| Display Service | サイネージ画面の表示 |
| Schedule Service | 予定情報の取得・管理・提供 |
| Weather Service | 天気情報の取得・管理・提供 |

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

- Display Service
  - ContentSwitcher
  - 時計等の表示要素
  - Config Module
  - Logging Module

- Schedule Service
  - Cache Module
  - Config Module
  - Logging Module

- Weather Service
  - Cache Module
  - Config Module
  - Logging Module

- OS
  - System Time

---

## 9. 未決定事項

次回以降、以下を検討する。

- Service間のデータフロー
- Service間の連携方式に必要な要件
- Schedule / WeatherからDisplayへデータを渡す流れ
- Service停止時のデータ利用
- キャッシュ利用時のデータフロー
- 状態管理
- 起動・復旧
- その他のアーキテクチャ設計項目

具体的な通信技術・保存技術等は、
原則としてIssue #4で選定する。