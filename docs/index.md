# ドキュメント案内

2026-11-28更新。開発は停止中。最新検証sourceはaea6caf、build/E2E7件成功、
通信0・証拠照合成功だが監査context終了失敗でZIP/SBOM未生成、未公開。
[最新preview検証](preview-validation.md)と[開発状況](status.md)を現在の参照先とする。

## 現在の手順と判断

| 目的           | 参照先                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 概要           | [日本語README](../README.md)、[English README](../README.en.md)                                                                                                              |
| 再開・優先順位 | [status](status.md)、[next steps](next-steps.md)、[roadmap](roadmap.md)                                                                                                      |
| 要求・完了判定 | [requirements](requirements.md)、[MVP checklist](mvp-checklist.md)                                                                                                           |
| 開発・検証     | [development](development.md)、[testing](testing.md)、[CI](ci.md)、[CONTRIBUTING](../CONTRIBUTING.md)                                                                        |
| 設計・互換性   | [architecture](architecture.md)、[browser compatibility](browser-compatibility.md)                                                                                           |
| モデル         | [conversion](model-conversion.md)、[model card](model-card.md)、[benchmarks](benchmarks.md)、[artifacts](../models/README.md)、[evaluation protocol](evaluation-protocol.md) |
| プライバシー   | [PRIVACY](../PRIVACY.md)、[SECURITY](../SECURITY.md)、[design](security-design.md)、[threat model](threat-model.md)、[security report](security-report.md)                   |
| 配布・公開     | [release](release.md)、[Store draft](store-listing.md)、[CHANGELOG](../CHANGELOG.md)、[third parties](../THIRD_PARTY_NOTICES.md)                                             |

## 研究と過去の検証

以下は各source・実験時点の記録。「次」「最新」は当時の記述で、再実行指示ではない。
閉じた試行は繰り返さず、測定日・失敗・SHAを保持する。

- [開発用精度評価の診断](research/accuracy-diagnosis.md)
- [M3: attention output projectionの混合量子化候補](research/attention-output-hybrid.md)
- [M3: disabled block5の局所捕捉](research/block5-parity-diagnostic.md)
- [ブラウザ推論・Chrome MV3 プラットフォーム調査](research/browser-platform.md)
- [M4: 最低Chrome版116の実行検証](research/chrome116-compatibility.md)
- [Chrome116のモデルなしWorker観測probe](research/chrome116-worker-visibility.md)
- [競合・参考実装調査](research/competitors.md)
- [M2: confidence閾値の全状態診断（事前登録と結果）](research/confidence-frontier.md)
- [M4: 実モデルによる連続編集の追加検証](research/continuous-editing-validation.md)
- [現runtimeのChrome116 idle互換性](research/current-runtime-chrome116.md)
- [session release runtimeの既定経路・Chrome116互換性](research/default-runtime-chrome116.md)
- [OS別native依存と配布ライセンスの決定性](research/deterministic-license-packaging.md)
- [M3: 後段の数値差を限定診断する](research/downstream-parity-diagnostic.md)
- [Embedding UINT8 / MatMul FP16 storage candidate](research/fp16-storage-candidate.md)
- [Worker終了前のセッション解放](research/graceful-worker-release.md)
- [M4/R05: idle Workerの解放と再初期化](research/idle-worker-resources.md)
- [独立実用評価データの実現可能性](research/independent-evaluation-data.md)
- [現runtimeの全context通信監査](research/instance-full-context-audit.md)
- [Instance identity runtimeのLinux回帰](research/instance-identity-linux-validation.md)
- [JWTD v2 preparation](research/jwtd-dataset.md)
- [実モデルWorkerの世代別heap観測](research/model-worker-heap-observation.md)
- [精度改善の次の実験計画](research/next-experiments.md)
- [背景側で照合するOffscreen文書identity](research/offscreen-brokered-identity.md)
- [Offscreen通知のdocumentId結合の訂正](research/offscreen-declared-document-id.md)
- [Idle時のOffscreen Document終了・再生成](research/offscreen-idle-recreation.md)
- [Offscreen instance識別子の照合](research/offscreen-instance-identity.md)
- [QUInt8 CPU and WASM parity investigation](research/onnx-wasm-parity.md)
- [親session経由のWorkerメモリ校正](research/parent-worker-heap-calibration.md)
- [関連target監視を外した資源診断](research/related-attachment-memory.md)
- [session解放とWorker保持を分ける対照試験](research/retained-session-trial.md)
- [親session観測によるChrome116実モデルidle検証](research/scoped-idle-chrome116.md)
- [同じ親session観測によるChromium159の資源比較](research/scoped-idle-chromium159.md)
- [親sessionに束縛したWorker観測](research/scoped-worker-observation.md)
- [M1: 曖昧diffの採点感度](research/scoring-sensitivity.md)
- [session release runtimeの既定経路・全context監査](research/session-runtime-full-audit.md)
- [共有Workerの並行要求を直列化する](research/shared-worker-concurrency.md)
- [M3: 固定activation量子化の限定候補](research/static-activation-candidate.md)
- [Upstream model investigation](research/upstream-model.md)
- [Workerメモリ観測の校正](research/worker-heap-calibration.md)

## 保存済みsnapshotと測定範囲

- [M1〜M5追加開発の検証と開発用snapshot](validation-0dc814c.md)
- [開発用snapshotの検証記録](validation-67217cc.md)
- [M1〜M4追加開発のWindows検証](validation-7db6271.md)
- [Linux validation](linux-validation.md)
- [Python coverage gate](python-coverage.md)
- [Browser corpus parity fixture](browser-corpus-parity.md)

## ADR

- [ADR-0001: npmとuv、Viteを直接利用する](adr/0001-tooling.md)
- [ADR-0002: CPUによるONNX変換](adr/0002-model-export.md)
- [ADR-0003: WASM向けQUInt8候補](adr/0003-quantization.md)
- [ADR-0004: Offscreenと専用Worker](adr/0004-extension-runtime.md)
- [ADR-0005: サイト単位の許可](adr/0005-site-permissions.md)
- [ADR-0006: 実行資産の同梱](adr/0006-distribution.md)
- [ADR-0007: 外部通信を必要としない実行](adr/0007-local-network-policy.md)
- [ADR-0008: 30Mモデルの公開受け入れを保留する](adr/0008-model-acceptance.md)
- [ADR-0009: Idle時にoffscreen文書も終了する](adr/0009-idle-offscreen-lifecycle.md)
- [ADR-0010: Offscreen identityを文書ごとの識別子へ結合する](adr/0010-offscreen-instance-identity.md)
- [ADR-0011: session解放後のWorker短期保持を候補として分離する](adr/0011-retained-worker-candidate.md)

## リポジトリSkills

- [browser-inference](../.agents/skills/browser-inference/SKILL.md)
- [chrome-extension](../.agents/skills/chrome-extension/SKILL.md)
- [model-conversion](../.agents/skills/model-conversion/SKILL.md)
- [project-development](../.agents/skills/project-development/SKILL.md)
- [release-management](../.agents/skills/release-management/SKILL.md)
- [security-review](../.agents/skills/security-review/SKILL.md)
- [test-driven-development](../.agents/skills/test-driven-development/SKILL.md)

## 文書と証拠の扱い

docs/research、ADR、過去snapshotは各記録の時点を保持する。外部資料の調査日を
2026-11-28へ更新したり、後続docs commitに旧テストを付け替えたりしない。
ignoredのartifacts/models/dist/coverageはfresh checkoutにはなく、公開用に一括添付しない。
更新前の時系列案内は`git show c14a591:docs/index.md`で参照できる。
