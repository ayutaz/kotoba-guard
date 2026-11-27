# CI運用とコスト境界

文書照合: 2026-11-28。最新preview aea6cafの結果はローカルWindows検証であり、remote Actionsは未実行。
今回Git remote未設定を確認し、認証・課金設定の再照会/変更はしていない。
既定workflowは通常のモデル生成/dist/チェック経路で、隔離previewモデルを自動で検証済みとはしない。
開発停止中で、文書保守を理由にCIを起動しない。[現在の検証](preview-validation.md)。
以下の外部料金/仕様は元の参照日時点の記録で、今回再調査していない。

2026-11-27時点のGitHub Actions定義に対する運用方針。CIはローカル開発と同じ品質ゲートを実行するが、外部CIの実行、課金設定、認証設定、公開設定はこのリポジトリから変更しない。

## デフォルト動作

- 成果物のアップロードは、リポジトリ変数 `KOTOBA_GUARD_UPLOAD_ARTIFACTS` が文字列 `true` の場合だけ実行する。変数が未設定の場合はアップロードしない。
- Actionsの依存キャッシュは使用しない。`setup-node` の `cache` は設定せず、`setup-uv` の `enable-cache` は固定actionの既定値 `auto` に依存しないよう明示的に `"false"` を設定する。
- 全ジョブに `timeout-minutes` を設定する。ハングしたジョブが無期限に実行されることを防ぐが、private repositoryのrunner分数が無料になることを意味しない。
- 各ジョブは `$GITHUB_STEP_SUMMARY` にコミットSHA、ジョブ結果、成果物アップロード設定だけを書き出す。入力本文、評価データ、ローカルパス、コマンド出力は書き出さない。
- 成果物パスは明示的なallowlistに限定する。`artifacts/`、`test-results/`、`playwright-report/` のようなディレクトリ全体はアップロードしない。

GitHubの説明では、private repositoryのActionsには無料枠があり、超過したrunner分数・artifact storage・cache storageが課金対象となる。artifactとPackagesは共有のストレージ枠、cache storageは別枠で、ストレージは時間単位の累積として計算される。成果物を後から削除しても、既に累積した当月分は消えないため、デフォルトでアップロードとcacheを停止している。

参照: [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)、[Managing caches](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manage-caches)、固定している[setup-uv action.yml](https://github.com/astral-sh/setup-uv/blob/557e51de59eb14aaaba2ed9621916900a91d50c6/action.yml)。

## CodeQLの扱い

`security.yml` のCodeQLジョブは次の両方を満たす場合だけ起動する。

1. `KOTOBA_GUARD_CODEQL=true` が明示的に設定されている。
2. リポジトリがpublic、または `KOTOBA_GUARD_CODEQL_PRIVATE_ENABLED=true` が事前設定されている。

private repositoryで条件を満たさずCodeQLがskipされた場合、依存監査ジョブのStep Summaryに「skipでありsecurity passではない」と記録する。skipを成功したセキュリティ検査として扱わない。

GitHub公式仕様では、code scanningはpublic repository、またはGitHub Code Securityが有効なTeam/Enterpriseのorganization-owned repositoryで利用できる。Free/Proのprivate repositoryでCodeQLを有効化するにはGitHub Code Securityが必要であり、workflowへactionを書くだけでは有効化されない。したがって、private利用の変数はプランと管理者設定を確認した後に、明示的に設定する。

参照: [Configuring default setup for code scanning](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/configure-code-scanning/configure-code-scanning?learn=code_security_actions)、[Cannot enable CodeQL in a private repository](https://docs.github.com/en/code-security/reference/code-scanning/troubleshoot-analysis-errors/private-repository-enablement)、[Configuring advanced setup for code scanning](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/configure-code-scanning/configuring-advanced-setup-for-code-scanning)。

## Workflow一覧

| Workflow                     | 起動条件                   | 主なゲート                  | timeout |
| ---------------------------- | -------------------------- | --------------------------- | ------: |
| `ci.yml`                     | push / pull request        | Windows・Linuxの通常品質    |    45分 |
| `browser-e2e.yml`            | push / pull request / 手動 | fixture/mock E2E            |    30分 |
| `browser-e2e.yml` real-model | 手動入力のみ               | pinned modelの実ブラウザE2E |    60分 |
| `model-validation.yml`       | 手動入力のみ               | CPU変換・parity・合成回帰   |    60分 |
| `security.yml` dependency    | push / pull request / 手動 | npm・Python監査・SBOM       |    30分 |
| `security.yml` CodeQL        | 明示変数かつ利用資格あり   | CodeQL                      |    30分 |
| `release.yml`                | 手動入力のみ               | reviewable package準備      |    90分 |

成果物を有効にする場合でも、アップロード対象は各workflowに記載されたmanifest、監査JSON、チェック結果、SBOMなどの最小ファイルだけである。raw model、raw dataset、評価入力本文、詳細なブラウザtraceは対象に含めない。

## ローカル検証

workflowポリシーは次で検証する。

2026-11-27のローカル検査は成功した。既存認証は有効だが、追加課金なしで使える計算枠の確実な残量を確認できていないため、リモートActionsは未起動。アカウントの支払・予算・認証設定は変更しない。ローカルLinuxと外部CIの結果を区別する。

```powershell
uv run --locked pytest -q tests/test_workflow_policy.py
```

このテストは、全jobのtimeout、成果物ゲート、allowlist、cache無効化、CodeQLの資格条件、Step Summaryの存在を確認する。GitHub Actions自体の実行結果をローカルテストの成功で代替しない。リモートCIは、リポジトリ設定と許可範囲を確認した後に別途実行する。
