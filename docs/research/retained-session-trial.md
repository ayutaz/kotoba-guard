# session解放とWorker保持を分ける対照試験

2026-11-27事前登録・実行。状態: 対照/保持の限定機能試験は成功、両予算終了。既定値への採用・長期資源・M5は未達/未決定。以下の事前登録は履歴として保持し、再実行指示としない。

[ADR-0011](../adr/0011-retained-worker-candidate.md)の候補は、推論セッションを解放した後もWorkerとORT moduleを短時間保持する。問いは、同じWorkerで新しいsessionを作り直してoffline検出でき、保持期限で確実に終了するか、および完全終了方式と資源観測がどう異なるかである。改善・採用は未決定。[旧159試行](scoped-idle-chromium159.md)の予算は終了したまま、新しいコード条件を比較する。

## 固定する入力と資産

実装・単体/結合テスト・この登録・診断build/testを含む次のclean40桁commitをsourceとする。原資産は`0ba36301cdb1b2b9759ce81dbdc8fb6837648bbe`の78ファイルで、通常の`dist/extension`を上書きしない。新sourceの`worker.js`と`offscreen.js`だけを別の実験ディレクトリへbuildし、distribution-manifestを再生成する。これら3ファイル以外の75ファイルは原資産と一致を要求する。同じsourceの対照/保持間の差分も記録する。外部配布用ZIPは作らない。

元モデルrevisionは`8d640720bddeb64c89dc1fa7780c3ea29fa523e8`。同梱QUInt8は37,789,676 bytes、SHA `dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`、WASM1threadと既存閾値を維持する。Windows11、Node24.15.0、Playwright1.65.1、既存Chromium159.0.8154.6（revision1255）の全305ファイルを前後照合する。download・machine/認証設定変更はしない。

先行14receipt/791証拠、旧Chrome27/preflight8、旧116 exe/ZIP/PDL、native接続不可記録、旧ZIP0dc814c、原78資産を前後照合する。新sourceのGit tree/archiveとcontrolファイル、実行コマンド・環境・wrapper/config/testのSHA、両armの全資産を別の排他的outputへ保存する。既存output・receipt上書き・同一arm再起動は拒否する。

## 2つのarmと予算

モデル・browser仕事は直列にする。各arm1試行、retry0、skip0。対照の機能・観測・cleanupが失敗したら保持armを起動しない。資源cohortの交代はunknownとして保持し、それだけで機能失敗にしない。

| arm      | 処理                                                             | 終了条件                                                                                                                            | test上限 |
| -------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------- |
| control  | 同じ新source、保持0。2タブ初回2推論、idle60秒/再開を2回、計4推論 | 3 Worker/document世代、idle通知2件、各release completed1/他0                                                                        | 240秒    |
| retained | 保持60秒。初回2推論、session release/再開を2回、計4推論          | 途中は同じ1 Worker/document、通知0。最後の入力から60秒で3回目session release、さらに60秒でWorker/document0、通知1件・completed3/他0 | 360秒    |

保持armの追加120秒は最終のsession解放と保持期限を観測するためで、旧試行の期限延長ではない。各中間idle poll85秒、最終終了poll145秒、cleanup各5秒。外側process上限はcontrol300秒/retained420秒。起動/観測/推論/cleanup失敗も試行予算終了とし、別入力・追加周期・追加推論・backend変更・強制GC・private allocator・自動retryへ拡張しない。途中で実装を直した場合は、この試行の失敗を残し、新条件の登録なしに再実行しない。

## 機能・セキュリティ条件

両armとも4回の実モデルoffline検出、2タブでの本文保持、storageContainsInput=false、監視開始後の予期しない通信/page error0、モデルSHA一致、親sessionによるWorker観測complete/pending0、全cleanup完了を要求する。isolated localhost fixtureのmanifest pregrantだけを加え、cloneの他77資産はbuildと一致させる。native権限・物理IME・実サービス成功とは扱わない。

保持armは中間idle時にready=false、document retiring=false、release completed1/2、他0、同じWorker/documentを要求する。再開はready=trueとなり、実検出が再び成功する。これを同じsessionの使い回しと混同しない。session-only release成功後にdetectorを作り直すことはWorker単体のconstructor/dispose回数でも検証する。status参照ではidle/保持期限を延長しない。最終通知のsender.documentIdが得られればpayloadと一致を要求し、欠落ならnullを保存し、browserが認証したdocument ID一致とは主張しない。private instance marker・ユーザー本文・例外全文は証拠へ出さない。

## 資源の判定と採否

before/shared/idle1/resume1/idle2/resume2の6時点でOS sampleを取得する。WindowsのCDP関連processのWorkingSet64/PeakWorkingSet64を順次取得し、scope・非空rows・欠落PIDなし・値の型/有限/非負を検査する。拡張専用RSS、同時peak、process開始identityやWorker専有の証明ではない。

主比較は各arm内のresume1/2のcurrentBytes合計と、同一PID/role集合の場合だけ差・比である。PID交代・重複・欠落・不正scope/値ならcohortMatch=false、比/差/largeIncreaseはnull。1.25超を従来と同じ診断分類とし、製品合格閾値へ転用しない。各armの絶対値と制約を併記し、異なるarmのPIDは一致を要求しない。単発の大小から因果、長期上限、リーク不存在やzeroizationを主張しない。

単体・結合Green、Lint/型/全entrypoint coverage、独立レビュー後にsourceを固定し、起動前と終了後の照合を行う。候補の機能成功や低い資源値だけで既定値を変更しない。影響するLinux/最低Chrome/全context通信監査、独立gold/精度、CPU/WASM parity/性能、native/実サービス/remoteとM5全条件は残る。WebGPU・修正候補・モデルの差替えは今回の範囲外。

## 実行前の検証記録

本体実装は`f31e6b9`。保持0/保持ありのBroker、実Worker entryとの接続、Offscreenを含む関連84件が成功した。Worker初期化/run/dispose競合と、同一releaseIdの早期false ACKで正常Workerが終了する問題をRedから修正し、独立レビューした。

準備時の全TypeScript523件、npm checkが成功した。coverageは全entrypointを含みstatements89.02%・lines91.67%、SDK statements92.42%・lines94.56%。初回全体検査のファイル処理5秒timeout（522成功/1失敗）、型エラーとFormat不一致、保護ファイルの照合root誤りはログへ保持した。DOM不要のファイル検証テストをNode環境へ移し、全体coverageは`--maxWorkers=4`で実行した。失敗したbuild unitの5秒制限・assertion・coverage閾値は緩めていない。成功ログは`artifacts/retained-session-overall-coverage-r2.log`、`artifacts/retained-session-overall-check-r3.log`。

通常unitではtmp fixtureを使い、実環境の巨大資産や791証拠をCIへ要求しない。実Viteの2entry tiny fixture build、排他的出力、symlink、固定entry、75資産不変、fixture overrideのsourceBound=false、証拠改変、PID/role交代、peak欠落/合計overflowを検査した。既定値のlive readbackも別コマンドで成功し、14receipt/791証拠、27/8旧証拠、78原資産、305browser、旧116の3ファイルと旧ZIP/native記録を実ファイル照合した。`artifacts/retained-session-protected-readback-r2.log`を参照する。

外側wrapperは`.cache/bind_retained_session.mjs`。identity空欄・最終expiry欠落・最終解放前のWorker交代を受理する欠陥を実際のRedから修正し、20のモデルなしprobeが成功した。wrapperの実体・probe/logを新sourceの出力へコピーしてSHAを固定する。controlのreceiptをretained起動前後にも検証し、同じpreflight SHA/sourceの成功がない限りretainedを起動しない。

```text
node .cache/bind_retained_session.mjs prepare <clean-source>
node .cache/bind_retained_session.mjs run <clean-source> control
node .cache/bind_retained_session.mjs run <clean-source> retained
```

`prepare`は実モデルを推論せず、原78資産から別buildを作り、全tracked sourceのraw SHA/Git blob・archiveとcontrolを束縛する。実行出力は`artifacts/retained-session-trial/<source>/<arm>`、buildは`artifacts/retention-trial-build/<source>/<arm>`。source・wrapper・資産の不一致時やoutput既存時は起動せず、起動後の失敗はそのarmの予算終了とする。最終releaseはstatusを観測した時刻とし、未観測のACK正確時刻を捏造しない。release3/ready=falseを同一Worker/documentで観測した後はOffscreen statusを送らず、public statusと文書/Worker消滅・通知で保持期限の終了を検証する。

最終追加検査ではWindowsでCLIが無言終了するfile URL判定をRedから修正した。追加CLI回帰を含む全524テストとnpm checkが成功（`artifacts/retained-session-final-tests.log`、`artifacts/retained-session-final-check.log`）。資産/ブラウザの余剰fileを拒否する回帰もRed→Greenで通過し、live readbackは`artifacts/retained-session-protected-readback-r3.log`で成功した。変更10文書のlocal link272件とSkill validatorも成功。これらは起動前の品質証拠であり、実モデルの成功を意味しない。

## 最初の準備失敗と修正（実行予算未使用）

clean `affc03c178e433e05c68605d48bb4e4f9bb4afdf`のprepareは、builder内の`safe.directory`へWindowsのbackslashを渡したためGit所有者確認で失敗した。build・browser起動・モデル推論はすべて0。グローバルGit設定や権限は変更しなかった。source archive、wrapper、準備ログ、失敗、所有者確認の実Redを同source出力へ48ファイルとして凍結した。receipt SHA `7bfaff1ff865b4bca4fd3537df63df72e48228c79a47db357b225a72d94413b6`。先行14receipt/791証拠と全原資産の不変も確認した。この準備出力は再利用しない。

修正はGitの1コマンドだけに渡すパスをforward slashへ正規化する。誤ったcommitを指定した実環境probeが、所有者エラーではなく意図したHEAD不一致で停止することをRed→Greenで確認し、builder9テストも再成功した。`artifacts/retention-trial-git-path-red.log`/`-green.log`と`.cache/probe_retention_git_path.mjs`を次の出力へ保存する。本体protocol・既定値・モデル・推論設定・登録予算は変えない。修正を含む次のclean sourceでprepareし、上記48失敗証拠も起動前後に追加保護する。control/retainedのbrowser予算はともに未使用の1回を維持する。

## 結果（source afbdd24、両予算終了）

clean sourceは`afbdd24de0c3c7f32f3afa3481f087c2b4a83d3d`、Git treeは`b8552293b0e74ba28f95c89495cbbda561ef5fb2`。実装f31e6b9、準備affc03c、Windows command-local Git path修正afbdd24の順で固定した。337 tracked controlsのraw SHA/Git blobとsource archiveを束縛した。両arm各78資産、原資産との変更はoffscreen.js/worker.js/distribution-manifest.jsonの3件のみ（75件不変）。arm間の差はoffscreen.jsとmanifestだけでWorker bytesは一致する。通常dist・旧ZIPは上書きしていない。

Windows11 / Node24.15.0 / Playwright1.65.1 / Chromium159.0.8154.6 / ORT Web1.31.1 / WASM1thread。モデルrevision・QUInt8の37,789,676 bytes/SHAは登録どおり。対照→保持を直列実行し、それぞれPlaywright1 expected、unexpected/flaky/skipped/retries0、外側process exit0だった。

| 観測                                                     | control (保持0)       | retained (保持60秒)          |
| -------------------------------------------------------- | --------------------- | ---------------------------- |
| offline実検出                                            | 4回                   | 4回                          |
| 途中Worker数 (before/shared/idle1/resume1/idle2/resume2) | 0,1,0,1,0,1           | 0,1,1,1,1,1                  |
| Worker/document                                          | 3世代                 | 再開2回とも同じ1世代         |
| release通知                                              | 2件・各completed1/他0 | 最終1件・completed3/他0      |
| 途中idle ready                                           | false                 | false、retiring=false        |
| storageContainsInput                                     | false                 | false                        |
| 監視開始後の予期しない通信 / page errors                 | 0 / 0                 | 0 / 0                        |
| 本体とcleanup合計時間                                    | 158,848.999 ms        | 274,256.662 ms               |
| 最終状態                                                 | 最後の再推論後ready   | release3後、Worker/document0 |

ストレージ検査の対象はchrome.storage.localで、storageContainsInput=falseを確認した。両armとも親session観測はcomplete/pending0で、各再開の実推論も成功した。保持版はsessionを解放してから同じWorkerに新しいdetector/sessionを作る。最終release3/ready=falseを同じWorker/documentで観測した後はOffscreen statusを送らず、公開状態・消滅・通知を使って終了を確認した。release状態の観測から終了観測まで58,897.391 ms、開始から終了観測まで272,259.986 ms。これはstatusの観測差であり、未観測のACKからの正確な60秒測定ではない。通知sender.documentIdは両armでnullなので、browser認証済みdocument ID一致とは主張しない。

### OS資源の実測値

各時点10 rowsのCDP関連browser processのcurrent WorkingSet64合計（bytes）。各PIDを順に測り、拡張専有・同時peak・OS即時回収を意味しない。

| 時点             |       control |      retained |
| ---------------- | ------------: | ------------: |
| before-inference |   687,575,040 |   687,108,096 |
| shared-inference | 1,042,321,408 | 1,046,507,520 |
| idle-1           |   798,277,632 |   983,486,464 |
| resume-1         | 1,044,684,800 | 1,068,978,176 |
| idle-2           |   790,245,376 | 1,007,050,752 |
| resume-2         | 2,688,946,176 | 1,081,966,592 |

controlはresume1/2のPID/role集合が交代し、cohortMatch=false、beforeBytes/afterBytes/delta/ratio/largeIncreaseはnull。絶対値2,688,946,176 bytesは保持するが固定cohortの増加率にはしない。retainedは同じ10 PID/role集合でcohortMatch=true、delta12,988,416 bytes、ratio1.012150309792667、診断上のlargeIncrease=false（登録した1.25分類）。この限定条件で大幅増加を観測しなかったことだけを示す。arm間のPID集合・OS/cache条件は異なり、反復もないため保持方式による因果的改善、安定した上限、リーク解消や既定値への採用は結論できない。process開始identityも検証していない。

### cleanupと固定証拠

| cleanup         | control ms | retained ms |
| --------------- | ---------: | ----------: |
| worker-observer |      6.713 |       0.370 |
| cdp-session     |      4.997 |      12.121 |
| browser-context |  1,476.473 |   1,706.932 |
| fixture-server  |      1.101 |       1.385 |

4段階すべて完了し、各5秒制限を維持した。全旧791証拠、旧affc03c失敗48証拠、原78資産、browser305ファイル、両build/sourceを前後照合した。独立レビューは`pass-bounded-functional-only`、blockingFindings=[]。レビュー指摘0は製品全条件合格ではない。

証拠rootは`artifacts/retained-session-trial/afbdd24de0c3c7f32f3afa3481f087c2b4a83d3d/`、buildは`artifacts/retention-trial-build/afbdd24de0c3c7f32f3afa3481f087c2b4a83d3d/`。新しい総receiptは277ファイル（今回の出力・両build/provenance・affc失敗receiptを含む）。旧791証拠とは別の照合範囲で、単純加算しない。

| 証拠                                   | SHA-256                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| source.tar (3,594,240 bytes)           | `68bd4e19b29d7063be082ad3e517fda666275c545d8b13968fac7670ff614d15` |
| preflight.json                         | `1b5c0462658e55b517a65e1faa4f769b0ca293b82e78bf5bcce33f56c82179a2` |
| binding-script.mjs                     | `0a36d488c189c849bcc9a234505b426c2f15447f55684de1dde5b468e526fc64` |
| control/report.json                    | `ecd9ba4d73dea0e7686c5ea5f4dc8b9d37042bcbde5046ebdf0a07be4d29d758` |
| retained/report.json                   | `04f63a153aa03a7842bcc6f7dec87f86305294018bd83f0f40d16b04c7803bde` |
| control/preserved-evidence.json        | `87291b38fca0bb18503b28560b68b07c1c994a4e2d88fb8f6896588a15d40d21` |
| retained/preserved-evidence.json       | `4d7df7e0b73ab5b7012cdbd5a1c807e6dcf364d03d3e739313967b5c4dc81f7b` |
| independent-review.json                | `8b2db5452049ed314e73b385416464c74a0a5ba41f08768d8f10ff9a8a665b79` |
| preserved-evidence.json (66,000 bytes) | `3e27e10c98d38a737da61563625c28314b536d28d0ad6a7504c2a33f3546167b` |

最終固定処理の初回はblockingFindingsを数値0と想定し、実際の空配列[]とのschema不一致でコピー/総receipt作成前に停止した。レビューや試験結果を変更せず、sealerだけに配列・length0の検査を入れ、再度ハッシュ照合して固定した。モデル/browserの追加起動は0。

### 採否と残ゲート

両armのboundedFunctionalAcceptance=true、memoryGrowthAcceptance=false、fullM5Acceptance=false、adoption=false。両実行予算は終了し、同じwrapperのprepare/runを再実行しない。後続文書commitは実測source afbdd24を変更しない。

次は候補に影響するLinux・最低Chrome116・全context通信監査を別のsource-bound条件と予算で登録する。短い再開試験とは異なる長時間/資源上限の受け入れを定義し、反復・cohort変化・測定制約を扱ってから採用を判断する。M2独立gold/精度、M3 CPU/WASM parity/性能、物理IME/native権限、実サービス、remote CIとM5全条件は未完了。今回の経過時間はcold/warm推論ベンチマークではなく、FP32/INT8/FP16精度・WebGPU速度/メモリの新測定もない。旧ZIP0dc814cを維持し、新ZIP・モデル公開・Store/npm/GitHub公開は行っていない。
