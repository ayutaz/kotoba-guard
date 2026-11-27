# M4/R05: idle Workerの解放と再初期化

2026-11-27。現行の`0dc814c`runtimeには要求完了後のWorker解放タイマーがなく、モデルを保持し続ける。今回、入力がない期間の資源保持を減らす。既存の301秒編集試験やモデル数値比較を再実行する実験ではない。

## 実装の受け入れ条件

- Offscreen側で最後の要求が完了してから60秒、pendingが0の場合だけ推論Workerをterminateする。実行中の要求はidleタイマーで中断しない。次の要求で遅延再生成し、旧Workerのイベントは受理しない。
- 新しい要求はidleタイマーを解除し、完了時から再計時する。成功・失敗・postMessage失敗・timeout/restartの経路で空のWorkerを無期限保持しない。
- モデル準備状態はWorkerでの成功後にtrue、解放・再起動後にfalse。popupのstatus取得は既存offscreenへ問い合わせるが、statusだけでWorkerやoffscreenを作らず、idle期限も延ばさない。応答なしは1秒で未準備と判定する。
- statusのChrome API呼出しは同時1件を共有する。timeoutしても取消できない元Promiseが未解決の間は新しい問い合わせを積み上げず、未準備を返す。元Promiseの完了またはService Worker再起動後に再取得できる。送信失敗した推論Workerも直ちに未準備へ戻して再起動する。
- 本文・結果を新たに保存・ログ出力しない。権限・モデル・tokenizer・WASM・検出閾値は変更しない。Offscreen Document自体は残し、Workerとモデルの寿命を分ける。

[Chrome公式](https://developer.chrome.com/docs/extensions/reference/api/offscreen)ではWORKERS理由に自動の寿命上限はなく、offscreenから利用できる拡張APIはruntimeのみ。[HTML Standard](https://html.spec.whatwg.org/multipage/workers.html#dom-worker-terminate)のterminateはWorkerを停止する。JSタイマーは指定時刻の厳密な実行を保証しないため、60秒は通常時の設定値であり、あらゆる環境での解放期限保証にはしない。

## 固定する実ブラウザ検証

TDD・関連回帰・独立レビュー後のclean sourceをbuildし、同梱モデルSHA `dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`を確認する。新しい専用fixture試験をChromium159/WASM1 threadで1回実行する。fixture originだけ事前許可した隔離コピーを使い、実際のoptional permission UIとは区別する。

2タブでオフラインの実推論を各1回完了し、単一の推論Worker targetを共有することを確認する。status問い合わせを続けてもidle解放し、CDP target数0・modelReady falseになること、次の入力で別のWorker targetから検出できることを2サイクル確認する。各段階でCDPに属するブラウザPIDのOS current working set/RSSを既存samplerで記録する。新規のメモリ閾値は設けず、JS heapや個別process HWM合計を現在RSSへ読み替えない。PID欠落はpartial、取得不能はunavailableとして保持し、0bytes成功にしない。CPU/WASMの新しい数値一致や速度評価には数えない。

本文・生URL・生例外はreportへ保存せず、状態・件数・hash・バージョン・経過時間・PID/OS bytesを保存する。監視開始後の外部通信・page error0、入力保持・非保存、Worker解放と再初期化のassertionを要求する。起動前の全通信、物理IME、native権限、実サービス、長期のリーク不存在、OSの即時メモリ返却は保証しない。失敗は保持し、原因が判明した場合に別sourceと明記した修正検証を行う。

## 実装時の検証（実ブラウザの前）

broker4件とoffscreen/background各1件のRedを確認して最小実装した。独立レビューで、成功後のpostMessage失敗でreadyが残る点と、未解決status probeが増え得る点を追加のRed2件で再現・修正した。関連32件が成功。送信失敗はWorkerを再起動して即時未準備に戻し、未応答probeは元の呼出しが完了するまで同時1件を維持する。

全TS264件とnpm checkが成功し、全TS coverageはstatements1,354/1,541（87.86%）・lines1,263/1,395（90.53%）。SDKはstatements92.42%・lines94.56%、offscreen/brokerはline100%。出力は`artifacts/coverage/idle-worker-precommit/`で、実装時のunit測定である。実モデルE2Eの成功・新しい全OS/package snapshot・製品精度の証拠にはしない。専用E2Eの型・Lint・listも確認した。

## 初回実モデル試験の失敗: 1cb8e32

clean `1cb8e32fa5f1d751387e5ef1f1922f111a5aa140`からbuildし、全81配布資産とmanifest・同梱モデルSHAを照合した。専用試験は2タブの検出・modelReady trueを通過した後、ブラウザ直下の`Target.getTargets`で推論WorkerのURLを一致判定できず、`shared-inference`段階で停止した。idle/reloadは0サイクル、成功として扱わない。失敗reportの経過25,455.9msには後続cleanup時間を含まない。cleanup自体はcompleted。

成果物は`artifacts/idle-real/1cb8e32fa5f1d751387e5ef1f1922f111a5aa140/`。report SHAは`f43201b89ffbdc09fd41b666394a3826f9f4997ce6e4b88cd0bb16237144f2f6`。Playwrightのtrace・画像・error context6件を専用フォルダーへコピーし、12ファイルのSHAを`preserved-failure.json`へ保存した。失敗後もclean sourceと全81資産がbuild時と同一だったことを`failure-control.json`で確認した。生traceのmachine path等は公開資料へ取り込まない。

モデルを使わない小さなMV3 fixtureで観測方法を切り分けた。Chromium159.0.8154.6で実際に稼働するWorkerのURLはブラウザ直下の一覧では期待URLと一致せず、Offscreen親への`Target.autoAttachRelated`後に一致した。これは観測上の結果でありURL不一致の内部理由までは特定していない。probe SHAは`eddc92682a0ec96299333b3c606de47370b9217b85f61576afe81aeb6d854564`。

## 訂正試験の固定条件

製品コード、モデル、60秒、2サイクル、メモリ取得、停止・非保存の判定は変更しない。[公式CDP定義](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Target.pdl)に従い、Offscreen親だけを停止なしで関連targetへattachし、Workerの正確なURLとIDを観測するhelperへ修正する。親は1回だけ接続し、第三者originやtab重複へ接続しない。非同期のtarget情報はpollし、単一Workerのassertionを維持する。debugger接続の影響を含むOSメモリであることを記録する。

この修正のunit回帰、型・Lint、独立レビュー後の新しいclean sourceからbuildし、40桁SOURCE_COMMIT、build controlと全配布SHA、テストSHAを結び付けた訂正試験を1回実行する。初回のreport・trace・画像を上書きしない。helperのunit回帰は追加後Greenであり、独立したunit Redは記録していない。初回の実E2E失敗とno-model probeを修正根拠として区別する。

09d886eの実行前には、訂正helperを含む全TS265件と型・Lint・Formatが成功した。別担当のレビューでも、対象親だけの停止なしattach、ID交代、元の0/1件assertion、privacy、cleanup、失敗保持についてblocking指摘なし。この時点で未測定だった訂正試験の結果を次節に記録する。

## 訂正試験09d886e: 機能assertion通過、cleanup失敗

clean `09d886e5d33cf4a9e10a19e57e8f5dce1a5f95be`の実モデル試験は終了コード1。4回のオフライン推論、単一Worker共有、0件への解放と別IDでの再生成2回、本文保持・非保存、外部通信/page error0、6段階すべてmeasuredのOSメモリ取得を通過した。しかし最後の`context.close()`が5秒でtimeoutしたため、reportのstatus/cleanupはともにfailedである。成功結果へ付け替えない。本体176,608.9msはcleanup時間を含まない。

成果物は`artifacts/idle-real/09d886e5d33cf4a9e10a19e57e8f5dce1a5f95be/`。report SHAは`df0315ffcc5e83238df661b2bf2d2210848385f527201e4fbead2beee35ddba9`。build/failure controlはclean sourceと全81資産が完全一致。trace・画像・error context6件と初期12ファイルのhashを保存した。初回1cb8e32の失敗も保持する。

各sampleはCDP関連10 processの順次取得working setであり、拡張専用の同時RSSではない。before/shared/idle1/resume1/idle2/resume2のcurrentBytes合計は692,752,384 / 1,035,739,136 / 790,163,456 / 1,039,306,752 / 785,678,336 / 1,935,048,704。最後の値も省かず、増加・リーク不存在や一定量の解放を主張しない。idleObservedAfterMsは約53.8秒だが直前のmemory capture後を起点にするため、60秒timerの直接実測値ではない。

## 所有CDP接続の終了修正と次の限定試験

owned root CDP sessionが明示的にdetachされていない点を修正する。sessionをtry外で保持し、contextの前にdetachする。detach失敗・timeout後もcontext/serverを必ず試み、全エラーを保持する。各5秒上限を維持し、終了失敗を合格にしない。4件のunit Red（既存4件は成功）から修正し、関連9件をGreenにした。Red時の早いexpect rejection警告も残し、timeout回帰は結果を即時受理する形へ修正した。

モデルなしのMV3/Worker3世代・trace付き2条件probeでは、detachなしのcontext close約3,039ms、先行detachあり約2,752msで、ともに完了した。したがって実モデル試験のtimeout原因は未特定であり、CDP未detachが原因だったとは断定しない。probe初回は広い.cache走査のACLエラーで起動前失敗し、専用testDirに限定してから実行した。ログを上書きせず保持する。probeのdetachなし条件は既に閉じたsessionへの救済detachが失敗した記録も含み、終了自体の失敗と混同しない。

所有資源の終了順を修正し、各CDP/context/server cleanupの状態・時間（未解決はpending/null）を記録した新clean sourceから、同じモデル・60秒・2サイクル・メモリ/通信/非保存条件で1回だけ実モデル確認を行う。新しいbuild controlと全81資産・40桁source/test SHAを結び付ける。これは原因確定済みの再現修正ではなく、終了手順改善の限定検証である。再度timeoutした場合は失敗を保存してこの追加実行予算を終了し、上限延長・無変更の再試行はしない。

終了修正後・次回実行前の全TS269件とnpm check（Lint・型・Format）は成功した。独立レビューでも終了順・各5秒上限・エラー保持・失敗記録の扱いについてblocking指摘なし。製品コードは1cb8e32以降変更していない。

## 限定試験6850aafの結果: 成功

clean `6850aafe66abb647bdea0a59499956bdc72191a1`からbuildしたChromium159.0.8154.6 / Windows11 / WASM1 threadの限定1回は終了コード0だった。4回のオフライン推論、2タブの単一Worker共有、statusを参照し続けた状態でのWorker0件・未準備化、別Worker IDでの再初期化2回、Offscreen Documentの保持、本文保持・非保存を確認した。監視開始後の外部通信/page errorは0。本体176,825.7msは推論速度ではなく、idle待機・6回のOS測定を含みcleanupを除く。

CDP detach6.86ms、context close3,706.07ms、server close0.94msで、全cleanupが既存の各5秒上限内に完了した。前回timeoutの根本原因を証明した結果ではない。初回・訂正失敗は保持し、登録した追加試験の予算は終了する。

| 段階             | Worker数 | modelReady | 関連process数 | currentBytes合計 |
| ---------------- | -------: | ---------- | ------------: | ---------------: |
| before-inference |        0 | false      |            10 |      689,467,392 |
| shared-inference |        1 | true       |            10 |    1,034,977,280 |
| idle-1           |        0 | false      |            10 |      786,354,176 |
| resume-1         |        1 | true       |            10 |    1,037,459,456 |
| idle-2           |        0 | false      |            10 |      781,312,000 |
| resume-2         |        1 | true       |            10 |    1,934,102,528 |

全sampleはmeasuredで欠落PIDなし。順次取得したCDP関連process cohortのworking setで、拡張専用・同時RSS・長期リーク不存在の証明ではない。最後の増加は同一rendererのcurrentBytes1,287,557,120（HWM2,466,443,264）に集中する。Worker ID消滅をメモリ上限の保証へ読み替えない。コードレビューで、idleはterminateのみでSDKのdispose/session.releaseを呼ばないことを確認したが、これが増加の原因か、明示releaseで改善するかは未検証。allocatorやdebuggerの影響も未特定である。新しい診断は仮説・条件・停止を別途登録してから行う。

成果物は`artifacts/idle-real/6850aafe66abb647bdea0a59499956bdc72191a1/`。report SHAは`8b3720d0fc334a50debb495f469559fc29fe9895a660e4f72ece991ce8bc5369`。build/final controlがclean source、test SHA、モデルSHA、全81資産の前後一致を検証した。独立レビューでも結果・制約・過去失敗保持の整合性を確認した。

同じclean runtimeで完了済みidleを除いた既存E2E10件（mock4/real6）も1回実行し、全成功、skip/retry/flaky/unexpected0。通常の24組連続編集を含み、旧301秒試験を再実行していない。回帰前後もclean source/全81資産が一致し、配布ディレクトリ検証はmodel5件・inventory80件（manifest自身を加えて81）で成功した。`regression/playwright.json` SHAは`618f80f29959f490335dd7dfa3a552d950925409a550ffd21496e1e73e6980e7`。専用idle1件と合わせて11件のWindows browser検証であり、新しい全OS/全context監査/package snapshotではない。既存ZIPは0dc814cのまま。

## Linux回帰4296639

Linux launcherのsource環境変数と階層下成果物の保持を修正後、clean `4296639b5c6728ccf3f2ebff0c531d2b68f96a5e`を固定Docker image・2CPU/8GBで1回検査した。製品コードとE2Eは6850aaf以降変更していない。全7ゲート、Python386/TS269、real E2E7件が成功した。Windows限定予算を繰り返す実験ではなく、別OSの変更後runtime回帰である。

Chromium159.0.8154.6 / Node24.15.0 / Python3.12.14 / WASM1 thread。idle試験は2タブ4推論・2サイクルと全cleanupが成功した。CDP detach3.49ms、context2,194.06ms、server0.46msで各5秒内。監視登録後の外部通信/page error0。各sampleは10 PIDの順次RSS取得で、拡張専用・同時/固有物理メモリやリーク不存在の証明ではない。

| 段階             | Worker数 | modelReady |  RSS合計bytes |
| ---------------- | -------: | ---------- | ------------: |
| before-inference |        0 | false      | 1,181,863,936 |
| shared-inference |        1 | true       | 1,663,336,448 |
| idle-1           |        0 | false      | 1,285,189,632 |
| resume-1         |        1 | true       | 1,553,534,976 |
| idle-2           |        0 | false      | 1,283,469,312 |
| resume-2         |        1 | true       | 2,149,777,408 |

最後の再初期化後の増加も保持する。Windows working setとLinux RSSは取得条件が異なり、数値の大小で優劣を判断しない。原因、長期間の資源上限、SDK dispose追加の効果は未検証。sourceとGit blobのtest SHA、同梱モデルSHA、7ゲートと必須reportを照合した。report SHA `10a7577541ba61e36d0f914d314c2a3bbba2325dab4b574a4ef0b767ac8a109d`、成果物は`artifacts/linux-check/4296639b5c6728ccf3f2ebff0c531d2b68f96a5e/`。モデル・選択した実行JS5件はWindowsと一致するがdistribution-manifestは異なり、OS間の全資産同一性は保証しない。[Linux記録](../linux-validation.md)と独立レビューに従う。新package/全監査/Chrome116/native/remoteやM5完成の証拠にはしない。
