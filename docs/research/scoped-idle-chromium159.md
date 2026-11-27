# 同じ親session観測によるChromium159の資源比較

2026-11-27事前登録。[Chrome116の実モデル試行](scoped-idle-chrome116.md)では、同じ9 PID/roleのresume-1/2のWorkingSet64合計が859,201,536→862,339,072 bytes（比1.003651688）だった。過去の159/Linuxでは増加があったが、runtime・文書寿命・観測方式が異なり、その差だけではbrowserの影響を分離できない。

今回の問いは、**同じ凍結runtimeと親session観測でも、現在のChromium159で2回目の再開後に大きな増加が現れるか**である。旧試行の再実行や失敗の補完ではなく、116からbrowserを替える別条件の1試行とする。製品コード、モデル、閾値、推論設定、idle期限、観測コードは変更しない。メモリ改善の実装・採用や製品受け入れは今回の目的ではない。

## 固定条件

本書を含む次のclean40桁commitをtest sourceとする。`tests/e2e/idle.real.spec.ts`と14 control filesはdaab981と同じ内容を使い、runtime asset sourceは`0ba36301cdb1b2b9759ce81dbdc8fb6837648bbe`の全78資産。QUInt8 SHAは`dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`、元モデルrevisionは`8d640720bddeb64c89dc1fa7780c3ea29fa523e8`。WASM1threadを維持する。

Windows11/Node24.15.0/Playwright1.65.1、既存cacheのChromium159.0.8154.6を使う。exeは`.cache/playwright/chromium-1255/chrome-win64/chrome.exe`（binderで絶対パスへ解決）、4,261,888 bytes、SHA `9b5b0b9d91b08bc432f53ddf9946aaec7ab100b3f887819656c2ee63cde1757e`。DLLやresourceを含むchrome-win64全ファイルをpreflightで凍結・前後照合し、実versionはreportで確認する。外部downloadやmachine設定・認証変更はしない。

116試行と同じ`createChromiumLaunchOptions`の明示exe経路を通し、同じextension flagsと`--headless=new`を使う。browser/versionとその実装差以外を意図して変更しないが、単発・別時刻の測定でOS状態やcacheの完全統制を保証しない。ブラウザ・モデル・性能仕事はこの1つだけを直列実行する。

## 予算と判定

```text
node node_modules/@playwright/test/cli.js test tests/e2e/idle.real.spec.ts --project=real --workers=1 --retries=0 --reporter=line,json,junit --output <新source別test-results>
```

1件を1回だけ実行し、2タブ4推論・idle2回・3 document/Worker世代・6 OS sampleで終了する。test240秒、各idle85秒、各cleanup5秒を維持し、起動/観測/終了失敗でも予算終了とする。同条件retry、追加周期/入力、GC強制、別backend、Linuxへの追加実行や実行後の閾値変更はしない。process終了を確認するまで別browserを起動しない。

機能・観測完了には実version159.0.8154.6、Playwright1 passed/skip・retry・flaky0、4回のoffline WASM検出、Worker状態0,1,0,1,0,1と親bindingの対応、3世代のID/連鎖、文書ごとのrelease completed1/他0、通知ちょうど2件、本文保持・storageContainsInput=false、監視開始後の外部通信/page error0、全cleanup completed/<5sを要求する。sender.documentIdが取得できればpayloadと一致を要求し、欠落時はnullを保持してbrowser認証済みの一致とは扱わない。

6 sampleはbefore-inference/shared-inference/idle-1/resume-1/idle-2/resume-2の順で、measured・非空rows・欠落PIDなしを要求する。Windows Get-ProcessのWorkingSet64/PeakWorkingSet64を順次測るCDP関連process cohortであり、拡張専用RSSや同時peakではない。

主要な資源比較はresume-1/2のcurrentBytes合計・差・比である。同じPID/role集合かを先に照合し、重複・欠落・不正値・集合差があれば比はunknownとする。同一PIDはprocess開始identityやWorker所有関係の証明ではない。比>1.25を過去と同じ「大きな増加」の診断分類とし、<=1.25なら「この限定条件では大きな増加を観測しなかった」とする。この線は新しい製品合格基準ではない。異なるbrowser間のPIDは比較せず、各browser内の再開比・絶対値・取得条件を併記する。結果の大小からbrowser/observerの因果や長期リーク不存在を断定しない。

## source・証拠の束縛と停止

新しい外側binderはclean HEAD/tree、14 controlのGit blob/raw SHA、source archive、実行binder/config/command、159全runtime files、116 exe/ZIP/PDL、全78製品資産、cloneの77資産＋唯一のlocalhost manifest grant差分を前後照合する。daab981の21証拠を含む13 receipts/759 files、旧Chrome27/preflight8/旧ZIP0dc814cを保護する。実際のbinderをコピー・hashし、排他的な`artifacts/scoped-idle-chromium159/<source>/`へ保存する。起動失敗はexit127、欠落/破損reportも失敗receiptへ残し、既存output・同一試行の再起動は拒否する。

実行前にbinderと本書を独立レビューし、source固定後にpreflightする。runtime/テストコードはdaab981から不変なので、既存のTS466/checkの対象を新sourceへ付け替えず、本書のformat・リンク・control同一性を検証する。実行後に結果と全資産を凍結し、独立レビューと状態文書更新・ローカルcommitを行う。

memoryGrowthAcceptance/fullM5Acceptance=falseを維持する。精度/独立gold、CPU/WASM parity/性能、Linux・長時間資源、native権限/物理IME、実サービス/remote CIと最終公開候補は別ゲート。fixture pregrantや合成IMEからnative成功を主張しない。旧ZIPの再包装・外部公開はしない。今回の成功/失敗で予算終了後は同条件を反復せず、残る原因候補と次の独立した検証を記録する。

## 実行前の検証

製品/試験コードはdaab981から不変で、準備時のnpm checkと文書リンク450件の照合が成功した。外側binderを独立レビューし、14 controlと製品/buildコードのbaseline一致、既存report/preflight/receiptの固定SHA、159全runtimeと旧116のexe/ZIP/PDL保護を確認した。

外側の追加回帰では、booleanのprocess countを比率へ使う不備と旧116 binary束縛の欠落をRed2→Green2で修正した。7件のobserver記録でafter処理がIndexErrorになる回帰、memory.scope不一致を有効扱いする回帰もRedから修正した。最終3テスト群は、同一cohort・PID/role交代・重複・不正値・1.25境界、正常/不正version・欠落/null storage・不正memory・cohort交代・破損JSONのfailure receipt、起動OSErrorのexit127・再起動拒否をすべて通過した。Ruffも成功。agentの初期missing-definitionメモはstatic確認であり、behavioral Redの件数へ含めない。

## 実行結果（成功、予算終了）

clean source `4f8c74da483a729476276937c0882ec0bbc236cf`、tree `6a6d1a3673bb6828083b97e4d2f53620df64973d`、固定runtime assets0baで登録した1回を完了した。Windows11/Node24.15.0/Chromium159.0.8154.6、WASM1thread、Playwright1 passed/skip・retry・flaky0、外側exit0。4 offline推論、2 idle解放/再開、document/Worker各3世代と連鎖、6 OS sampleを確認した。

Worker状態は0,1,0,1,0,1、すべてcomplete、parentBound/ownedParentSessionsはfalse/0・true/1と対応し、pendingCommands0。通知は各退役文書に1件・全体2件、release completed1/他0だった。159でも今回のsender.documentIdは2件ともnullであり、payloadと世代の対応・sender ID/URL検査をbrowser提供document IDの認証と混同しない。本文保持・storageContainsInput=false、監視開始後の外部通信/page error0、全cleanup completedも確認した。

cleanupはobserver6.3595ms、CDP3.3857ms、context3,942.2661ms、fixture0.9752msで各5秒内。試験本体179,056.5134ms、外側process184,601.1563msで終了した。NO_COLOR/FORCE_COLORのNode警告はexecution.logへ保持し、page errorや試験失敗とは分ける。

### 資源値と比較不能の範囲

各sampleはmeasured・10 process・欠落なしで、scopeと各PID/role/current/peak値を検査した。Windows WorkingSet64の順次取得であり、拡張専用RSS・同時peakではない。

| phase            | Working set合計（bytes） |
| ---------------- | ------------------------ |
| before-inference | 696,274,944              |
| shared-inference | 1,042,407,424            |
| idle-1           | 798,113,792              |
| resume-1         | 1,039,110,144            |
| idle-2           | 755,691,520              |
| resume-2         | 2,055,770,112            |

resume-1/2間でrenderer1件が退役し別PIDのrenderer1件へ交代した。同じ10 processという件数とrole multisetだけでは固定cohortではない。登録どおりcohortMatch=false、beforeBytes/afterBytes/deltaBytes/ratio/largeIncreaseはすべてnullとし、1.25分類は適用しない。上表は各時点の実在process合計として保持する。最後の約2.06GBという値も隠さないが、別集合の比率を固定processの増加率として主張しない。

Chrome116の同一9 PID/roleの比1.003651688と、今回の159の比較不能なcohortは区別する。browser/observer/allocator/旧Worker保持の因果、長期上限やリーク不存在は特定していない。資源問題は未解決で、今回の機能成功からmemory受け入れへ進めない。

### 証拠と次の作業

出力は `artifacts/scoped-idle-chromium159/4f8c74da483a729476276937c0882ec0bbc236cf/`。archiveは323 tracked files、3,430,400 bytes、SHA `845d248771e3237d721261655fe89fda47c7da9c9b9661157fd150b45302171a`。idle.json SHA `d37cecec59cfc916deaccecc168ca143949df538918ec0b4bc0d13ec454327c6`、preflight SHA `289b95a86c98195662086369b52d94e23b5db1431efeb8405d3fa4c5e906d9ab`。32証拠のreceipt SHA `1e21acf9257afaeef8a9c7efc4aafed31adac2f39b57339879e70190911f06e1`、先行759と合わせ14 receipts/791 filesを保護する。実行binder SHAは `899dc1bb8599378480ac806fd00b629e3596b93f04921971f11419e00222e03d`。

source/control14/archive、159全305ファイル、旧116の3ファイル、全78元資産、clone77＋唯一のlocalhost manifest grant差分、先行13receipt759証拠・旧Chrome27/preflight8/旧ZIPは前後一致した。別APIのnative接続不可記録もhash固定・コピーした。結果の独立レビューでblockingなし。機能条件のboundedCompatibilityAcceptance=true、memoryGrowthAcceptance/fullM5Acceptance=false。旧試行・ZIPは変更しない。

予算は終了した。次は同じ試行の反復ではなく、コードでsession寿命とWorker/ORT module寿命を分けた保持方式の変更点・リスクを評価する。現Workerのdisposeはretiring=trueにして復帰しないため、同じWorkerを残すだけでは再利用できない。新しいsession解放状態と期限を設けるなら、既存の全退役レーンを残した別契約・TDD・事前登録が必要で、現時点では未実装・未採用。独立gold/精度、CPU/WASM parity/速度、Linux・長時間資源、native/実サービス/remoteとM5の未達は維持する。
