# M3: attention output projectionの混合量子化候補

事前登録: 2026-11-27。[block5の局所捕捉](block5-parity-diagnostic.md)では、微小float差のある`view_17`からDynamicQuantizeLinearの1要素不一致が現れた。これは量子化の感度を支持するだけで、weight-only変換の有効性やkernel故障を証明しない。

## 1候補を固定する

- 入力は同じsanitized QUInt8、SHA `dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`。元revisionは`8d640720bddeb64c89dc1fa7780c3ea29fa523e8`。CPU変換のみ、元のモデルは上書きしない。
- 対象は全10ブロックのattention output projection（linear1,5,9,13,17,21,25,29,33,37）。linear21だけを選ばない。対応するactivation量子化経路を除き、同じUINT8重量のDequantizeLinear(axis1)とfloat MatMulへ置換する。変換の利点は未検証。
- その他32個のMatMulInteger（classifier2個を含む）、量子化embedding Gather、全initializerは変更しない。実グラフの直接接続と消す中間値の全consumerを検査し、曖昧・共有・欠落があれば変換拒否。選択した出力名を維持し、対象外node/initializerの不変性を検証する。
- 仮説は、全weight-onlyより小さい変更範囲でattention出力の動的量子化による差を抑えられる可能性。これは単一行の回避策ではなく、演算の役割から対象10個を事前固定する比較である。他経路の感度が残り不合格になる可能性も保持する。

## 固定64例を1回だけ比較する

元fixtureはSHA `4bc05c93b39be219eeff70f57a8da18fd85271b74fec4be4a156800f49e72f47`の64例。ID/mask/offset/label/本文・順序を維持し、候補の新しいCPU logitsだけを別fixtureへ保存する。旧候補や元モデルのlogitsを新モデルの期待値へ付け替えない。

CPU ORT1.32.0はintra/inter1・`disabled`で基準を生成し、WASM ORT Web1.31.1は1 thread・通常の要求最適化`all`で1回比較する。この組合せは計測前に固定する。通常のbrowser条件に対する候補を先に判断するため、失敗後のdisabled fallbackや設定の探索はしない。内部optimized graphは未観測。通過してもnative CPUの通常`all`との一致は未検証であり、拡張pageから直接ORTを使う比較は通常offscreen/worker経路の成功とは別にする。

サイズ50MB以下、全64例のdtype/shape/finite・入力一致、最大logit差0.001以下、token argmax/span不一致0を必要条件とする。外部通信・page errorは監視登録後0が必要。失敗したら、この候補では精度2,000例・性能測定・通常worker検証へ進まず、失敗を保存して終了する。候補の変換またはfixture準備の実装不具合は、失敗と修正を保存したうえで数値比較開始前に修正する。

通過しても一般精度・速度・メモリ・モデル採用・M5公開候補の合格ではない。次の段階は性能・精度・通常workerを別条件で固定して実測すること。配布モデル・通常UIはこの実験で変更しない。1候補の結果を見て対象を増減したり、threshold/toleranceを変えたりしない。

成果物は新しい`artifacts/candidates/attention-output-hybrid/<source>/`へ保存する。manifestへ元モデル・変換source・選択10個・不変32個/embedding・出力SHA/bytes・ツールversionを記録し、別の隔離runtimeへ同梱して旧ZIPとの不変資産照合を保持する。巨大モデル・本文付きfixture・raw logは通常Gitへ追加しない。

## 実測結果: a68f91b — 不採用

clean source `a68f91b2a2a0200856b104bd760d6600c7a3b6eb`で1候補の変換、CPU基準生成1回、WASM固定64例1回を完了した。CPU ORT1.32.0はdisabled・intra/inter1、WASM ORT Web1.31.1は要求all・1 thread。Windows x64、Node24.15.0、Chromium159.0.8154.6。browserは拡張pageから直接ORTを実行する診断経路であり、通常offscreen/workerではない。

| 項目                                | 実測                                                                |
| ----------------------------------- | ------------------------------------------------------------------- |
| 候補サイズ                          | 37,785,858 bytes                                                    |
| 候補SHA-256                         | `f54bf3c711bbc0492a5f439b40fffb1de355fead98640b7bdc5a31cb1b329273`  |
| 置換対象                            | 登録したattention output projection10個                             |
| 対象外不変                          | MatMulInteger32個、全initializer、全非削除node、embedding結合・重量 |
| ID・mask・offset・shape一致／finite | 全64例                                                              |
| logit差0.001超過                    | 39/64例、最大2.5434560775756836                                     |
| token argmax不一致のある行          | 4/64例                                                              |
| SDK検出span不一致のある行           | 6/64例                                                              |
| 監視登録後の外部通信／page error    | 0／0                                                                |
| CPU準備／browser終了コード          | 0／1（数値不一致）                                                  |

元fixtureの全64行は、logits以外の全field・順序が同じことを別途比較した。新しいCPU logitsを保存し、旧候補の期待値を流用していない。診断時の既存ハーネスはshape/finiteを検査したが、実行時dtypeの明示的なassertと記録が不足していた。この64例のdtypeゲートを確認済みとしない。数値・argmax・spanの不合格は残り、dtype確認のための追加モデル実行も行わない。

全10出力層のactivation量子化を除くだけでは、この条件で数値一致しなかった。残る演算が原因か、最適化に依存するかは未特定。39/64という件数を旧モデルからの一般的な改善と解釈しない。固定subsetは既に診断に使われており、独立精度の証拠でもない。

隔離runtimeの基礎81ファイルと元`dist/extension`の81ファイルは、実行後も`0dc814c`のZIPと完全一致。候補は隔離コピーへ追加しただけで、配布モデル・通常UIを変更していない。変換manifestのruntime欄は変換時点の未検証を表し、後続の成功／失敗はCPU/browser reportを正とする。

成果物は`artifacts/candidates/attention-output-hybrid/a68f91b2a2a0200856b104bd760d6600c7a3b6eb/`。本文付きfixture・モデルはGitに含めない。

- 変換manifest SHA: `cdd49cc676b2640050240df9635492f241141dd7c86ad778b82a902dc925b065`
- CPU report SHA: `dea2c9d1e6a02ae41ea7a060fa540636484ca629fc1f9f494b2bcdf33bd48752`
- CPU fixture SHA: `a38592ddc2a5d7cbe0c6ea362017003ace9c29889321edd912e9a36814ce5e70`
- browser report SHA: `ba7465bdf1f054753b0a3113fcf8d00e08d244d1a8cf1fe044045320979ee085`
- build-control SHA: `e9f8aac2a3ba61ede9eb47bff51a40a9c6e3c2c8bf6fb5bb5539384000cd926c`
- observations SHA: `7cae37c2718158f83ae86d84679bd411af48fffd4960486008c5bfc9d9bf15b5`

独立レビューでも39/64・argmax4行・span6行と、source/runtime/モデル・fixtureのhash整合を確認した。同時にdtype未検証を指摘し、その限界を保持した。

**この候補は終了。不採用。** 登録した実行予算を使い切り、disabled fallback、対象層の増減、精度2,000例・速度・メモリ・通常workerの評価には進まない。次のM3作業は別仮説の根拠と停止条件を先に固定すること。M2の参照能力・独立gold不足も解決しなければM5公開候補には移行できない。

## 変換コードの検証

変換器は元SHA・全40文字SOURCE_COMMIT・実グラフの役割／結合・UINT8重量・FLOAT scale・共有consumer・不変node/initializerを検査し、既存出力とcanonicalへの書込を拒否する。TDDで欠落module、重複node、来歴不整合を再現して修正した。最終の来歴回帰はRed5件を確認後、関連27件がGreen。`a68f91b`の全Python312件と関連Ruffが成功した。

coverage宣言へ新scriptを追加し、実ファイルとの一致テストを加えた。旧26ファイル81.30%を新27ファイルのcoverageへ付け替えない。この時点では新しい全体coverageとLinux検証は未測定だった。後述の全体coverage測定と区別し、既存snapshotの対象sourceは`0dc814c`を維持する。

後続修正`f35deb794645d23db2c0504c3690b02f860597ec`はCPU/ブラウザの実出力dtypeを記録し、float32以外を拒否する。Pythonのfloat64/int32、JSのfloat64 backing array・誤った型名・通常ArrayをRedから回帰テストにした。最終Python314件・TS239件、npm check・Ruffが成功し、独立レビューの重大指摘なし。単一installerをChromium159/about:blankへ導入するモデルなし4条件試験も成功。これはハーネス検証のみであり、上記64例の再実行ではない。

続くclean source `a110acb`では[新27ファイルの全体Python coverage](../python-coverage.md)を測定し、line81.40%・全9コマンド成功を確認した。候補parityは再実行せず、Linux・通常runtime・配布物の再検証とも区別する。
