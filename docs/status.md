# 開発状況

2026-11-28、最短リリース計画1〜4を完了し、[v0.1.0プレビュー](https://github.com/ayutaz/kotoba-guard/releases/tag/v0.1.0)を公開した。
ZIPの実モデル検証・通信監査・公開後のダウンロード照合、Windows/Linux CI、公開workflowのdry-runが成功。
正式MVP/M5は未完成。[公開検証記録](validation-v0.1.0.md)を現在の結果の参照先とする。

## 最新の実装と検証

| 項目           | 状態                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------- |
| リリースソース | `f2d6afdd5bd241a5bed30b77faef226702f09cd2`                                                    |
| 拡張機能       | MV3、共有Offscreen/Worker、WASM、一般編集欄、手動/自動検査、合成IME、サイトopt-in、機密欄除外 |
| 配布ZIP        | 62,507,705 bytes、SHA `1eb9f114bf49efd29b2c1df3b46665460e61d3eb95ce92dcb147eb1d5e8ecda2`      |
| build/E2E      | 78資産、最終展開ZIPの7件成功（mock4/実モデル3）                                               |
| 監査           | exit0/gate=true、予期しない通信0、offline6回、coverage/source/資産/cleanup8項目成功           |
| 公開           | GitHub prerelease。11添付物をダウンロードし全SHA一致、タグの実体も確認                        |
| CI             | リリースソースのWindows/Linux品質・browser fixture・依存監査成功。CodeQLはskip                |
| 公開自動化     | CLI実公開成功。workflowは実bundleで検証成功、公開jobはpublish=falseでskip                     |

## テストと未達

ローカルTS623件、既存Python回帰411件、新CLI/workflow/coverage関連43件が成功。
Pythonの2グループには重複があり合算しない。新しい全体coverage測定は行っていない。
モデルは48,188,514 bytesのEmbedding UINT8/MatMul FP16保存・FLOAT演算。
速度p50=150.1msの100ms未達、一般精度未評価、参照/旧モデルの精度未達は保持する。
物理IME、native権限UI、実サービス、最新モデルの最低Chrome/Linux実モデルと長期資源は未完了。

## 保存した失敗と履歴

旧aea6cafの監査cleanup失敗、3672c76のcontext/OS計測失敗を保持する。
e627333で終了observer修正後に監査成功し、公開sourceでも改めて最終監査を成功させた。
最初の最終buildは出力先の許可範囲で開始前に拒否され、規定の新規出力先へ直した。
原本・旧ZIP/dist/実験の207固定ファイルはSHA不変。
元のローカルmain履歴は保持し、公開用branch `release/public-preview`をremote mainへ送った。

## 次の作業

今回の公開範囲は完了して区切る。最適化・機能追加・Store/HF/npm公開へ自動で進めない。
未達は[残タスク](next-steps.md)と[MVP checklist](mvp-checklist.md)に保持する。
