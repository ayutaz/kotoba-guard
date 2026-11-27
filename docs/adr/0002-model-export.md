# ADR-0002: CPUによるONNX変換

採用。固定リビジョンの公式 `ModernBertForTokenClassification` をPyTorch CPUで再現し、`torch.onnx.export` のopset18、Dynamo exporter、動的なbatch・系列長で出力する。既存のOptimum設定を推測して適用するより、参照クラスと入出力を直接比較できる方式を選んだ。現在の固定ツール組み合わせではAttentionの置換なしで変換できている。

FP32は外部weight dataを伴う。FP16変換でRoPEのCast型が不整合になったため、そのCastをFP16へ揃える。変更後の数値差を測定し、単にONNX checkerが通ることを精度の証明にしない。詳細と再現コマンドは [モデル変換](../model-conversion.md)。
