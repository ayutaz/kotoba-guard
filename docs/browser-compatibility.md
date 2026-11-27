# ブラウザ互換性

文書確認: 2026-11-28。最新previewの検証環境はWindows11 x64 / Node24.15.0 /
Chromium159.0.8154.6 / ONNX Runtime Web1.31.1 / WASM1thread。
公開source`f2d6afd`の展開ZIPで7E2E・通信監査が成功。両OS品質CIとLinux browser fixtureも成功。
Linux実モデルと最低Chromeは別の未完了項目。[v0.1.0公開記録](validation-v0.1.0.md)を参照。
[preview記録](preview-validation.md)に正確な範囲を記載する。

Chrome MV3とruntime.getContextsを利用できるChrome116以降を設計上の下限とする。
最低版の旧[0dc814c fixture](research/chrome116-compatibility.md)、
[session runtime116検証](research/default-runtime-chrome116.md)はそれぞれのsourceの証拠。
最新previewモデル/実装のChrome116、Linux、Edge、Firefox、モバイルは未検証。
旧OS・最低版の成功を最新previewへ付け替えない。

通常WorkerはWASM固定。previewモデルはEmbedding UINT8 / MatMul FP16保存・FLOAT演算で、
全演算FP16・WebGPUではない。SDKのバックエンド選択/fallbackと隔離FP16 WebGPU probeは別の検証。
マルチスレッドはcross-origin isolation制約を考慮して既定1thread。GPU不要で動作する設計。

一般editor fixtureではtextarea/input/contenteditable、合成composition、機密欄除外を確認した。
物理IME、native許可UI、Gmail/ChatGPT/X/Slack/GitHub等実サービス、cross-origin iframe、
closed Shadow DOM、Google Docsは受け入れ済みとしない。今回の初回preview公開範囲では追加互換性試験を行わない。
