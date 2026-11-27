# 検証方針

現在はGitHub v0.1.0プレビュー公開済み。[v0.1.0公開記録](validation-v0.1.0.md)を参照。以下の測定・停止記録は各記載日時点の範囲を示す。

文書確認: 2026-11-28。初回previewの作業は完了。今回の文書更新ではモデル・ブラウザ・unit suiteを再実行しない。
最新の実測は[preview検証記録](preview-validation.md)のsourceとSHAを参照する。

## 最新previewの保存済み結果

| 対象            | 結果・範囲                                                                         |
| --------------- | ---------------------------------------------------------------------------------- |
| source          | `aea6caf1c1e8afaf29b524c9ac9fafde6d9b2f17`                                         |
| build           | Windows、78資産成功。旧distを変更しない隔離build                                   |
| E2E             | mock4＋実モデル3、全7件成功、skip/retry/flaky0                                     |
| mock            | IME、機密欄/停止、スクロールと選択、contenteditable/XSS                            |
| real            | 自動検査/一般editor/IME/機密欄/非保存、並行2要求/3件目busy/dispose、手動検査/popup |
| offline         | 実モデルE2Eと監査で初回からオフライン。監査は6回実推論                             |
| 通信監査        | unexpected0、対象coverage/証拠照合成功。ただしcontext cleanup失敗でexit1           |
| TS              | 全609件は準備source6de3a00まで。aea6cafは変更helper13件成功                        |
| Python          | 関連19件成功。preview同梱・FP16保存・旧weight-only回帰                             |
| coverage/他環境 | 最新previewで全coverage/Linux/最低Chrome/remote CIは再検証していない               |

初回6de3a00はE2E5成功/2失敗。機能assertion後のcontext.closeが5秒を超えた。
aea6cafでページを先に閉じるhelperへ修正し、5秒制限を維持して7件成功した。
監査には別の終了経路があり、その失敗をE2E成功で置き換えない。両試行の原本を保存する。

## テストの選択と再開境界

主要変更はRed → Green → Refactor。期待を弱めず、原因に対応する回帰を先に追加する。
mockはスケジュールと表示、実モデルはTokenizer/ORT、実ブラウザはMV3/Worker/offlineの証拠。
fixture事前許可はnative許可UI、合成compositionは物理IME、WASMはWebGPUの受け入れではない。
各ソースのcoverage目標はSDK90%、Python80%、全体80%。旧割合を新sourceへ転用しない。

既定`npm run test:e2e`は全mock/real projectと追加診断を含む。最新previewの7件と同じ選択ではない。
previewは専用configと新規出力を使い、manual/automatic/concurrencyの実モデルlaneを選択した。
`KOTOBA_GUARD_EXTENSION_DIR`と`KOTOBA_GUARD_EXPECTED_MODEL_SHA256`で資産を指定し、
automatic/concurrencyの専用出力・モデルSHA、`SOURCE_COMMIT`/`RUNTIME_SOURCE_COMMIT`も結ぶ。
具体的な選択config・env・stage logは保存済みpreviewの証拠に含まれる。
再開時は[development](development.md)、[next steps](next-steps.md)に従い、既存レポートを上書きしない。
文書保守ではリンク・format・source対応と保護資産のhashだけを確認する。

## 履歴と未完了項目

[0dc814c snapshot](validation-0dc814c.md)は両OS全10ゲート、Python297/TS234、Windows9/Linux実モデル5件、
Python line81.30%・SDK statements92.42%、監査・ZIP一致の過去結果。
[67217cc](validation-67217cc.md)、[Linux](linux-validation.md)、[Python coverage](python-coverage.md)、
各[研究記録](index.md#研究と過去の検証)も対象sourceの範囲を保持する。
最新previewの一般精度、独立gold、物理IME/native権限、実サービス、長期資源とremote CIは未完了。
全項目の判定は[MVP checklist](mvp-checklist.md)。旧検証方針の詳細は`git show c14a591:docs/testing.md`で参照できる。
