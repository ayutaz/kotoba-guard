# 残タスクと着手順

2026-11-28、最短リリース計画1〜4を完了。[v0.1.0プレビュー](https://github.com/ayutaz/kotoba-guard/releases/tag/v0.1.0)を公開した。
実行結果と根拠は[公開検証記録](validation-v0.1.0.md)。今回の作業はここで区切る。

## 実行計画

| 順序             | 結果                                                            |
| ---------------- | --------------------------------------------------------------- |
| 1 公開自動化     | CLI/workflowを実装・レビュー・回帰検証済み                      |
| 2 ソース/ZIP固定 | 公開履歴のprivacy確認、2回包装一致、SHA/SBOM/ライセンス確認済み |
| 3 展開ZIP検証    | E2E7件と実モデル通信監査が成功                                  |
| 4 GitHub公開     | 同一ZIPのprerelease公開、実タグ/公開11添付物のSHA照合済み       |

## 公開自動化の最小実装計画

初回の実公開はローカルCLIで実行した。sealed bundleも同じReleaseに添付した。
GitHub workflowは実際の公開bundleで検証jobが成功し、publish=falseの公開jobはskipした。
以降も公開前に固定source/version/SHA/証拠を照合し、明示指定時だけ公開する。
公開時の再変換・再build・再包装、既存tag/release/assetの上書きはしない。

## 次の段階

新しい指示後に、Chrome Web Store初回申請の説明・画像・ポリシー資料を実物に照合する。
申請は公開操作なので、その許可範囲を確認してから行う。審査期間は開発側で短縮保証しない。
物理IME/native権限UI/実サービスの実用確認、独立goldと精度評価は正式MVPの未完了事項。
最適化・WebGPU・修正候補・辞書・追加サイト・新モデルは初回提供後の別作業とする。

## 現在の再開手順

`git status`、AGENTS、[status](status.md)、[公開検証記録](validation-v0.1.0.md)を読む。
作業branchは`release/public-preview`、公開先branchは`origin/main`。元のローカルmainは旧開発履歴。
公開側へ旧mainの履歴をmerge/pushしない。公開用GitHub identityを使い、force pushしない。

## 生成物を保護する

リリースソースは`f2d6afdd5bd241a5bed30b77faef226702f09cd2`。`artifacts/preview/<source>/`と公開後の取得物を保持する。
旧aea6cafのbuild、旧dist/ZIP、失敗ログ、閉じた実験を上書き・再ラベルしない。
新しい生成物は[開発手順](development.md)の明示的な出力先を使う。

## 再検証と停止の基準

今回の公開とダウンロード確認は完了。追加の変換・精度・速度・資源実験を始めない。
修正時は関連回帰と影響範囲を確認し、失敗の無視、閾値引き下げ、無変更retryで合格扱いにしない。
正式MVP/M5の未達をpreview公開で完了扱いにしない。
