# Issue #12：自動起動・復旧・Deployの実機確認

## 範囲と状態

[技術スタック選定 第26章](../technology-stack.md#startup-recovery-operations)の構成（PR #114）を、PR #115の設定・Script・[運用手順書](../operations.md)に沿って、Raspberry Piへ初めて適用した結果を記録する。適用と確認はユーザーが手動で行った（手順の補助にChatGPTとClaude Codeを使った。Claude CodeはPiを操作していない）。

- 確認日：2026-11-16〜2026-11-17
- 対象：`main`のMerge Commit `b82ff45`（PR #115）。Release `20261117-222638-b82ff45`
- 環境：Raspberry Pi 5、Debian 13（trixie）・ARM64、systemd 257、LightDM + labwc（Wayland）、Chromium、nginx 1.26.3、Node.js v24.22.1。RTCのバックアップ電池なし
- **状態：途中経過**。設置・初回Release・Kioskの自動起動・P9・P10まで確認した。R-06の時間の計測、Backendの異常終了からの復旧などは未実施（「未実施の項目」）。確認が進んだら本記録に追記する
- Secret・地点・カレンダーID・Quota履歴の値は記録しない

## 方法

[運用手順書](../operations.md)の2.（初回の設置）と4.1（Deploy）の順に行った。時間は、特に書いていなければ体感で、計測していない。

## 結果

### 初回の設置（手順書 2.1〜2.6）

| 項目             | 結果                                                                                                                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 Node.js      | v24.22.1を`/usr/local`へ導入した。公式の`SHASUMS256.txt`での検証は、ユーザーの報告による（`sha256sum -c`の出力は記録していない）。それまでのNode.jsは`signage`のnvmだけで、`hds`から使えなかった（P3）                                                            |
| 2.2 `hds`        | 非ログインのシステムユーザーとして作成した。`hds`からNode.js・`timedatectl`（NTPの状態）・RTC（`since_epoch`）を読めた（P3・P4）                                                                                                                                  |
| 2.3 nginx        | 設定を適用し、`127.0.0.1:80`だけで待ち受けることを確認した（P7）。**`apt install`の時点で既定のサイト（全Interfaceの80番）でnginxが起動しており、`systemctl reload`・`enable --now`では古い待ち受けが残った。`restart`で解消した**（手順書は`275eb35`で修正済み） |
| 2.4 journald     | `Storage=persistent`・`SystemMaxUse=100M`・`MaxRetentionSec=7day`を設定し、`systemd-journald`の再起動で反映を確認した                                                                                                                                             |
| 2.5 所有者の移行 | 下記                                                                                                                                                                                                                                                              |
| 2.6 Backend Unit | 配置し、`systemd-analyze verify`はエラーなし。`daemon-reload`の後、`loaded`・`inactive`・`disabled`・`User=hds`。手順書のとおり、ここでは`enable`しなかった                                                                                                       |

### DB・Secret・Configの所有者の移行（手順書 2.5）

- DBは、第26章 26.4が想定した「別の場所へコピーする」形ではなく、既にあった本番のPath（`/var/lib/home-digital-signage/`）で、**その場で所有者を`hds`に変えた**。変更前の複製を`/var/backups/home-digital-signage/pre-hds/`に保存した。
- 変更前：Backendの停止を確認した。複製と本体のSHA256が一致した。両方の`integrity_check`が`ok`だった。Quota履歴（`provider_quota_metadata`・`provider_quota_consumptions`の件数・最後の連番・最新の予約時刻）が一致した（`MATCH`）。
- 所有者：DB・`-wal`・`-shm`・`backend.lock`は`hds:hds`、Secretは`hds:hds`、`backend.env`は`root:root`。`backend.env.save`は変更していない（用途はユーザーの確認待ち）。
- 変更後：もう一度比べて一致した（`MATCH`）。
- 所有者の変更後の確認で、`sudo stat … /var/lib/home-digital-signage/*`は失敗した。`signage`のShellが、`hds`の0700のディレクトリの中を`*`で展開できないため。`sudo find`で確認できた（手順書は`275eb35`で修正済み）。
- 保存した複製は、全検証とGitHubへの記録が終わるまで削除しない。

### 初回Release（手順書 2.7・4.1）

- 開発PC（Windows）で`main`からBuildし、Piへ転送した。必要なファイルがそろっていることを確認した後、`npm ci --omit=dev`を実行した。better-sqlite3は、メモリDBでSQLが実行できることを確認した。
- `activate-release.sh activate`：`20261117-222638-b82ff45 is active`、終了コード0。
- その後に`enable`した：`loaded`・`active`・`enabled`・`User=hds`。
- Backendのログ：`weather_provider_enabled`・`schedule_provider_enabled`・`rain_forecast_provider_enabled`・`storage_startup_committed`・`database_status`（`HEALTHY`）・`startup_complete`・`time_availability_changed`（`available`、`ntp`）。
- `/api/published-states`は200、nginx経由の`/`は200で、Releaseの`index.html`とバイト単位で一致した。
- 予定は取得・公開された（`lastAttemptResult: success`）。天気・降雨は「範囲外で観察したこと」を参照。

### Kiosk（手順書 2.8）

| 項目                                                | 結果                                           |
| --------------------------------------------------- | ---------------------------------------------- |
| P5：labwcのautostartから、ユーザーUnitでKioskを起動 | PASS。Piの再起動の後、自動で起動した           |
| 全画面表示                                          | PASS                                           |
| P6：Keyringのパスワード要求・不要なダイアログ       | PASS（表示されなかった）                       |
| P8：起動時間                                        | 体感で20秒未満。**電源投入からの計測は未実施** |

### P9：Chromiumの異常終了からの自動復旧：PASS

`systemctl --user kill --signal=SIGKILL --kill-whom=main home-digital-signage-kiosk.service`でChromiumの主Processを止めた。

```text
22:59:16 Sent signal SIGKILL to main process
22:59:16 Main process exited, code=killed, status=9/KILL
22:59:21 Scheduled restart job, restart counter is at 1
22:59:21 Started home-digital-signage-kiosk.service
```

- systemdは約5秒後に起動し直した（`RestartSec=5s`）。全画面表示へ戻るまで、体感で10秒未満。不要なダイアログは出なかった。
- ChromiumがVulkanに関する警告を出したが、表示に問題は見られなかった。

### P10：nginxより先にKioskが動いた場合：PASS

nginxを止めてからKioskを再起動し、nginxを戻した。

```text
23:06:19 Started home-digital-signage-kiosk.service
23:06:48 kiosk: nginx did not answer within about 60 s
23:06:48 Main process exited, status=1/FAILURE
23:06:53 Scheduled restart job, restart counter is at 1
23:07:23 kiosk: nginx did not answer within about 60 s
23:07:28 Scheduled restart job, restart counter is at 2
```

- nginxが止まっている間、Chromiumは起動せず、エラーページも出なかった。nginxを戻した後、自動で全画面表示に戻った。
- 1回の待ちは約30秒で、メッセージの「about 60 s」より短い。`kiosk.sh`は`curl --max-time 1`を最大30回試し、その間に1秒ずつ待つ。「約60秒」は、相手が応答しないときの上限である。nginxが止まっていると接続はすぐに拒否されるため、1回が約1秒で、30回で約30秒になる。動作は第26章（60秒以内に応答がなければ終了し、systemdが待ち直す）の範囲内である。メッセージの表現は実際より長い。
- nginxのUnitは`Restart=no`（Debianの既定）。nginx自体の異常終了からの自動復旧は、第26章の範囲外である。

## P1〜P17の状況

| #   | 事項                                             | 状態                                                                                           |
| --- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| P1  | systemdのバージョン                              | 確認済み（257）                                                                                |
| P2  | 段階的Backoffの採否                              | 未確認。現在は`RestartSec=5s`の固定                                                            |
| P3  | `hds`からNode.jsを実行できる                     | 確認済み（`/usr/local`へ導入した後）                                                           |
| P4  | `hds`で`timedatectl`・RTCを読める                | 確認済み                                                                                       |
| P5  | labwcのautostartからユーザーUnitでKioskを起動    | 確認済み                                                                                       |
| P6  | Keyringのパスワード要求が出ない                  | 確認済み                                                                                       |
| P7  | nginxが`127.0.0.1:80`だけで待ち受ける            | 確認済み（`restart`が必要だった）                                                              |
| P8  | 電源投入から2分以内に基本画面                    | 未確認（体感だけ）                                                                             |
| P9  | Backend・Chromiumを止めたときの自動復旧          | Chromiumは確認済み。**Backendは未実施**                                                        |
| P10 | nginxより先にKioskが動いても止まらない           | 確認済み                                                                                       |
| P11 | 再起動の後も前回の起動のログが残る               | 未確認                                                                                         |
| P12 | Releaseの切替と失敗時の切戻し                    | 初回の切替だけ確認済み。2回目の切替・切戻しは未実施                                            |
| P13 | Secretの正常な読み込みと、権限が不正なときの拒否 | 正常な読み込みは、予定の取得の成功で確認できた。拒否は未実施                                   |
| P14 | 画面が消えない・カーソルが見えない               | 未確認。マウスをつないだ状態では、再起動の後もカーソルが残った。マウスをつながない状態は未確認 |
| P15 | Network未接続で電源を入れても基本画面が出る      | 未実施                                                                                         |
| P16 | 管理コマンドの実行方法                           | 未実施                                                                                         |
| P17 | 既存DBの移行                                     | 移行の前後の一致と、移行後の起動（`HEALTHY`）・予定の取得は確認済み。降雨の取得の再開は未確認  |

## 範囲外で観察したこと

### A：起動直後の天気の取得のTimeout

- 最初の起動（2026-11-17 22:33ごろ）の直後、Open-Meteoの3つ（currentWeather・hourlyWeather・weeklyWeather）が、同時に`weather_acquisition_failed`（`reason: timeout`）になった。開始から約10秒（HTTPのTimeout）で失敗した。
- 同じHTTPの仕組みを使う予定の取得は成功し、`hds`からの一般的なHTTPSの通信もできた。原因は確定していない（Open-Meteoへの経路、またはOpen-Meteo側の一時的な遅れの可能性）。**その後の試行で回復したかは未確認**。

### B：降雨が表示されない（再起動後の待機）

- 画面は「雨の予報を取得できません」。APIの`rainForecast`は`data: null`で、`meta`は2026-11-14の最後の取得（`lastAttemptResult: success`、期限は同日11:02）のまま。期限切れのデータは、APIが応答の時点で`data`を`null`にして返す（`published-state-api.ts`の`present()`）。
- 再起動のたびに過去の送信履歴を数え、約65〜70分は送信しない（[技術スタック選定 21.9](../technology-stack.md)の「再起動後の保守的な待機」。方針Aとして受け入れ済み。履歴は20件以上・400件未満）。Backendの最後の起動は22:54なので、23:59〜翌00:04ごろに再開する見込み。**再開は未確認**。

## 未実施の項目

1. Backendを`kill -9`してから、基本画面のデータが戻るまでの時間（R-06：1分以内）
2. 電源の抜き差しから、時計を含む基本画面が出るまでの時間（R-06：2分以内。P8）
3. P2の採否、P11、P12の切戻し、P13の拒否、P14、P15、P16
4. 降雨の取得の再開（B）と、Open-Meteoの天気の回復（A）
5. Network復旧の後、操作なしで取得が回復すること（Issue #12の完了条件。回復までの時間の目標は[#113](https://github.com/rinYamano211/home-digital-signage/issues/113)）
6. `backend.env.save`の扱いの判断
