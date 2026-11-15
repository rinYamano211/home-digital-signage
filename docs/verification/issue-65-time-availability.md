# Issue #65：表示用時刻の利用可否の実機確認

## 範囲と状態

[技術スタック選定 第25章](../technology-stack.md#display-time-availability)の判定（PR #110）と、[Frontend開発手順 第13章](../frontend-development.md#13-表示用時刻の利用可否issue-65)の表示への接続（PR #111）を、Raspberry Piで確認した。確認はユーザーが手動で行った。

- 確認日：2026-11-15（設計前の事前確認は2026-11-14。結果は[第25章 25.1](../technology-stack.md#display-time-availability)）
- 対象：PR #111のMerge後の`main`（Merge Commit 3e34268）。Pi上の成果物とCommitの照合は記録していない
- 環境：Raspberry Pi 5、Raspberry Pi OS、systemd-timesyncd、Chromium（通常のウィンドウ）。**RTCのバックアップ電池なし**
- 判定：結果はすべてIssue #65の期待どおり（下記V1〜V6）。範囲外の観察は「範囲外で観察したこと」に分けた

## 方法

本番の配置（nginx・systemd・自動起動）は#12の範囲のため、Issue #93と同じ一時ディレクトリ（`~/signage-check`）で手動で起動した。

- Frontend：開発PCで`npm run build:frontend`を実行し、`dist/frontend/`をPiへ転送した。Pi上で`npx vite preview --config vite.frontend.config.ts --host 127.0.0.1 --port 4173 --strictPort`で配信した。`preview`は開発サーバーの`/api`の転送設定を引き継ぎ、Backend（127.0.0.1:3000）へ転送した（V3の記録で、配信経由のAPIが値を返したことを確認）。
- Backend：`npm run build:backend`の後、`backend.env`を読み込んで`npm run start:backend`で起動し、出力を`backend.log`へ追記した。
- Chromium：`--incognito --new-window`で`http://127.0.0.1:4173/`を開いた（ターミナルを操作するため、Kioskモードは使わなかった）。
- 記録：Wi-Fiを切るとSSHが使えないため、Piのデスクトップで記録用のスクリプトを実行した。スクリプトは、OSの時刻、`NTPSynchronized`、RTCの`since_epoch`、APIの応答（Backend直接・配信経由）、Backendのログ（`time_availability_changed`・`time_evidence_*`）をファイルに追記する。
- 自動起動がないため、「起動直後」は、Piが起動した後に手動でBackendと画面を起動した時点を指す。

### 記録の出どころ

- 記録用スクリプトの出力は、V1・V2・V3の3回分がある。見出しの時刻（ユーザーが入力したラベル）は、V2が14:26でV1（15:04）より前になっているなど、実際の順序と合わない箇所がある。元の記録は変更していない。
- **V4〜V6には、記録用スクリプトの出力がない**。Backendのログ、APIの応答（`curl`）、画面の目視に基づく。
- Backendのログで確認した起動時刻（`database_status`、JST）：14:56、15:17、15:39、15:49、21:29（V4。時計は遅れていた）、22:13（V6の再起動）。

## 結果

### V1：通常の起動（Wi-Fiあり）：PASS

- APIは`200`・`cache-control: no-store`・`{"availability":"available"}`。判定はNTPによる（`reason":"ntp"`）。
- 時計は正しく表示され、進み続けた。
- 最初の「時刻を合わせています」は目視では見えなかった。Backendが起動済みで最初の応答がすぐに届くため、想定どおりと考える。最初が`unavailable`であることは単体テストで確認している（PR #111）。
- コンテンツは今日の予定のまま切り替わらなかった。範囲外の観察Aを参照（天気のデータがなく、表示できるコンテンツが予定だけだった）。

### V2：同期した後にWi-Fiを切る：PASS

- 約2〜3分、時計は表示されたまま進み続けた。APIは`available`。
- `NTPSynchronized`は`yes`のままだった（Linuxは同期が切れてもしばらく同期済みを保つ）。そのため、RTCを根拠にした判定はV2では確認しておらず、V3で確認した。

### V3：電源を入れたまま再起動（オフライン）：PASS

記録用スクリプトの出力（抜粋）：

```text
===== V3 real=15:41 =====
2026年 11月 15日 日曜日 15:41:27 JST
no
1794724887
--- API (Backend)
HTTP/1.1 200 OK
cache-control: no-store
{"availability":"available"}
--- API (画面の配信経由)
{"availability":"available"}
```

- OSの時刻は正しく、`NTPSynchronized=no`、RTCは有効（OSの時刻と一致）。
- Backendのログ：`"availability":"available","reason":"rtc","ntp":"unsynchronized","rtc":"valid"`。
- 時計が表示された。NTPで同期していなくても、RTCが有効なら表示に使う動作（Architecture 10.2）を確認した。

### V4：電池なしで電源を完全に切った後（オフライン）：PASS

Wi-Fiを切ったままシャットダウンし、電源ケーブルを抜いて5分以上置いてから起動した。

- OSの時刻は本当の時刻より約8分遅れていた（前回終了時付近の時刻からの起動。25.1の事前確認と同じ）。
- 時計タイルは「時刻を合わせています」のままで、日付・時刻を表示しなかった。
- コンテンツ領域は「時刻を確認できるまで／予定と天気は表示しません」の1枚表示で、巡回しなかった。
- APIは`200`・`cache-control: no-store`・`{"availability":"unavailable"}`。
- Backendのログ：`"reason":"none"`、`"rtc":"invalid"`。

もっともらしいが誤った時刻を、通常の時計として表示しないこと（R-01）を確認した。

### V5：V4の状態からWi-Fiをつなぐ：PASS

時系列（JST。21:29はV4の遅れた時計による記録）：

- 21:29頃：Backendを起動。予定・天気の取得は`network_error`で失敗した。
- 21:39頃：Wi-Fiをつないだ。
- 21:39:19：Backendのログ：`"availability":"available","reason":"ntp","ntp":"synchronized","rtc":"valid"`。
- 時計は操作なしで、日付と時刻の表示に変わった。
- 22:06:19：予定・天気の取得に成功した（APIの`lastAttemptAt`・`lastAttemptResult: success`）。
- 22:07頃：コンテンツの巡回が操作なしで始まった。

時刻の利用可否は、同期の後に操作なしで`available`へ戻った。時刻が約8分補正されても、時計は新しい時刻で表示された。予定・天気が戻るまでの約27分は、範囲外の観察Bを参照。

### V6：Backendを止める・再び起動する：PASS

時計・予定・天気が表示されている状態で、Backendを`Ctrl+C`で止めた。

- 約1〜2分（目視の概算）で「時刻を合わせています」と、コンテンツ領域の1枚表示に変わった。仕様では、最後の取得の成功から60秒（止める直前の成功は最大10秒前なので、止めてから約50〜60秒）。ストップウォッチによる厳密な計測はしていない。
- Backendを再び起動すると、約30秒で時計と予定・天気の巡回に戻った。

## 範囲外で観察したこと

Issue #65の判定・表示とは別の仕組みによるもので、#65の修正は行わない。

### A. V1で天気のデータがなかった

- V5で取得に成功するまで、天気（現在・時間別・週間）の`expiresAt`は2026-11-08のままだった。V1の起動直後（14:57頃）の週間天気の取得は`timeout`で失敗した。
- 表示できるコンテンツが予定だけのとき、ContentSwitcherはそれを表示し続ける（Frontend開発手順 第10章）。V1でコンテンツが切り替わらなかったことは、これで説明できる。
- 天気が11月8日から更新されていなかった理由は、今回の記録からは分からない（`backend.log`は2026-11-15の分だけで、それ以前の取得状況を確認できない）。

### B. Networkの復旧後、予定・天気が戻るまで約27分かかった

- 取得に失敗すると、次の試行までの間隔は1→2→4→8→16→30分（上限）と伸びる（`src/backend/acquisition/control-state.ts`）。失敗の回数はDBに保存され、Backendを再起動しても引き継がれる。
- Schedulerは次の試行までの待ち時間を`setTimeout`で予約する。予約した後に時計が補正されても、待ち時間は変わらない。Networkの復旧を検知して再取得を早める仕組みはない。
- 最後の失敗（ログ上21:29:30、本当の時刻では約21:37）から30分後は約22:07で、実際の取得（22:06:19）とおおむね一致する。上限の30分の待機によると考えられる。
- この動作は現行の仕様どおりだが、[Architecture 11.3](../architecture.md#113-recovery-escalationと初期目標)の初期目標「Networkが再び利用可能になってから1分以内に再取得処理を開始」を満たしていない。扱いはIssue #65の外で決める。

### C. 降水予報（RainForecast）が取得されなかった

- 各起動で`rain_forecast_provider_enabled`が記録された（Providerは登録されている）。
- 最後の試行は2026-11-14で、2026-11-15の起動では一度も試行しなかった。V5の後も`data: null`（期限切れ）のままだった。
- Tomorrow.ioの送信には、Clock Trust・History Trust・Quotaの条件と、再起動後の待機がある（技術スタック選定 21.9）。今回はBackendの再起動とオフラインを繰り返したため、送信の条件がそろわなかった可能性がある。原因は確定していない（Issue #93の範囲）。

### D. 時刻が誤っている間のBackendの記録

V4では、Backendが取得の失敗の時刻（`lastAttemptAt`）を、約8分遅れた時計のまま保存した。Backendの時刻依存処理への反映は[Issue #108](https://github.com/rinYamano211/home-digital-signage/issues/108)で扱う。

### E. 取得に成功したときのログ

`weather_acquired`・`schedule_acquired`は`debug`レベルのため、INFOレベルの運用ではログに出ない。取得の成功は、APIの`lastAttemptResult`で確認した。

## 今回は確認しなかったこと

- 時刻を手動で大きくずらす確認（Piの設定を変えるため）。
- 約9時間以上のオフライン（#13の長時間試験で観察できる）。
- RTCのバックアップ電池を付けた後の電源断（電池の購入後に確認する）。
- 自動起動での起動直後（#12の後、#13で確認する）。
- V6の切り替えまでの時間の厳密な計測。

## Windows・CIの証跡

- PR #110・#111の作成時（Windows）：Lint・Type Checkは成功。Testは、worktreeに`node_modules/typescript/bin/tsc`がないための`tests/backend/process.test.ts`の1件を除いて成功（PR #111の時点で1962件）。`format:check`は、`core.autocrlf=true`の作業コピーでCRLFになるための既知の問題で失敗し、変更したファイルはLFで合格した。
- GitHub ActionsのQuality checks（Lint・Format Check・Type Check・Test）は、PR #109〜#111のいずれも成功した。
