# session release runtimeの既定経路・Chrome116互換性

現在の状態: 検証準備だけを完了し、追加browser試行は未起動で保留した。ユーザーから時間過多の指摘があり、補助検証より精度・数値差・メモリの製品阻害要因を優先する。以下の実行登録は未使用で、起動済み/互換性成功とは扱わない。

2026-11-27事前登録。起点は`b64168c`、製品runtimeは`afbdd24de0c3c7f32f3afa3481f087c2b4a83d3d`。[既定経路の通信監査](session-runtime-full-audit.md)は成功・終了済み。今回の新条件はブラウザを固定Chrome116へ変更し、現runtimeの保持0のidle/reload機能を検証すること。旧`daab981`のChrome116成功を新runtimeへ付け替えず、閉じた159対照/保持試験を反復しない。

## 固定対象と受け入れ

資産は`artifacts/retention-trial-build/afbdd24de0c3c7f32f3afa3481f087c2b4a83d3d/control`の全78ファイル。モデルrevision `8d640720bddeb64c89dc1fa7780c3ea29fa523e8`、QUInt8 SHA `dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`、WASM1thread、保持0を変更しない。build/package/モデル変換・閾値変更・外部downloadはしない。

Windows11 / Node24.15.0 / Playwright1.65.1 / Chrome for Testing116.0.5845.96。既存exe SHA `7460094ab51e1cb2fa6abeef0683275bb99684ad00334556547d7f4a6dd84c4e`、ZIP SHA `58ce894d230738e5b05ec0e20f8283c77070a97afb21bae3175e13f2b0af08b7`、公式固定tag PDL SHA `685dfe50fca9d91116412afeb42990d5f7a38857cb8336d4729a75650f166390`を前後照合する。認証・権限設定・PC設定を変更しない。

既存`tests/diagnostics/retained-session.spec.ts`のcontrolを1件だけ実行する。二つのタブで計4回のoffline WASM検出、idle2回、Worker/Offscreenの異なる3世代、before/shared/idle1/resume1/idle2/resume2の6資源sample、各idle通知1件（合計2件）、各解放completed1/failed・timedOut・sendFailed0を要求する。再開cycleのWorker/文書とsnapshotを対応させ、通知も実際のretired文書と対応させる。unknown観測や未取得の本文非保存を成功へ読み替えない。

Playwright1passed、skip/retry/flaky0、本文保持・storageContainsInput=false、監視開始後のunexpectedRequests/pageErrors0、親session経由のWorker観測complete、各idleでWorker/文書0、全4段cleanup completedかつ各5秒未満を要求する。OS資源sampleは全6段でmeasured、PID/role/current/peak/件数が完全であること。PID集合が変われば比率・増加分類はnull、メモリ改善を合格条件にしない。

fixtureだけのhost grantをmanifestへ追加したcloneを使い、元資産は変更しない。cloneは78ファイル集合一致、manifest以外77資産の完全一致、変更manifestの前後不変と唯一のlocalhost grantを既存specで確認する。これはnative権限承認/取消や実サービスの検証ではない。

## テストと証拠

`scripts/runtime_compatibility_acceptance.mjs`は明示したsource/runtime/version/platform/node/model契約と実レポートを照合する。sourceは今回の検証コード・本書を含む次のclean40桁commit、runtime sourceはafbdd24として分離する。初期14テストはimport不在RedからGreen、旧159controlの読み戻しも成功した。読み戻しは初期schema確認だけで新ブラウザ合格ではない。

独立レビューにより8件の実際の失敗assertionを追加し、全22件に成功した。実モデルhashとexpectedModelSha256の一致、Worker IDのArray型、report/snapshot/cycle/notice等のキーallowlistを検証する。senderDocumentIdがnullならsenderIdentityAuthenticated=falseを明示し、staleNoticeSecurityAcceptanceは常にfalse。文書IDの対応は確認してもbrowser認証の成功とは扱わない。

idle観測はpoll開始時点より前のmemory sample等にも時間を使うため、releaseObservedAfterMsに根拠のない下限を設定しない。specに最後の入力操作を発行する直前の時刻を追加し、cycleごとにidleStartedAfterLastInputMsとreleaseObservedAfterLastInputMsを記録する。両者とpoll経過時間の和の整合、入力発行から解放観測まで60秒以上、既存poll期限85秒未満を要求する。入力時刻は推論完了より前なので、厳密なACK時刻やtimer発火時刻の測定とは区別する。新しい時刻fieldのない旧reportは、今回の厳格な契約へ補完・再ラベルしない。

初回全体検査は既存`prepare_retention_trial.test.ts`の78ファイルfixtureコピーで5秒timeout、578pass/1failとなった。期限やassertionを変えず、Vitestのworker上限を4へ明示し、別ログで全579件に成功した。最初のrunの環境起動集計175.12秒と次run69.34秒は異なる並列条件の実測で、timeout原因の完全な特定や速度改善の保証ではない。両ログを保持し、同条件の無根拠なretryやskipはしていない。

外側binderは`.cache/bind_default_runtime_116.mjs`。source全tracked raw SHA/Git blob/tree/archive、runtime関連全72 blob、実行binder/spec/config/helper/lock、既存モデル/全78資産、Chrome116の3ファイル、旧38/277/791証拠・旧dist/ZIP・先行失敗を前後照合する。出力を先に排他的確保し、既存output/receiptを上書きしない。binder自身をコピーしhashを固定する。

```text
node .cache/bind_default_runtime_116.mjs prepare <source>
node .cache/bind_default_runtime_116.mjs run <source> <externally-recorded-preflight-sha256>
```

出力は`artifacts/default-runtime-chrome116/<source>/`。実行1回・retry0、test240秒、各idle85秒、cleanup各5秒、外側process300秒、外側CIM識別/終了処理の各段10秒（timeout後最大50秒）。`audit_process_supervisor.mjs`で新規所有treeのPID/creationを照合し、正常終了0・残存tree0・unknownなしを必要とする。CIMアクセス可能な承認済みローカル条件で実行し、先行のprocess probeは繰り返さない。timeout・起動・推論・観測・cleanup・bindingの失敗でも予算終了、全失敗理由を保持する。同じlive handleの観測を継続し、yieldを理由に新processを起動しない。

レポート、Playwright JSON/JUnit、trace/実行log、外側process/run-start/preflight SHA、前後照合とbudgetClosedを保存する。実行前に独立レビューを行い、実行後も結果をレビュー・receiptで固定する。

外側binderのレビューでは、runで初めてSHAを計算するだけではprepare後のpreflight改変を検出できない問題も見つかった。prepare時に出力したSHAを外側へ記録し、runの必須引数で明示して読み込み前に照合する形へ変更した。固定Chrome exe/runtime/model SHAもrunで再検査する。欠落SHAは起動前に拒否する。binderの実試行は保留のままで、これらの変更を実ブラウザ成功の根拠にはしない。

## 対象外と残ゲート

保持60秒のsession release/expiry、長期資源、全startup通信、全116patch、WebGPU、物理IME/native権限、実サービス、remote CIは今回の対象外。新しい精度/独立gold、CPU/WASM parity/性能測定もしない。限定機能成功でもM2/M3・Linux・メモリ増加とM5全条件は残る。保持既定0、候補採用未決定、memoryGrowthAcceptance/fullM5Acceptance=false、旧ZIP0dc814cを維持し、外部公開は行わない。

## 準備完了時の記録

最終の全TS587件/53files、npm check（Lint/型/Format）は成功した。追加22件のvalidatorテストは、初期import不在Redとレビュー起点の8fail/14passからGreenを確認している。実process/browser/modelは0回、coverage・性能・新しい互換性の実測も0回。準備logは`artifacts/runtime-compatibility-{validator-red,validator-green,review-red,review-green,check,check-r2,full-tests,full-tests-bounded-workers,full-tests-final}.log`へ分けて保持する。binderは構文確認のみで、実行によるpreflight/事後照合は未検証。M5未完成を維持する。
