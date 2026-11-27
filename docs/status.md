# 開発状況

ユーザーの「4まで進めて」により、最短リリース計画1〜4を再開した。監査終了処理の修正、公開自動化、
ZIP確認、GitHubプレビュー公開までが今回の範囲。最適化・機能追加・Store/HF/npm公開は含めない。
初回修正3672c76は関連110件成功後に実監査を1回実行した。通信0・coverage/資産照合成功だが、
context終了と途中のOSプロセス計測で失敗。原本は`artifacts/release-audit/3672c765640b3cc72b455963d4a8b8691882a970/`。
独立レビュー後、observer停止とbrowser owner終了を修正し、関連134件・型・Lintが成功した。
新source e627333の独立checkoutでは実監査がexit0/gate=true。通信0、coverage/資産照合、offline6回、
8項目の終了処理とOSメモリ計測が成功した。旧失敗は保持する。公開自動化とZIP最終確認は進行中、公開は未実施。
以下の表は再開前の保存済みpreviewの記録。現在の監査結果は上の追記を参照し、過去の対象sourceは変更しない。

## 再開前のpreviewの記録

| 項目          | 現在の状態                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------- |
| 検証ソース    | `aea6caf1c1e8afaf29b524c9ac9fafde6d9b2f17`                                                    |
| 停止記録      | `c14a591`。今回の文書更新とは別commit                                                         |
| 拡張機能      | MV3、共有Offscreen/Worker、WASM、一般編集欄、手動/自動検査、合成IME、サイトopt-in、機密欄除外 |
| previewモデル | Embedding UINT8 / MatMul FP16保存・FLOAT演算、48,188,514 bytes                                |
| 数値一致      | source2914a68の固定64例でCPU/WASM一致。最大差0.0000248                                        |
| build・E2E    | aea6cafで78資産build、mock4＋実モデル3＝7件成功                                               |
| 通信監査      | unexpected0・観測網羅/証拠照合成功。ただしcontext cleanup失敗でgate=false/exit1               |
| 新ZIP/SBOM    | 監査で停止したため未生成                                                                      |
| 最新の既存ZIP | source0dc814cの旧development snapshot。previewへ付け替えない                                  |
| 公開          | remote未設定（今回Git設定で確認）。push/Store/HF/npm公開なし、許可も未取得                    |

対象、SHA、保存場所、初回失敗と修正の区別は[最新preview検証記録](preview-validation.md)を正とする。
`dist/extension`は旧固定資産であり、最新buildは`artifacts/preview/aea6caf1c1e8afaf29b524c9ac9fafde6d9b2f17/extension`。

## テストと未達

全TS609件はpreview準備まで、Python関連19件は変換/同梱回帰、終了helper13件は後続修正の範囲。
これらを合算した「現HEADの全suite成功」や新coverageとは表示しない。
速度p50=150.1msの100ms目標未達は保持し、追加最適化は延期する。
参照/旧QUInt8とも精度未達、独立実用gold不足、最新previewの一般精度は未評価。
物理IME、native権限、実サービス、最新runtimeのLinux/最低Chrome/remote CIと長期資源は未検証・未解決。

## 2026-11-28の文書保守

日英README、進捗/計画/受け入れ、モデル/検証/配布資料、関連ADRとSkillsを同期した。
95件のMarkdownの相対リンク・見出し、Skillsの必須frontmatter、変更文書の整形を確認する。
preview/旧dist/既存候補の207ファイルを更新前後のSHA-256で照合し、変更なしを確認した。
文書検査の結果は`artifacts/docs-20261128/`へ保存する。実装・モデル/ブラウザ試行・build・公開は再開していない。
過去の測定値・対象sourceを保持し、文書commitを新しいruntime検証と扱わない。

## 次の作業

公開自動化の実装は揃っており、レビューと関連回帰を行う。次に公開ソース・ZIPを固定し、
展開ZIPの実モデルE2E/通信監査、GitHubプレビュー公開、ダウンロード後のSHA照合まで進める。
初回はローカルCLIを使い、以降は固定bundleをworkflowから検証・公開する。
最適化・新モデル・追加サイト・Store/HF/npm公開は含めない。[実行計画](next-steps.md)を正とする。

## M1〜M5の実装再開（2026-11-27）

この節名は旧リンク互換のため保持する。M1採点診断は完了、M2精度/独立goldは未達、
M3数値一致候補は得たが正式採用/性能目標は未達、M4は限定fixture検証、M5は未完成。
過去の詳細は[研究文書索引](index.md#研究と過去の検証)と各sourceの記録を参照。
更新前の時系列全文は`git show c14a591:docs/status.md`で取得できる。
