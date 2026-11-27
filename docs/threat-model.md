# 脅威モデル

保護対象は入力本文、許可サイト情報、ユーザーの編集状態、実行モデルの同一性。信頼境界はWebページ、isolated content script、service worker、offscreen/worker、モデル配布、ビルド依存。

| 脅威                           | 対策                                                                             | 検証                                                          |
| ------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 機密入力の誤取得               | 取得前の機密属性除外、自動検査はsite opt-in、手動検査は明示操作のactiveTab grant | 属性と祖先・動的変更fixture                                   |
| 悪意あるページの大量リクエスト | 直接のpage messageを受けず、schema/sender/長さ/queue制限                         | 不正メッセージ・連続入力                                      |
| 入力由来XSS                    | HTML文字列挿入なし、textContent                                                  | 攻撃文字列fixture                                             |
| 入力漏洩・保存                 | 外部コードなし、local assets、設定だけstorage                                    | オフライン・通信監視・storage検査                             |
| モデル改ざん・依存侵害         | revision/lockfile/SHA、SBOM、audit                                               | package verification                                          |
| IME/選択/Undo破壊              | 編集DOMを書き換えず、composition中停止                                           | composition・選択範囲を確認。物理IMEと完全なUndo/Redoは未検証 |
| 誤検出・見逃し                 | 可能性として表示、信頼度・制約を明示                                             | 正常文と誤り文を分けて評価                                    |

ブラウザ/OS自体の侵害、同じページ内の他の拡張、属性が不適切な機密欄の完全識別、モデルの意味的正しさは保証範囲外。未実施のテストは実施済みと記載しない。

Offscreen文書の交代後に旧要求が届く脅威には、immutable instance markerとcurrent documentIdの再照合、単一close lease、期限後も実APIの完了まで保持する照会制限を適用する。[Windows A/B](research/offscreen-instance-identity.md)で旧marker拒否と実モデル再生成を確認済み。null sender IDだけを同一isolateの証明にせず、拡張内部の信頼とChromeの単一文書制約を前提とする。
