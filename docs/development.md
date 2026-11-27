# 開発手順

現在はGitHub v0.1.0プレビュー公開済み。[v0.1.0公開記録](validation-v0.1.0.md)を参照。以下の測定・停止記録は各記載日時点の範囲を示す。

文書確認: 2026-11-28。GitHub preview公開完了。[最新preview](preview-validation.md)を参照。
以下のinstall/ハーネス/buildは再開後の開発用。文書保守ではリンク・format・source/資産照合だけを行う。
既定コマンドは旧`dist/extension`やレポートを上書きするため、状態確認のためには実行しない。

## 保存済みpreviewと隔離出力

最新buildは`artifacts/preview/aea6caf1c1e8afaf29b524c9ac9fafde6d9b2f17/extension`。
モデル取得済みなら`prepare_models.py --preview-from <candidate.onnx> --output <fresh bundle>`、
続いて`node scripts/build.mjs --model-source <bundle> --out-dir <fresh extension>`を使う。
出力は`artifacts/preview`内の新しいdirectoryへ限定し、既存資産を上書きしない。
詳細は[release](release.md#ローカルpreviewの作成)、テスト選択/envは[testing](testing.md)を参照。
既定packageは旧dist専用で、最新previewの配布検査はまだ行っていない。

Node.js 24 LTS（`>=24 <25`）、Python 3.12（`>=3.12 <3.13`）、uvを使い、リポジトリ直下で実行する。解決済み依存はnpmとuvのlockfileを正とする。依存追加は `npm install` / `uv add`、Python開発依存は `uv add --dev`。グローバルPythonや `pip install` は使わない。

```sh
uv sync --locked
npm ci
uv run --locked python scripts/harness/check_environment.py
uv run --locked python scripts/harness/run_checks.py
```

Windowsの制限付き環境では実行前にキャッシュをcheckout内へ指定する。ブラウザ導入と実行で同じPlaywrightパスを使う。

```powershell
$env:UV_CACHE_DIR = "$PWD/.cache/uv"
$env:npm_config_cache = "$PWD/.cache/npm"
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD/.cache/playwright"
```

WindowsAppsのPython aliasが動かない場合はuvのインストール済み3.12を明示指定する。Gitの所有者検査はcheckoutを確認して `git -c safe.directory=<absolute checkout path> ...` を使う。システム設定やグローバルGit trustは変更しない。

## チェックの選び方

| コマンド                | 実行範囲                                                             |
| ----------------------- | -------------------------------------------------------------------- |
| `npm run check`         | ESLint、TypeScript strict、Prettier                                  |
| `npm test`              | Vitest単体試験                                                       |
| `npm run test:coverage` | Vitestとカバレッジ閾値（全体80%、SDK90%）                            |
| `npm run test:model`    | 固定モデルの34 tokenizerケース照合                                   |
| `npm run build`         | MV3生成、ライセンスとbundle監査。モデルがあればSHA照合・sanitization |
| `npm run test:e2e`      | 既定はmock/real両project。詳細は [testing.md](testing.md)            |
| `npm run package`       | 既存の `dist/extension` を検証・ZIP化。buildは実行しない             |

通常ハーネスはRuff lint/format、pytest、npm check、TS coverage、buildの6ゲート。モデルなしbuildは可能だが推論できず、packageは拒否する。[モデル変換](model-conversion.md) で資産を用意してから次を実行する。

```powershell
npx playwright install chromium
uv run --locked python scripts/harness/run_checks.py --model --e2e --package
```

`--model` はtokenizer照合と40文の変換回帰ゲートを追加する。`--package` もtokenizer照合を追加するため、単にbuild済みであるだけでは足りない。`--e2e` はPlaywrightを追加し、project選択は `KOTOBA_GUARD_E2E_MODE` に従う。未設定なら両project、`mock` / `real` なら片方のみ。3フラグ併用では計10ゲートとなる。

結果は終了コード、`artifacts/checks.json`、`artifacts/check-*.txt`、`artifacts/pytest.xml`、`artifacts/playwright.json`、`coverage/` に出力する。ハーネスは失敗後も他ゲートを実行し、1件でも失敗すれば非0で終了する。再実行で同名証拠を上書きするため、必要な過去記録は先に別名保存する。入力本文をログや永続ストレージへ記録しない。

速度測定とモデル変換は並列に実行しない。再exportは同じweightでもONNXのhashが変わり得るため、測定前に資産を凍結し、測定・E2E・包装で同じSHAを使う。coverage用再変換には別出力先を指定する。

## CIと再開

CI定義は通常品質（Windows/Linux）、モデル手動検証、mock/手動realブラウザ、依存監査/CodeQL、手動release準備の5本。CodeQLジョブだけ `security-events: write` を使い、他はread権限。モデルジョブに定期実行はまだない。現在の成功証拠はローカルWindowsと隔離Linux Dockerであり、GitHub Actionsは未実行。

停止中は再開指示を待つ。再開後は [status.md](status.md)、[roadmap.md](roadmap.md)、Git履歴を読む。MVPの残る受け入れを [mvp-checklist.md](mvp-checklist.md) で選び、関連Skillを使い、文書とテスト結果を同期してConventional Commitを作る。公開操作は別途許可が必要。
