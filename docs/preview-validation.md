# 最新previewの検証記録

## 現在の公開結果

GitHub v0.1.0プレビュー公開とダウンロード照合を完了した。最新ソースは`f2d6afdd5bd241a5bed30b77faef226702f09cd2`。
最終展開ZIPの7E2E・実監査・Windows/Linux CIは成功。詳細は[v0.1.0公開記録](validation-v0.1.0.md)。
以下は各旧ソースの履歴で、現在の公開結果へ付け替えない。

## リリース再開後の監査追記

ユーザーの「4まで進めて」で最短リリース計画を再開した。監査source
`e62733358b603daf9645d8ca8fa4f11236f76b06`の独立checkoutで、下記aea6cafの
同一build/モデルを再監査し、exit0・gate=trueになった。対象coverage・資産照合・offline6回・
unexpected0・cleanup8項目（popup/monitor/cdp/pages/browser/context/fixture/profile）全成功。
observerのauto-attach/discovery/sessionを停止し、Playwrightのbrowser ownerを先に終了する修正。
各5秒と監査の完全性条件は維持した。Windows計測は明示的にPowerShell7を選択した。
原本は`.cache/release-audit-source/artifacts/release-audit/<e627333のfullSHA>/`。
初回修正3672c76のcontext/OSメモリ計測失敗も`artifacts/release-audit/<3672c76のfullSHA>/`に保持する。
これは監査のみの追加検証で、新しいZIP・公開・最終sourceの全検証完了を意味しない。
以下のaea6cafの元の判定とhashは変更しない。

文書確認日: 2026-11-28。以下は2026-11-27の保存済み結果の照合であり、今回の再実行ではない。
この節の以下は一時停止時点の保存記録。現在の公開結果は冒頭のリンクを参照。

## 対象と判定

| 項目                   | 対象・結果                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 検証ソース             | `aea6caf1c1e8afaf29b524c9ac9fafde6d9b2f17`、clean                                                                 |
| ソースtree             | `1243d01fcd75d222e74cbcef6bae00bcd04ba5eb`                                                                        |
| 同梱モデル             | `embedding-u8-matmul-fp16-storage`、48,188,514 bytes                                                              |
| モデルSHA-256          | `4b8d05c29f7c99dbb85e721ef619ca748758ec3c60b03d9290473992b705bbf7`                                                |
| 元モデル               | SB Intuitions `ja-typo-detector-modernbert-ja-base-30m`、revision `8d640720bddeb64c89dc1fa7780c3ea29fa523e8`、MIT |
| build                  | 成功、78資産。sanitize前後のCPU固定8/32/128-token出力は完全一致                                                   |
| E2E                    | mock4件＋実モデル3件、計7件成功。skip/retry/flakyなし                                                             |
| 通信監査               | 予期しない通信0、陽性対照・拡張context観測のcoverageComplete=true、offline実推論6回                               |
| 証拠照合               | source/配布資産の前後照合成功、旧distも不変                                                                       |
| 監査の終了処理         | contextのみ失敗。popup/browser CDP/CDP/browser/fixture/profileは完了                                              |
| 最終判定               | `cleanup-incomplete`、監査exit1、`ready=false`、M5未完了                                                          |
| ZIP・SHAファイル・SBOM | 今回のパイプラインでは未生成。公開・申請も未実施                                                                  |

Windows11 x64 / Node24.15.0 / Chromium159.0.8154.6 / ORT Web1.31.1のローカル結果。
手動検査、自動検査、textarea/input/contenteditable、合成IME、機密欄除外、本文非保存、
オフライン検出、共有Workerの2要求成功・3件目busyとdisposeを確認した。
fixtureへの事前許可はnative権限UIの受け入れではなく、物理IME・実サービス・他環境は未検証。

## 初回失敗と修正範囲

`6de3a0067aaad6deb1141c0eaf5cf7cc8b9dde17`の初回はbuild成功、E2E5件成功/2件失敗。
失敗した自動検査と並行要求も機能上のassertionは完了していたが、context終了が5秒を超えた。
`aea6caf`でテスト共通helperをページ終了→context終了の順へ修正し、5秒制限を維持してE2E7件に成功した。
通信監査は別の終了経路を持ち、そのcontext終了失敗は残っている。E2Eの修正を監査成功へ読み替えない。
初回のログ・失敗・画像と、修正版の結果は別ディレクトリで保持する。

## モデルの判定と早期提供方針

変換source `2914a68`の固定64例ではCPU/WASMのIDs/mask/offset/shape/dtype/有限値、
通常tokenのargmaxとspanが一致し、最大logit差は0.0000247955322265625。
128-token WASM1thread、3 warmup＋20 samplesの初回p50=150.1ms/p95=200.5msだった。
元の100ms p50目標は未達で性能試行を終了し、その後ユーザーが最適化を後工程へ延期したため
同じモデルの開発preview統合へ進んだ。追加の性能試行・新候補探索は行わない。
詳細は[FP16保存候補](research/fp16-storage-candidate.md)。

Embeddingは既存UINT8のGather後にDQし、42個のMatMul重みをFLOAT16保存してFLOATへCastする。
演算はFLOAT32で、全演算FP16やWebGPU実行ではない。legacy runtimeのファイル名
`onnx/model_quantized.onnx`を維持するが、manifestのmodel_kindが形式を示す。
今回のモデルの一般コーパス精度は未評価。元モデル・旧QUInt8の精度未達を解消したとはしない。
[精度判断](adr/0008-model-acceptance.md)と独立実用gold不足は残る。

## 単体・品質チェックの範囲

| 保存済み結果       | 範囲                                                                             |
| ------------------ | -------------------------------------------------------------------------------- |
| TypeScript全609件  | preview準備source6de3a00まで。aea6cafの全テスト再実行ではない                    |
| Python関連19件     | preview準備・FP16保存・旧weight-only回帰。全Python suite/新coverageではない      |
| 終了helper関連13件 | aea6cafのページ終了順序・失敗伝播。全TSを611件成功と推計しない                   |
| Lint/型/format     | 準備時のnpm check、変更helperのESLint/tsc/format確認。docs更新への対象付替えなし |

最新モデル・runtimeのLinux、最低Chrome、remote CI、coverage再測定は未実施。
旧[0dc814c snapshot](validation-0dc814c.md)や過去の全context監査は各sourceの証拠として保持する。

## ローカル成果物と証拠

基点: `artifacts/preview/aea6caf1c1e8afaf29b524c9ac9fafde6d9b2f17/`。
`extension/`が展開済みbuild、`bundle/`がモデル同梱元、`source.tar`がソースarchive。
`playwright.json`、`manual/browser-real.json`、`automatic.json`、`concurrency.json`、
`security.json`、各stageのlog/exit JSON、`built-assets.json`、`result.json`を保存している。
ignored資産なのでfresh checkoutには存在しない。rawレポートにはローカルパス等があり、公開用に一括添付しない。

| 証拠            | SHA-256                                                            |
| --------------- | ------------------------------------------------------------------ |
| source.tar      | `0de97309e92caa8f4ba57af9403f63a4718d90440447ec8448f7c8164e34e43e` |
| playwright.json | `c122ca81203015b6b6e03c44e2a7c3cf5b64b3f7d034971a26710beebfde849b` |
| security.json   | `9cca09e7b5b4c84f585ac901ee0b837cc1accc3f774e5b27d04268f559920baa` |
| result.json     | `cb11e8d2f2f68facc4777579150584f534e5d1295f541550037669e8d429803b` |

停止記録commitは`c14a591`。後続の文書commitへbuildやテスト結果を付け替えない。
[再開手順](next-steps.md)の最小範囲は監査終了処理の修正・確認→ZIP/配布検査。
この旧試行は終了済み。現在の作業状態は公開記録とstatusを参照。
