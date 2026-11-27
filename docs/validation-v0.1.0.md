# v0.1.0プレビュー公開記録

2026-11-28、[GitHub prerelease](https://github.com/ayutaz/kotoba-guard/releases/tag/v0.1.0)を公開した。正式MVP/M5、Chrome Web Store配布版ではない。

## 公開物とソース

| 項目                      | 実際に確認した値                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------- |
| タグ                      | `v0.1.0`。実体は下記commit、draft=false / prerelease=true                              |
| build・実モデル検証ソース | `f2d6afdd5bd241a5bed30b77faef226702f09cd2`                                             |
| ZIP                       | `kotoba-guard-0.1.0.zip`、62,507,705 bytes                                             |
| ZIP SHA-256               | `1eb9f114bf49efd29b2c1df3b46665460e61d3eb95ce92dcb147eb1d5e8ecda2`                     |
| 同梱モデル                | Embedding UINT8 / MatMul FP16保存・FLOAT演算、48,188,514 bytes                         |
| モデルSHA-256             | `4b8d05c29f7c99dbb85e721ef619ca748758ec3c60b03d9290473992b705bbf7`                     |
| 元モデル                  | SB Intuitions 30M、revision `8d640720bddeb64c89dc1fa7780c3ea29fa523e8`、MIT            |
| 配布資産                  | 78ファイル。モデル・Tokenizer・JS・WASM・ライセンスを同梱                              |
| ダウンロード確認          | 公開された11添付物すべてのSHAがローカルと一致                                          |
| 履歴の扱い                | 元の開発履歴はローカルに保持。公開は同じtreeの新しい履歴とGitHub公開用identityから開始 |

2回包装したZIPが一致し、検査前に作成して展開したZIPとも一致した。公開後のZIPを再度配布検査した。
SBOMは実配布の依存ライセンス一覧から生成し、公開manifest・モデル・監査資産と照合した。
公開payload88項目に既知の私有パス・非公開メール・認証情報の検出なし。画像は合成fixtureで、表示文字も確認した。
旧preview/dist/実験の固定207ファイルはSHA不変。

## 実行したチェック

- ローカルTypeScript単体623件成功、Lint・型検査・整形成功。
- 新CLIを除くPython回帰411件成功。CLI/workflow/coverage関連43件成功（既存suiteと重複があり、合算しない）。
- 最終ZIPを展開してmock4＋実モデル3のE2E全7件成功。skip/retry/flakyなし。
- 実モデル通信監査exit0/gate=true。予期しない通信0、拡張contextと陽性対照の観測網羅性、source/78資産の前後照合、offline6回を確認。
- cleanup8項目すべて成功。OSプロセスメモリの試料は取得済みだが、モデル単体のメモリベンチマークや長期資源の合格ではない。
- [Windows/Linux品質CI](https://github.com/ayutaz/kotoba-guard/actions/runs/46033217090)成功。
- [ブラウザCI](https://github.com/ayutaz/kotoba-guard/actions/runs/46033217143)成功。これはfixture/mockで、Linux実モデル検証ではない。
- [依存監査・SBOM CI](https://github.com/ayutaz/kotoba-guard/actions/runs/46033217325)成功。CodeQLは明示変数がないためskipで、実施済みとはしない。
- [公開workflow](https://github.com/ayutaz/kotoba-guard/actions/runs/46034122767)成功。実際の公開bundleを取得・検証し、publish=falseのため公開jobはskip。

初回の実公開はローカルCLIの`--publish`で行った。workflowの公開job自体は未実行。
以降は同じ方式で用意したsealed bundleを固定URL/SHAで検証し、明示指定時だけ公開する。
今回のbundle SHA-256は`fd2b337a101aff1cdfbf243e71ed4ed149ab9bd6fb623a8ceca3e12b657bc7e8`。既存release/tag/assetの上書きは拒否する。

## 機能と残る制約

手動/自動チェック、textarea/input/contenteditable、ハイライト、合成IMEイベント、サイトopt-in/停止、
機密欄除外、本文非保存、オフラインWASM、共有Workerの並行要求をローカルfixtureで確認した。
許可を事前付与したfixtureは、Chromeのnative権限ダイアログの受け入れを代替しない。

新モデルの一般コーパス精度は未評価。参照/旧候補の精度目標未達を解決したとはしない。
別実験の128-token WASM p50=150.1ms/p95=200.5msは100ms目標未達で、今回再測定していない。
物理IME、実サービス、最新モデルの最低Chrome/他ブラウザ、Linux実モデル、長期メモリは未完了。
WebGPU UI、修正候補、辞書、新モデル・追加サイト・最適化、Store/HF/npm公開は今回の範囲外。

## ローカル証拠と再開

`artifacts/preview/f2d6afdd5bd241a5bed30b77faef226702f09cd2/`にsource archive、build、tested ZIP、extracted ZIP、E2E、監査、release、bundleと各終了記録がある。
公開後の取得物は`artifacts/published-v0.1.0/`、照合記録は`artifacts/publication-v0.1.0-receipt.json`。
rawログ・trace・ローカルパスはReleaseへ添付していない。fresh cloneにはignored証拠はなく、公開添付物と本記録を使う。
最初の出力先指定ミスのbuild拒否と、過去の監査失敗もローカルに保持する。

この公開までで今回の作業を区切る。次は[残タスク](next-steps.md)を参照し、新しい指示の範囲で進める。
