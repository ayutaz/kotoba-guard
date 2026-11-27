# Workerメモリ観測の校正

2026-11-27事前登録。起点clean `687d6ea`。M4/R05の観測手段を作る段階で、モデルを使用しない。既存のrelease/関連target監視除外の予算は終了済みで、これらを反復しない。

## 根拠と目的

関連process working setだけでは、WASM線形メモリ・JS heap・他のブラウザ領域を分離できなかった。[公式CDP定義](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/js_protocol.json)の`Runtime.getHeapUsage`はisolate全体のJS heap、embedder heap、ArrayBuffer/external stringのbacking storageを返す。backing storageをWASM専用値と扱わない。

小さなMV3 offscreen/Worker fixtureで、WASMメモリのbyteLengthを返す診断hookと、CDPのheap統計を併記できるか校正する。hookは`WebAssembly.Memory`/`Instance`/`instantiate`/`instantiateStreaming`を委譲するProxyで包み、MemoryへのWeakRefだけを保持する。snapshotは数値だけを返す。元の引数・戻り値・例外を保ち、モデル/ユーザー文章/HTMLを読まない。計測に伴うmicrotaskやdebuggerの影響は残る。

CDPへの子targetコマンドは、所有sessionに限定した`Target.attachToTarget(flatten:false)`と`Target.sendMessageToTarget`を使う。後者はdeprecatedだが、[公式Target定義](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Target.pdl)にある機能として、実際のChrome159で可否を検証する。利用不可なら失敗を保持し、この手段で実モデルへ進めない。privateなPlaywright接続や任意コード実行へのfallbackは行わない。

## 校正条件と予算

1. hookの委譲、内部export Memory検出、grow後byteLength、重複排除、上限超過/不完全状態、およびCDP応答・timeout・session不一致・cleanupをunit Red→Greenで確認する。
2. 独立レビューと全TS/check後、clean sourceからWindows Chromium159.0.8154.6で**モデルなしの1 browser試行**を実行する。既存0f99811 runtime/モデル/通常E2E/ZIPを変更せず、専用fixture・config・新規outputを使う。retries0、全体120秒、CDP commandと各cleanupは最大5秒。
3. 同じWorkerを保ったまま、baseline → 内部exportのWASM16MiB → ArrayBuffer8MiB → JS Array(1,000,000要素)の4段階を観測する。全割当は固定値でfixtureが生存参照を保持する。GC強制、heap snapshot全体、ユーザー文章の取得は行わない。
4. 受け入れ: 全段階でisolate IDが一致、正当な非負有限heap統計、WASM容量0→16MiBかつ後続でも16MiB、ArrayBuffer段階のbacking storage増分8MiB以上、JS段階のused heap増分3MiB以上。これは校正fixtureの判定で製品の性能・資源基準ではない。欠落値や不完全hookを0扱いで通さない。
5. 終了時は所有子session→root CDP→context→fixture serverを各5秒以内に解放し、成功/失敗・途中値・固定source/test/fixture/hook SHAを保存する。既存report/Playwright JSONは拒否し、上書きしない。

成功・失敗でこのbrowser予算を終了する。失敗時の無変更再試行やtimeout/閾値変更は行わない。実行前のコード不具合はTDDで修正できる。校正成功だけで実モデルのWASM容量、増加原因、リーク不存在やM5完成を主張しない。実モデルの観測は校正結果を基に別の条件・予算を登録してから行う。

実装上の明確化: fixtureはextension-localページだけを使いHTTP serverを起動しない。cleanupは子session・root CDP・contextをそれぞれ5秒で試み、先行失敗後も後続を実行する。no-opをserver終了の証拠にしない。

実行前レビューによる探索の明確化: 既存helperは`autoAttachRelated`を有効にするため利用しない。専用の新規browserでinventoryだけを読み、期待するoffscreen親が1つ、全dedicated Workerが1つで、そのURLが期待値またはChromiumが隠す空文字の場合に限り選ぶ。後続の固定snapshot呼び出しでhook存在と数値を検証する。複数Worker・異なるURL・親欠落は失敗とし、追加attachmentへfallbackしない。この選択方法は隔離された校正fixture専用で、実製品の所有target判定には転用しない。

実行前検査: hook/通信helperそれぞれ初回Redはmodule不在によるsuite失敗・test実行0である。初回Green途中にはnativeの負数initialがRangeErrorではなくTypeErrorを投げるというテスト想定の誤りがあり、実nativeと比較するassertionへ修正して保持した。Promiseそのものを置き換える委譲不備も追加のbehavioral Red1で検出し、同じnative Promiseを返すよう修正した。最終全TS292件とLint/型/Formatは成功。途中のLint未定義globalも修正し、ログを保持した。browser校正は未実行。

探索分離後は全TS295件/check成功。inventoryの無応答が5秒で終了しないbehavioral Red1も修正した。外側のpre/post検証でclean source・controlのGit blob SHA・製品全81資産と旧0dc814c ZIPの固定SHAを照合し、source専用の新規artifact親に限定して実行する。これは製品資産の不変性の確認で、新runtimeの全品質検査を追加した意味ではない。

## 固定1試行の結果

clean source `bc13c8676bcf56e21200b4e5f0129c29e95f7744`（tree `6409d87dc913e246b5c058a2e32d00fc5267e4a4`）でWindows/Node24.15.0/Chromium159.0.8154.6の1試行を実行し、**校正失敗**。`findCalibrationWorker`が10秒のpoll中に選択条件を満たさず、setupで終了した。baseline通知には到達したが、子sessionは未attach、数値sampleは0件。inventoryの生応答を保存していないため、Worker不在・親/数の不一致・空URL以外のいずれかは判別できない。CDP子通信と実ブラウザのhook容量は未検証であり、unit成功を代用しない。

root CDP解放4.7856ms、context終了411.1277msは成功。未作成の子sessionのcleanup成功は数えない。全経過11,957.7326msは失敗した校正の時間で推論性能ではない。監視開始後の外部通信/page errorは0件。モデル・実ユーザー文章・製品拡張は使っていない。

実行前後のclean source/tree、8controlのGit blob SHA、既存runtime `0f99811`の全81資産、旧`0dc814c` ZIP固定SHAを外側で照合した。校正受け入れはfalse、同条件の予算は終了。コード上のblocking解消は実行前に独立レビューし、失敗判定も独立レビュー済み。探索時の監視条件追加は別登録なしに行わない。

証拠は`artifacts/worker-heap-calibration/bc13c8676bcf56e21200b4e5f0129c29e95f7744/`に保持する（Git対象外）。実行は`SOURCE_COMMIT`と絶対`KOTOBA_HEAP_PROBE_OUTPUT`を指定して`npx --no-install playwright test --config playwright.heap-probe.config.ts`、retries0。before/failure binder、report、Playwright JSON、exit-code、trace/screenshot、途中のunit/静的検査ログを含む29ファイルを`preserved-evidence.json`で凍結した。

| 証拠                    | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| report.json             | `709ce944db03646c69988a44b77ace0e2ff44702dcf29ac3796d2b32c856893c` |
| playwright.json         | `9bc8bb405af396a73f3420d40eaa2419fc0411e54f88334e7ba20c86c23af0a4` |
| preflight.json          | `67163c33611ce685e2008a40a3d848c1d2291c594057bbb8156ca087beb7b617` |
| final-control.json      | `a9e1e277e65edc1d13093c337e66dd45318500dcf9912e38c6964d9d9e06db3b` |
| preserved-evidence.json | `1c99dea618e9ae3f3f4d16445b53d6814ce9061e23d25f9521a0907a6c9ade80` |

次の作業は、追加の所有parent監視を条件に含める探索設計と新規登録。上記の校正を再実行せず、実モデル観測にも進まない。製品メモリ増加・M2/M3/native/service/remoteとM5は未解決。
