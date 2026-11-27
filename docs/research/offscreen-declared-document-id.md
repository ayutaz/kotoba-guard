# Offscreen通知のdocumentId結合の訂正

本登録は終了: f2f2ceaのモデルなしsmokeはoffscreen内getContexts案で失敗し、予定した実モデル試行は未実行で取り消した。[背景側identity照合の別登録](offscreen-brokered-identity.md)へ訂正し、72236f2でモデルなし/実モデル機能試験と通常回帰10件が成功した。以下は旧条件の履歴。

2026-11-27事前登録。起点clean `da07389`。[初回の失敗](offscreen-idle-recreation.md)と予算を分離する。

## 確認した原因

登録済みモデルなしfixtureをclean `da0738960f901a745c13560ab86e729463148770`で1回実行した。Chromium159.0.8154.6、通知1件、推論0件、2,032ms/cleanup成功。製品background.jsは初回モデル試験のbytesと一致（SHA `240bb2d42b760b0d85bd976af8ccf4f06ae48b0e54bfeb09427e0a8a1844b9d3`）。背景とpopupが見たsenderは拡張ID/URL一致・tabなしだが、**documentId/frameIdはともに未提供**だった。一方getContextsは有効なdocumentIdを返した。応答はnull、文書は残った。sender.documentId必須という実装の仮定が現Chromeに合わず、通知検査で拒否することを再現した。全Chromeで同じとは断定しない。

証拠directory `artifacts/offscreen-notice-metadata/da0738960f901a745c13560ab86e729463148770/`。report SHA `73268029b68305ed7a458346cc92934947cabdb648a0c963319599f89b4c299b`、script/12 fixture資産/logを含む15証拠receipt SHA `29b276f58518b6ad14d211d9eb0ad5928aa27d83f23f70fd4786893fd819aa57`。先行46証拠不変も確認した。このmodel-free予算も終了。初回実モデルを成功へ読み替えず、IDの具体値は公開文書へ転記しない。

## 訂正と受け入れ

実モデルの前に、新しい宣言ID protocolのモデルなしsmokeを**1回/通知1件/推論0/60秒/retry0**で行う。先行の失敗metadata fixtureとは別source/output/scriptとし、offscreen自身がgetContextsで取得したIDを送ること、backgroundが現在文書と照合して文書0となることを確認する。文書破棄により送信元への応答が失われても成功と断定せず、受信metadataと実context消失を根拠にする。成功しない場合は実モデルへ進まない。このsmoke予算も成功/失敗で終了する。

Offscreenがruntime.getContextsから自文書のIDを取得し、固定数値の通知へ`documentId`を加える。retiringはこの非同期取得より前に立てる。背景は引き続き拡張ID/完全一致offscreen URL/tabなし/schemaを要求し、通知の宣言IDを現在getContextsのIDと照合する。sender.documentIdがある環境では宣言IDとの一致も要求する。未提供を許容してもURL/権限/現ID/古い通知の検査を省かない。IDが取得できなければ通知せずfail-closed。本文・永続ストレージ・権限・モデルは追加しない。

TDDで実測と同じsender.documentId未提供の通知を受理するRedを確認し、宣言ID不一致/古いID/偽装sender/余分なkey/欠落IDと、ID取得中の推論拒否を検証する。popup診断は宣言IDと未提供を含むsender metadataを区別して保存し、現在文書と結合する。失敗時も観測済みのnotice/control値と通信/pageerrorカウンターを途中reportへ残す。

全TS/check、独立security/診断レビューと新clean sourceを固定後、**訂正protocolの実モデル1試行**だけを実行する。条件は先行登録のWindows/Chromium159、offline/WASM1thread、4推論/2idle/3文書、240秒/新規body受付190秒、idle各85秒、command/cleanup各5秒・OS15秒、6sampleと同じ。変更点は実測に基づくID取得/結合だけで、モデル/文章/閾値/周期を増やさない。成功/失敗で新予算も終了する。

Source/tree/clean、全81資産、同一model SHA、先行46+15証拠・旧ZIPを外側で前後照合する。PID/role pair不一致はratio unknown、機能成功だけでメモリ・M5合格としない。新report/outputはsource別で上書き禁止。失敗したら後続推論へ進まず保存し、無変更再試行しない。新runtimeのLinux/最低版/全監査・coverage/新ZIPとM2/M3/native/実サービス/remoteは別ゲートとして維持する。

## 実装前後

背景entryの新payload/欠落sender ID回帰Red4、null表現の追加Red1、closed:false後の自文書変更Red1を保存して修正した。identity取得前のbusy、欠落/曖昧/reject/hang時の無通知を確認し、関連73件、最終offscreen entry17件が成功。型を持つsender IDが非nullで異なる場合は引き続き拒否する。背景のcurrent IDと宣言IDの照合は維持し、closed:falseでもoffscreenが自文書IDを再確認して一致する場合だけ再開する。各identity/通知応答/再確認は5秒。diag contract4件はGreen確認であり、担当分の実行前RedログはないためRed実施と主張しない。

全TS351/check成功。diagnosticの制御読取失敗を古い成功noticeで置き換えず、直近の成功noticeは失敗reportの証拠にだけ保持する。監視開始前の通信/pageerror数はnull、開始後の値だけ数値にする。ここまで訂正protocolのbrowser/modelは未実行。
