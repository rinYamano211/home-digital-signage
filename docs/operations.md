# 運用手順書（Raspberry Pi・Issue #12）

本番の構成と方針の正本は[技術スタック選定 第26章](technology-stack.md#startup-recovery-operations)である。本書は、その構成をPiに設置・更新するための手順をまとめる。設定ファイルは`deploy/`、Scriptは`scripts/`にある。

- 操作はユーザー（管理者）がPiで行う。AIはPiを操作せず、Secretの値も扱わない。
- 「**検証待ち**」の手順は、Piで確かめるまで確定扱いしない（第26章 26.12のP1〜P17）。結果はIssue #12の検証記録（PR 3）に残す。
- Secret・地点・カレンダーIDの値は、ログ・Issue・PR・チャットへ貼らない。

## 1. 前提（2026-11-16にユーザーが確認したPiの状態）

- Debian 13（trixie）・ARM64、systemd 257。
- Node.js v24.22.1が`signage`のnvm（`/home/signage/.nvm/`）にある。システム共通のNode.jsは未確認。
- nginxは導入済みか未確認で、サービスはinactive。
- `/var/lib/home-digital-signage/`（`signage.db`・`backend.lock`を含む）、`/etc/home-digital-signage/secrets/`（`schedule.json`・`weather.json`）、`/etc/home-digital-signage/backend.env`は、いずれも`signage`が所有し、0700（ディレクトリ）・0600（ファイル）。
- `/etc/home-digital-signage/backend.env.save`がある。設定情報を含む可能性がある。用途が分からないため、本書の手順では削除・上書き・所有者変更をしない（扱いはユーザーの確認待ち）。

## 2. 初回の設置

上から順に行う。各手順の後に、示した確認をする。先に、開発PCからリポジトリの`deploy/`をPiの`~/incoming/deploy/`へ転送し（`scp -r deploy signage@<pi>:'~/incoming/'`）、`deploy/`を含むコマンドは`~/incoming`で実行する。

### 2.1 Node.jsをシステム共通のPathに入れる

`hds`は`signage`のホームの下を読めないため、nvmのNode.jsを使えない（26.3）。nvmの環境はそのまま残す。

- Versionは、nvmと同じv24.22.1にそろえる。`npm ci`はnvmのNode.jsで実行するため、better-sqlite3（Native Module）の互換性を保つ。
- 方法は、Node.jsの公式Binaryを`/usr/local`に展開する。DebianのPackageは版が古く、外部のAPTリポジトリは追加しないため。**この方法はレビューで確定する**。

```sh
ver=v24.22.1
cd "$(mktemp -d)"
curl -fsSLO "https://nodejs.org/dist/$ver/node-$ver-linux-arm64.tar.xz"
curl -fsSLO "https://nodejs.org/dist/$ver/SHASUMS256.txt"
grep " node-$ver-linux-arm64.tar.xz\$" SHASUMS256.txt | sha256sum -c -
sudo tar -xJf "node-$ver-linux-arm64.tar.xz" -C /usr/local --strip-components=1 --no-same-owner
/usr/local/bin/node --version
```

`sha256sum -c`が`OK`にならなければ、展開しない。

### 2.2 `hds`ユーザーを作る

```sh
sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin hds
sudo -u hds /usr/local/bin/node --version
sudo -u hds timedatectl show -p NTPSynchronized --value
sudo -u hds cat /sys/class/rtc/rtc0/since_epoch
```

最後の3つは、それぞれ`v24.22.1`・`yes`か`no`・整数を返すこと（P3・P4）。読めない場合は、権限を変える前に報告する。

### 2.3 nginx

```sh
sudo apt install nginx
sudo rm -f /etc/nginx/sites-enabled/default
sudo install -m 0644 deploy/nginx/home-digital-signage.conf /etc/nginx/sites-available/home-digital-signage
sudo ln -sfn /etc/nginx/sites-available/home-digital-signage /etc/nginx/sites-enabled/home-digital-signage
sudo nginx -t && sudo systemctl enable nginx && sudo systemctl restart nginx
sudo ss -ltnp | grep ':80 '
```

- `sites-enabled/default`はsymbolic linkで、削除しても`sites-available/default`は残る。
- Debianの`apt install nginx`は、その時点で既定のサイト（全Interfaceの80番）のnginxを起動する。`systemctl enable --now`は、既に動いているnginxには何もしないため、設定を変えても古い待ち受けが残る（Issue #12の実機で確認）。そのため、`nginx -t`が成功した後に必ず`restart`する。初めて導入したときも、既に動いているときも、同じ手順でよい。
- `enable`は、OSの起動時にnginxを自動で起動する設定である。`restart`は、いま動いているnginxを止めて、新しい設定で起動し直す。
- `rm -f`・`ln -sfn`は、手順をやり直しても失敗しないようにするため。
- 最後の確認で、`127.0.0.1:80`だけが表示されること（P7）。Releaseを配置するまでは、画面は404等になる。

### 2.4 journald

```sh
sudo install -d -m 0755 /etc/systemd/journald.conf.d
sudo install -m 0644 deploy/journald/home-digital-signage.conf /etc/systemd/journald.conf.d/
sudo systemctl restart systemd-journald
journalctl --disk-usage
```

この設定はOS全体のログに効く（7日より古いログは消える。26.8）。

### 2.5 既存DB・Secret・Configの所有者を移す

第26章 26.4は「既存のDBを新しい場所へコピーする」手順を想定していた。実際には、DBはすでに本番のPath（`/var/lib/home-digital-signage/`）にある。そのため、**その場で所有者を`hds`に変え、変更前の複製を保存しておく**手順にした（26.4の目的である、Quota履歴の維持・整合性の確認・旧DBの保持は変わらない）。

1. 手動で起動しているBackendを、Ctrl+Cで正常に終了する。残っていないことを確かめる。

   ```sh
   pgrep -af 'dist/backend/main.js' || echo stopped
   ls -la /var/lib/home-digital-signage/
   ```

   `signage.db-wal`・`signage.db-shm`の有無を記録する。

2. 変更前の複製（旧DB）を保存する。`signage.db`と、あれば`signage.db-wal`を保存する（`-shm`は保存しない。26.4）。**移行の検証（P17）が終わるまで、削除・変更しない**。

   ```sh
   src=/var/lib/home-digital-signage
   bak=/var/backups/home-digital-signage/pre-hds
   sudo install -d -m 0700 "$bak"
   for f in signage.db signage.db-wal; do
     if sudo test -e "$src/$f"; then
       sudo cp -p "$src/$f" "$bak/$f" && sudo cmp "$src/$f" "$bak/$f" && echo "$f saved"
     fi
   done
   ```

3. 旧DB（保存した複製）と移行対象のDB（`/var/lib`の本体）の両方について、整合性とQuota履歴を出力し、比べる。`sqlite3`コマンドを使う（入っていなければ`sudo apt install sqlite3`。P17）。
   - 本体や保存した複製をSQLiteで直接開くと、rootの所有のファイルが作られたり内容が変わったりするおそれがある。そのため、毎回、使い捨ての作業用の複製を作って開く。
   - 出力は件数・連番・時刻だけで、Secretは含まない。値はチャットに貼らなくてよい（一致したかどうかだけ報告する）。
   - 比較結果は、`mktemp -d`で作る専用の一時ディレクトリ（権限0700）に保存する。
   - 2.〜5.は、変数（`src`・`bak`・`rep`・`verified`）と関数を引き継ぐため、同じターミナルで続けて実行する。
   - `db_report`は、コピー・SQLiteのどれかが失敗すると、作業用の複製を消した後に失敗（終了コード1）を返す。後片付けの成功で、失敗が隠れないようにするため。`sqlite3 -bail`は、SQLのエラーで止まって失敗を返す。

   ```sh
   db_report() {
     work=$(sudo mktemp -d) || return 1
     status=0
     sudo cp -p "$1/signage.db" "$work/" || status=1
     if [ "$status" -eq 0 ] && sudo test -e "$1/signage.db-wal"; then
       sudo cp -p "$1/signage.db-wal" "$work/" || status=1
     fi
     if [ "$status" -eq 0 ]; then
       sudo sqlite3 -bail "$work/signage.db" "PRAGMA integrity_check;
         SELECT 'metadata', provider_key, history_status, initialized_at_ms, last_sequence FROM provider_quota_metadata ORDER BY provider_key;
         SELECT 'consumptions', provider_key, COUNT(*), MAX(sequence), MAX(reserved_at_ms) FROM provider_quota_consumptions GROUP BY provider_key ORDER BY provider_key;" ||
         status=1
     fi
     sudo rm -rf "$work"
     return "$status"
   }
   rep=$(mktemp -d)
   echo "$rep"
   verified=no
   if db_report "$bak" > "$rep/backup.txt" &&
     db_report "$src" > "$rep/live.txt" &&
     [ "$(head -n 1 "$rep/backup.txt")" = ok ] &&
     [ "$(head -n 1 "$rep/live.txt")" = ok ] &&
     diff "$rep/backup.txt" "$rep/live.txt"; then
     verified=yes
     echo 'MATCH: 4.へ進んでよい'
   else
     echo 'STOP: 4.へ進まない'
   fi
   ```

   - `MATCH`は、両方の`integrity_check`が`ok`で、`metadata`（Providerごとの状態・最後の連番）と`consumptions`（件数・最大の連番・最新の予約時刻）が一致したことを示す。
   - **`STOP`のときは、ここで止める。所有者の変更（4.）にもBackendの起動にも進まず、原因を調べる**。DB本体・保存した複製は、この手順では変更しない。

4. 所有者を変える。Modeは0700・0600のまま変えない。3.で`MATCH`になっていなければ、何も変更しない。

   ```sh
   if [ "$verified" = yes ]; then
     sudo chown hds:hds /var/lib/home-digital-signage /var/lib/home-digital-signage/* &&
       sudo chown hds:hds /etc/home-digital-signage/secrets /etc/home-digital-signage/secrets/schedule.json /etc/home-digital-signage/secrets/weather.json &&
       sudo chown root:root /etc/home-digital-signage/backend.env &&
       sudo chown root:root /etc/home-digital-signage &&
       sudo chmod 0755 /etc/home-digital-signage &&
       echo 'CHANGED' || echo 'STOP: 所有者の変更が途中で失敗した'
   else
     echo 'STOP: 3.の比較が成功していない'
   fi
   sudo find /var/lib/home-digital-signage -maxdepth 1 -printf '%m %u:%g %p\n' | sort
   sudo find /etc/home-digital-signage -maxdepth 2 -printf '%m %u:%g %p\n' | sort
   ```

   - 確認には`find`を使う。所有者を変えた後は、`signage`は`hds`の0700のディレクトリの中を読めないため、`/var/lib/home-digital-signage/*`のような`*`は、`sudo`の前に`signage`のShellで展開できない。`find`はroot（`sudo`）として中を列挙する。
   - 期待値：`/var/lib/home-digital-signage`は`700 hds:hds`、中のファイルは`600 hds:hds`。`/etc/home-digital-signage`は`755 root:root`、`backend.env`は`600 root:root`、`secrets`は`700 hds:hds`、その中は`600 hds:hds`。`backend.env.save`は変更前のまま。
   - 途中で失敗したら、`find`の結果を見て、変わった所有者を元（`signage`）に戻し、原因を調べる。

   - `backend.env`はsystemd（root）が読む。以後、`signage`は読めない。
   - `/etc/home-digital-signage`をrootの所有にするのは、`signage`が`backend.env`・`secrets/`を差し替えられないようにするため（26.3）。
   - `backend.env.save`は、削除・上書き・所有者の変更をしない。設定情報（地点・カレンダーID等）を含む可能性があるため、内容をログ・Issue・チャットへ貼らない。用途はユーザーの確認待ちとし、扱いは確認の後に決める。

5. 所有者を変えた後に、もう一度比べる。`MATCH`にならなければ、2.6以降（Backendの起動）へ進まない（所有者を`signage`に戻して原因を調べる）。

   ```sh
   if db_report "$src" > "$rep/after.txt" &&
     [ "$(head -n 1 "$rep/after.txt")" = ok ] &&
     diff "$rep/backup.txt" "$rep/after.txt"; then
     echo 'MATCH: 2.6へ進んでよい'
   else
     echo 'STOP: Backendを起動しない'
   fi
   ```

   `$rep`（3.で表示したPath）の比較結果は、P17が終わるまで残す。その後、`rm -rf -- "$rep"`で削除する。ターミナルを閉じた場合は、表示したPathを指定して削除する。

6. 移行の後は、`signage`として`npm run start:backend`を実行しない（所有者が合わず起動できない。旧DBの複製でも起動しない）。

### 2.6 Backendのsystemd Unit

```sh
sudo install -m 0644 deploy/systemd/home-digital-signage-backend.service /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/home-digital-signage-backend.service
sudo systemctl daemon-reload
systemctl show home-digital-signage-backend.service -p LoadState -p UnitFileState -p ActiveState -p User
```

- 期待値：`LoadState=loaded`・`UnitFileState=disabled`・`ActiveState=inactive`・`User=hds`。
- ここでは`enable`も`start`もしない。`enable`は「OSの起動時に自動で起動する」設定で、`start`（`restart`）は「いま起動する」操作である。Releaseがない間に`enable`すると、Piの再起動のたびに`/opt/home-digital-signage/current`がないまま起動を試み、5秒ごとに失敗を繰り返す（害はないが、ログが増える）。`disabled`のままなら、Releaseの前にPiが再起動しても、Backendは起動しない。
- 最初の起動は、2.7の`activate-release.sh`が行う（Scriptの`systemctl restart`は、`disabled`のUnitも起動する）。`enable`は、最初のReleaseが正常に動くことを確かめた後に行う（2.7）。

### 2.7 最初のRelease

1. 4.1の手順で配置する。`activate-release.sh`がBackendを起動し、疎通を確かめる。
   - 最初は`previous`がないため、疎通確認に失敗しても切り戻せない（終了コード2）。その場合は、`sudo systemctl stop home-digital-signage-backend`で止め（`Restart=always`のため、止めるまで再起動を繰り返す）、3.1のログで原因を調べる。`enable`はしない。
2. 終了コード0（`... is active`）を確かめたら、OSの起動時の自動起動を有効にする。

   ```sh
   sudo systemctl enable home-digital-signage-backend.service
   systemctl show home-digital-signage-backend.service -p UnitFileState -p ActiveState
   ```

   期待値：`UnitFileState=enabled`・`ActiveState=active`。R-06の電源投入後の自動起動は、ここから有効になる（確認はP8）。

3. 起動したら、次を確かめる（P17の後半）。
   - `journalctl -u home-digital-signage-backend -b`に`database_status`・`startup_complete`があること。
   - `curl -fsS http://127.0.0.1/api/published-states`が応答すること。
   - 予定・天気が取得されること。降雨は、再起動から約65〜70分は取得されない（受け入れ済みの方針A。26.5）。

   確認が終わったら、P17を完了とし、`/var/backups/home-digital-signage/pre-hds/`を削除してよい。

### 2.8 Kiosk・画面

`signage`として行う。

1. `sudo raspi-config`で、Desktop Autologin（System Options → Boot / Auto Login）を有効にし、Screen Blanking（Display Options）を無効にする。
2. Kioskのユーザー Unitを置く。

   ```sh
   install -D -m 0644 deploy/systemd/user/home-digital-signage-kiosk.service ~/.config/systemd/user/home-digital-signage-kiosk.service
   systemctl --user daemon-reload
   ```

3. labwcのautostartに追記する。既にファイルがあれば、先に複製を取る。

   ```sh
   mkdir -p ~/.config/labwc
   [ ! -e ~/.config/labwc/autostart ] || cp -p ~/.config/labwc/autostart ~/.config/labwc/autostart.bak-"$(date +%Y%m%d)"
   cat deploy/labwc/autostart >> ~/.config/labwc/autostart
   ```

   ユーザーのautostartがあると、システムのautostart（`/etc/xdg/labwc/autostart`。パネル等）が実行されなくなる可能性がある（**検証待ち**。P5）。Kioskとしては問題ない。

4. マウスカーソルを隠す方法は**検証待ち**（P14）。labwcで使える方法を調べてから決める。
5. `sudo reboot`し、電源投入から時計が表示されるまでの時間を計る（P8：2分以内）。

## 3. 日常の操作

### 3.1 状態とログ

```sh
systemctl status home-digital-signage-backend
journalctl -u home-digital-signage-backend -b
journalctl -u home-digital-signage-backend -b -1
systemctl show -p NRestarts home-digital-signage-backend
systemctl --user status home-digital-signage-kiosk
journalctl --user -u home-digital-signage-kiosk -b
```

- `-b -1`は前回のBootのログ（P11）。
- Kioskの2つは、`signage`としてSSHでログインして実行する。

### 3.2 再起動・停止

```sh
sudo systemctl restart home-digital-signage-backend
systemctl --user restart home-digital-signage-kiosk
```

`systemctl stop`で止めた場合は、自動では再起動しない。

### 3.3 Configの変更

```sh
sudoedit /etc/home-digital-signage/backend.env
sudo systemctl restart home-digital-signage-backend
```

変更は再起動で反映する（24.2）。Config不正のときもsystemdは5秒ごとに再起動を続けるため、直した後にrestartする。

### 3.4 Secretの更新

同じディレクトリの中に一時ファイルを作り、Atomic Renameで置き換える（26.10）。新しい値は、`signage`のホームの下に一時的に置いたファイル（例：`~/weather.json.new`）から入れる。

```sh
sudo install -m 0600 -o hds -g hds ~/weather.json.new /etc/home-digital-signage/secrets/.weather.json.new
sudo mv -T /etc/home-digital-signage/secrets/.weather.json.new /etc/home-digital-signage/secrets/weather.json
rm ~/weather.json.new
sudo systemctl restart home-digital-signage-backend
```

`schedule.json`も同じ手順で更新する。正常な読み込みと、権限が不正なときに拒否されることを、Piで確かめる（P13）。

### 3.5 管理コマンド（Provisioning・Migration）

Backendを止めてから、`hds`として、`backend.env`の値を与えて実行する（26.3）。この方法は**検証待ち**（P16）。

```sh
sudo systemctl stop home-digital-signage-backend
sudo systemd-run --uid=hds --gid=hds --pty --wait -p EnvironmentFile=/etc/home-digital-signage/backend.env /bin/sh /opt/home-digital-signage/current/scripts/with-backend-lock.sh <command>
sudo systemctl start home-digital-signage-backend
```

`<command>`は`provision`・`provision-quota`・`migrate-v2`・`migrate-v3`のいずれか。Migrationの前には、Backup（技術スタック選定 第13章）を取る。

## 4. Deploy・Rollback

### 4.1 Deploy

1. 開発PC（Windows）で、`npm run check`の後に`npm run build:backend`・`npm run build:frontend`を実行する。
2. Releaseの名前を決める：`<YYYYMMDD-HHMMSS>-<git短縮SHA>`（例：`20261116-153000-eda4343`。`git rev-parse --short HEAD`で確認）。
3. 開発PCからPiの受け取り用ディレクトリへ転送する（`<name>`は2.の名前、`<pi>`はPiのホスト名）。

   ```sh
   ssh signage@<pi> mkdir -p '~/incoming/<name>/dist'
   scp -r dist/backend dist/frontend signage@<pi>:'~/incoming/<name>/dist/'
   scp -r scripts package.json package-lock.json signage@<pi>:'~/incoming/<name>/'
   ```

   設置用の`deploy/`は、Releaseに含めず、必要なときに`~/incoming/deploy/`へ転送する。

4. Piで、`signage`として依存Packageを入れる（rootでは実行しない）。

   ```sh
   cd ~/incoming/<name> && npm ci --omit=dev
   ```

5. 切り替える。初回だけ、先に`/opt/home-digital-signage/releases`を作り、成功した後に2.7の2.（`enable`）を行う。

   ```sh
   sudo install -d -m 0755 /opt/home-digital-signage /opt/home-digital-signage/releases
   sudo sh ~/incoming/<name>/scripts/activate-release.sh activate ~/incoming/<name>
   ```

   Scriptは次の順に処理する（26.9）。
   - Releaseを`/opt/home-digital-signage/releases/<name>/`へコピーし、rootの所有・755/644にする。
   - `current`をAtomicに切り替える。
   - Backendを再起動し、約30秒まで疎通を確かめる：`:3000/ping`・`:3000/api/published-states`、nginx経由の`/api/published-states`、nginx経由の`/`が新しいReleaseの`index.html`を返すこと。
   - 失敗したら直前のReleaseへ切り戻して終了する（終了コード1）。成功したら`previous`を記録し、3世代を残して古いReleaseを消す。

6. Kioskを再起動し、画面を目視で確かめる。エラーページではなく、時計を含む基本画面が出ていること。

   ```sh
   systemctl --user restart home-digital-signage-kiosk
   ```

7. 確認が終わったら、`~/incoming/<name>`を削除してよい。

### 4.2 Rollback

- 直前のReleaseに戻す。Kioskも再起動して目視で確かめる。

  ```sh
  sudo sh /opt/home-digital-signage/current/scripts/activate-release.sh rollback --schema-checked
  systemctl --user restart home-digital-signage-kiosk
  ```

- `--schema-checked`は、戻す先のReleaseがDBの現在のSchemaに対応していることを確かめた、という確認である。Migrationを実行した後は、Migrationより前のReleaseへは戻さない。対応が分からない場合は実行せず、Backupからの復元を含めて判断する（26.9）。
- 戻す先のBackendがSchemaに対応していない場合は、起動時のSchemaの検証で止まり、疎通確認が失敗する。そのときはログを見て判断する。
