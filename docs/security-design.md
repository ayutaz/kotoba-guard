# セキュリティ設計

入力はページ → isolated content script → extension runtime →専用Workerという境界内で処理する。ネットワーク宛の入力送信、input storage、ユーザー文章のログ、外部コードを禁止する。機密欄の属性を検査してから文章を取得する。許可解除・無効化時は監視と表示を停止し、処理中の古い結果も破棄する。

権限はactiveTab/scripting/storage/offscreenを使用する。自動検査はサイトopt-in、手動検査は明示操作に伴うactiveTabの一時許可で行い、両経路とも入力取得前に機密欄を除外する。通常配布Workerの推論はWASM固定。optional host permissionはユーザーのサイト許可のために宣言する。default host accessと静的全サイトcontent scriptは使用しない。CSPはselfとWASM実行だけを許可し、web accessible resourcesは不要とする。

メッセージはtype・長さ・request ID・sender・tab/originを検証する。ページからのwindow.postMessageを推論入口にしない。Content Script経由でも入力サイズ・同時数を制限する。表示にはtextContent/安全なDOM APIを使い、入力由来HTMLを実行しない。

モデルSHA-256と配布inventoryを検証し、欠損・改ざん・想定外の権限を配布ゲートで拒否する。CSPだけではcontent scriptやライブラリの全通信を証明できない。実ブラウザの通信監視、コードレビュー、依存auditを合わせて検証する。実施結果はstatusへ記録する。

Offscreenの世代照合は[ADR-0010](adr/0010-offscreen-instance-identity.md)に従う。文書寿命中に固定したUUIDと背景のbefore/probe/after documentIdを照合し、idle close lease内で再確認する。古いmarker・不正schema・未知の終了結果はfail-closed。markerは本文と結合せず永続化・ログ出力しない。信頼された拡張コード内の照合であり、Chrome内部raceや同じ拡張の侵害を暗号学的に証明するものではない。
