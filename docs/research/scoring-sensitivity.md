# M1: 曖昧diffの採点感度

2026-11-27。診断ソースはcleanな`1e5b6096044b3cf8984b58d3854d6cfff0093c64`。固定development-v1の2,000例（誤り1,000・正常1,000）と4モデルの保存済みlogitsだけを再集計した。新規推論、閾値選択、held-out利用、モデル変更はない。元のbest結果は4モデルとも全項目で完全再現した。

## 結論

採点方式による差はあるが、最良のbestでもPrecision95%・Recall80%・正常文誤検出2%以下を満たさない。曖昧diffの扱いだけでは精度未達を説明できず、元モデルの能力・実用データでの検証と、変換/WASMの数値差は別に解決する。学習露出の可能性がある開発用データの診断であり、実用文体への一般化を示す結果ではない。

| モデル              | 方式      | TP / FP / FN    | Precision | Recall | F1       |
| ------------------- | --------- | --------------- | --------- | ------ | -------- |
| PyTorch / ONNX FP32 | canonical | 628 / 216 / 399 | 74.41%    | 61.15% | 0.671299 |
| PyTorch / ONNX FP32 | best      | 670 / 174 / 357 | 79.38%    | 65.24% | 0.716195 |
| PyTorch / ONNX FP32 | worst     | 603 / 241 / 424 | 71.45%    | 58.71% | 0.644575 |
| ONNX QUInt8         | canonical | 605 / 220 / 422 | 73.33%    | 58.91% | 0.653348 |
| ONNX QUInt8         | best      | 645 / 180 / 382 | 78.18%    | 62.80% | 0.696544 |
| ONNX QUInt8         | worst     | 581 / 244 / 446 | 70.42%    | 56.57% | 0.627430 |
| ONNX FP16           | canonical | 629 / 214 / 398 | 74.61%    | 61.25% | 0.672727 |
| ONNX FP16           | best      | 671 / 172 / 356 | 79.60%    | 65.34% | 0.717647 |
| ONNX FP16           | worst     | 604 / 239 / 423 | 71.65%    | 58.81% | 0.645989 |

75文書に複数の完全な再構成があり、bestとworstでevent TPが変わるのはPyTorch/FP32/FP16で各67文書、QUInt8で64文書。PyTorchのcanonicalからbestへの増分は42 TP、bestとworstの幅は67 TP。0幅のgold eventは129件、投影不能文書は0件。正常文の指摘はPyTorch/FP32/QUInt8で55/1,000、FP16で54/1,000で、位置選択では変わらない。

raw exact・token投影span・token分類は凍結仕様に従い全方式でcanonicalに固定する。これらをbest/worstで再選択した数値として解釈しない。

| モデル              | raw exact F1 | token投影span F1 | token F1 |
| ------------------- | ------------ | ---------------- | -------- |
| PyTorch / ONNX FP32 | 0.416532     | 0.570048         | 0.671329 |
| ONNX QUInt8         | 0.403471     | 0.544469         | 0.658691 |
| ONNX FP16           | 0.417830     | 0.571429         | 0.672028 |

## 入力と証拠

- 元モデルrevision: `8d640720bddeb64c89dc1fa7780c3ea29fa523e8`
- baseline source: `af8cd9480431052da280bc0e536f8ae5f65eeb62`
- baseline SHA: `fe1926d09ac6051e8180ecf726e11cbc2335c843b85226eb2b2ac0311a727328`
- dataset SHA: `94f257e7968e496dd2ff043b7c58fa3a547a665e185b81e97d5c3384b7dcbdd1`
- manifest SHA: `0ee9a84e9c81597ee5f3fe2421d9f695c01818a586d49a5a98fbef5dbf8279be`
- protocol SHA: `2c88f2afbf31e6684dd26b2bbc45ed196efad23267853b30e5910809d98e8e3a`
- 出力: `artifacts/scoring-sensitivity/1e5b6096044b3cf8984b58d3854d6cfff0093c64/sensitivity.json`と同じ場所の`summary.md`
- JSON SHA: `b3bf435e827e4087142547ff9229c0e79e0613a5babf0360330f0174171d8d3d`

JSONには4モデルのcache/重量/Tokenizer/config・評価コードのSHA、診断コードSHA、元baseline sourceと診断sourceを別々に保存した。`source.clean=true`、`canonical_development_v1=true`、`baseline_reproduced=true`、`inference_performed=false`を確認した。本文はレポートに含まない。

実行は[評価仕様のCLI](../evaluation-protocol.md#開発用cacheの採点感度診断)に従い、出力先へ上記診断commitを指定した。初回は通常sandboxから元FP32外部重みファイルを読めず終了コード1、出力作成前に停止した。既存のモデルを変更せず、必要な読取権限の実行でSHAを照合し、終了コード0で完了した。

## 判定と次の作業

M1/R01の「固定best再現と採点幅の説明」は完了。凍結protocolの採点不備を支持する結果ではなく、元の数値は保持する。独立評価は[データ候補調査](independent-evaluation-data.md)の不足条件を解消してから行う。M2/M3の製品合格とM5のrelease candidate化は未達のまま維持する。
