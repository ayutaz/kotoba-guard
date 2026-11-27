# アーキテクチャ

文書確認: 2026-11-28。最新preview sourceはaea6caf、詳細なbuild/テスト対応は[preview検証](preview-validation.md)。
共有Worker直列化を含むbuild/E2E7件は成功。監査context終了失敗・他環境/長期資源の未完了は残る。
session-only保持は実験で、通常の保持設定は0のまま。

source `8c9988e`では、共有Workerを実行1件/待機1件に制限し、別クライアントがSDKのlatest-wins制御で相互cancelしないようにした。3件目はbusy。応答timeout後も実runのsettleまでslotを保持し、永久停止時はowner BrokerがWorkerを終了する。解放前の待機要求は世代不一致で拒否する。[実装と限定検証](research/shared-worker-concurrency.md)を参照。新sourceの他OS/最低版/全監査・資源受け入れは未完了で、以下の旧runtimeの検証を付け替えない。

以前のruntime `0e13b12`は、[文書ごとのinstance照合](research/offscreen-instance-identity.md)をWindowsのA/B・通常回帰で検証した。OffscreenからgetContextsを呼ばず、背景への認証済みidentifyとSW専用のinstance probeを使う。immutable markerとbefore/probe/afterのdocumentIdを照合し、旧markerを拒否する。detect/status/probeは背景Service Workerだけから受け付ける。信頼された拡張内の世代照合であり、資源受け入れ・Chrome内部TOCTOUの暗号学的証明・M5完成を意味しない。

Workerのidle終了後にoffscreen文書も閉じ、create/closeを単一遷移で直列化する。実API未完了時は5秒で応答失敗してもleaseを残す。文書側retiringを保持してSW再起動後の旧文書再利用を防ぎ、不明な終了状態では推論を停止する。status応答にも世代無効化を適用する。[ADR-0009](adr/0009-idle-offscreen-lifecycle.md)と[先行試験の履歴](research/offscreen-idle-recreation.md)を参照。現在の機能成功も資源受け入れとは分離する。

idle終了時にはまずSDK disposeのackを最大1秒待ち、その成否にかかわらずWorkerをterminateする。解放中はready=falseで、次の要求もpendingに数えて旧Worker終了後に送る。エラー/推論timeoutは即時終了する。内部statusのreleasesは成功・失敗・timeout・送信失敗の件数のみで本文を保持しない。[事前登録](research/graceful-worker-release.md)とその検証結果を参照する。明示releaseがOSメモリを即時回収するとは保証しない。

ページ上のContent Scriptはeditor adapter、IME、表示だけを扱う。Service Workerは許可・設定・メッセージ調停を担い、Offscreen Documentから専用Workerを起動する。SDKはChrome APIを参照せず、モデル/tokenizerをextension-local URLから読み込む。推論セッションはWorkerで共有する。通常WorkerのbackendはWASM固定。旧distは動的QUInt8、最新previewはEmbedding UINT8 / MatMul FP16保存・FLOAT演算の別モデルで、WebGPUはSDKと隔離probeの範囲に留める。

```text
許可したeditor → content → service worker → offscreen → worker → core SDK → ORT WASM
                ← 検出span・ラベル・信頼度 ←
```

UIとSDKの位置はUTF-16半開区間 `[start,end)`。Pythonのcodepoint位置とは区別する。tokenizer正規化で元文章への対応が変わる場合も位置を保存する。モデルラベルはconfigから取得する。公式と同じトークン単位の表示が基本で、softmax確率は校正済みの正確率ではない。修正候補は生成しない。

実行中の推論は実行中を含め最大2件に制限し、飽和時はbusyを返す。本文や設定の世代が変わった結果を捨てる。編集欄のDOMやvalueを書き換えず、外側の表示で検出を伝える。入力上限は20,000 UTF-16単位。配布Workerは256 token（特殊token込み）・重複32でチャンク化する。固定モデルの系列長上限8192と、拡張のチャンク長・文字数上限を区別する。自動検査はoptional host permissionと設定の両方があるoriginだけに動的登録する。手動検査は明示的なaction操作によるactiveTabと10秒の一回限りgrantを使う。モデル/WASMはページに公開しない。

SDKは明示した`maxTokens`もTokenizerの安全な上限と8192以内に制限し、特殊token追加後の長さ・offset/ID整合性を短文と長文の両経路で検証する。空入力も以前のリクエストを無効化する。`dispose()`は共有Promiseで初期化と実行中の推論を待ち、sessionを一度だけ解放し、release失敗を伝播する。ORTの`session.run()`自体はAbortSignalで中断できないため、単独SDKでrunが永久保留する場合はdisposeも保留する。拡張側はWorkerのtimeoutと終了・再生成で別の障害境界を設ける。

ContentControllerは停止/再開始の世代を保持し、停止後や前の開始世代の応答を表示に使わない。WorkerBrokerは最初の要求でWorkerを生成し、生成・再生成の失敗を要求のrejectとして返す。旧Workerのイベントはidentityで拒否し、不正な応答envelopeはpendingを消費せず無視する。

WorkerBrokerは最後のpending完了から60秒のidleでWorkerを解放し、最大1秒のdispose ACK後に終了する。文書はretiringへ入り、背景がclose lease内でcurrent documentId/markerと処理中要求を再照合した場合に閉じる。次の入力で新文書/Workerを生成する。実行中の要求をidle timerで中断せず、status/probe参照でも期限を延ばさない。popupの準備状態は実際のWorker状態を参照し、statusだけで推論環境を作らない。取消不能なstatus/identity APIは応答timeout後も実Promiseの完了まで1件を保持する。未知のclose結果ではretiringを解除せず、必要ならブラウザ/拡張の再起動で回復する。idle後はcold startが必要で、OSメモリ解放は保証しない。[ライフサイクルADR](adr/0009-idle-offscreen-lifecycle.md)と[instance ADR](adr/0010-offscreen-instance-identity.md)を参照する。
