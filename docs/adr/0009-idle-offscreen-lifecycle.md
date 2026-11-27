# ADR-0009: Idle時にoffscreen文書も終了する

2026-11-27。状態: 背景側identity照合へ訂正し、clean72236f2のWindows実モデルで機能検証済み。資源/公開受け入れは未達。[結果](../research/offscreen-brokered-identity.md)を参照。

## Identity照合の訂正

実Chromeではoffscreen送信元のdocumentIdが欠落し、offscreen側のruntime.getContextsも利用できなかった。2つの失敗条件は保持して終了した。[訂正protocolと予算](../research/offscreen-brokered-identity.md)に従い、offscreenはruntime.sendMessageで背景へidentity照会する。背景は完全一致の拡張ID/文書URL/tabなしを認証し、getContextsで単一文書を確認する。返却IDをidle通知へ宣言し、close直前にも現在文書と照合する。identity queryも5秒上限・未完了の実API1件だけとする。単体テストからoffscreenのgetContexts mockを除き、実環境にないmethodに依存する実装を失敗させる。

## 問題

モデルsession dispose/Worker terminateを実施しても、3世代の現Worker容量/JS usedに現れないprocess working set増加が観測された。旧文書やnative領域の保持は未同定。[観測の範囲](../research/model-worker-heap-observation.md)を原因の証明としない。

## 決定

既存のoffscreen内60秒idle timerと1秒dispose ACK上限を維持し、Worker終了後、pending0なら文書をretiringにして背景へ固定数値のidle通知を送る。背景は現在documentIdと送信元を照合し、使用中の推論がなければoffscreen.closeDocumentする。create/close遷移は共有し、検出は終了後の文書再発見/再作成を待つ。各遷移の呼出元応答は5秒で失敗できるが、取消不能の実APIが未完了なら単一leaseを残す。

常駐Workerでsessionだけを解放する案はruntimeを残し、現行のsession解放との差が限定的なため今回は採らない。private ORT allocator APIや強制GCは依存せず、本文保存、SWの常時keepalive、追加権限は導入しない。Chrome API根拠・予算・停止は[事前登録](../research/offscreen-idle-recreation.md)に固定した。

## 再起動と不明状態

idle通知より前に文書側のretiringを立て、検出はbusyを返してWorkerへ転送しない。背景がSW再起動でleaseを失っても、getContexts/statusでretiring文書を発見し、消えるまで5秒以内の待機に留める。二重close/createをせず、消失後だけ再生成する。close未開始を意味する明示的なclosed:false応答だけがretiringを解除する。拒否/timeout/送信失敗・応答消失は成功とも未開始とも断定しない。

強制SW停止等で終了結果が失われ、旧文書が残る場合は推論をfail-closedする。ブラウザ/拡張の再起動で回復する必要があり、自動回復を保証しない。未知のcloseと競合して新しい文書を作るより安全な制約として残す。設定や本文を永続化しない。

idle後の次の入力には文書/モデルのcold startが必要。statusは初期化せず、閉鎖前の遅いready応答を世代で破棄する。旧宣言IDを持つ遅延idle通知はcurrent ID不一致で拒否する。ただしsender.documentId欠落時のidentity照会はisolate固有の証明ではなく、旧isolateが文書交代後にも実行できる仮想raceへのnonce防御は未実装。この制約は上記の訂正protocolに記録する。文書終了はOSメモリ解放の保証ではない。単体・統合・実モデル機能・process計測を分離し、実測後に採否を記録する。旧ZIPと別OS/最低版/全監査の成功を今回へ付け替えない。
