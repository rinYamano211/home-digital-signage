# Linux flock技術検証（PR-B / B-3A-0）

## 目的・範囲

Issue #16のB-3A-1に向け、専用Lockファイル・実Process・継承FDによる排他を検証する。PoCは本番BackendStore・Provisioning・SQLite・APIへ組み込まない。既存Backend・依存パッケージ・CI設定は変更しない。

## 実行方法・環境

```sh
npm ci
npx vitest run tests/poc/linux-flock.test.ts --reporter=verbose
```

既存Quality checksの`npm test`でも実行される。Linux以外は全項目Skip。Linuxではflockがなければ失敗する。実行ユーザーは非rootとする。各ケースは専用一時Directoryを使い、Process Groupを記録し、終了時に残存ProcessをSIGKILLしてDirectoryを削除する。待機・Lock取得・Worker寿命・テストには上限を設ける。

ローカルWindowsはNode.js v24.14.0。利用可能なWSL Linux環境がないため、Linux実測は既存Ubuntu CIで行う。Raspberry Pi OS・ARM64・本番filesystemは未検証。Kernel・Node.js・flock Version・UIDはテストの`POC_ENV`ログに出力する。

2026-10-25の[Linux CI実測ログ](https://github.com/rinYamano211/home-digital-signage/actions/runs/40168527755/job/121094435549)で、Ubuntu 24.04.5、Kernel 6.17.0-1022-azure、x64、Node.js v24.21.0、util-linux flock 2.39.3、UID 1001を確認した。テストコードCommitは`87d31c0a957418bef48370dafb85e5da939a05fd`。PoC 13テストはすべてPASS、既存52テストを含む65件もPASS。Lint・Format・Type Checkも成功した。

## 検証方式とFD所有

Shellが専用LockファイルをFD 9で開き、`flock -x/-s -w 1 9`を実行する。Node.jsを同じFD 9の継承付きで起動し、同じOpen File Descriptionを保持する。Node.jsから短命のflock子ProcessへFD 9をFD 3として明示的に渡し、`flock -s -w 1 3`で変換する。

通常ケースはShellの`exec`でNode.jsへ置き換え、監視用Wrapperを残さない。異常系ではShellがNode.jsをbackground起動してwaitする方式と比較する。FD継承漏れの反例では、孫Processへ意図的にFDを渡す。これは推奨動作ではない。

単純な`flock -x <command>`は、コマンド実行中の排他保持には使えるが、Node.js内で初期化完了を認識して共有へ移行する制御までは提供しない。`--close`ではNode.jsにFDが残らず、Wrapper終了後の保護を期待できない。継承FD方式は初期化完了後に同じFDへ変換要求を送れる点を検証する。

## LOCK-01〜LOCK-12

以下は上記CIで実Processを用いた実測結果。PASSには、保護できないケースを期待どおり再現した結果も含む。LOCK-07はSignal別の2テストで、合計13テストとなる。

| ID      | 確認内容                                               | 結果                                                 |
| ------- | ------------------------------------------------------ | ---------------------------------------------------- |
| LOCK-01 | 排他同士の競合                                         | PASS：競合Exit 73                                    |
| LOCK-02 | 共有Lockの共存                                         | PASS：別Processも取得                                |
| LOCK-03 | 共有保持中の排他拒否                                   | PASS：排他Exit 73                                    |
| LOCK-04 | 同じFDの排他→共有変換、20回の競合試行                  | PASS：変換成功。割込み観測0/20、Atomicの証明ではない |
| LOCK-05 | Wrapperだけ終了してもNode.jsのFDが保護を維持           | PASS：Wrapper Kill後も排他拒否、Node終了後は取得     |
| LOCK-06 | 正常終了後の排他再取得                                 | PASS：Node Exit 0、排他再取得                        |
| LOCK-07 | SIGTERM/SIGKILL、Backendのみ・Wrapperのみ・Group・孫FD | PASS：両Signalで下記の保持・解放を再現               |
| LOCK-08 | 150ms競合TimeoutとDB操作用marker非生成                 | PASS：Exit 73、上限1.8秒以内、markerなし             |
| LOCK-09 | 残存Lockファイルの再利用                               | PASS：ファイル残存、Lock再取得可能                   |
| LOCK-10 | 共有LockではBackend多重起動を禁止できない              | PASS：2 Node同時起動を再現                           |
| LOCK-11 | wx同時作成・既存・Symlink・権限拒否・作成直後Kill      | PASS：下記の拒否・残存を確認                         |
| LOCK-12 | 排他Lock保持中のwx、解放後の既存DB保護                 | PASS：Lock競合を拒否、解放後もwxは既存を拒否         |

LOCK-04では競合Processの起動markerを待ってから変換するが、Kernel内の待ちQueueへの登録は観測していない。20回は有限の競合試行であり、あらゆる割込み順序を網羅しない。

LOCK-07のSIGTERM・SIGKILL実測は、Backendだけ終了するとwait中のWrapperも終了して解放、Wrapperだけ終了すると生存NodeのFDにより保持、Process Group全体終了で解放となった。明示的にFDを渡した孫Processは親終了後もLockを保持し、孫終了後に解放された。暗黙の子孫継承一般を安全とする結果ではない。

LOCK-11は同時2作成のうち1件だけ成功、他方と既存ファイルはEEXIST（テストExit 17）。実在対象・dangling両SymlinkもEEXIST、対象データは不変。書込み不可DirectoryはEACCES（Exit 13）。空ファイル作成直後のSIGKILLではファイルが残り、その後のwxもEEXISTとなった。

反例の再現は`npx vitest run tests/poc/linux-flock.test.ts -t LOCK-07`でFD残存、`-t LOCK-10`で多重起動、`-t LOCK-11`で不完全ファイル残存を確認する。テスト自身はこれらの期待した制約を確認してPASSする。

## 仕様上の制約と判断基準

Linuxのflockは協調的Lockであり、同じOpen File Descriptionの全FDが閉じるまで保持される。明示的なunlockは共有する他FDにも影響する。子孫への意図しないFD継承、Lockパスのunlink・置換、協調しないProcessの書込みは別に防ぐ必要がある。

排他→共有の変換はAtomicと仮定しない。競合試行で割込みを観測しなくてもAtomicの証明にはならない。変換の間に他の排他所有者が変更できるなら、初期化中に検証した内容を無条件で信頼できない。共有取得後の再検証・変更検出と、安全に継続できない場合の停止をB-3A-1で設計する。単一のdowngrade成功をSchema整合性保証としない。

`wx`は既存ファイル・Symbolic Linkの上書きを拒否するが、有効なDBの完成・耐電源断・安全なDirectory・pathのすり替え防止を保証しない。作成直後Killで残った不完全ファイルは自動削除・再作成しない。Lockと排他的作成は別の保証である。

## B-3A-1への推奨候補・未検証事項

実測に基づく推奨候補はShellでFDを開いてNode.jsへexec継承し、Node.jsが寿命中保持する方式。追加Native依存なしで同じFDの操作とProcess終了による解放を確認できた。ただし、共有への非Atomic変換・終了処理・子ProcessへのFD継承規律が成立条件であり、本番方式の無条件な採用判断ではない。単純Wrapper保持だけを推奨とはしない。

Native Bindingは同一Process内でLock操作・エラー管理を行いやすい一方、ARM64 Build・ABI・保守・追加依存の検証が必要で、今回は追加しない。Native化してもflock変換のAtomic性は得られない。別Lockによる遷移直列化などのLinux機能は代替候補であり、本PoCで採用確定しない。

共有Lockは複数Backendを許可するため、多重起動防止は別に必要。Productionでは単一systemd Unitと起動経路の限定を第一候補とし、手動起動も禁止したい場合の専用Instance Lock等は後続で判断する。PIDファイル存在だけで判定しない。

Pi実機ではOS・Kernel・util-linux・filesystem、FD継承、systemdの実Process Groupと停止挙動、再起動・電源断、権限、Lockファイルを置換しない運用を追加確認する。実際のSchema検証・Migration、変換中の変更検出、Native方式との比較性能、lock fairness・長期負荷は未検証。

## 参照

- [Linux flock(2)](https://man7.org/linux/man-pages/man2/flock.2.html)
- [util-linux flock(1)](https://man7.org/linux/man-pages/man1/flock.1.html)
- [Node.js 24 fs: file system flags](https://nodejs.org/docs/latest-v24.x/api/fs.html#file-system-flags)
- [B-2設計](../technology-stack.md#123-初回db-provisioningと通常起動)
