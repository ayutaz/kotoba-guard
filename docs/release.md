# 公開準備

2026-11-28更新。GitHub v0.1.0プレビュー公開まで完了した。[v0.1.0公開記録](validation-v0.1.0.md)を参照。最適化を延期し、
preview配布と正式MVP/M5の受け入れを区別する。完了範囲と後続タスクは[実行計画](next-steps.md)。

## 公開自動化

`scripts/preview_release.py`でprepare/verify/publish/bundle/extractを提供する。
初回は検証済みのローカル配布物をCLIから公開する。以降の手動workflowは同一リポジトリの
固定SHAのsealed bundleを取得・再検証し、公開指定がある場合だけprereleaseを作成する。
公開時に再build・再変換・再包装せず、既存versionを上書きしない。

```text
uv run --locked python scripts/preview_release.py prepare --extension-dir <tested-extension> --source-commit <full-sha> --e2e <playwright.json> --security <security.json> --output-dir <new-release-dir> --version 0.1.0
uv run --locked python scripts/preview_release.py verify --release-dir <release-dir> --source-commit <full-sha> --version 0.1.0
uv run --locked python scripts/preview_release.py publish --release-dir <release-dir> --tag v0.1.0 --title "Kotoba Guard 0.1.0 preview" --notes-file <public-notes.md>
```

最後のコマンドは既定でdry-run。許可された公開実行時だけ`--publish`を追加する。
公開用ZIP、checksum、SBOM、model manifest、検証要約、release manifestをallowlistに限定する。
初回公開後、同じreleaseディレクトリを`bundle`で封印し、そのZIPとSHAを同じReleaseへ追加する。
その固定URL/SHAでworkflowをpublish=false実行し、後続の公開経路を確認する。
rawのartifacts・trace・入力文章・ローカルパスを公開しない。

監査終了処理は`e627333`で修正・実監査成功。最終公開ソースと展開ZIPでもE2E/監査が成功した。既存の成功結果を付け替えない。Chrome Web Store/HF/npm公開は今回の対象外。

## 再開前の保存済み成果物

最新検証sourceは`aea6caf1c1e8afaf29b524c9ac9fafde6d9b2f17`。
`artifacts/preview/<source>/extension`に78資産のunpacked build、`bundle`に同梱元がある。
buildとE2E7件（mock4/実モデル3）は成功。通信監査はunexpected0・対象coverage/照合成功だが、
context終了失敗でexit1、ready=false。**新ZIP/SHAファイル/SBOMは未生成。**
[preview検証](preview-validation.md)のモデルSHA・ソースarchive・stage結果を正とする。

旧ZIPは[0dc814c snapshot](validation-0dc814c.md)の固定記録であり、最新previewではない。
[67217cc](validation-67217cc.md)や初回6de3a00の失敗も元のsourceで保存する。
ignored資産はfresh checkoutにない。後続の文書commitへ測定対象を付け替えない。

## ローカルpreviewの作成

以下は隔離した出力先での再現手順。
候補ONNXと隣接する変換manifestから検証済みconfig/tokenizer/LICENSEを揃え、
新規bundleと新規extensionへ生成する。`<candidate.onnx>`は実在する保存済み候補へ置き換える。

```text
uv run --locked python scripts/prepare_models.py --preview-from <candidate.onnx> --output artifacts/preview/local/bundle
node scripts/build.mjs --model-source artifacts/preview/local/bundle --out-dir artifacts/preview/local/extension
```

既存/重複出力・symlink/junction・モデル欠落やhash不一致は拒否する。preview準備は
既存候補の検証とコピーで、再download/export/inferenceはしない。buildは資産照合・sanitize比較を行う。
通常の`npm run build`/ハーネスは旧distやレポートを更新するため、隔離previewの代わりに実行しない。

監査独自の終了経路は修正済み。最終sourceと展開ZIPにE2E/通信/配布検査を結ぶ。
監査は`node scripts/browser_security_audit.mjs --extension-dir <absolute directory> --output <new report>`。
既存outputや`.cache/run_preview.py`をそのまま再実行しない。正確な再開点は[next steps](next-steps.md)。

`npm run package`のCLIは旧`dist/extension`を対象としbuildしない。隔離previewのZIPは
`scripts/package_extension.py`の`create_zip(root, output)`/`verify_zip`を用いる経路で明示的に作る。
同じ検証済みdirectoryから2回包装し、SHA一致、SBOM、完全LICENSE、model manifest、source commitを記録する。
v0.1.0はこの段階を完了済み。新しいversionでも実測したZIPのサイズ/SHAのみを記載する。

## 正式公開との境界

FP16保存モデルの100ms p50目標未達、一般精度未評価、参照/旧QUInt8の精度未達、独立gold不足、
物理IME/native許可/実サービス/最新環境/remote CI/資源の未完了を明示する。
最適化延期を正式目標達成や無条件の公開判断へ読み替えない。
`development_preview`はローカルrunnerの記録種別で、正式receipt CLIの新しい合格種別ではない。

日英README・モデルカード・説明と掲載画像を実際の候補へ照合し、公開/privacy/support URLを確定する。
Git remoteは文書確認時点で未設定。認証は今回再確認しない。
Store、GitHub Release、Hugging Face、npmへの正式公開には明示的な許可が必要。

### 証拠を固定するツール

`uv run --locked python scripts/prepare_release.py --help` で引数を確認する。`--kind release_candidate` はcleanなソースcommit、実ZIPの完全な配布監査、固定モデル由来・sanitized SHA、checks/e2e/security/accuracy/native_ime/native_permission/remote_ciの全証拠、環境・SBOM・license記録を要求する。証拠は同じsource commitに結び、`references` の各 `{path, sha256}` をローカルファイルと照合する。accuracyには候補と参照それぞれのPrecision/Recall、正常文の母数・誤検出率、量子化F1差が必要。単に `status: passed` を記載しても閾値未達は拒否する。

ZIPは危険なentry名・symlink・1,000件超・展開200MiB超を拒否し、リポジトリ内の専用一時ディレクトリで `verify_directory` を実行する。ZIP内のモデルmanifestと指定manifestのバイト一致、配布モデルのsize/SHAを検証する。`artifacts/candidates/<commit>/` にreceiptとallowlistのみを書き、同じcommitの既存記録は上書きしない。公開・ビルド・検査そのものを代行するツールではなく、実行した証拠を照合する。

`--kind development_snapshot` は未完了の記録用で、全入力が成功していても常にblocked。公開候補として扱わない。24回帰試験でCLI起動、証拠欠落・改変、モデル不一致、不正なCSP/権限/欠落資産を検証した。新しい候補の実行結果と正式公開の許可は引き続き別途必要。

ONNXのデバッグ情報には開発環境のパスが含まれることがある。buildで配布用コピーを除去・推論比較し、packageで再検査する。raw変換ディレクトリやローカルartifactsを一括でアップロードしない。workflowの成果物はZIP・SHA・SBOM・manifest等の明示リストに限定する。ソースSHA、変換元SHA、配布モデルSHAを混同しない。

Store申請資料には説明文、権限の理由、入力が端末内に留まる処理図、スクリーンショット、プライバシーURL、サポート窓口が必要。現状は文書とローカルfixture画像を用意した段階で、申請資料一式・公開URL・窓口は未確定。公開先や審査通過を推測しない。
