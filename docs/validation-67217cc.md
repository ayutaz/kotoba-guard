# 開発用snapshotの検証記録

2026-11-27 JST。対象はcleanなソース `67217cc172cacc36bff0a970a556a35ec5f16564`。後続の文書・Skill更新はこの成果物の対象commitを変更しない。正式公開、push、認証・課金設定変更は行っていない。

## 成果物と判定

| 項目             | 実測・記録                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------- |
| 種別             | `development_snapshot`、公開受け入れは`blocked`                                          |
| Windows ZIP      | 53,014,251 bytes                                                                         |
| ZIP SHA-256      | `759785fe9a542b413eeea8e6e9e5b5247613004b6c9973022c6b610c076a23cd`                       |
| 再包装           | 同じWindows buildから2回包装し、SHA一致                                                  |
| 配布モデル       | sanitized QUInt8、37,789,676 bytes                                                       |
| モデルSHA-256    | `dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`                       |
| 元モデルrevision | `8d640720bddeb64c89dc1fa7780c3ea29fa523e8`                                               |
| Linux ZIP        | 53,018,173 bytes、SHA `3252e0d05e83e4c5a2a4a4dfb9a3bca93e79892d536b8e90730addbb96b0385f` |

Windows ZIPは `artifacts/validation/67217cc172cacc36bff0a970a556a35ec5f16564/kotoba-guard.zip`。同じディレクトリに2回目のZIP、reproducibility、model/distribution manifest、環境、各証拠、SBOM、ライセンス一覧を保存した。標準CycloneDXはNode218 components（1.5）とPython73 components（1.4）。独自のsource-bound索引とSBOM本体は別ファイル。47件のbrowser依存inventoryには同梱の有無と44件のlicense file参照を記録し、実ファイルを照合した。

receiptとallowlistは `artifacts/candidates/67217cc172cacc36bff0a970a556a35ec5f16564/`。receiptのファイル名・schemaはrelease-candidateだが、`kind: development_snapshot`、`acceptance: blocked`であり公開候補ではない。精度未達、物理IME/native権限/remote CI未検証とsnapshot種別による11 blockersを保持する。資産欠落やSHA不一致によるblockerはない。

独立レビューでもreceipt・allowlist・直接参照の全SHA、ZIP内model manifestのバイト一致、モデルSHA、source対応を確認した。`reference_precision/recall invalid`というblocker文言は、今回は数値の不正でなく基準未達を表す。2回目ZIPはreproducibility JSON内の記録と実ファイルのSHAを別途照合しており、receiptが再帰的に全ネスト参照を検証するという意味ではない。

生成物はignoredローカル資産でfresh checkoutには存在しない。allowlistは公開許可ではなく、正式公開前には添付内容とprivate pathを別途レビューする。Windows内の再包装一致をOS横断のバイト一致と解釈しない。

## 品質ゲート

| 検査               | 結果・範囲                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| Windows統合        | 全10ゲート成功。Python249、TS182、mock4＋実モデル5 E2E、build/package                             |
| Linux統合          | 全10ゲート成功。Python249、TS182、実モデル5 E2E、build/package                                    |
| Python全体coverage | unit＋実モデル統合9コマンド、24対象ファイル、line2,703/3,352（80.64%）、branch955/1,324（72.13%） |
| TS coverage        | statements85.15%、lines88.58%、SDK statements91.19%・lines93.65%                                  |
| Tokenizer          | 1 integration test内の34ケースでnative ID/UTF-16 offsetと照合                                     |
| 依存監査           | Node/Python既知脆弱性0、Pythonはskipなし。torch +cpuは公開版番号でadvisory照合                    |
| 通信・資源         | 全scope監査成功、オフライン実推論完了、外部HTTP/WebSocket・監視漏れ・fatal error・pending task0   |

WindowsはWindows11、Node24.15.0/npm11.4.2/Python3.12.13/uv0.12.20、Chromium159.0.8154.6。Linuxはtracked Dockerfileから構築した `kotoba-guard-linux-check:locked-20261127`、image ID `sha256:3e7e3086bb864bc828c283ed1224437464e1f97105d04cac46e9a8928840cca3`。Node24.15.0/npm11.12.1/Python3.12.14/uv0.12.20、2 CPU・8g制限、Git履歴なしarchiveと読み取り専用モデルで検証した。ローカルLinuxとGitHub Actionsは別の証拠である。

Windows pytestには`.pytest_cache`書込み権限のwarningが1件あった。249件は全成功し、隔離coverageとLinuxでも全件成功した。

## 通信監査と画面

最初の監査は相対パスを渡し、Chromeの`Extensions.loadUnpacked`が`File path cannot be resolved`で読込前に失敗した。`browser-security-audit.json`に保持。絶対パスの`browser-security-audit-absolute.json`は合格し、監査したJS・モデル資産のsize/SHAを配布inventoryと照合した。監視条件・timeout・合否基準の変更はない。

拡張page/background service worker/offscreen/dedicated workerとHTTP/WebSocket陽性対照を確認した。process memoryとJS heapを別々に取得し、CDP processのHWM合計の最大観測値は1,351,823,360 bytes。同時RSS peak、モデル単体の使用量、全OS process treeとは扱わない。

同じ実モデルE2Eの `screenshots/store-editor.png` は1280×800、SHA `2a8d097ade61eb690491942d876cdad22c4d0fffe7462b7fb43f5b0cb2228103`。`screenshots/popup.png` は330×357、SHA `7eeccb32c0b7ddf18eca476fbcc942b3875c475ef1ce42287608b666900c3d1f`。両方を目視し、検出件数が次の入力欄ラベルを覆わず、popupのCSS・設定・手動チェックが表示されることを確認した。popupはモデル初期化前の画像である。

## 精度と残課題

同梱モデルを固定開発用2,000例で新規CPU実行した。閾値0.5、ORT1.32 CPU1 thread、graph optimization無効。TP647/FP171/FN380、Precision79.0954%、Recall62.9990%、F1 0.701355、正常文50/1,000（5%）、凍結PyTorch参照からのF1低下0.0148395。推論は全件完了、終了コード1は精度受け入れ不合格を表す。

記録は `artifacts/candidate-evaluation/distributed-quint8-67217cc/`。参照は`af8cd94`の凍結結果を保持し、新規推論したと表示しない。学習露出の可能性がある開発用評価で、WASM一般精度や業務文章への精度を測った結果ではない。既存のnative最適化有効評価、公式test、実験用weight-onlyの数値と条件を分ける。

通常QUInt8の固定64例CPU/WASM数値不一致、参照モデル自体の実用精度未達、物理IME、native権限UI、remote CIは未解決。今回の`sky.list_windows`もnative pipe欠落（os error2）で失敗し、UI操作は行っていない。リモートは未設定、CIは未起動。新weight-only候補は精度・速度で採用保留のまま。

元の工程1〜5について、ソース・coverage、候補比較と不採用理由、精度診断と公開保留、実行可能な両OS/通信/資源検証、開発用配布物と掲載文案を記録した。未達を残す開発用snapshotとして区切り、MVP完成・正式公開とはしない。次は[精度改善計画](research/next-experiments.md)、公開前の条件は[MVP記録](mvp-checklist.md)を参照する。
