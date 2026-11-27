# ADR-0010: Offscreen identityを文書ごとの識別子へ結合する

2026-11-27。状態: `0e13b12`でTDD・Windows A/B機能検証・通常回帰成功。`949fe5e`の[Linux全7ゲート](../research/instance-identity-linux-validation.md)も成功した。全配布再現性/最低Chrome/全監査・資源・M5受け入れは未完了。

## 問題

[72236f2の検証](../research/offscreen-brokered-identity.md)では、sender.documentIdがない場合に背景が返すIDは現在の単一文書のIDであり、要求したisolate固有の照合がなかった。古い文書が交代後にも照会できる仮想raceを防いだとは言えなかった。

## 決定

Offscreenのmodule初期化時にcrypto.randomUUIDでUUID v4のinstanceIdを1回生成する。値は文書の寿命中に変えず、retiring中も保持する。弱い乱数や時刻によるfallbackを設けず、API欠落時は初期化失敗とする。本文、ログ、永続storageには出さない。

背景だけが呼べる一キーのoffscreen-instance probeに、OffscreenはinstanceIdだけを返す。この照会はWorkerを生成せず、idle期限を延長せず、retiring中も応答する。detect/statusと同様に送信元をService Workerの拡張ID・tabなし・URLなしまたは完全一致background.jsへ制限する。

Offscreenからのidentify要求はtype/instanceIdの二キー、idle通知はtype/documentId/instanceId/releasesの四キーに限定する。送信元は完全一致offscreen URL・拡張ID・tabなし、識別子はUUID v4の形式を検証する。release値は既存の安全な整数検証を維持する。

背景のidentity照会はgetContexts(before)→instance probe→getContexts(after)。前後で単一の同じ非空documentIdが存在し、probeの識別子が有効な場合だけ、docID/instanceIdの組を得る。実照会は1件を共有するが、要求した識別子との比較はcallerごとに行う。古いcallerへの拒否を、正しいcallerへ誤って共有しない。

三段階全体で5秒のdeadlineを共有する。取消不能の実APIが未完了ならその実照会を保持し、timeout後に呼出しを重複させない。遅れて応答しても、期限後に次段階のAPIを開始しない。late resolve/reject後には新しい照会で回復する。

closeは[既存lease](0009-idle-offscreen-lifecycle.md)内で現在docID/識別子・処理中/待機中の検出を確認し、closeDocument完了までcreate/別closeを直列化する。不明な終了結果を成功やclose未開始とみなさず、retiringを保持する。SW再起動後も永続nonceに依存せず、現在文書をprobeで再発見できる。

## 範囲と代替案

URL token案はgetContexts URL filter・sender URL・既存target監視の変更を伴うため、固定URLと現在文書へのprobeを選ぶ。[Chrome公式offscreen仕様](https://developer.chrome.com/docs/extensions/reference/api/offscreen)のprofileあたり単一文書を前提とする。incognito split profileの横断動作は保証しない。

これは信頼された拡張コード内での世代照合であり、同じ拡張に混入した悪性コードやChrome内部のTOCTOUを暗号学的に証明するものではない。nonceを追加しただけで全セキュリティ受け入れを完了したとはしない。新規権限・外部通信・本文保存・モデル変更はない。メモリ問題の改善も主張しない。

ブラウザ条件・停止・証拠は[新しい登録](../research/offscreen-instance-identity.md)に分離する。72236f2の閉じた予算、旧ZIP、旧sourceの他OS/監査結果を付け替えない。
