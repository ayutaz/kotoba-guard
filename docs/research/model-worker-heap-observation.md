# 実モデルWorkerの世代別heap観測

2026-11-27事前登録。起点clean `f843b3d`。M4/R05の追加診断。M5の製品受け入れを代替しない。

## 根拠と変更条件

先行の[明示release](graceful-worker-release.md)と[所有関連監視除外](related-attachment-memory.md)では、再初期化2回目の関連process working setが約2.46GBへ増えた。既存の登録予算は終了しており、その無変更再試行は行わない。[親session経由の合成校正](parent-worker-heap-calibration.md)は`72dd90f`で成功し、線形WASM容量・JS heap・ArrayBufferを分離して読む経路ができた。この新条件では、現世代Workerの容量増加とprocess cohortの増加が同時に見えるか調べる。

製品runtime `0f99811`の全81資産を固定して診断用コピーを作り、変更は次に限定する。

- fixture origin1つのhost permission（既存の隔離fixture pregrant）
- worker.jsの先頭に固定の`import "./memory-probe.mjs";`と改行だけを追加。元workerの全bytesはそのままsuffixとして残す。
- 校正済み`wasm-memory-probe.mjs`を同じ内容で追加。モデル・core・WASM・Tokenizer・通常Workerの本文・製品sourceは変更しない。

全82コピー資産と元81資産の差を実行前後に検証する。モデルは37,789,676 bytes、SHA-256 `dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`。配布manifestのworker hashは元資産のものを保持し、診断コピーは配布用packageや通常runtimeと呼ばない。hook/親子debugger/計測のoverheadを含む。

## 条件・予算・停止

1. copy差分の許可範囲、source/事前controlの結合、親子heap取得、失敗時の途中値・cleanupをTDDで検証する。全TS/checkと独立レビューを通し、clean commitとsource専用の新規outputで実行する。
2. Windows/Node24/Chromium159.0.8154.6、同梱WASM1thread・ネットワークoffline、2fixture tab、固定文「明日の予定については、来週移行にご連絡します。」。全体240秒・retries0の**1 browser試行**。初回2tabの2推論、idle60秒のrelease ack1→再開1推論、idle60秒のack2→再開1推論まで。計4推論・3Worker世代・idle2周期で終了し、追加の文章・周期・GC強制・別backendを試さない。各idleの観測上限85秒を維持する。
3. process memoryはbefore-inference/shared-inference/idle1/resume1/idle2/resume2の6回だけ。同じCDP関連PID inventoryとWindows working set helperを使い、欠落/partialを成功扱いしない。OS問合せの既存15秒上限を維持する。process合計は同時測定・拡張専用RSSではない。
4. 現世代heapはshared-inference/resume1/resume2の3回だけ読む。各回、親へ非flat接続→親のworker auto-attach通知1件→既存子session採用→isolate/heap/線形容量を読む→子detach応答と通知→親detachを行い、所有する診断接続は次のidle前に外す。校正済みの固定数値expressionのみ。CDP command/通知待機/各cleanupは5秒、child失敗時の残存child明示detachを別5秒で1回試み、元の失敗を保持する。
5. 各heap読取はhook complete、観測Memory1個以上・正のbyteLength、正当な非負整数heap・used<=totalを要求する。3世代のWorker target/session/isolateは異なり、offscreen親targetは同じことを確認する。not-ready段階はheap未観測と記録し、0を補わない。dead Workerの旧WASM容量やheapは測っていない。
6. 4推論の視覚検出、本文保持・非保存、release ack1/2、offscreen1、監視開始後の予期しない通信/page error0、全cleanupとfixture差分保持を要求する。途中で失敗したら後続モデル推論へ進まず、途中値/traceを保持して予算終了。root/context/serverのcleanupは先行失敗後も各5秒で実行する。
7. 外側before/afterでsource/tree/clean・診断とstable controlのGit blob SHA、元81資産・旧0dc814c ZIP・先行校正54証拠の不変を照合する。固定control不在、既存report/出力衝突、source不一致ではbrowser起動前に失敗させる。

## 判定と限界

観測完了と製品資源合格を分ける。resume2/resume1のprocess cohort working set比、現世代WASM容量比、JS used比を併記する。1.25は先行診断と同じ「大きな増加」の分類線であり、新しい製品合格基準ではない。process比>1.25で現Worker容量/used比<=1.25でも、旧Worker保持・他領域・allocator/OS挙動のどれが原因かは特定できない。counterは加算してRSSにせず、異なる観測条件の過去値との差を因果効果としない。

hookのcompleteは上限/追跡エラーがないという意味で、全ての非公開WASM memoryを捕捉できる保証ではない。線形容量はresident/使用中bytesではない。観測後のdebugger detachはWorker終了の証明ではなく、idle時の製品release ackとは分ける。

成功・失敗で登録予算は終了し、無変更再試行・timeout延長・結果に応じた閾値変更・追加推論を行わない。実行前のコード不具合は回帰Redから修正する。M2独立gold/精度、M3 parity/速度、native/実サービス/remote、新runtimeの他環境/全監査とM5の未達条件を維持する。

## 実行前

モデル観測は未実行。実装・テストと結果をsource別に追記する。

実装前レビューの明確化: bodyの新規処理受付期限を開始190秒に置き、idle pollのtimeoutを残時間に切り詰める。OS queryは15秒を残せない場合開始しない。heap helperも各段階で期限を確認し、期限到達後は追加推論へ進まず、途中値を保存してcleanupする。最終240秒には最大50秒の終了/進行中要求の余裕を残す。遅い問合せでは全観測を完了できない可能性があり、成功条件を緩めず失敗で終了する。

直列の最悪値170秒（idle2回）＋90秒（OS6回）だけでも240秒を超えるため、最悪遅延での完遂を保証しない。SystemInfoと制御messageも5秒で閉じ、query直前にCDP5秒＋OS15秒の20秒を残せない場合は開始しない。新たな非空入力の直前とheap取得の各段階で受付期限を再確認する。遅延時は観測不合格・途中report保存・cleanupで終わり、240秒の延長や続きの推論を行わない。

workerのsuffixとprobeはbytes完全一致、残る79資産はSHA/size一致、manifest差分はhost permission1つだけを要求する。各heap recordは直前の推論番号・phaseと親/子target/session/isolateを結合する。各推論で表示span・本文保持・非保存を確認し、文章自体をreport/logへ加えない。比率は正の有限分母と完全なprocess sampleを要求し、欠落/0/partialならunknown、観測試行も受け入れない。

実行前のTDD: 新helper2module不在のsuite Red（実行0件）、比率計算と5秒wrapperのmissing exportによるbehavioral Red各1件を保持し、実装後に全TS318件/check成功。途中の型検査でtest用asset辞書の型推論が追加keyを拒否したため、明示的な辞書型を付けて修正した。deadline後のadopt/read停止、無効memory、読取/child/parent cleanup失敗、copy改変/余分なcode/権限変更、unknown比率を検証した。独立レビューで観測経路のblockingは解消済み。binderのdirty sourceと既存出力拒否probeはそれぞれexit1、出力作成なしで成功した。browserは未実行。

binderの最終レビューを受け、このChrome159診断ではexplicitParentIdの非null・親target一致を3世代すべてで要求する。読み取り後にもbindingValidとID対応が維持されることを確認する。2回帰testの初回mock配線に誤りがあり、実際にnull/無効状態になったことをassertする修正後もRed2を再確認してからhelperを修正した。両Redログを保持する。本文/保存検査はbooleanだけをassertし、失敗出力へ本文を出さない。process CDP commandの一覧と親子通信は別項目として記録する。

実行直前の全TS320件/check成功、コードとbinderの独立最終レビューでblockingなしを確認。次にclean sourceで固定1試行を実行する。

## 結果（登録予算終了）

clean source `58042c2faf2ca56c6e53119c99758d2b6b84f76d`、tree `076b5fe66b2bf656e4d1151e023191e809025899`で1試行が成功した。Windows/Node24.15.0/Chromium159.0.8154.6、WASM1thread。body160,239ms（最終cleanupを除く）、4推論・2idle周期、retry/skip/flaky0。全推論でspan13〜15、本文保持・非保存、release ack1/2と失敗数0、監視開始後の予期しない通信/page error0を確認した。3世代のWorker/session/isolateは異なり、offscreen親targetは同じ。各子/親detachと最終root/context/server cleanupはすべて5秒以内で完了した。

| phase            | 関連process working set合計 bytes | 現Worker WASM容量 bytes | JS used heap bytes | ArrayBuffer backing bytes |
| ---------------- | --------------------------------: | ----------------------: | -----------------: | ------------------------: |
| before-inference |                       682,770,432 |                  未観測 |             未観測 |                    未観測 |
| shared-inference |                     1,042,538,496 |             114,556,928 |         36,253,276 |                38,471,100 |
| idle-1           |                       799,051,776 |                  未観測 |             未観測 |                    未観測 |
| resume-1         |                     1,055,215,616 |             114,556,928 |         35,967,588 |                38,470,049 |
| idle-2           |                       791,318,528 |                  未観測 |             未観測 |                    未観測 |
| resume-2         |                     2,432,323,584 |             114,556,928 |         35,957,504 |                38,470,049 |

**cohort監査:** 各sampleは欠落なしの10 PIDだが、beforeのrenderer68396がshared以降のrenderer210368へ入れ替わった。6段階を固定process集合の時系列として扱えない。主要比較のresume-1/2は10 PIDとrole mapが完全一致するため、その2段階に限ってprocess比2.305048889647971を報告する。WASM比1、JS used比0.9997196364682558。PID一致はprocess開始identityやTarget所有関係の証明ではない。共通renderer85824のworking setも395,620,352→1,775,521,792 bytesへ増えたが、当該Workerのrendererとは同定していない。

現世代Workerの観測WASM容量/JS usedに同程度の増加は現れなかった。旧Worker・native領域・ブラウザallocator/キャッシュ・OS挙動の原因は未特定。観測試行を受理し、製品memory受け入れは不合格のままとする。独立レビューの初回「比率も異なるcohort」という指摘は、rootの全PID map照合と再レビューで訂正された。元receiptは変更せず、追加監査receiptで上の範囲を固定した。

全81基礎資産・診断82資産・旧0dc814c ZIP・先行54証拠が前後一致。元の26証拠も追加監査で再照合した。診断資産を製品へ採用せず、runtimeは`0f99811`、ZIPは`0dc814c`を維持する。

証拠directory: `artifacts/model-worker-heap-observation/58042c2faf2ca56c6e53119c99758d2b6b84f76d/`。

| 証拠                                          | SHA-256                                                            |
| --------------------------------------------- | ------------------------------------------------------------------ |
| report.json                                   | `3240bce25e7c6b9fb76399cf566fde94d6387d10d83849543a522557ca1c2940` |
| playwright.json                               | `b52e0246b89a24a65e17961bad2fd20bd643cde00fd866da219ad3cdba2c13fa` |
| build-control.json                            | `865f7e7df807c6c96219bd0664ecbf4c7014f05c6c634853daba1f522dbc1203` |
| final-control.json                            | `1f0ab5bf2a9fb7d8fe6657c2422b079dee63c344546418253d4e3aa59cb85f54` |
| preserved-evidence.json（26ファイル）         | `0151e4abb5a91b65fc3d755ddee588d71d63a04accdc2c415b5ed4eedfc1a1d3` |
| cohort-audit.json（追加、元証拠を変更しない） | `80a86601a9126bbd1861893c9e000704b8ed3e0ba659dfcf28b8d8d5b91acdd0` |

後続で比率helperにPID/roleの一致・重複拒否を追加した。回帰Red1→Green6を保存し、不一致をunknownにする。これは旧測定の再実行ではない。全TS/checkの新結果はstatusへ記録する。製品coverage/Python/Linux/WebGPU/最低版/全通信監査/新ZIPの追加成功はない。

次の単独仮説はoffscreen document自体のidle終了とlazy再生成である。既にsession dispose/Worker terminateは実装済みなので、それを繰り返すだけの候補にしない。公式API制約・race・pending/readinessを設計し、新しい事前登録とTDD/独立レビューを通してから別試行を行う。今回の観測予算は終了し、追加周期・GC・無変更再試行は行わない。M2/M3/native/実サービス/remoteを含むM5は未完成。
