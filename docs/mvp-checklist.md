# MVP受け入れ記録

文書確認: 2026-11-28。**MVP/M5は未完成。GitHub v0.1.0プレビュー公開済み。**
最新previewと過去snapshotの受け入れを分ける。詳細は[最新検証](preview-validation.md)、
[status](status.md)、[正式精度判断](adr/0008-model-acceptance.md)。

## 公開preview（source f2d6afd）

[v0.1.0公開記録](validation-v0.1.0.md)に最終ZIP・監査・CI・公開後のSHA照合を記録する。

- [x] Windowsの隔離MV3 build（78資産）
- [x] mock4＋実モデル3のE2E全7件成功（skip/retry/flakyなし）
- [x] textarea/input/contenteditableの手動・自動検査、合成IME、表示、機密欄除外、本文非保存
- [x] 同梱WASMで初回オフライン推論
- [x] 共有Workerの実モデル2要求成功、3件目busy、dispose/終了
- [x] 監査対象contextの観測網羅性・陽性対照・予期しない通信0・source/資産照合
- [x] 監査全体の合格（終了処理を修正し、最終公開ソースの展開ZIPでexit0）
- [x] 新preview ZIP、SHAファイル、SBOM・配布検査・再包装一致、公開11添付物のダウンロード照合
- [ ] 最新previewの一般コーパス精度評価
- [x] 最新ソースのWindows/Linux品質CI、browser fixture CI、依存監査CI
- [ ] 最新previewのLinux実モデル/最低Chrome検証

## モデル・SDKの過去の実装証拠

- [x] 固定revisionのPyTorch参照、30M ONNX FP32/INT8/FP16変換と実推論
- [x] 旧QUInt8と参照の精度比較（合成/開発/公式test。精度受け入れは不合格）
- [x] FP16保存モデルの固定64例CPU/WASM一致（source2914a68、同じSHAをpreviewへ同梱）
- [x] SDK Unicode/offset/chunk/cancel/dispose、34 tokenizer fixture等の回帰
- [x] 旧0dc814cの両OS全10ゲート、全context監査・ZIP一致・coverage

上記のチェックは各sourceの実施を示し、新previewでの全再実行・全機能保証ではない。
全TS609件は準備sourceまで、Python関連19件と後続helper13件は限定範囲。
旧[0dc814c](validation-0dc814c.md)と[67217cc](validation-67217cc.md)のreceiptは付け替えない。

## 正式MVP/M5・公開前の未完了事項

- [ ] 製品精度目標・独立実用gold（参照/旧候補は精度未達、新モデルの一般精度は未評価）
- [ ] 物理日本語IMEの受け入れ
- [ ] native権限UIを含むサイト有効化・解除
- [ ] 実サービス（Gmail/ChatGPT/X等）と対応範囲の確認
- [ ] 最新source/モデルで要求されたWindows/Linux/最低Chrome/remote CIの証拠統一
- [ ] 長期資源の受け入れ・最新sourceの必要なcoverage
- [x] 合成fixture画像の説明照合、公開/サポート/privacy URL、GitHub preview公開の明示許可

速度p50=150.1msの100ms未達は保持する。最適化はユーザー方針で後工程へ延期し、達成とは表示しない。
WebGPU等P1/P2を先に増やさず、今回のGitHub preview公開は完了し、[残タスク](next-steps.md)へ記録した。
日英README、MIT/クレジット、privacy/security、Skillsと継続手順は作成済み。GitHub preview公開と正式MVPの受け入れは区別する。
