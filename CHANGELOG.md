# Changelog

## 2026-11-28 documentation maintenance

最新previewのsource/モデル/検証範囲へ日英README、状態・計画・受け入れ、モデル/配布/セキュリティ資料とSkillsを同期。
過去の測定・失敗・sourceを保持し、実装・モデル実験・build・公開は再開していない。

### 2026-11-27 preview implementation and pause

- `2914a68`: FP16重み保存候補。48,188,514 bytes、固定64例CPU/WASM一致、p50=150.1msで性能目標未達・試行終了。
- `6de3a00`: 最適化延期方針に従い隔離preview同梱/buildとSHA固定のE2Eを実装。初回E2E5成功/2終了失敗。
- `aea6caf`: fixtureページをcontextより先に閉じるhelper修正。関連13テストと全7E2E成功。
- 最新監査は通信0・coverage/照合成功だが独立context終了失敗でexit1。新ZIP/SBOMなし。
- `c14a591`: ユーザー指示で開発停止。[最新previewの根拠](docs/preview-validation.md)。

以下は各source時点の変更履歴。古い「最新」「次」は現在の再開指示ではない。

Chromium159の親session実モデル比較をclean4f8c74dで完了。4推論/2idle/3世代/cleanupと全資産照合が成功し、32証拠を追加した。最終Working Set合計約2.06GB、PID交代により固定cohort比はunknown、memory受け入れ/M5完成は未達。別操作APIの接続不可も記録し、native試験へ付け替えない。

## 0.1.0 (unreleased)

2026-11-27追加: clean daab981のChrome116実モデルidle検証が成功。親session観測で4推論・2idle・3世代、通知重複拒否、本文非保存、6 OS sampleと全cleanupを確認した。全TS466/check、製品全78資産不変。今回のresume working setは約859→862MBだったが、他環境との違いの原因や長期資源は未解決。[条件と証拠](docs/research/scoped-idle-chrome116.md)を参照。M5は未達。

2026-11-27追加: 親non-flat sessionに束縛したWorker台帳/observerをTDDで追加。clean c1200feのChrome116モデルなし1試行でWorker/Offscreenの0→1→0、全cleanupと資産不変を確認した。全TS463/check成功。unknownと0を分離し、ACK/postflight前の公開、遅延attach cleanup、世代・foreign・矛盾eventを回帰検証する。[結果と範囲](docs/research/scoped-worker-observation.md)を参照。製品の実モデルidle/M5は未達。

2026-11-27追加: モデルなしChrome116観測probeとprivacy分類/timeout/親選択の回帰を追加。初回のpage/tab二重選択失敗を保存し、訂正版905c773はping/pong・context1→0・cleanupに成功した。Workerはroot一覧に現れずeventで確認でき、eventを使う観測方法が次の候補となった。全TS421/check成功、製品互換性/M5は未達。[条件と証拠](docs/research/chrome116-worker-visibility.md)を参照。

2026-11-27追加: browser試験のtest/runtime sourceを分離し、不正なcommit指定を拒否する。現runtimeのChrome116試行7554a69は2タブの検出後にWorker観測で失敗し、idle0回の記録を保持した。将来の失敗にもversion・進捗・本文/URLを含まない件数診断を残す。全TS413/checkと独立レビュー成功、追加browser試行は未実施。[結果・未検証範囲](docs/research/current-runtime-chrome116.md)を参照。M5は未達。

2026-11-27追加: 通信監査をoffline-first page読込・新規output予約・実Git/source/全配布資産の前後照合・cleanup後のreceipt保存へ強化した。全TS406/check/coverageとclean6c1a810のWindows/Chrome159実監査1回が成功。固定0ba3630の78資産でoffline6チェック、監視対象の通信/gap0を確認。[範囲と証拠](docs/research/instance-full-context-audit.md)を参照。長期資源・M5は未達。

2026-11-27追加: 非収録のnative image依存のlicenseメタデータをlockfile由来にし、OS別install差を解消した。推論なしのLinux quality-only laneもTDDで追加。clean0ba3630の通常6ゲート・Python399/TS380成功、Windows/Linux全78配布ファイル一致。[証拠と制約](docs/research/deterministic-license-packaging.md)を参照。M5は未達。

2026-11-27追加: Linux collectorで実配布bytesを保持し、symlink/衝突を回帰テストした。clean949fe5eの全7ゲート・Python391/TS380・実モデル7件成功。OS別license/監査JSON差と資源未達を保持する。[実行結果](docs/research/instance-identity-linux-validation.md)を参照。

2026-11-27追加: Offscreen文書のimmutable instance markerを背景のdocumentId照合へ結合し、旧文書のidentify/idle要求を拒否する。clean `0e13b12`の単体380件、品質/build/coverage、WindowsモデルなしA・実モデルB・通常回帰10件が成功。[記録](docs/research/offscreen-instance-identity.md)を参照。資源問題とM5未達は維持し、旧ZIPは変更しない。

2026-11-27追加開発: `0dc814c`で両OS全10ゲート、Python297件、TS234件、Windows E2E9件/Linux実モデル5件、26-file Python overall81.30%、全context監査とZIP再包装一致を確認。IME・最新入力集約・停止/無効化・SDK解放境界を修正し、採点感度・限定量子化診断を追加した。精度と最終数値差は未解決で、正式公開・MVP受け入れは保留。[検証記録](docs/validation-0dc814c.md)を参照。

2026-11-26時点のローカル開発版。MVPの受け入れは未完了で、正式公開・Store申請は行っていません。

- uv/Python 3.12、Node24、TDD基盤、統合ハーネス、7 Skills、5本のCI定義を追加。
- 固定revisionのPyTorch参照、FP32/QUInt8/FP16変換と合成40文の評価を実装。
- 独立SDKにTokenizer、UTF-16位置、重複チャンク、閾値、キャンセル、解放を実装。
- MV3の共有Offscreen/Worker、WASM、400ms IME debounce、一般editor、ハイライト、日本語popup、手動検査、サイトopt-inを追加。
- 機密欄除外、メッセージ・権限・世代・有界queue検証、オフライン実モデル試験を追加。
- 配布モデルのprivate-path metadata除去、全資産SHA、LICENSE/SBOM、HTML参照検査、決定的ZIPを追加。
- popup CSS欠落、textarea内部scroll、Tokenizer ByteFallback、権限撤回例外等を回帰テスト付きで修正。
- Windows統合10ゲートと隔離Linux通常6ゲートに成功。GitHub Actionsは未実行。
- 日英README、再現手順、測定値、既知の制約、文書索引を実装と照合して更新。

数値・証拠の対象コミットと未完了項目は [status](docs/status.md)、[MVP受け入れ](docs/mvp-checklist.md)、[benchmarks](docs/benchmarks.md) を参照してください。
