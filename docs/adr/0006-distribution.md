# ADR-0006: 実行資産の同梱

採用。モデル、Tokenizer、JS、ORTのESMとWASM sidecarをZIPに同梱する。初回インストール後の実行時ダウンロードを設けない。開発者だけが明示的な固定revision取得・変換スクリプトを実行する。巨大なweightは通常のGit履歴に入れない。

モデルmanifestと配布全体のinventoryにサイズ・SHA-256を記録し、欠落・想定外ファイル・改ざんをパッケージ検証で拒否する。これはinventoryとZIPの自己整合性検査であり、署名による配布元認証ではない。ZIPのentry順・timestampを固定し、同一ビルドの2回の包装でハッシュ一致を検証する。公開先は未設定、公開操作は実施しない。

変換元ONNXはdebug stacktraceに開発者のパスを含んだため、公開対象から除外する。buildは変換元SHAを照合後、別コピーのprivate-path debug metadataを除去し固定合成token-ID入力8/32/128トークンでCPU logitsの完全一致を検査する。配布用SHAと変換元SHAはmanifestで別記録し、パッケージ側でもパスを再検査する。CI成果物のuploadは明示リストに限定する。

## 2026-11-28追記: 隔離preview出力

旧dist/ZIPを保護し、既存候補からの`--preview-from`同梱準備と
`--model-source`/`--out-dir`を明示した新規directoryへのbuildを実装した。
sourceaea6cafのbuild/E2Eは成功、監査context cleanup失敗により新ZIP/SBOMは未生成。
詳細は[preview検証](../preview-validation.md)と[配布手順](../release.md)。停止中は再生成しない。
