# Issue #12：自動起動・復旧・Deployの実機確認

## 範囲と状態

[技術スタック選定 第26章](../technology-stack.md#startup-recovery-operations)の構成（PR #114）を、PR #115の設定・Script・[運用手順書](../operations.md)に沿って、Raspberry Piへ初めて適用した結果を記録する。適用と確認はユーザーが手動で行った（手順の補助にChatGPTとClaude Codeを使った。Claude CodeはPiを操作していない）。

- 確認日：2026-11-16〜2026-11-21
- 対象：`main`のMerge Commit `b82ff45`（PR #115）。Release `20261117-222638-b82ff45`
- 環境：Raspberry Pi 5、Debian 13（trixie）・ARM64、systemd 257、LightDM + labwc（Wayland）、Chromium、nginx 1.26.3、Node.js v24.22.1。RTCのバックアップ電池なし
- **状態：途中経過**。設置・初回Release・Kioskの自動起動・P8〜P17まで確認し（P2は不採用）、Network復旧後の自動回復は一部を確認した（降雨は除く）。R-06の2つの時間（電源投入から2分以内、異常終了から1分以内）は確認した。残りは「未実施の項目」。確認が進んだら本記録に追記する
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

- DBは、第26章 26.4が想定した「別の場所へコピーする」形ではなく、既にあった本番のPath（`/var/lib/home-digital-signage/`）で、**その場で所有者を`hds`に変えた**。変更前の複製を`/var/backups/home-digital-signage/pre-hds/`に保存した。26.4は、この結果に合わせて更新した（本PR）。
- 変更前：Backendの停止を確認した。複製と本体のSHA256が一致した。両方の`integrity_check`が`ok`だった。Quota履歴（`provider_quota_metadata`・`provider_quota_consumptions`の件数・最後の連番・最新の予約時刻）が一致した（`MATCH`）。
- 所有者：DB・`-wal`・`-shm`・`backend.lock`は`hds:hds`、Secretは`hds:hds`、`backend.env`は`root:root`。`backend.env.save`は変更していない（後に削除した。下記の「`backend.env.save`の削除」）。
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

| 項目                                                | 結果                                 |
| --------------------------------------------------- | ------------------------------------ |
| P5：labwcのautostartから、ユーザーUnitでKioskを起動 | PASS。Piの再起動の後、自動で起動した |
| 全画面表示                                          | PASS                                 |
| P6：Keyringのパスワード要求・不要なダイアログ       | PASS（表示されなかった）             |
| P8：起動時間                                        | 下記「P8：電源投入から基本画面まで」 |

### P8：電源投入から基本画面まで：PASS

- Raspberry Piの電源を切った状態から、電源ボタンを押して起動した。
- 電源ボタンを押してから、時計を含む基本画面が表示されるまで、**実測で20秒**。R-06の2分以内を満たす。
- 表示の異常や、不要なダイアログはなかった。

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

### P9：Backendの異常終了からの自動復旧：PASS

BackendのMain Process（PID 1003）を`SIGKILL`で強制終了した。

| 時刻（JST、2026-11-18） | 事象                                                     |
| ----------------------- | -------------------------------------------------------- |
| 00:08:15                | 異常終了                                                 |
| 00:08:20                | systemdが自動で起動し直した（PID 4476。`RestartSec=5s`） |
| 00:08:21                | `database_status`（`HEALTHY`）、`startup_complete`       |

- 異常終了からBackendが処理できる状態になるまで、約6秒。R-06の1分以内を満たす。
- 画面は正常に表示されていた。

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

### P11：再起動の後も前回の起動のログが残る：PASS

- P8のコールドブートの後に、`journalctl -b -1 -u home-digital-signage-backend.service`で、前回の起動のBackendのログを取得できた。
- 2026-11-18 00:08:21（JST）の`startup_complete`・`database_status`（`HEALTHY`）と、00:12:54の`shutdown_complete`を確認した。
- OSの再起動をまたいで、journaldのログが残ること（`Storage=persistent`）を確認した。

### P12：Releaseの切替と、失敗時の切戻し：PASS

確認日：2026-11-18。`scripts/activate-release.sh activate`で、正常な切替と、切替の失敗時の自動の切戻しを確かめた。

| 名前      | ディレクトリ              | 用途               |
| --------- | ------------------------- | ------------------ |
| Release A | `20261117-222638-b82ff45` | 初回のRelease      |
| Release B | `20261118-010000-b82ff45` | 正常な切替の確認用 |
| Release C | `20261118-220000-b82ff45` | 故障を入れる確認用 |

Release B・Cは、既存のReleaseを複製して作った確認用のReleaseである。名前の時刻は、実際のBuildの時刻ではない。

**1. 正常な切替（A→B）：PASS**

- 実行：`sudo sh /opt/home-digital-signage/current/scripts/activate-release.sh activate /home/signage/incoming/20261118-010000-b82ff45`
- 期待：`current`がB、`previous`がAになり、Backendが動き、APIが応答する。
- 結果：`activate-release: 20261118-010000-b82ff45 is active`。`current`はB、`previous`はA、Backendは`active`、nginx経由の`/api/published-states`は200。
- 終了コードは記録していない。成功のメッセージと、切替の後の状態で判定した。

**2. 切替の失敗時の自動の切戻し（B→C→B）：PASS**

- 故障の入れ方：Release Cの`dist/frontend/index.html`に、存在しないJavaScriptへの参照（`<script type="module" src="/assets/p12-rollback-test-missing.js"></script>`）を加えた。参照先がないことを確かめた。切替の前のファイルの確認は通り、切替の後の疎通確認（静的ファイルの比較）で失敗させるため。
- 期待：疎通確認が失敗し、Bへ切り戻し、切り戻した先が正常であれば終了コード1になる。
- 結果：`activate-release: health check failed for 20261118-220000-b82ff45; switched back to 20261118-010000-b82ff45 and it is healthy`、`activate_exit_code=1`。

**3. 最終の状態（Scriptの外から確認）：PASS**

- `current`はB、`previous`はAのまま。Backendは`active`、APIは200。
- `releases/`にはA・B・Cの3つがある。Cは稼働せずに残っている（失敗したときは古いReleaseの整理をしないため）。

**4. 手動の切戻し（`rollback --schema-checked`）：PASS**（2026-11-21に追加で確認）

- `--schema-checked`の根拠：Release A・Bは同じCommit（`b82ff45`）の複製で、DB Schemaが同じ。
- 確認の引数なし（`activate-release.sh rollback`）：`activate-release: confirm DB schema compatibility, then pass --schema-checked`、終了コード1。`current`はB、`previous`はAのまま変わらなかった。
- B→A（`rollback --schema-checked`）：`activate-release: rolled back to 20261117-222638-b82ff45`、終了コード0。`current`はA、`previous`はB。Backendは`active`、nginx経由のAPIは200。その後にKioskを再起動した。
- A→B（もう一度`rollback --schema-checked`。元の状態へ戻すため。14:15ごろ）：`activate-release: rolled back to 20261118-010000-b82ff45`、終了コード0。`current`はB、`previous`はA。
- B→A・A→Bのどちらの後も、Kioskを再起動した後の画面の表示に問題はなかった（目視）。

**今回は確かめていないこと**：

- DB Schemaの異なるRelease間の切替
- Backendの起動の失敗を原因とする切戻し（CIのテストでは、偽の`systemctl`・`curl`による模擬の失敗で確認済み。実機は未実施）
- 切替の直後のKioskの画面の目視

**確認時点の運用の状態**（2026-11-21の手動の切戻しの後。以後の操作で変わる）：稼働中はRelease B、`previous`はRelease A、Release Cは故障を入れた確認用として残している。Releaseの削除・整理はしていない。DBの複製（`pre-hds`）は、残りの検証とGitHubへの記録が終わるまで残す。

### P13：Secretの正常な読み込みと、権限が不正なときの拒否：PASS

- 正常な読み込み：本番のSecretでは、予定の取得の成功で確認できている（「初回Release」）。
- 拒否：2026-11-18に、`dist/backend/config/secrets.js`の`loadSecret()`を、`hds`として実行して確かめた。**本番のSecretには触れず、`/tmp/hds-p13-secrets`に隔離した偽のSecretを作って試した**。Secret Loaderだけの実機での確認で、本番のSecretの権限を変える試験ではない。Backendの停止・再起動とDBの変更はしていない。

| ID  | 条件                                        | 期待                         | 結果 |
| --- | ------------------------------------------- | ---------------------------- | ---- |
| T1  | ディレクトリ0700、ファイル0600、所有者`hds` | 正常に読み込む               | PASS |
| T2  | ディレクトリ0755                            | `SecretError("permission")`  | PASS |
| T3  | ファイル0644                                | `SecretError("permission")`  | PASS |
| T4  | ファイルの所有者root、実行ユーザー`hds`     | `SecretError("permission")`  | PASS |
| T5  | `schedule.json`をsymbolic linkにする        | `SecretError("unsafe_path")` | PASS |

- 試験の後、試験用のファイルとディレクトリを削除した。偽のSecretの値は記録しない。

### P14：画面が消えない・カーソルが見えない：PASS（現在の運用の条件）

確認日：2026-11-21。環境：labwc 0.20.2、wlroots 0.20.2、ディスプレイ`HDMI-A-1`。Piの設定は変えていない。

**結果**

- 画面のブランキング：ユーザーの申告では、約3日前から画面を表示し続けており、自動の消灯・暗転は起きていない。`wlopm`で見たディスプレイの状態は`HDMI-A-1 on`。PASS
- マウスカーソル：確認の時点で、画面にカーソルは表示されていなかった。PASS

**設定・Processの確認（読み取りだけ）**

- `/home/signage/.config/labwc/rc.xml`はなく、`/etc/xdg/labwc/rc.xml`はある。labwcは`/usr/bin/labwc -m`で動いている。
- labwcの設定ファイルに、ブランキングの無効化やカーソルの非表示を明示する設定は見つからなかった。
- `swayidle`・スクリーンセーバー等の常駐Processはなかった（`wlopm`コマンドは使える）。`kanshi`は動いている。
- ユーザーのlabwcのautostartは、手順書2.8のとおり（環境変数をsystemdへ渡し、Kiosk Unitを起動する）。

**分かっていないこと・未検証**

- 画面が消えない理由と、カーソルが表示されない仕組みは特定していない（設定ではなく、常駐Processがないことによる可能性があるが、推測である）。
- マウスの接続時・操作時のカーソルの挙動は、今回は確かめていない。2026-11-17には、マウスをつないだ状態で、再起動の後もカーソルが残ることを観察している。本運用はマウスをつながない前提である。
- 手順書2.8の1.（raspi-configでScreen Blankingを無効にする）を行ったかどうかは、この確認には含まれていない。

### P15：Network未接続で電源を入れても基本画面が出る：PASS

確認日：2026-11-21。Piの本体にディスプレイとキーボードをつなぎ、本体のターミナル（`signage`）で操作した。

- 事前の確認：Networkは`wlan0`（Wi-Fi、自動接続が有効）だけで、`eth0`は未接続。通常の起動では、ログインの操作なしでChromiumが自動で表示される。
- `sudo nmcli radio wifi off`でWi-Fiを切った。切った後も、サイネージの基本画面は表示され続けた。
- Wi-Fiを切ったまま`sudo reboot`した。

| 項目                                           | 結果 |
| ---------------------------------------------- | ---- |
| ログインの操作なしでChromiumが自動で表示される | PASS |
| Networkなしで基本画面が表示される              | PASS |
| エラー画面や、読み込みのままの停止にならない   | PASS |

Backendのログ（2026-11-21、JST）：

| 時刻                                     | 事象                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 12:38:27                                 | `startup_complete`、`database_status`（`HEALTHY`）、`time_availability_changed`（`reason: rtc`。NTPは未同期） |
| 12:40:00・12:41:00・12:43:00             | `schedule_acquisition_failed`（`network_error`）                                                              |
| 12:40:25〜26・12:41:25〜26・12:43:25〜26 | `weather_acquisition_failed`（`network_error`）                                                               |

- Network未接続の間も、Backendは起動して動き続け、DBは正常だった。時計は、RTCを根拠に表示できる状態だった（第25章）。

### Network復旧後の自動回復：一部確認

Issue #12の完了条件「Network復旧後に外部データ取得が自動的に回復する」の確認。P15の続きで行った。

- `sudo nmcli radio wifi on`でWi-Fiを戻した。Wi-Fiの再接続を確認し、Backendは`active`だった。ChromiumとBackendの再起動、手動での取得はしていない。
- 12:43:57に`time_availability_changed`（`reason: ntp`、NTPは同期済み）。NTPの同期と、外部APIからの取得の成功は、別の事象である。
- 取得の成功のEventはjournalctlでは見ていない（成功はINFOのログに出ない）。`GET http://127.0.0.1:3000/api/published-states`の`states.*.meta`で、復旧の後の取得の成功を確認した。

| State            | `dataUpdatedAt`（JST） | `lastAttemptResult` | `dataSource`  |
| ---------------- | ---------------------- | ------------------- | ------------- |
| `hourlyWeather`  | 11/21 12:47:26         | `success`           | `externalApi` |
| `schedule`       | 11/21 12:57:01         | `success`           | `externalApi` |
| `currentWeather` | 11/21 13:02:27         | `success`           | `externalApi` |

- 画面に、現在の天気・時間ごとの天気・予定が表示されていることを目視で確認した。表示の値がAPIの最新の値と一致することまでは確かめていない。
- `schedule`は、取得は`success`だったが、`events`は空だった。予定があったことや、予定の内容が更新されたことは確かめていない。
- **確認していないこと**：
  - `weeklyWeather`（最後の取得の成功は11/21 10:36:24。Network復旧の前）の、復旧の後の再取得。取得の周期（6時間）を考え、確認のための手動の取得はしていない。
  - すべての外部APIが同じ時間内に回復すること、Networkの復旧をすぐに検知すること（回復までの時間は[#113](https://github.com/rinYamano211/home-digital-signage/issues/113)の範囲）。
- **降雨（`rainForecast`）は、Issue #12の確認から除く**（2026-11-21、ユーザーが判断）：
  - 最後の取得の成功は11/21 12:35:46（P15の再起動の前）。その後、P15の再起動・P12の手動の切戻し・P16の確認で、Backendは何度か再起動した。最後の起動は14:13:38。
  - 15:45の時点（起動から約92分）でも、`rainForecast`の取得は一度も試みられていなかった（`lastAttemptAt`は12:35:45のまま。期限切れのため、APIは`data: null`、`dataSource: null`を返した）。21.9の「20件以上」の場合の約65〜70分を超えている。
  - 原因の推定（コードと21.9からの推定。DBの件数は見ていない）：11/18から5分周期で取得を続け、旧履歴が400件以上になった。そのため、再起動のたびに24時間窓の待機（約25時間）に入っている（21.9の「400件以上」の行）。
  - この待機は、可用性に欠けるとユーザーが判断した。再起動の後の保守的な待機の見直しは、別のIssueで扱う。Network復旧の後の降雨の再取得は、その見直しの後に確かめる。
- 判定：予定・現在の天気・時間ごとの天気は、操作なしで回復した（PASS）。週間の天気は確認待ち。降雨は上記のとおりIssue #12の確認から除く。

### P16：管理コマンドの実行方法：PASS（下記の範囲）

手順書3.5の方法（`systemd-run --uid=hds --pty -p EnvironmentFile=…`）で、実行の経路、排他制御、管理コマンドが本番のDBで安全に拒否されることを確かめた。DB・Quotaを変える操作はしていない。

- 確認済み：
  - `systemd-run`で、`hds`（UID 999）として実行できた。
  - `--uid=hds --pty`で、対話端末付きで実行できた。
  - `EnvironmentFile=/etc/home-digital-signage/backend.env`を通して、`SIGNAGE_DATA_DIR`が設定されていた（値は記録しない）。
  - `with-backend-lock.sh invalid-command`は、`lock: invalid command`を表示し、終了コード74で拒否した。この拒否はLockの取得より前に行われる。
  - 試験の後も、Backendは`active`で、APIは200を返した。
- 排他制御（2026-11-21）：Backendが`active`の間に`provision`を実行すると、約2秒後に`lock: timeout`、終了コード73（`CANTCREAT`）で終わった。DBは開いていない（Lock Scriptは、Lockが取れなければNode.jsを起動しない）。試験の前後とも、Backendは`active`。
- 管理コマンドの起動と安全な拒否（2026-11-21、Backendを止めて実行）：
  - `provision`：`provision_failed`（"Database provisioning refused or failed"）、終了コード1。DBが既にあるため、新しいDBの作成（`openSync(…, "wx")`）の時点で拒否される（`src/backend/storage/provision.ts`）。
  - `migrate-v3`：`schema_upgrade_failed`（"Schema upgrade refused or unconfirmed"）、終了コード1。確認の環境変数（`SIGNAGE_V3_UPGRADE_ACK`）を設定していないため、DBを開く前に拒否される（`src/backend/storage/upgrade-v3.ts`）。
  - その後にBackendを起動し、`active`になった。起動の直後の`curl`ではnginx経由のAPIが502だった。Backendが待ち受けを始める前に問い合わせたためと考えられる（推測）。続けて行った手動の切戻し（P12の4.）では、`activate-release.sh`の疎通確認（BackendとAPIの200）が成功している。
- 確かめていないこと：本番のDBでの成功（新しいDBの作成、`provision-quota`によるQuotaの初期化、Migration）。本番のDBとQuota履歴を変えるため、行っていない。成功の経路は、CIのテスト（`tests/backend/provision-quota.test.ts`等）で確認している。`provision-quota`は、Quotaが既に初期化済みのため実行していない。
- この範囲（実行の経路、排他制御、安全な拒否）で完了とすることは、Claude Codeの提案による（2026-11-21）。

### P17：既存DBの移行の完了：PASS

- 移行の前後の一致（「DB・Secret・Configの所有者の移行」）、移行後のBackendの起動（`HEALTHY`）、予定の取得に加え、降雨の取得の再開を確認した。
- 2026-11-18 00:04:26（JST）に、`rainForecast`の外部APIからの取得が成功した：`lastAttemptResult: success`、`dataSource: externalApi`、`dataUpdatedAt: 2026-11-17T15:04:26.951Z`。データは`status: raining`・`intensity: moderate`で、画面にも降雨の予報が表示され、実際の降雨と合っていた。
- Backendの起動（2026-11-17 22:54:22）から約70分後の取得で、再起動後の保守的な待機（[技術スタック選定 21.9](../technology-stack.md)、履歴が20件以上・400件未満のとき約65〜70分）と合う。移行したQuota履歴を使って、取得が再開したことになる。

## P1〜P17の状況

| #   | 事項                                             | 状態                                                                                                                 |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| P1  | systemdのバージョン                              | 確認済み（257）                                                                                                      |
| P2  | 段階的Backoffの採否                              | 不採用（2026-11-21、ユーザーが判断。実機での確認はしていない。`RestartSec=5s`の固定を正式とする。理由は第26章 26.5） |
| P3  | `hds`からNode.jsを実行できる                     | 確認済み（`/usr/local`へ導入した後）                                                                                 |
| P4  | `hds`で`timedatectl`・RTCを読める                | 確認済み                                                                                                             |
| P5  | labwcのautostartからユーザーUnitでKioskを起動    | 確認済み                                                                                                             |
| P6  | Keyringのパスワード要求が出ない                  | 確認済み                                                                                                             |
| P7  | nginxが`127.0.0.1:80`だけで待ち受ける            | 確認済み（`restart`が必要だった）                                                                                    |
| P8  | 電源投入から2分以内に基本画面                    | 確認済み（実測20秒）                                                                                                 |
| P9  | Backend・Chromiumを止めたときの自動復旧          | 確認済み（Chromium：約5秒後に起動し直した。Backend：約6秒で`startup_complete`）                                      |
| P10 | nginxより先にKioskが動いても止まらない           | 確認済み                                                                                                             |
| P11 | 再起動の後も前回の起動のログが残る               | 確認済み                                                                                                             |
| P12 | Releaseの切替と失敗時の切戻し                    | 確認済み（正常な切替、静的ファイルの不整合による自動の切戻し、手動の`rollback --schema-checked`とその拒否）          |
| P13 | Secretの正常な読み込みと、権限が不正なときの拒否 | 確認済み（読み込みは本番のSecret、拒否は隔離した偽のSecretで確認）                                                   |
| P14 | 画面が消えない・カーソルが見えない               | 確認済み（現在の運用の条件。約3日の連続表示で消灯なし、カーソルの表示なし。マウスの接続時は未検証）                  |
| P15 | Network未接続で電源を入れても基本画面が出る      | 確認済み                                                                                                             |
| P16 | 管理コマンドの実行方法                           | 確認済み（実行の経路、排他制御、本番のDBでの安全な拒否。本番のDBでの成功は行っていない）                             |
| P17 | 既存DBの移行                                     | 確認済み（上記「P17：既存DBの移行の完了」）                                                                          |

### `backend.env.save`の削除

確認日：2026-11-21。ユーザーがPiで確認し、削除した。内容（値）は記録しない。

- 所有者は`signage`、0600。最終更新は11/08 23:42で、`backend.env`（11/08 22:56）より新しかった。
- 中身は`backend.env`と異なった。変数の名前だけを比べると、`backend.env`にだけ天気の地点の2つ（`SIGNAGE_WEATHER_LATITUDE`・`SIGNAGE_WEATHER_LONGITUDE`）があり、`.save`にだけある変数はなかった。
- nanoが編集中の内容を退避した、`backend.env`の古い版と推定した。BackendのUnitが読むのは`backend.env`だけで、リポジトリのScript・設定にも`.save`を読むところはない。
- 今の`backend.env`で予定・天気の取得は成功しており、`.save`は不要と判断した。`sudo rm`で削除し、`/etc/home-digital-signage/`には`backend.env`と`secrets`だけが残った。

## 範囲外で観察したこと

### A：起動直後の天気の取得のTimeout

- 最初の起動（2026-11-17 22:33ごろ）の直後、Open-Meteoの3つ（currentWeather・hourlyWeather・weeklyWeather）が、同時に`weather_acquisition_failed`（`reason: timeout`）になった。開始から約10秒（HTTPのTimeout）で失敗した。
- 同じHTTPの仕組みを使う予定の取得は成功し、`hds`からの一般的なHTTPSの通信もできた。原因は確定していない（Open-Meteoへの経路、またはOpen-Meteo側の一時的な遅れの可能性）。
- その後、Open-Meteoからの取得は成功している（2026-11-21の公開状態で、`weeklyWeather`は10:36:24、`hourlyWeather`・`currentWeather`はNetwork復旧の後に`success`・`externalApi`）。Timeoutが続く状態ではない。

### B：降雨が表示されない（再起動後の待機）

- 画面は「雨の予報を取得できません」。APIの`rainForecast`は`data: null`で、`meta`は2026-11-14の最後の取得（`lastAttemptResult: success`、期限は同日11:02）のまま。期限切れのデータは、APIが応答の時点で`data`を`null`にして返す（`published-state-api.ts`の`present()`）。
- 再起動のたびに過去の送信履歴を数え、約65〜70分は送信しない（[技術スタック選定 21.9](../technology-stack.md)の「再起動後の保守的な待機」。方針Aとして受け入れ済み。履歴は20件以上・400件未満）。Backendの最後の起動は22:54で、翌00:04:26に再開した（P17）。
- その後、旧履歴が400件以上になったとみられ、2026-11-21の再起動の後は約25時間の待機に入ったと推定される（「Network復旧後の自動回復」を参照）。

## 未実施の項目

1. P12の残り（Backendの起動の失敗による切戻しの実機での確認）
2. Network復旧の後の、週間の天気の再取得（Issue #12の完了条件の残り。回復までの時間の目標は[#113](https://github.com/rinYamano211/home-digital-signage/issues/113)）。降雨はIssue #12から除き、再起動の後の待機の見直しの後に確かめる
