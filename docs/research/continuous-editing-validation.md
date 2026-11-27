# M4: 実モデルによる連続編集の追加検証

事前登録: 2026-11-27。既存の短いE2Eに加え、同じ配布モデルを反復して使う。新しい製品機能・モデル採用・精度評価ではない。

## 固定条件

- 実行するruntimeは検証済み`0dc814cda3bfec86379928f505c6d3ed2725b5dc`のWindows ZIPと全ファイルを照合する。テストソースのcommitは別に記録し、古いruntimeの検証を新ソース全体へ付け替えない。
- モデルSHAは`dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`。Chromium、WASM、1 thread、オフライン、ローカルHTML fixture。隔離した拡張コピーのmanifestにfixture originだけ事前許可する。native permission UIの試験とは区別する。
- 最低300秒、最低24組の誤り文／正常文の編集を完了する。時間を待つだけの試験にはしない。通常回帰の既定は24組とし、長いlaneは環境変数で明示実行する。
- 誤りのハイライト、推論後の選択範囲保持、モデル状態、IMEイベント、debounce待機中のcomposition開始、表示済みeditorのDOM削除、global/site停止を検証する。検出件数をキュー長の代替にしない。
- 本文をreport・storage・ログへ保存しない。reportには件数・経過時間・状態・バージョン・hashだけを記録し、既存ファイルへ上書きしない。

## 判定と範囲

入力値・選択範囲・ハイライト・停止動作のassertionがすべて成功し、監視開始後の予期しない外部通信とpage errorが0なら、このfixture・この継続時間での反復試験成功とする。通信監視はbrowser起動後からで、全context・起動時の監査を置き換えない。物理IME、実サービス、長時間常用、すべてのUnicode/Undo経路、メモリリーク不存在、同時多数タブの成功とはしない。

失敗を保存し、原因がテスト側なら修正理由と失敗範囲を記録する。製品側の不具合なら回帰テストから修正し、新runtimeを別commitで検証する。好都合な反復だけを選ばず、結果と制約をこの文書に追記する。

## 実測結果: f2f01ff

Windows11 / Chromium159.0.8154.6、runtime `0dc814cda3bfec86379928f505c6d3ed2725b5dc`、test source `f2f01ff39f767893fb6d0dd673455ee88bdff7de`。全81 runtimeファイルとテストファイルのcommit一致を実行前に確認した。作業ツリーには別担当の診断4ファイルの未コミット変更があり、bindingにも`source_clean:false`とそのpathを保持した。テストと実行runtimeには使っておらず、checkout全体のclean検証とは主張しない。

要求300,000msに対して編集期間300,981ms、**165組の誤り文／正常文の実推論**、IMEイベント4回、DOM削除4回、global/site停止2回を完了した。推論後の値と選択範囲、正常文の推論完了、表示済みeditor削除、本文非保存を確認し、Playwrightは1件成功・終了コード0（全体約5.4分）。監視開始後の予期しない外部通信・page errorは0件だった。

サイト設定は無効となり検査・表示も停止したが、fixtureの事前host grantに対する権限削除APIは`permission-remove-failed`を返した。native optional permissionの承認・撤回成功には数えない。メモリリークや長時間常用の受け入れもこの5分から推定しない。

成果物: `artifacts/stress-real/f2f01ff/`の`report.json`、`runtime-binding.json`、`run.log`。report SHAは`b8b56c75e361cea7e2e75c62aac52393953439854cdcd3fab94668e223c7c199`。失敗や再試行はなく、実モデルの短い既定回帰とは別の明示300秒実行だった。

実行時は`PLAYWRIGHT_BROWSERS_PATH=.cache/playwright`、`SOURCE_COMMIT`と`RUNTIME_SOURCE_COMMIT`を別々に設定し、未使用の`KOTOBA_STRESS_OUTPUT`を指定する。

```powershell
$env:KOTOBA_GUARD_STRESS_DURATION_MS = "300000"
npx playwright test tests/e2e/stress.real.spec.ts --project=real --reporter=line
```

通常の`npm run test:e2e`では最低24組の回帰を行い、成果物はランダムな新規ディレクトリへ保存する。300秒の実行証拠には要求時間・実測時間・完了件数を照合する。テスト作成時は型・Lint・整形・listを先行し、実runtimeでの失敗を先に再現したTDDとは区別する。
