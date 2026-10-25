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

## 検証方式とFD所有

Shellが専用LockファイルをFD 9で開き、`flock -x/-s -w 1 9`を実行する。Node.jsを同じFD 9の継承付きで起動し、同じOpen File Descriptionを保持する。Node.jsから短命のflock子ProcessへFD 9をFD 3として明示的に渡し、`flock -s -w 1 3`で変換する。

通常ケースはShellの`exec`でNode.jsへ置き換え、監視用Wrapperを残さない。異常系ではShellがNode.jsをbackground起動してwaitする方式と比較する。FD継承漏れの反例では、孫Processへ意図的にFDを渡す。これは推奨動作ではない。

単純な`flock -x <command>`は、コマンド実行中の排他保持には使えるが、Node.js内で初期化完了を認識して共有へ移行する制御までは提供しない。`--close`ではNode.jsにFDが残らず、Wrapper終了後の保護を期待できない。継承FD方式は初期化完了後に同じFDへ変換要求を送れる点を検証する。

## LOCK-01〜LOCK-12

Linux CIの実測結果は初回実行後に記録する。テストの存在を検証成功とは扱わない。

| ID      | 確認内容                                               | 結果     |
| ------- | ------------------------------------------------------ | -------- |
| LOCK-01 | 排他同士の競合                                         | 実測待ち |
| LOCK-02 | 共有Lockの共存                                         | 実測待ち |
| LOCK-03 | 共有保持中の排他拒否                                   | 実測待ち |
| LOCK-04 | 同じFDの排他→共有変換、20回の競合試行                  | 実測待ち |
| LOCK-05 | Wrapperだけ終了してもNode.jsのFDが保護を維持           | 実測待ち |
| LOCK-06 | 正常終了後の排他再取得                                 | 実測待ち |
| LOCK-07 | SIGTERM/SIGKILL、Backendのみ・Wrapperのみ・Group・孫FD | 実測待ち |
| LOCK-08 | 150ms競合TimeoutとDB操作用marker非生成                 | 実測待ち |
| LOCK-09 | 残存Lockファイルの再利用                               | 実測待ち |
| LOCK-10 | 共有LockではBackend多重起動を禁止できない              | 実測待ち |
| LOCK-11 | wx同時作成・既存・Symlink・権限拒否・作成直後Kill      | 実測待ち |
| LOCK-12 | 排他Lock保持中のwx、解放後の既存DB保護                 | 実測待ち |

## 仕様上の制約と判断基準

Linuxのflockは協調的Lockであり、同じOpen File Descriptionの全FDが閉じるまで保持される。明示的なunlockは共有する他FDにも影響する。子孫への意図しないFD継承、Lockパスのunlink・置換、協調しないProcessの書込みは別に防ぐ必要がある。

排他→共有の変換はAtomicと仮定しない。競合試行で割込みを観測しなくてもAtomicの証明にはならない。変換の間に他の排他所有者が変更できるなら、初期化中に検証した内容を無条件で信頼できない。共有取得後の再検証・変更検出と、安全に継続できない場合の停止をB-3A-1で設計する。単一のdowngrade成功をSchema整合性保証としない。

`wx`は既存ファイル・Symbolic Linkの上書きを拒否するが、有効なDBの完成・耐電源断・安全なDirectory・pathのすり替え防止を保証しない。作成直後Killで残った不完全ファイルは自動削除・再作成しない。Lockと排他的作成は別の保証である。

## B-3A-1への推奨候補・未検証事項

実測前の候補はShellでFDを開いてNode.jsへexec継承し、Node.jsが寿命中保持する方式。追加Native依存なしで検証できるが、共有への非Atomic変換・終了処理・子ProcessへのFD継承規律が成立条件である。単純Wrapper保持だけを推奨とはしない。

Native Bindingは同一Process内でLock操作・エラー管理を行いやすい一方、ARM64 Build・ABI・保守・追加依存の検証が必要で、今回は追加しない。Native化してもflock変換のAtomic性は得られない。別Lockによる遷移直列化などのLinux機能は代替候補であり、本PoCで採用確定しない。

共有Lockは複数Backendを許可するため、多重起動防止は別に必要。Productionでは単一systemd Unitと起動経路の限定を第一候補とし、手動起動も禁止したい場合の専用Instance Lock等は後続で判断する。PIDファイル存在だけで判定しない。

Pi実機ではOS・Kernel・util-linux・filesystem、FD継承、systemdの実Process Groupと停止挙動、再起動・電源断、権限、Lockファイルを置換しない運用を追加確認する。実際のSchema検証・Migration、変換中の変更検出、Native方式との比較性能、lock fairness・長期負荷は未検証。

## 参照

- [Linux flock(2)](https://man7.org/linux/man-pages/man2/flock.2.html)
- [util-linux flock(1)](https://man7.org/linux/man-pages/man1/flock.1.html)
- [Node.js 24 fs: file system flags](https://nodejs.org/docs/latest-v24.x/api/fs.html#file-system-flags)
- [B-2設計](../technology-stack.md#123-初回db-provisioningと通常起動)
