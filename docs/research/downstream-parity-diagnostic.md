# M3: 後段の数値差を限定診断する

事前登録: 2026-11-27。実行前に条件を固定する。前回`0dc814c`では選択した1例の最初のDynamicQuantizeLinear/MatMulInteger pairが一致し、最終logitsに0.2579023838043213のCPU/WASM差が残った。配布モデル・品質基準・データ・confidenceは変更しない。

## 入力と仮説

- モデル: 同じsanitized QUInt8、SHA `dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`。グラフ809 nodes、42 DynamicQuantizeLinear/MatMulInteger。重みinitializerはUINT8であるため、S8重み特有のAVX2飽和を原因と決め付けない。
- 同じ固定fixture（SHA `4bc05c93b39be219eeff70f57a8da18fd85271b74fec4be4a156800f49e72f47`）のindex2、33 tokens。本文を出力しない。
- 選択に使う既存all-control reportのSHA `2c96e17044c61e865c8b7f9751867dc6520f90c4473b826194974b5a933533d9`。実用精度の標本抽出ではなく数値差の診断であり、別の失敗行を選び直さない。
- 仮説: 最初のpairより後、残差blockまたはclassifierの量子化経路で小さい浮動差が整数値の差へ増幅される。整数入力が違うMatMulIntegerの出力差は、kernel不具合の証明にはならない。
- CPU ORT1.32.0、intra/inter1 thread、WASM ORT Web1.31.1、1 thread、両方の要求最適化`all`。内部optimized graphは未観測として保持する。オフラインの隔離拡張コピーを用い、現行配布物を変更しない。

[ORT量子化ガイド](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html)は中間activationの比較を勧める。[ONNX DynamicQuantizeLinear仕様](https://onnx.ai/onnx/operators/onnx__DynamicQuantizeLinear.html)を参照し、scale/zero-point/整数値を分けて比較する。仕様の一般論を、このモデルの故障箇所と混同しない。

## 最大2個のscratch graph

1. **block-boundaries:** pinned graphで接続を確認した10残差出力`add_7, add_11, add_15, add_19, add_23, add_27, add_31, add_35, add_39, add_43`とlogitsを捕捉する。最初に0.001を超えるblockを固定順で選ぶ。各境界がすべて0.001以内でlogitsのみ超過なら、classifierを選ぶ。
2. **局所捕捉または計測影響の対照:** 1が元graphのlogitsをCPU/WASMそれぞれ完全再現した場合だけ、最初に差が出る1 blockの4量子化linear経路、またはclassifierの2経路を捕捉する。DQLの入力・整数・scale/zero-point、MatMulInteger、Cast、乗算scale、linear出力を実グラフの接続から確認する。1で元logitsを再現できなければ、代わりに`disabled`で同じ境界graphを1回だけ比較し、局所捕捉はしない。

型・rank・固定shape・finiteを検証し、整数は完全一致、floatは最大/平均差を記録する。1または2で計測による元logitsの変化があれば、その経路の局所原因判定はinconclusiveとする。名前だけからの曖昧な対応付け、capture範囲の追加、3個目のgraph、別fixture、tolerance変更、同条件の都合のよい再実行は行わない。

結果は新しいsource-boundな`artifacts/quantized-intermediates/<source-commit>/downstream/`へ保存し、profile・出力順・原モデル/fixture/NPZ/各reportのSHAと両backendの元logits再現を記録する。出力先の再利用・既存reportの上書きを拒否する。

## 次の判断

整数入力一致・重量一致でも同じ演算の整数出力が違えば、独立した小グラフ再現の次案を作る。整数入力がすでに違うなら、その直前のfloat演算・丸めを候補として記録し、kernel故障とは呼ばない。局所化できても固定64例、一般精度、性能、通常offscreen/workerの受け入れ成功にはしない。候補を変更する場合は別の事前登録・精度/数値/性能評価が必要である。

## 実測結果: beb6f76

cleanな診断source `beb6f76eed9da7a5a3b63f667f9a4c903e5f4f5c`で、登録した1例・2条件を完了した。実行runtimeは`0dc814c`のZIPと全81ファイルを照合した隔離コピー。元モデル・runtimeは変更していない。

| 条件                  | CPUの捕捉前後logits最大差 | WASMの捕捉前後logits最大差 | 判定                                                  |
| --------------------- | ------------------------: | -------------------------: | ----------------------------------------------------- |
| boundaries / all      |    0.00000095367431640625 |                     未実行 | CPU完全再現ゲートが失敗。通常条件の局所原因は判定不能 |
| boundaries / disabled |                         0 |                          0 | 捕捉影響なし。ただしCPU/WASM数値一致は不合格          |

disabledでは`add_7`〜`add_23`の最大差は約0.00000149。初めて0.001を超えたのは`add_27`（0始まりblock5）の0.023182004690170288で、最終logits最大差は0.8440403938293457だった。全出力のdtype/shape/finiteは一致し、監視登録後の外部通信・page errorは0。これは**最適化無効の対照1例の境界候補**であり、通常all条件の原因特定、特定kernelの不具合、一般精度の改善ではない。

allのCPU診断は終了コード1、disabledのCPUは0、disabledのbrowserは数値差により1。allのbrowserはCPUゲート拒否のため未実行で、成功や失敗へ読み替えない。2条件を使い切ったため、局所block capture・3条件目は実行していない。次の案はdisabledのblock5を局所捕捉する別の事前登録であり、今回の予算を増やさない。

成果物は`artifacts/quantized-intermediates/beb6f76eed9da7a5a3b63f667f9a4c903e5f4f5c/downstream/`。`observations.json`に各report/NPZのbytes・SHAとruntime bindingを保存した。

- all CPU report: `17b08fbe516e15d14e3c65cf321985a81453e0808796cf47aefaf40dc0b62de2`
- disabled CPU report: `e9cb4755231ee5c090b71d16db82e119b39e8b9cebd9bf58da23586034eb930a`
- disabled browser report: `9502f192405bd3c57e295e8204baa69d6691cbd25f6843ce0aab645edcff2098`

実装はfirst-pairの既定を維持し、13 profileをallowlist化した。実グラフの接続、UINT8 initializer、DQL zero-point、FLOAT Cast、決定的出力順、最終分類層の特殊名を検査する。独立レビューで旧first-pair固定検査・classifier名漏れ・残差接続検査の不足を修正した。最終Python全300件、TS全235件、npm check、関連Ruffが成功。初回Ruff format検査の1ファイル不一致は整形後に17件を再実行して成功した。全OS・全coverage・通常経路の全E2Eをこの診断sourceで再検証したとはしない。
