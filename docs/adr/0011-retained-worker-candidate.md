# ADR-0011: session解放後のWorker短期保持を候補として分離する

2026-11-27。状態: 実験候補、製品既定値への採用は未決定。

## 根拠

[直近のChromium159試行](../research/scoped-idle-chromium159.md)は全終了処理と4推論に成功したが、最後の関連process Working Set合計は2,055,770,112 bytesだった。rendererのPID交代があるので固定cohortの増加率はunknown。原因や長期上限は未解決であり、同条件を反復しない。

現行Workerのdisposeは`retiring=true`を不可逆にし、SDKのdispose完了後にWorkerと文書を終了する。一方、同梱ORTの`lib/wasm/wasm-factory.ts`はmodule scopeに初期化済みWASMを保持し、初期化済みなら再初期化しない。新しいWorkerを毎回作ることと、同じWorker内で新しいdetector/sessionを作ることは、異なる資源寿命である。再利用でprocess memoryが改善するという点は未検証の仮説。

[ORTのrelease API](https://onnxruntime.ai/docs/api/js/interfaces/InferenceSession.html)はsession資源の解放を定義しているが、OS resident memoryの即時回収を保証するものとは扱わない。[ChromeのOffscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen)ではWORKERS reasonに固定の存続期限は設けられていない。今回もService Workerの常時keepalive、新権限、private allocator API、強制GCは追加しない。

## 候補の契約

既定の保持時間0は[ADR-0009](0009-idle-offscreen-lifecycle.md)の完全終了経路を維持する。実験用の明示的なfactory呼び出しだけが保持時間を指定でき、URL、storage、Webページmessage、ユーザー入力から設定できない。上限は60,000ms、有限・非負整数に限る。

保持モードは最後のpending完了から既存の60秒後に、session-only releaseを開始する。`ready=false`にし、`{type:"release-session",releaseId}`の応答を最大1秒待つ。ACKは正確なschema、Worker identity、safe integerのreleaseIdを照合する。releaseIdはWorker内で単調増加し、古い/重複/遅延ACKで新しいsessionを解放しない。

成功時はdetector/sessionを破棄し、WorkerとORT moduleだけを最大60秒保持する。次の要求は同じWorkerで新しいdetector/sessionを作る。session release中の要求は既存offscreen上限2件へ数え、timeoutを止めず、3件目はbusyにする。文書のretiring状態はまだ立てない。成功ACKで文書を閉じず、保持期限が切れた場合だけWorkerを終了して既存のonIdle/identity/close leaseを使う。status参照は期限を延長しない。

Worker側は初期化/進行中のSDK runとdispose完了を待ってACKする。release中は新しいdetectorを作らず、直接届いたdetectにはbounded busyを返す。release失敗は再利用不能にする。release中の永久disposeは待機中の解放を共有し、成功後もWorkerを復帰させない。

ACK失敗・送信失敗・timeoutは旧Workerを終了してから待機要求を新Workerへ送る。要求timeoutに伴うrestartも先に旧releaseをキャンセルし、重複Workerを作らない。本文・結果・private instance markerのログ/永続化は追加しない。session解放はメモリのzeroization保証ではない。

## 検証と採否

単体Red→Green、既存完全終了テスト、Worker/Offscreen統合、Lint/型/coverage、独立レビューを通す。別のsource-bound実モデル試行で同一Workerの新session、offline検出、期限付き最終終了、資源値を測る。旧sourceの試験・ZIP・791証拠へ変更を加えず、候補資産を別ディレクトリへ作る。

実装済みのプロトコルや単体成功だけでは採用しない。candidateと既存方式の条件・停止を別途登録し、実測と影響するOS/最低Chrome/全通信監査を揃える。精度/独立gold、CPU/WASM parity/性能、native/実サービス/remoteとM5の残条件は維持する。

## 限定試験後の判断

clean `afbdd24`の[対照/保持試験](../research/retained-session-trial.md)は各4回のoffline実推論とcleanupに成功した。保持版は同じWorker/documentでsessionを作り直し、最終期限で両方を終了した。同じ10 PID/role集合のresume1/2比は1.012150310だったが、対照版はPID交代で比がunknown、反復もない。資源改善の因果・長期上限・採用を証明しない。既定値0、adoption=false、memoryGrowthAcceptance/fullM5Acceptance=falseを維持する。両試行予算は終了し、影響するplatform/全通信監査と長時間条件は別登録とする。
