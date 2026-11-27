# 共有Workerの並行要求を直列化する

文書追記: 2026-11-28。最新sourceaea6cafのpreview E2Eでは実モデル2要求成功・
3件目busy・dispose/Worker終了を確認した。初回6de3a00のE2E終了失敗を残し、helper修正後の
全7件成功と区別する。監査は別のcontext終了処理で失敗しており、全体のcleanup合格や長期資源改善とはしない。
[最新preview](../preview-validation.md)を参照。開発は停止中。

2026-11-27。製品バグの修正。Offscreenは最大2要求を受けるが、Workerは両方を同じLocalTypoDetectorへ同時に渡していた。SDKは後続detectで前のgenerationをcancelするため、別クライアントの要求が失敗し、未完了のORT runと後続runも重なり得た。旧2タブfixtureは逐次入力だったのでこの競合を検出していなかった。

実SDKと制御したsession.runを使う回帰で、同時run・3件目の過剰受付・応答timeout後のrun重複の3件がRedになった。Workerを実行1件/待機1件へ制限し、3件目はworker-busy、解放前の待機要求は世代不一致で拒否する。応答timeoutでも実runが終わるまでslotを保持し、owner Brokerの期限/Worker終了で回収する。本文を保存・ログ出力する処理は追加しない。

初回Greenでは既存の「実行中detectの完了結果」の期待1件が失敗した。既存のactive結果の扱いを維持し、世代チェックを待機開始/初期化の境界に限定して関連18件に成功した。最初のRed/Green失敗もartifacts/shared-worker-concurrency-{red,green,green-r2}.logに保持する。これは過去のidle/reloadメモリ増加の根因特定やRSS改善の証拠ではない。

## 実モデル確認の限定条件

次のclean commitをsource/runtime sourceとして、既存prepare_retention_trial.mjsで別のcontrol78資産を作る。固定0ba3630原資産からWorker/offscreenだけをbuildする既存経路を使い、source/provenance/全資産を照合する。古いdist、afbdd24の両build、38/277/791証拠と旧ZIPは変更しない。新資産の既定保持0、model revision8d640720bddeb64c89dc1fa7780c3ea29fa523e8、QUInt8 SHA dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab、WASM1threadを維持する。

Windows11 / Node24.15.0 / Playwright1.65.1 / 既存Chromium159.0.8154.6で、tests/e2e/concurrency.real.spec.tsを1件・1回・retry0だけ実行する。拡張popup内で実bundled Workerを1個作り、offlineにした後、3件を同時発行する。1/2は実モデルの検出成功、3だけbusy、モデルrevision/backend一致、dispose ACK成功とWorker終了、本文非記録、監視開始後のunexpected/pageError0、全cleanup成功を必要とする。二つのタブのUI/host permission全体を同時検証したとは扱わない。

新しいidle周期、資源sample、モデル変換/数値比較、Chrome116試行や全監査は追加しない。推論2件、Worker内応答期限60秒、Playwright180秒、外側process240秒、既存cleanup各5秒、外側所有process確認各10秒。失敗でも予算終了し、同条件retryは行わない。出力とreport/JUnit/trace/logをsource別に排他的保存する。source/Git blob/archive、binder、preflight SHAの外側固定、全資産/モデル、旧receiptを前後照合し、独立レビュー後に記録する。

SDK/native模擬回帰は実行slot1件を検査する。実ブラウザは実モデルの2結果とbusy/disposeを検査する。いずれも長期メモリ・OS RSS改善・精度・CPU/WASM parity/性能・native・他OS/最低Chrome・remote・M5全条件を代替しない。既存ZIPのsourceも変更しない。

## 結果（予算終了）

clean source/runtime `8c9988ed3d493157ccd5bd50f91b185be301d3f5` / tree `8d87617ae606c69755ff59f7c72d12eeb3c29c32`で実行した。全TS591件（54files）とnpm check成功。初期型検査のinventory型エラーと後続Formatエラーも別logに保持し、最終check-r3で全成功した。348 tracked controlsとarchive、全78資産/provenance、固定モデル・ブラウザ・旧38/277/791証拠・dist/ZIPを前後照合した。

Playwrightは1passed、skip/retry/flaky0、21,819.008ms。Chromium159.0.8154.6、offline-before-Worker、WASM実検出2件、3件目busy1、dispose ACK成功・Worker terminate、browser context cleanup completed、監視開始後unexpected/page error0、全資産不変を確認した。これはpopup内の実Worker契約の機能成功で、全2タブUI・全通信context・推論速度やメモリ改善の測定ではない。

外側supervisorはnormal/exit0だったが、初期CIM観測が10秒のdeadlineを超えた。creationIdentity=null、beforeSnapshot/afterSnapshot=[]は未観測であり、残存0を示さない。unknownReasonsはobservation-deadline-exceeded/root-identity-unconfirmed/cleanup-unverified、accepted=false・cleanupVerified=false。bound-resultもaccepted=false、errors=[process-or-report-gate-failed]、budgetClosed=true。事後binding失敗はなく、独立レビューはfunctional-pass-process-gate-failedと判定した。失敗を成功へ補完せず、CIM追加実行・期限延長・browser/model再試行は行っていない。

証拠rootは`artifacts/shared-worker-concurrency/8c9988ed3d493157ccd5bd50f91b185be301d3f5/`、開発用資産は`artifacts/retention-trial-build/8c9988ed3d493157ccd5bd50f91b185be301d3f5/control/`。101ファイルをreceipt SHA `f0d827bff6dcc768c8e2a6c664128e3aea7b95c1c67ca2adae7e995b936f2a17`で固定した。report SHA `df804e10b016c327f3d37317f5c4dd3acbaeae9f0c41c7378d5fe0c0ceeefa54`、preflight SHA `354d517c83bad341e23948c759efd75636ca9e654dbb93d26241726cf63a102d`、独立review SHA `0bcce71c3e04b544d1f652572a3674b262cf7ab4b1c638c2ae67ee3ad6db2e73`。後続文書commitへ実測sourceを付け替えない。

機能バグの修正は実装・限定実モデル検証済み。formalTrialAcceptance/memoryGrowthAcceptance/fullM5Acceptance=false。新sourceのLinux/最低Chrome/全監査、旧来の長期メモリ・精度/独立gold・CPU/WASM parity/性能・native・実サービス・remoteとM5全条件は残る。旧ZIPは更新せず、公開も行わない。
