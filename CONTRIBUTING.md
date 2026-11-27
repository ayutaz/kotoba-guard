# 開発への参加

2026-11-28: 開発はユーザー指示で停止中。文書保守は再開を意味しません。
[最新preview](docs/preview-validation.md)と[残タスク](docs/next-steps.md)を優先してください。
文書だけの変更はリンク・format・source/資産hashを確認し、buildやモデル/ブラウザ試行を実行しません。
既定ハーネス/build/packageは旧distや証拠を上書きし得るため、再開後も隔離出力を使います。

[AGENTS.md](AGENTS.md) と [文書索引](docs/index.md)、[開発手順](docs/development.md)、[検証方針](docs/testing.md) を読み、変更前にテストを追加してRedを確認してください。Python依存はuv、Node依存はnpmとlockfileで管理します。単体・型・lintと変更に関係するブラウザ/実モデル検証を実行し、未実行の検証を明記します。

Conventional Commitsを使い、モデル重量・入力本文・秘密情報・生成レポートをGitに追加しないでください。サイトのfixtureと実サービス検証、合成データと一般精度を区別します。コードと日英README、関連ADR、statusを同期させます。文書のみの更新では既存測定の対象コミット・調査日を保持し、今回再実行した検証と分けてください。PRの基本ハーネスだけでは実モデル/E2E/packageを実行したことにはなりません。公開や有料環境の実行は別の許可が必要です。
