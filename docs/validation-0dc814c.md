# M1〜M5追加開発の検証と開発用snapshot

2026-11-27。検証対象はcleanな`0dc814cda3bfec86379928f505c6d3ed2725b5dc`。ローカルのWindows/Linux品質ゲート、全Python coverage、全context監査、同じWindows buildのZIP再包装が成功した。**製品精度・CPU/WASM一致・独立gold・native操作・remote CIの受け入れは未完了。MVP完成、release candidate、正式公開ではない。** 後続の文書だけのcommitへ、このソースの実測結果を付け替えない。

## 実装と設計

- `0410403`: IME開始時に既存debounceと遅延結果を無効化。editorごとに送信中1件と最新pending1件へ集約し、DOM削除時にtimer・pending・表示を清掃する。automatic busy再試行は1回だけで、送信済みmanualはone-shot権限のため再試行しない。再試行もbusyなら、次の入力か新しい明示manualが必要になる。
- siteが無効のままglobalだけ無効へ変わる場合もepochを更新し、保留manualと既存ハイライトを消去する。独立レビューで検出し、Redを確認後に修正した。controller23件が成功。
- `4b6bbf1`、`0dc814c`: 1失敗例・最初の量子化演算対に限定したCPU/WASM中間値診断。実ORT enum、出力metadataのdtype/rank/固定次元、NumPy実生成Zip64 NPZ、browserのdims/type、上書き防止、入力SHAを検証する。診断Python14件・JS8件。独立レビュー指摘を回帰テストで修正した。
- モデル共有は既存のcontent → background → offscreen → dedicated worker → SDKを維持する。ページ入力を保存・送信せず、各入力欄の集約とworker再利用を分ける。Skillsと26ファイルのPython coverage inventoryを更新した。

## 実行結果

| 項目                                                                 | 結果                                                                                                                  |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Windows / Linux                                                      | 両方の全10ゲート成功                                                                                                  |
| Python unit                                                          | 両OS297件成功                                                                                                         |
| TypeScript unit                                                      | 両OS234件成功、26 test files                                                                                          |
| Python overall                                                       | 全26ファイル、unit＋実モデル統合9コマンド成功。line3,047/3,748（81.30%）、branch1,057/1,456（72.60%）                 |
| TypeScript overall                                                   | statements1,298/1,489（87.17%）、lines1,215/1,349（90.06%）、branches81.38%                                           |
| SDK coverage                                                         | statements92.42%、lines94.56%                                                                                         |
| Tokenizer integration                                                | 固定34ケースを1テストで照合、成功                                                                                     |
| 変換回帰                                                             | 自作40文の限定ゲート成功。一般精度とは別                                                                              |
| Windows E2E                                                          | mock4件＋実モデル5件、全9件成功（約3分）                                                                              |
| Linux E2E                                                            | 実モデル5件成功（59.7秒）。mockはこのlaneでは実行しない                                                               |
| E2E skip / retry / flaky / unexpected                                | 両OSすべて0                                                                                                           |
| 通信・資源監査                                                       | 合格。HTTP/WebSocket陽性対照、拡張page/background/offscreen/worker、オフライン初回・短文・長文・連続推論              |
| 監視対象の外部通信 / 未監視target / gap / fatal error / pending task | すべて0                                                                                                               |
| メモリ                                                               | process memory / JS heapともmeasured。HWM合計の最大観測値1,353,969,664 bytes。同時RSS peakや全OS process treeではない |
| 依存監査 / SBOM                                                      | Node・Python既知脆弱性0。標準CycloneDXは218 / 73 components                                                           |
| ライセンス                                                           | inventory47件、44ライセンスファイルをZIP内容と照合                                                                    |

Windows11、Node24.15.0/npm11.4.2、Python3.12.13、uv0.12.20、Chromium159.0.8154.6。LinuxはNode24.15.0/npm11.12.1、Python3.12.14、uv0.12.20、2 CPU/8GBの隔離Docker。image IDは`sha256:3e7e3086bb864bc828c283ed1224437464e1f97105d04cac46e9a8928840cca3`。tracked source archiveを使い、モデルはread-only mount。Playwright用OSパッケージは実行時取得で、全OS依存の完全固定や両OSのZIP同一性は主張しない。remote GitHub Actionsとは別のローカル検証である。

通常のpytest呼出しではsystem Tempの権限で120件成功・174 setup errorになった。workspace内の`--basetemp`へ切り替えたpreflightと、正式harnessの297件は成功。初回失敗の要約を`artifacts/validation/preflight-20261127/`に保持する。Windows pytest cache書込みwarningとPlaywright色設定warningも成功ログに残しており、削除・skip・閾値変更で通していない。

## モデルと未達の評価

元モデルはSB Intuitionsの`sbintuitions/ja-typo-detector-modernbert-ja-base-30m`、revision `8d640720bddeb64c89dc1fa7780c3ea29fa523e8`、MIT。SB Intuitionsによるモデル開発と、本プロジェクトによる変換・拡張実装を区別する。PythonはPyTorch2.15.0+cpu / Transformers5.24.1 / ORT1.32.0、browserはORT Web1.31.1。

| 資産                           |       bytes |
| ------------------------------ | ----------: |
| FP32 ONNX graph＋external data | 148,552,783 |
| FP16 ONNX                      |  75,004,051 |
| raw QUInt8 ONNX                |  38,356,996 |
| 同梱sanitized QUInt8           |  37,789,676 |

同梱モデルSHAは`dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`で変更していない。WASM/WebGPUの速度ベンチマークは今回再測定していない。[既存条件・測定値](benchmarks.md)を保持し、今回の診断時間を性能値に使わない。WebGPU通常UI、実サービス、最低Chrome版、物理IME・native権限も合格へ変更しない。

M1の[採点感度](research/scoring-sensitivity.md)は既存bestを再現したが、最良採点でも目標未達。M2は[独立gold未確保](research/independent-evaluation-data.md)。M3の[中間値診断](research/onnx-wasm-parity.md#measured-first-pair-result-at-0dc814c)では両backendのinstrumented logitsが元graphと完全一致し、最初の量子化pairの整数も一致した。一方、最終CPU/WASM logit差0.2579023838043213が残る。この1例では差が後段にあると分かっただけで、特定kernelの故障・全体parity成功・精度改善ではない。

精度は旧`67217cc`の同じ配布モデルによる2,000例評価（P79.10%/R63.00%、正常文誤検出5%、F1低下0.0148395）が不合格のまま。今回再推論したと扱わず、receiptも旧accuracy evidenceのsourceを維持する。そのため`accuracy: source commit mismatch`も正しく残る。新規独立評価や許容値変更で解消したとはしない。

## 成果物と再開

- Windows: `artifacts/validation/0dc814cda3bfec86379928f505c6d3ed2725b5dc/`。checks/10 logs/JUnit/Playwright/TS coverage/監査/ZIP/manifest/SBOM/licenseと個別証拠を保存。
- Python overall: `artifacts/coverage/python-overall-0dc814c/report.json`、SHA `a040814cb8a284df26277fe41ba7e9d6f179966f4aa777b2426e1c493dc07f8f`。隔離worktreeのtop-level証拠を退避し、生成モデルsandboxは複製しない。
- Linux: `artifacts/linux-check/0dc814cda3bfec86379928f505c6d3ed2725b5dc/`。ZIP53,019,197 bytes、SHA `4a9fbbfe36a4f98fffe72f9c5ecd664f94a881890a3c3998425b9f38a9ddc6c2`。
- Windows ZIP: 53,015,274 bytes、2回ともSHA `5f07c72e220f3fc6a68da9d309e84198671382a6572f4ae4c6ea2e10ef6f9aae`。監査したruntime7資産とmodel5資産をこのZIPへ照合済み。
- 全context監査SHA `86afb1bed233f0b4bf449a7c1865cd499f822d6616945a7b1ef23a3d11070d57`。
- `artifacts/candidates/0dc814cda3bfec86379928f505c6d3ed2725b5dc/release-candidate.json`はschema名にかかわらずkind=`development_snapshot`、acceptance=`blocked`、12 blockers。SHA `4eb9902ad8b47d40eeea62f2e9ae4fdb87c88a8dd259103107f716b1a1340c53`。生成コマンドの終了コード0は製品合格ではない。

次は独立goldとモデル方針の判断、別途事前登録した後段の数値差調査、利用可能なnative/remote環境の受け入れ。[残タスク](next-steps.md)に従う。同じ失敗実験を反復せず、新runtimeが変わったときだけ品質・監査・配布を新sourceで実行する。Git remoteは0、指定repositoryは現CLI権限では解決できず、非存在とは断定しない。公開・push・認証変更・課金はしていない。

raw logs、coverage、Linux launcherの記録にはローカルpathが含まれ得る。ignored成果物やlocal allowlist一式をそのまま公開しない。正式公開時は、レビュー済みの資産・レポートだけを選び直す。

独立レビューで全参照SHA/bytes、両OSゲート、26-file coverage、標準SBOM・license、監査とZIPのbinding、旧accuracy sourceと12 blockersの保持を確認し、追加の不整合・誤完了は検出されなかった。
