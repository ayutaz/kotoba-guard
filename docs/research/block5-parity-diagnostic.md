# M3: disabled block5の局所捕捉

事前登録: 2026-11-27。[前回の境界診断](downstream-parity-diagnostic.md)の2条件は完了している。今回は別の仮説・1条件だけを固定し、旧実験へ追加しない。

## 固定する条件

- 根拠は`beb6f76`のdisabled browser report、SHA `9502f192405bd3c57e295e8204baa69d6691cbd25f6843ce0aab645edcff2098`。両backendの捕捉前後logits差0、最初の0.001超過境界は`add_27`だった。通常allの原因をこの結果から推定しない。
- モデルSHA `dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`、fixture SHA `4bc05c93b39be219eeff70f57a8da18fd85271b74fec4be4a156800f49e72f47`、index2・33 tokensを維持する。選択用all-control report SHA `2c96e17044c61e865c8b7f9751867dc6520f90c4473b826194974b5a933533d9`も維持する。
- CPU ORT1.32.0、intra/inter1、WASM ORT Web1.31.1、1 thread、要求最適化は両方`disabled`。内部optimized graphは未観測。runtimeはZIPと全81ファイルを照合した`0dc814c`の隔離コピー。
- 実装は`beb6f76`の既存`block-5` profileを使用する。対象は0始まりblock5の4経路（linear20〜23）。DQL入力は`layer_norm_10`、`view_17`、`layer_norm_11`、`mul_149`。各入力・量子化activationのUINT8値・scale/zero point・MatMulInteger・Cast・combined scale・linear出力の計32値とlogitsを捕捉する。重みinitializerは元モデルSHAと実グラフの結合検査で固定し、追加出力にはしない。

## 仮説・判定・停止

仮説は、小さい浮動小数点差がこのblockのDynamicQuantizeLinearで整数差に変わり、後段で増幅されること。整数入力が異なるMatMulIntegerの出力差をkernel不具合とは呼ばない。[DQL仕様](https://onnx.ai/onnx/operators/onnx__DynamicQuantizeLinear.html)と[MatMulInteger仕様](https://onnx.ai/onnx/operators/onnx__MatMulInteger.html)を参照し、入力・整数値・scaleを分けて解釈する。

**scratch graphは1個、同じ1例、CPU1回とWASM1回だけ。** 各回の内部では元graphとのlogits再現を比較する。CPUまたはWASMの捕捉前後logits差が0でなければinconclusiveとして終了する。別profile、all、別行、3回目以降の好都合な再試行、許容差変更は行わない。

全出力のdtype/rank/shape/finiteを確認し、整数は完全一致、floatの比較基準は0.001を維持する。出力の固定順で最初の差を記録する。DQL入力が微小差、整数値が不一致なら「動的量子化の感度を支持」とするだけで、丸めの正誤や実装バグは証明しない。整数入力と対応weight/zero pointが同一なのにMatMulIntegerだけ違う場合は、独立した小グラフ再現を次の案とする。

結果は`artifacts/quantized-intermediates/<diagnostic-source>/block5-disabled/`へ保存し、source/clean状態、元runtime/ZIP、graph/NPZ/reportのSHA、両backendの捕捉前後再現を記録する。既存ファイルは上書きしない。数値差が局所化できても固定64例parity、精度、性能、通常worker経路、M5公開候補の合格にはしない。

実行には既存CLIの`--capture-profile block-5 --graph-optimization disabled`を使用する。CPUゲート不合格ならbrowserは実行しない。結果を見て同じ実験の捕捉範囲を増やさない。

## 実測結果: 4654737

診断source `4654737c8f531aad87c7c264be07a72064f69d53`、実装は`beb6f76`から変更なし。事前登録した1 graph・1例を完了した。CPUの終了コード0、browserはCPU/WASM差で1。両backendで捕捉前後logits差は0、33出力のdtype/shape/finiteも一致した。

| 捕捉値                                          | CPU/WASMの差                           |
| ----------------------------------------------- | -------------------------------------- |
| `layer_norm_10_quantized` / 最初のMatMulInteger | 整数不一致0                            |
| `view_17`                                       | float最大差0.0000019073486328125       |
| `view_17_scale` / `view_17_zero_point`          | 完全一致                               |
| `view_17_quantized`                             | 8,448要素中1要素不一致、flat index2100 |
| `linear_21_output_quantized`                    | 整数252要素不一致                      |
| `linear_21`                                     | float最大差0.0012693703174591064       |
| 最終logits                                      | 最大差0.8440403938293457               |

この条件での最初の整数差はattention出力を量子化する箇所に現れた。CPU側の不一致位置の入力/scaleは約15.4999943で丸め境界に近いが、WASM側の同じ位置の生値は保存していないため、丸めの実装が正しいかまでは判定しない。入力がすでに異なるMatMulIntegerの差をkernelの不具合とは呼ばない。通常all条件への帰属も未検証のまま。

監視登録後の外部通信とpage errorは0。元runtime81ファイルは実行後もZIPと一致した。成果物は`artifacts/quantized-intermediates/4654737c8f531aad87c7c264be07a72064f69d53/block5-disabled/`のreport/NPZ/observations/binding。

- CPU report SHA: `405f38f9acdcc25a0775baacfc1dbfa4bfddef0e79d77bef3ae34936642f615f`
- browser report SHA: `0a851a2a40783aa9e41f06f763399908d20685b1dcb7b85f2f784bbbbc0cbb69`
- CPU NPZ SHA: `81794eac9676e692e70f40985e51ce09f0eb94a81a754bc2bcdc293ea9a33719`

この局所捕捉は終了した。次は[全10 attention output projectionだけをweight-onlyへ変更する候補](attention-output-hybrid.md)を別仮説として比較し、linear21だけの行固有変更や、同じ局所捕捉の反復はしない。
