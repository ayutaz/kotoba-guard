# ADR-0003: WASM向けQUInt8候補

採用。ただし一般的な精度の受け入れは未完了。動的QUInt8、per-channel、定数weightのMatMulとEmbedding Gatherを量子化する。MatMulのみでは大きいEmbeddingが残るため、配布サイズの要件を満たせない。signed QInt8試行より今回のsmokeで差が小さかったQUInt8を第一候補とした。

FP32、FP16、量子化モデルを同じ入力で比較する。合成40文では閾値によってF1の変化があり、「1ポイント以内」を一般に達成したとは扱わない。公式評価コーパスを使った追加検証が公開前に必要。サイズ・差・速度は [実測結果](../benchmarks.md) を正とする。FP16 WebGPUはP1、INT4は未採用。

## 2026-11-28追記: 開発preview

元の動的QUInt8採用は旧distributionの判断として保持する。ユーザーが最適化を延期したため、
最新previewはEmbedding UINT8 / MatMul FP16保存・FLOAT演算の数値一致候補へ切り替えた。
48,188,514 bytes、固定64例CPU/WASM一致、128-token p50=150.1msの目標未達。
一般精度は未評価で、正式採用/公開/精度合格ではない。[最新検証](../preview-validation.md)を参照。
開発は停止中で、閉じた性能試行を繰り返さない。
