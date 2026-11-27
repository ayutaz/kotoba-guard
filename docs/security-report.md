# ローカルセキュリティ検証記録

2026-11-28、公開source `f2d6afdd5bd241a5bed30b77faef226702f09cd2`の最終展開ZIPの監査がexit0/gate=true。
通信0・coverage・offline6回・資産照合・cleanup8項目成功。公開後の全添付物SHAも一致。
[v0.1.0公開記録](validation-v0.1.0.md)を現在の参照先とする。

以下は修正過程の記録。監査source `e627333`で保存済みpreviewを再監査し、exit0/gate=trueとなった。
予期しない通信0、対象coverage/source/資産照合、offline6回、終了処理8項目とOSメモリ計測が成功した。
最終公開ソースと展開ZIPの結果は冒頭の公開記録を参照。[現在の検証記録](preview-validation.md)を参照。

以下は修正前の失敗記録で、対象sourceと結果を維持する。

## 修正前のpreview監査

対象source: `aea6caf1c1e8afaf29b524c9ac9fafde6d9b2f17`、Windows11 / Chromium159 / WASM1thread。
モデル・source archive・レポートのSHAは[preview検証](preview-validation.md)に記録する。

| 項目           | 保存済み結果                                                                     |
| -------------- | -------------------------------------------------------------------------------- |
| 予期しない通信 | 0。HTTP/WebSocket陽性対照と対象拡張contextのcoverageComplete=true                |
| オフライン     | 初回より前に設定、6回の実モデル推論、既存markも6回クリア                         |
| 証拠照合       | source/配布資産の前後照合成功。旧distも不変                                      |
| 実行           | completed、gate=false、exit1                                                     |
| 失敗           | `cleanup-incomplete`。securityFailures=[]、resourceFailures=[cleanup-incomplete] |
| cleanup        | context=false。他のpopup/browserCdp/cdp/browser/fixture/profileはtrue            |
| 警告           | 重複CDP sessionのdetach警告4件を保持                                             |
| 次stage        | ZIP/SHAファイル/SBOMは未生成。公開なし                                           |

browser UIと監視開始前bootstrapは対象外。対象scopeの網羅性は全Web環境・全経路の安全保証ではない。
context終了失敗があるため、残存processなし・資源受け入れ完了とも断定しない。
E2E helperの終了順序修正は7件成功したが、独立した監査scriptの問題は未修正。
再開後の最小作業は監査終了経路の修正・確認と配布検査。現在は実行しない。

## その他の証拠と境界

previewのmock/real fixtureは機密欄除外、非保存、XSS/編集DOM、IME、停止と一般editorを扱う。
実装・unit回帰はsender/schema/origin/長さ、古い結果、bounded queue、許可状態を検証している。
物理IME・native権限UI・実サービス・未知の機密属性は受け入れ済みとしない。
CSP、hash自己整合性、OSSの各事実だけで安全性全体を保証しない。

過去の[d306948監査](research/session-runtime-full-audit.md)、[6c1a810監査](research/instance-full-context-audit.md)、
[0dc814c snapshot](validation-0dc814c.md)、[67217cc snapshot](validation-67217cc.md)は各source/資産の合格記録。
旧sourceの既知脆弱性0、SBOM、包装一致を最新previewの再監査結果へ転用しない。
private path除去、完全な同梱LICENSE、Sharp非収録をsource mapで確認する設計は継続する。
rawレポート・モデル変換元・traceを一括公開しない。

設計は[security-design](security-design.md)、[threat-model](threat-model.md)、[PRIVACY](../PRIVACY.md)、
[SECURITY](../SECURITY.md)。過去の失敗と詳細は研究記録および`git show c14a591:docs/security-report.md`に残す。
