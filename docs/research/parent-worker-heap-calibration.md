# 親session経由のWorkerメモリ校正

2026-11-27事前登録。起点clean `b9bf7c6`。M4/R05の観測手段の校正で、製品変更・実モデル推論は行わない。

## 別条件にする根拠

[inventory-only校正](worker-heap-calibration.md)は`bc13c86`でWorker選択条件を満たさず終了した。sample0件で、その試行の再実行・成功補完はしない。新しい観測条件は、所有offscreen親へ先に非flat接続し、親が直接報告するWorkerの既存sessionを使うもの。

[公式Target定義](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Target.pdl)では`setAutoAttach`は直接関連する既存targetにも接続する。[Chromium実装](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/devtools/protocol/target_handler.cc)ではbrowser-level `autoAttachRelated`はflatを強制するため、今回の非flatトンネルには使わない。親targetへ`attachToTarget(flatten:false)`し、そのsession内で`Target.setAutoAttach(autoAttach:true, waitForDebuggerOnStart:false, flatten:false, filter:workerのみ)`を送る。親の`attachedToTarget`通知で受け取ったWorker sessionを使い、Workerに重ねて`attachToTarget`しない。

親のsession内の通知を経由したことを親子対応の根拠にし、親target/sessionと子target/sessionのID、期待するextension-local URL一致、pauseなしをmetadataとして記録する。明示parentIdが通知にある場合は不一致を拒否する。任意URL・文章・heap snapshot・ユーザーbrowserは扱わない。関連監視・二段のdebugger通信・hookのProxy/microtask overheadを含む校正で、旧inventory-only条件の数値と統合しない。

## 実装と受け入れ

1. 親inventoryの一意選択、親非flat接続、親子通知の対応、子session採用時の二重attach防止、foreign session拒否、数値応答、timeout、先行失敗後のcleanupをTDDで確認する。全TS/checkと独立レビューを実行してからclean sourceでbrowserへ進む。
2. 隔離された新規Windows Chromium159.0.8154.6 browser、Node24、モデルなしの**1試行**。専用config/output、retries0、全体120秒。全CDP command/子待機/各cleanupは5秒以内。親不在・複数親/子・URL不一致・session不一致・pause・数値欠落は失敗。private Playwright接続、flat/任意eval/追加探索のfallbackはしない。
3. 同じfixture/hookの固定4段階 baseline → WASM16MiB → ArrayBuffer8MiB → JS Array100万要素を同じWorkerで1回だけ実行する。割当を保持し、強制GCしない。WASM byteLengthは0→16MiB→16MiB→16MiB、同一isolate、ArrayBuffer段階のbacking storage増分8MiB以上、JS段階のused heap増分3MiB以上、すべてのheap値が非負整数でused<=total、hook completeを要求する。CDPのbacking storageをWASM専用値としない。
4. 子session→親session→root CDP→contextを各5秒で解放し、失敗後も後続を試みる。HTTP serverは起動しない。未作成資源をcleanup成功として数えない。
5. 失敗/途中値/traceを保持し、source/tree/clean・全controlのGit blob SHA・fixture/hook SHA、親子metadata、cleanup時間を保存。外側のbefore/afterで`0f99811`製品全81資産・旧`0dc814c` ZIPと先行校正の29証拠ファイル不変を検証する。source専用の新規artifact親を強制し既存出力を上書きしない。

成功・失敗でこの予算は終了する。失敗時の無変更再試行、timeout延長、閾値変更、モックへの置換はしない。実行前の不具合は回帰Redから修正できる。校正成功は実モデル容量・増加原因・リーク不存在・製品資源基準やM5完了を証明しない。実モデルの追加観測は結果を踏まえて別登録する。

## 未実行

この文書は実行前の条件であり、browser結果ではない。M2独立gold/精度、M3 parity/速度、M4 native/実サービス/remote、新runtimeの他環境/全監査とM5は未達・未検証のまま。

実装前レビューで、listenerを親内`setAutoAttach`より前に登録し、root通知の親session IDと内側通知の子session IDを分離する条件を確認した。子を二重attachせず、子のdetach通知を親内で観測してactiveChildren0を要求してから親を解放する。parentIdが省略された場合も、親session内の直接通知という対応を記録し、別の親から届くwrapperは無視する。

実行前TDD: 新module不在のsuite Red（実行0件）、既存WorkerHeapSessionへのadopt追加のbehavioral Red1、foreign子session拒否とpause状態の誤記録のRed2を保持して修正。関連11件、全TS302件とLint/型/Formatが成功。実ブラウザでの親子通信・heap値はまだ未検証。外側binderはsource専用pathとcontrolのGit blob、全81資産、旧ZIP、前回29証拠ファイルをbefore/afterで照合する。

実行前のコードレビューで、detach応答と通知の順序依存を検出した。Red3から通知待機APIと未adopt子の明示detachを実装し、通知→応答/応答→通知/欠落/foreignを回帰検証した。子cleanupの同じ5秒枠内でコマンド応答と通知を並行して待つ。親detachだけを子detach成功にしない。最終関連14件・全TS305件/check成功。browserは未実行。

再レビューにより、adopt済み子のcleanup失敗でもactive子が残る場合は、元の失敗を保持して`residual-child-sessions`の別5秒枠で明示detachを1回試みる。未adopt子も同じ経路を使い、いずれも通知を待つ。timeout済みPromiseの再利用をRed1で確認し、settle後に待機を解除する修正を追加した。これは失敗時の資源回収で、試行成否を成功へ変更する再試行ではない。最終全TS306/checkを確認してからbrowserへ進む。

実行直前の全TS306/checkは成功、独立レビューでblocking解消を確認した。途中の型検査は追加testのoptionalプロパティへundefinedを代入して失敗し、プロパティの削除へ修正して再検査した。失敗ログも保持する。以下のbrowser結果はこの後に追記する。

## 固定1試行の結果

clean source `72dd90fed7a012a092145b4fc1d4d353e35e7ea2`、tree `63bae9fe4977590840ba8986b98d69c9eba81259`で**校正成功**。Windows/Node24.15.0/Chromium159.0.8154.6、モデルなし。Playwright1件成功、retry/flaky/skip0、全4段階で同じWorker/isolateだった。

| 段階        | WASM線形容量bytes | JS used bytes | backing storage bytes |
| ----------- | ----------------: | ------------: | --------------------: |
| baseline    |                 0 |       327,152 |                 3,879 |
| WASM        |        16,777,216 |       343,736 |                 3,879 |
| ArrayBuffer |        16,777,216 |       344,844 |             8,392,487 |
| JS Array    |        16,777,216 |     4,345,768 |             8,392,487 |

ArrayBuffer段階のbacking storage増分8,388,608 bytes、JS段階のused増分4,000,924 bytesで登録基準を満たした。この環境・fixtureではWASM16MiBの割当がbacking storage値へ現れなかった。したがって、この値だけを実モデルWASM容量の代用にしない。これらのcounterは加算してprocess working set/RSSにできない。

親session内の直接通知1件・explicitParentId一致・URL一致・pauseなしを確認し、二重attachせず子sessionを採用した。終了時の子detach通知1件、activeChildren0も確認。cleanupは子5.0886ms・親2.4660ms・root2.5307ms・context487.0408msで全成功。全経過2,584.1361msは合成校正の時間でモデル推論性能ではない。監視開始後の外部通信/page error0件。

外側after binderでsource/tree/clean・8controlのGit blob SHA、製品`0f99811`の全81資産、旧`0dc814c` ZIP、先行失敗の29証拠ファイル不変を確認し、独立レビュー済み。モデル/製品runtimeの変更・新推論・ZIP更新はない。登録した1試行は完了して予算終了。旧inventory-onlyの失敗は保持し成功へ付け替えない。

証拠は`artifacts/parent-worker-heap-calibration/72dd90fed7a012a092145b4fc1d4d353e35e7ea2/`に保持（Git対象外）。`SOURCE_COMMIT`、絶対`KOTOBA_PARENT_HEAP_OUTPUT`を指定し、`npx --no-install playwright test --config playwright.parent-heap.config.ts`を1回実行した。before/after binder、report、Playwright JSON、exit codeと途中のRed/型失敗を含む25ファイルを凍結した。

| 証拠                    | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| report.json             | `6410332a8a7ac25ebf1e6e147678149ee7a20cc5a53897c8758c75dcbea2c6d4` |
| playwright.json         | `060fc52dd515480e3fb7f3e0ac25f7259ec4d0d6fb8e42f2557fa33678c7f0b5` |
| preflight.json          | `e53dd14b3c49925efbb3d5d506a156bfa8587bf39faddbd20cfc9ee7da3d0659` |
| final-control.json      | `6ca212bb6bf655efe49e539052c096275a822574b26d1441e8cbb89c35360e97` |
| preserved-evidence.json | `c12a4520b3dd933535c3d5a85b41c9846af3a929b8a01b9d81a070b8ea49c30a` |

次は、このhookと親子通信を使う実モデルの観測条件を別登録する。校正成功は製品のメモリ容量・増加原因・資源上限・リーク不存在を証明しない。全M5未達条件を維持する。
