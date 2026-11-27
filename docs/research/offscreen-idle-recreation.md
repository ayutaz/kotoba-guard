# Idle時のOffscreen Document終了・再生成

最新結果は[背景側identity照合の登録と結果](offscreen-brokered-identity.md)。本書の初回37cfb0dは失敗として終了し、後続の別条件72236f2で機能観測・通常回帰10件が成功した。資源問題/M5は未解決。以下は初回条件と当時の履歴であり、未実行表現を現在の状態と解釈しない。

2026-11-27事前登録。起点clean `91f7776`。M4/R05の別仮説であり、M5受け入れや公開を代替しない。

## 根拠と設計

[現Workerの観測](model-worker-heap-observation.md)では、session dispose/Worker terminate後の3世代でWASM容量/JS usedは一定だが、同一resume pairのprocess合計は2.305倍だった。原因やWorker→PID所有関係は未特定。次はWorkerを所有するoffscreen document自体もidleで閉じる。Chromeが共有renderer/native領域を解放する保証はなく、改善は実測前に主張しない。

[公式offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen)ではoffscreenはruntime APIだけを使用でき、closeDocumentは背景側から呼ぶ。WORKERS reasonには自動寿命制限がない。[runtime getContexts/MessageSender](https://developer.chrome.com/docs/extensions/reference/api/runtime)のdocumentIdで現在文書と送信元を照合する。最低Chrome116のまま、追加権限・通信・保存なし。[SW lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)の休止を前提に、SW timerで60秒を数えずoffscreen内の既存idle timerを使う。閉鎖後のSW再起動はgetContextsで実状態を再発見する。

- 既存60秒idle→SDK dispose ACK（上限1秒）→Worker terminateを維持する。完了時にpending0の場合だけ、offscreenから型/固定数値だけのidle通知を送る。
- 背景は拡張ID・完全一致offscreen URL・tabなし・非空documentId・厳密なmessage schemaを検証する。getContextsの現在documentIdと一致し、処理中/待機中の検出がなければcloseDocumentする。旧宣言IDを持つ遅延idle通知はcurrent ID不一致で拒否する。後続の[訂正protocol](offscreen-brokered-identity.md)に記載したnull sender identityの仮想raceは未検証、nonceによるisolate固有証明は未実装。
- create/closeは単一の遷移を共有し、検出は終了中のcloseを待つ。新しい入力を失わず、作成中/使用中はcloseしない。Chrome APIが応答しない場合は5秒で呼出元を失敗させ、未完了の実APIを保持して重複したcreate/closeを増やさない。
- 現documentIdの確認からclose実APIの完了まで同じclose leaseを保持する。遅延close中の新規検出は旧文書へ0件、完了後だけ再生成へ進む。5秒の応答期限後も実APIが未完ならleaseを保持し、遅い成功/拒否後にのみ再発見・回復する。遅延APIを用いたhelper/背景entryの統合回帰でこの順序を確認する。実モデルtrialへ人工遅延を加えて性能/資源条件を混在させない。
- statusは文書/Workerを生成せずidle期限も延長しない。releaseやclose失敗は入力やraw errorを記録しない。offscreenから送る通知にユーザー文章を含めない。

## TDDと機能受け入れ

実装レビュー追加条件: SW再起動でvolatile leaseが失われる競合を防ぐため、文書側retiringをidle通知前に立てる。retiring中のdetectはbusyでWorkerへ0件。新SWはgetContexts/statusを観測して旧文書消失を5秒以内で待ち、その間create/二重close/検出を行わない。close未開始の明示応答`{ok:true,closed:false}`だけがretiringを解除する。API拒否/timeout/通知消失/同期throwはunknownとして保持する。旧文書が残り結果を失った場合はfail-closed、ブラウザ/拡張再起動が必要な既知制約とする。遅延resolve/reject・SW再初期化・通知消失を回帰で確認する。予算/閾値/文章/周期は変更しない。

独立したlifecycle helperとentry/broker/背景境界のテストを先に失敗させる。close中の新規入力、同時ensure、作成/終了失敗と回復、未完了APIの上限、pending中の閉鎖拒否、古いdocumentId、content/popup/不正通知拒否、status非初期化を確認する。全TS/checkと独立レビューを通してclean sourceを固定する。モデルは既存QUInt8 SHA `dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`のまま。全81配布資産を新sourceと対応付け、旧ZIP・先行証拠を変更しない。

## 新しい実モデル予算

Windows/Node24/Chromium159.0.8154.6、同梱WASM1thread、fixture2tab、offline、固定の既存typo文。**1 browser試行/retry0/240秒/4推論/2idle周期**で終了する。初回2tabで共有1文書/1Worker、idle後は文書0/Worker0、各再開後は文書1/Worker1・異なるdocumentId/Worker IDとなること。2回のrelease ACK成功をテスト側popup listenerで固定数値とsender documentIdだけ観測する。製品への永続カウンターや診断用公開endpointは加えない。各推論の検出span13〜15、本文保持・非保存、監視開始後の外部通信/page error0、全cleanup5秒以内を要求する。通常の機能E2Eも変更後runtimeで実行するが、既存の登録資源予算の再実行にはしない。

文書0はgetContexts、Worker0は旧targetの明示inventory消失をそれぞれ確認し、ACKだけでは代用しない。get-statusはmodelReady=falseを返す。再生成後は新documentId/Worker target ID、同時文書数1を確認する。親target監視を使う場合は終了した親を再利用せず、所有sessionを明示detachしてから次の親を監視する。監視・detach/cleanup overheadを含む診断であり通常操作の速度保証とはしない。

process memoryはbefore/shared/idle1/resume1/idle2/resume2の6回のみ（SystemInfo5秒/OS query15秒）。新規body処理受付期限190秒を適用し、query前に20秒を残せない場合は停止。最終cleanupはCDP/context/server各5秒。元81資産の新build control、source/tree/clean・model/hash・全cleanup・旧証拠不変を外側で照合する。途中で失敗したら追加推論へ進まず途中reportを保存する。

この条件はdocumentを意図的に再作成するためPID交代が起こり得る。各sampleの完全なPID/role map・合計・交代を保存し、resume pairが一致する場合だけ同一cohort増加比を計算する。不一致なら比率unknownとして機能受け入れと分離する。process比1.25は診断分類線のままで製品のメモリ合格閾値に変更しない。WASM/heap hook・強制GC・追加周期・backend変更を加えず、今回の機能成功だけでリーク解消/資源上限合格としない。

成功/失敗で予算終了。無変更再試行、timeout延長、閾値変更、追加推論は禁止。旧trial・ZIPを付け替えない。Linux/最低Chrome/全context監査・coverage・新配布snapshotとM2/M3/native/実サービス/remoteは別の未完了ゲートとして維持する。

## 実装・実行前の確認

診断レビュー後の観測protocol明確化: hot3段階だけ、成功済みParentWorkerSessionの非flat親session通知から所有Worker IDを取得する。明示parentId/child IDを照合し、子detach応答+通知/active0と親detachをそれぞれ5秒で完了してからidleへ進む。heap hook/数値読取は加えない。idleはgetContexts0と全Target inventoryの旧Worker/親消失を確認する。親子対応/cleanupをreportとbinderに保存する。これにより単なるURL一致や累積detach件数を所有関係の証拠にしない。観測のoverheadを含むことは維持する。通知schemaは余分なkeyも拒否し、回帰Red1→Green4。成功reportのbody elapsed<=190秒、idle観測各<=85秒も外側で検査する。

文書lifecycle helperのmissing module Red（suite実行0）を保存して実装し、entryのclose/通知/偽装拒否Red3を確認した。初回Green確認の1失敗はmock検出resultのdetections欠落で、実データ形状へ訂正した。閉鎖前readinessの遅延応答Red1、SW再起動/retiring/通知喪失Red5、重複通知時のunknown保持Red6を追加して修正した。helper10件、offscreen entry11件の安全経路が成功している。同期sendMessage throwの捕捉も検証した。

新しい診断と通常idle E2Eは文書0→新IDの再生成へ更新した。新診断のレビューで、文書毎のrelease数を累積とした誤りを1に訂正、fixture manifestのafter自己比較を実行前固定との比較に変更し、全推論のspan/保持/非保存・非空入力前deadline・OS query直前20秒余裕・partial後停止を追加した。process pairの正当性は回帰Red1→Green4で検証した。実ブラウザはまだ実行していない。

全TS343件/checkが成功。テストmockのChrome API overload型エラー2件を型付けされたローカルmock参照へ修正し、通常idle specのdocumentId絞り込みも型検査した。dirty sourceと既存出力を使った外側binderの負例は各exit1・新出力なし。旧runtime81資産を全bytes保存・ハッシュ照合した。実行前レビューとclean commit/source専用build-controlで固定後、登録1試行へ進む。

## 初回結果: idle1で失敗、予算終了

clean `37cfb0d3c7b42a446121d8aafbaafd7d47cd8773`（tree `fd2246353a80ae10fec739bddcd01c517d309597`）のビルド・ディレクトリ検証と前後binderは成功したが、登録した実モデル1試行は最初のidle poll85秒で失敗した。body99,938ms、初回2推論のspan/本文保持/非保存は成功。idle終端のpredicateはready=false/Worker0だがcontexts1/parent1/released=false。再開推論と2周期目は未実行、メモリ増加の比較はできない。所有親子session1世代のID対応、子detach応答/通知/active0と親detachは成功。最終CDP4.64ms/context929.30ms/server1.12msのcleanupも成功した。

report: `artifacts/offscreen-idle-recreation/37cfb0d3c7b42a446121d8aafbaafd7d47cd8773/report.json`、SHA `06ef0423a6f766fabeda449a2697c20819505827d9ceaa8959af4c5133adb089`。`failure-control.json`はfunctional_observation_acceptance=false。ログ/trace/screenshots/controlを含む46証拠の`preserved-evidence.json` SHA `4ec14d2f50cfd991715f2acc534dae3763993ca79547b841bd8d9c48384f33f7`を固定した。モデル/旧ZIP/先行証拠不変を外側で確認。失敗reportには終端の生sender metadataやnotice/status内容、通信/pageerrorの途中カウンターがなく、未観測を0と補わない。

無変更再実行しない。次の別条件は**モデルなしの通知metadata診断1回**: Windows/同Chromium、モデル/tokenizer/WASMを持たない最小MV3 fixtureへ今回のbackground.jsをbytes一致でコピーし、診断offscreen文書から固定idle通知1件だけ送る。popupと背景受信でsenderのID一致/URL一致/tab有無/documentIdと、getContexts documentIdの対応・応答を観測する。文書作成1回/通知1件/最大60秒/retry0、失敗でも終了する。入力文章、実サイト、推論・GC・追加モデル周期は含めない。診断コード/元background/manifest/全fixture assets/source/reportをhashで結合し、元81製品資産と46証拠を変更しない。これは失敗の原因調査であり、製品機能の受け入れにはしない。
