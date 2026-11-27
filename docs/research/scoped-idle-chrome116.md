# 親session観測によるChrome116実モデルidle検証

2026-11-27事前登録。[モデルなしc1200fe試行](scoped-worker-observation.md)で親session経由のWorker集合0→1→0とOffscreen文書0→1→0を確認した。旧[実試行7554](current-runtime-chrome116.md)はinventoryによるWorker観測で失敗し予算終了している。今回の変更条件は、idle試験の観測方法をこの検証済み親session方式へ接続することに限る。製品runtime・モデル・閾値・推論設定・精度採点は変更しない。

## 実装とsource束縛

idle.real.spec.tsでScopedWorkerObserverを使い、ACKと親postflight後にのみ子Worker集合を公開する。Worker通知未取得やdetach、CDP失敗等のunknownを0件へ読み替えない。観測中の一時unknownはpollの未成立として扱い、既存の期限を延ばさない。ready時はcomplete/parentBound=true/Worker1、idle時はcomplete/parentBound=false/Worker0とOffscreen0を同時に必要とする。

cleanupFixtureResourcesへ観測用sessionのdispose段階を追加する。observer→root CDP→context→fixture serverの順に、各5秒の独立したdeadlineで全段を試みる。前段の失敗やtimeoutでも後段を実行し、全エラーとpending/failedを残す。既存CDP/context/serverの5秒上限をまとめたり延長したりしない。shared helperの順序・this束縛・全失敗保持・各期限をRed3から回帰検証する。

これらの変更、本書、unit/関連docsを含む次のclean40桁commitをtest sourceとする。runtime asset sourceは `0ba36301cdb1b2b9759ce81dbdc8fb6837648bbe` の全78ファイル。root distも同一のpath/bytes/SHAであることを前後照合する。元モデルrevision `8d640720bddeb64c89dc1fa7780c3ea29fa523e8`、QUInt8 SHA `dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`、WASM1threadは固定する。

Windows11/Node24.15.0/Playwright1.65.1、既存Chrome for Testing116.0.5845.96の絶対exeを使用する。exe SHA `7460094ab51e1cb2fa6abeef0683275bb99684ad00334556547d7f4a6dd84c4e`、ZIP SHA `58ce894d230738e5b05ec0e20f8283c77070a97afb21bae3175e13f2b0af08b7`、固定tag公式PDL SHA `685dfe50fca9d91116412afeb42990d5f7a38857cb8336d4729a75650f166390`。外部download、machine設定や認証変更は行わない。

## 1試行の予算と受け入れ

```text
node node_modules/@playwright/test/cli.js test tests/e2e/idle.real.spec.ts --project=real --workers=1 --retries=0 --reporter=line,json,junit --output <source別test-results>
```

試行は上記1件・1回だけ。2タブ4推論、idle2回、Offscreen/Workerの3世代、6段階のOSメモリsampleを確認する。test240秒、各idle85秒、各cleanup5秒の既存上限を維持する。成功・失敗・起動/観測/cleanup失敗のいずれでも予算終了とし、同条件retry、別filter/browser、モデル/設定変更による追加推論はしない。同じprocess handleの終了を確認し、新しいbrowserを並行起動しない。

合格には、実version116.0.5845.96、Playwright1件passed/skip・retry・flaky0、offline WASM検出4回、各idleのmodelReady=false/Worker0/Offscreen0、文書ごとのrelease ACK completed1/failed・timedOut・sendFailed0、3つの異なるdocument/Worker IDと世代連鎖、新文書での再検出、本文保持・非保存、監視開始後の外部通信/page error0、全cleanup completedが必要。6 sampleはbefore-inference/shared-inference/idle-1/resume-1/idle-2/resume-2の順に、measured/非空rowsと実状態の対応を要求する。

各retired documentのidle通知はちょうど1件、全体2件とし、後続の重複・失敗通知も許可しない。成功時も通知のdocument ID・解放結果件数を保持し、raw instance markerは保存しない。

入力の非保存チェックはstorageContainsInputとしてbooleanを記録し、未取得はnullとする。外側binderも明示falseを必要とし、欠落やnullを成功へ読み替えない。

reportはtest/runtime sourceを分離し、実browserVersion、完了推論数、世代・memory・counts/statusを成功失敗の両方で保持する。raw input/URL/foreign ID/例外本文/private instance markerを保存しない。数値はOS metricとCDP PID cohortを明記し、working setやprocess HWMを拡張専用RSS、長期リーク不存在、メモリ改善に読み替えない。今回はメモリ低減を変更条件にしていないためmemoryGrowthAcceptanceはfalseのままとする。

外側binderはsource/tree/clean/control Git blob・raw SHA、実行したbinder/config/command、source archive、exe/ZIP/PDL、モデル/全78元資産、実行cloneのmanifest以外77資産と唯一のlocalhost fixture grant差分を前後照合する。先行12receipt738証拠、旧Chrome27証拠、未実行preflight8証拠、旧ZIPを保護する。新出力はartifacts/scoped-idle-chrome116/<source>/へ排他的に作成し、旧reportを補完・上書きしない。起動例外や欠落/破損reportも失敗receiptへ残す。

## 範囲と停止条件

fixture host grantはnative権限承認/取消の代替ではない。合成IMEは物理IMEの証拠ではない。全startup通信、全116patch、WebGPU、実サービス、精度/独立gold、CPU/WASM parity/性能、長期資源、remote CIとM5は別ゲートである。旧marker拒否はChrome159の別試験の証拠を維持し、今回116へ付け替えない。旧ZIP0dc814cは不変、公開しない。

試験終了後は結果と全資産の照合を凍結・独立レビューし、未達をそのまま記録する。失敗時は仮説と観測結果を整理し、条件を変えない追加試行へ進まない。

## 実行前の検証

shared cleanupの新3回帰はRed後に修正し、関連11 unitと全TypeScript466件が成功した。observer接続と本書を独立レビューし、対象通知の重複も検査する。AGENTSのformat指摘を修正し、Lint・型検査・formatを含むnpm checkも成功した。これらを含むclean sourceと外側binderの最終確認後に、登録した1試行を実行する。

## 実行結果（成功、予算終了）

clean `daab981136f3502321fbfc3a277656b98a51ea5f`、tree `051e95a3e1f305e37028b5a2eab67db26e25eb8e`、固定runtime assets0baで登録した1回を完了した。Windows11/Node24.15.0/Chrome116.0.5845.96、WASM1thread、Playwright1件passed・skip/retry/flaky0、外側exit0。オフライン検出4回、2回のidle解放と再検出、document/Worker各3世代の交代・連鎖を確認した。

Worker観測は6phaseで0→1→0→1→0→1件、すべてcomplete、parentBound/ownedParentSessionsも対応するfalse/0・true/1、pendingCommands0だった。退役文書の通知は各1件・合計2件、release completed1/他0、payload document IDと世代の対応を確認した。Chrome116は通知のsender.documentIdを提供せず、reportは2件ともnull。sender ID/URLは検査しているが、browser提供のsender document ID照合が成功したとは扱わない。本文保持とstorageContainsInput=false、監視開始後の外部通信/page error0、全6 OS sampleのmeasured/各9行も成功した。

cleanupはobserver4.1218ms、CDP2.2062ms、context4,236.7464ms、fixture0.8158msで各5秒以内。試験本体173,614.6053ms、外側process179,759.0288msで終了した。source/tree/clean/control14、exe/ZIP/PDL、全78製品資産とcloneの77資産・唯一のlocalhost grant差分、先行12receipt738証拠、旧Chrome27/preflight8/旧ZIPは前後一致した。

### この試行のメモリ

Windows Get-ProcessのWorkingSet64を、CDPに関連する同じ9 PID/roleについて順次取得した。拡張専用RSSや同時測定ではない。

| phase            | Working set合計（bytes） |
| ---------------- | ------------------------ |
| before-inference | 532,541,440              |
| shared-inference | 857,092,096              |
| idle-1           | 567,922,688              |
| resume-1         | 859,201,536              |
| idle-2           | 571,957,248              |
| resume-2         | 862,339,072              |

resume-2/resume-1は1.003651688、差は3,137,536 bytesだった。このChrome116の限定試行では、過去のChrome159/Linux試行にあった約2倍の増加を観測しなかった。browser・観測条件が異なるため、原因特定や改善の因果・長期リーク不存在にはしない。各PIDのPeakWorkingSet64はraw reportへ保持し、それらの合計を同時peakとは扱わない。memoryGrowthAcceptance=falseを維持する。次の比較にはbrowser/観測条件を固定した別仮説と予算が必要。

### 証拠と残る範囲

出力は `artifacts/scoped-idle-chrome116/daab981136f3502321fbfc3a277656b98a51ea5f/`。archiveは322 tracked files、3,409,920 bytes、SHA `f95873cce9626387cf84c7098c7b6c690174d67223b1dfa9290cf6cef1f612f6`。idle.json SHA `fd51933dc6011aa2cc5bdb93ba52999f351cb9731cf6b5a3fbd2148398b103a9`、preflight SHA `e4f5516a0b0da886cfec38c4d38d81e10f11f47b21ce96cea28c73bc87ffd2ca`。新21証拠のreceipt SHA `f68d9a38044bb9705cc916c5dba4c96d5b8f8676a72414e0f5af62eaf3db9e7f`、合計13receipt759証拠を保護する。結果を独立レビューしblockingなし。

この条件のboundedCompatibilityAcceptance=true、memoryGrowthAcceptance/fullM5Acceptance=false。旧7554の失敗はそのまま保持し、今回の成功へ付け替えない。精度/独立gold、CPU/WASM parity/性能、他browserの資源増加、native権限/物理IME、実サービス/remote CI等は残る。旧ZIPは0dc814cのまま。予算は終了し、追加の推論や同条件retryへ進まない。
