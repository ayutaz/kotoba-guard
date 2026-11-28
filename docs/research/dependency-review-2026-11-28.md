# Bot PR確認記録（2026-11-28）

公開後に届いたDependabot PR 8件と、対応中に届いたグループ更新1件を確認した。
8件をマージし、互換性がないTypeScript更新1件を保留した。変更対象は開発依存とCIであり、
公開済みv0.1.0のタグ・モデル・配布ZIPは更新しない。

## 判断と対応

| PR                                                  | 更新                  | 判断・対応                                                                                                     |
| --------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| [#1](https://github.com/ayutaz/kotoba-guard/pull/1) | CodeQL                | initだけの更新を修正し、analyzeも同じSHAに統一。回帰テストとグループ更新設定を追加してマージ                   |
| [#2](https://github.com/ayutaz/kotoba-guard/pull/2) | setup-uv 10.4.0       | 固定uv 0.12.20・Python 3.12・キャッシュ無効設定を保持してマージ                                                |
| [#3](https://github.com/ayutaz/kotoba-guard/pull/3) | upload-artifact 7.0.2 | opt-in条件・保存期間・対象ファイルを保持してマージ。アップロード自体は実行されていない                         |
| [#4](https://github.com/ayutaz/kotoba-guard/pull/4) | pytest-cov 7系        | uv.lock未更新によるCI失敗を修正。7.1.0へ固定し、全CI成功後にマージ                                             |
| [#5](https://github.com/ayutaz/kotoba-guard/pull/5) | checkout 7.0.1        | persist-credentials: falseを保持してマージ                                                                     |
| [#6](https://github.com/ayutaz/kotoba-guard/pull/6) | setup-node 7.1.0      | Node 24の指定を保持してマージ                                                                                  |
| [#7](https://github.com/ayutaz/kotoba-guard/pull/7) | huggingface-hub 2系   | uv.lock未更新によるCI失敗を修正。2.5.0とHTTP依存を固定し、全CI成功後にマージ                                   |
| [#8](https://github.com/ayutaz/kotoba-guard/pull/8) | TypeScript 7.0.2      | 保留。typescript-eslint 8.74.0のpeer要件が `>=4.8.4 <6.1.0` のためnpm ciがERESOLVEで失敗。依存を強制解決しない |

## 実行した検証

- CodeQLのSHA不一致を新規テストで再現（Red）。統一後、workflowと公開CLI関連24テストが成功（Green）。Ruff成功。
- 最初の関連テスト実行は隔離worktreeの一時ディレクトリ親が存在せず失敗した。親ディレクトリを作成後に成功。テストは変更していない。
- pytest-covのPRは変更前の `uv lock --check --offline` が失敗。対象依存だけロックを更新後、チェックと `uv sync --locked` が成功。
- pytest-cov 7.1.0でPython全428テストが成功。coverage JSON出力成功。単体試験のみの分岐込みcoverageは75.69%であり、実モデル・subprocessを統合した全体受け入れ値ではない。
- huggingface-hubのPRも同じロック不整合を再現・修正。2.5.0でPython全428テストとRuffが成功。
- Transformers 5.24.1をimportし、匿名・テレメトリー無効で固定モデルのメタデータとconfigを取得できることを確認。
  リビジョン `8d640720bddeb64c89dc1fa7780c3ea29fa523e8`、config SHA-256 `9305fa06a819bdb8bcc978e0f4dd0a78c9047a23a3b3c0eae5eb004013174b5f`、ラベル9件。
- マージした8件はPRのWindows/Linux品質ゲート、ブラウザfixture/mock E2E、依存監査が成功してからマージ。
- CodeQL本体と実モデルE2Eはopt-inのためskip。今回の成功項目に含めない。モデル再変換・速度測定・新規リリースは行っていない。

ローカルの追加テスト結果は隔離worktree内の `artifacts/pr4-pytest.xml`、
`artifacts/pr4-coverage.json`、`artifacts/pr7-pytest.xml`、`artifacts/pr7-hub-smoke.json` に保存した。
既存のリリース証拠は上書きしない。

## 参照した公式資料

- [checkout 7](https://github.com/actions/checkout/blob/v7.0.1/README.md)
- [setup-node 7](https://github.com/actions/setup-node/blob/v7.1.0/docs/advanced-usage.md)
- [upload-artifact 7](https://github.com/actions/upload-artifact/blob/v7.0.2/README.md)
- [setup-uv 10](https://github.com/astral-sh/setup-uv/blob/v10.4.0/README.md)
- [pytest-cov変更履歴](https://pytest-cov.readthedocs.io/en/latest/changelog.html)：7系で暗黙のsubprocess測定を廃止。本プロジェクトの統合coverageドライバーは明示的なcoverage実行を使用する。
- [huggingface-hub 2移行](https://github.com/huggingface/huggingface_hub/releases/tag/v2.0.0)：HTTP依存をhttpx2へ変更。本プロジェクトは独自HTTPクライアントや旧transport例外を使用していない。
- [huggingface-hub 2.5.0](https://github.com/huggingface/huggingface_hub/releases/tag/v2.5.0)

TypeScript 7の採用は、ESLint側が正式に対応してnpm ci・lint・型検査が通る時点で再検討する。
Python依存更新では、pyproject.tomlだけでなくuv.lockを更新し、locked実行を確認する。

対応中に作成された [#9](https://github.com/ayutaz/kotoba-guard/pull/9) はCodeQLのinit/analyzeを公式v4.39.5へ一括更新するもの。公式タグの実コミットSHAと両Actionの一致、全CI成功を確認してマージした。
