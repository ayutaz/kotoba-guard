# ブラウザ推論・Chrome MV3 プラットフォーム調査

調査日: 2026-11-25（Chrome for Developers / ONNX Runtime / Hugging Face の公開ページ確認日）

2026-11-26の実装照合: 4権限とサイトopt-in、Chrome116の設計下限、WARなし、WORKERS offscreen、1-thread WASM、直接ORT APIを採用済み。実Chromium159のオフライン推論は成功。下記の外部仕様は調査日時点の記録で、製品の検証状況は [browser-compatibility.md](../browser-compatibility.md) と [testing.md](../testing.md) を正とする。

## 調査の目的

Kotoba Guard を Manifest V3 の Chrome 拡張機能として配布し、拡張機能に同梱した tokenizer・ONNX モデル・WASM だけで日本語誤字検出を実行できるかを確認した。ここでは、Chrome の実行コンテキスト、Service Worker と Offscreen Document の境界、CSP/権限、メッセージング、WASM/WebGPU の実行経路を整理する。

「事実」は公式ドキュメントで確認した仕様、「推論」は Kotoba Guard に適用する設計判断である。Chrome の API のバージョン挙動は変動するため、リリース対象の最小 Chrome で E2E を再実行する。

## 結論

P0 は、次の経路に固定する。

```text
ユーザーが許可したページ
  -> isolated-world content script（IME/DOM/サイト Adapter）
  -> runtime メッセージ（検証済みスキーマ）
  -> Service Worker（ライフサイクル制御・設定・タブ単位の調停）
  -> 1つの Offscreen Document（WORKERS reason）
  -> extension-owned Web Worker（Tokenizer + ONNX Runtime Web WASM）
  -> 検出結果（UTF-16 span に変換）
  -> content script（CSS Highlight/Shadow DOM で表示）
```

Service Worker 自体には DOM がなく、モデルをグローバル変数だけに保持すると停止時に失われる。Offscreen Document は拡張機能に同梱した静的 HTML だけを開け、拡張 API は `runtime` に限られるため、推論ワーカーとの通信は `runtime` メッセージに限定する。`WORKERS` reason は Offscreen Document が Worker を生成する場合に対応する。

推論は content script や Web ページの main world で実行しない。これによりページ CSP・ページ JavaScript・DOM の競合を減らし、モデル/入力の境界を extension-owned context に集約できる。全サイト自動監視を初期権限にせず、サイト単位のユーザー操作から optional host permission を取得する。手動チェックの最小経路は `activeTab` とする。

## Chrome の実行コンテキスト

### Service Worker

[Extension service worker](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers) は MV3 のイベントハンドラーであり、DOM にアクセスできない。必要になった時にロードされ、休止するとアンロードされる。[ライフサイクル仕様](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) では通常、30 秒の非アクティブ、単一イベント/リクエストの 5 分超、fetch 応答の 30 秒超などで停止し得る。API 呼び出しやイベントでタイマーが更新されるが、停止しないことを前提にしてはいけない。

Service Worker で保持する設定やモデル状態は、Chrome storage または再初期化可能な状態機械にする。`onStartup` が発火しても Service Worker のイベントが全て再実行されるわけではないため、各 inference request が必要ならば worker/offscreen の存在を確認してから送信する。モデルの `InferenceSession` を Service Worker のグローバルだけに置く実装は、停止後に再初期化できるテストを必須とする。

### Offscreen Document

[Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen) の確認結果（ページ更新 2026-11-10）は次の通り。

- `offscreen` 権限を manifest に宣言する必要がある。API の利用可能範囲は Chrome 109+ MV3（`browser.*` の記載は Chrome 148+）である。
- Service Worker が DOM を使えない場合の、非表示の extension page である。URL は拡張機能に同梱した静的 HTML でなければならない。
- Offscreen Document で使える拡張機能 API は `runtime` のみである。通常の Chrome API を直接使う前提を置かず、Service Worker が権限付き処理を担当する。
- インストール済み拡張機能では、通常プロファイルごとに同時に 1 つだけ Offscreen Document を開ける（split incognito では各プロファイルに 1 つ）。複数タブ用のモデル複製場所として使わない。
- `runtime.getContexts()` は Chrome 116+、`offscreen.hasDocument()` は Chrome 150+ と記載されている。最小 Chrome を低くする場合は `getContexts()` の有無または `clients.matchAll()` の互換経路を実装する。
- `reasons` には `WORKERS` があり、Offscreen Document が Worker を生成する目的を明示できる。音声用 `AUDIO_PLAYBACK` 以外の reason は寿命制限がないと説明されている。Kotoba Guard は `WORKERS` を採用済み。ただしアイドル時のモデル解放は未実装。

推論用 Offscreen Document は `offscreen.html` として静的に同梱し、Service Worker から `createDocument` を呼ぶ。現行実装は `offscreenReady` と `runtime.getContexts()` で存在を確認する。独立した `creating` Promiseは採用していない。背景処理は直列に進め、実行中を含む最大2件の有界キューを使う。最新性はContent Scriptのrequest IDと状態世代で判定し、古い結果を表示しない。

### Content Script

[Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) はデフォルトで isolated world に注入され、ページと DOM を共有するが、JavaScript の変数環境は分離される。`MAIN` world を選ぶとページ JavaScript と同じ環境になり、ページから干渉されるリスクがあるため、Kotoba Guard の Adapter は isolated world を既定にする。

content script が `fetch()` 等で外部データを取得した場合の XSS、`innerHTML`、文字列評価を避けるよう Chrome 公式は警告している。表示は `textContent`、`createElement`、Range/CSS Highlight、Shadow DOM を使い、入力文章を HTML として解釈しない。モデル・WASM の資産を page に見せるための web accessible resources は追加しない（必要な場合も対象 match を最小にする）。

現行Content Scriptはdocumentにイベントを委譲し、input/compositionの対象からAdapterを選ぶ。フォーカス時に設置するMutationObserverは、その対象欄が削除された場合などの表示解除を担い、追加editorの走査やAdapter再接続は行わない。動的登録は `document_idle` を採用。iframeは権限・frame境界が異なるため、一般editor fixtureの成功から対応を推定しない。

## CSP とローカル資産

[Manifest の CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy) は、extension pages の最低ポリシーを `script-src 'self' 'wasm-unsafe-eval'; object-src 'self';` 相当としている。既定 CSP では WebAssembly が無効なので、ONNX Runtime Web の WASM を実行する拡張機能は `wasm-unsafe-eval` を明示する必要がある。MV3 の `extension_pages` では任意の `'unsafe-eval'` や外部 script source を足してはならない。

content script の isolated world も `'wasm-unsafe-eval'` を含む CSP と説明されているが、main world に入れる script にはページ側 CSP が適用される。WASM 実行は extension-owned page/worker に閉じ込め、main world への依存を作らない。

P0 の manifest では次を品質ゲートにする。

- JavaScript、WASM、tokenizer、ONNX ファイルは全て package に存在し、runtime URL は `chrome.runtime.getURL()` からの静的資産だけである。
- `fetch` の宛先をコード検索・静的解析・実行時通信監視で検査し、外部 URL や CDN がないことを確認する。
- CSP に外部 script、`unsafe-eval`、動的コード実行を追加しない。WASM については `wasm-unsafe-eval` の必要性と、これがコード実行を許可する範囲を文書化する。
- `web_accessible_resources` は空、または必要な静的 UI 資産だけに限定する。モデル/WASM はページから直接取得できなくても拡張機能内部でロードできる配置を確認する。

## 権限とサイトアクセス

[Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions) は、`permissions`（必須 API）、`optional_permissions`、`host_permissions`、`optional_host_permissions` を分ける。optional permission は実行時にユーザーへ理由を示して付与でき、侵害時の影響範囲を減らす。ホスト権限は content script 注入、プログラムによる script 注入、Service Worker からの fetch 等に影響する。

[Permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions) は、manifest に宣言した optional permission を `permissions.request()` でユーザー操作から取得できる。`https://*/*` 等を `optional_host_permissions` に宣言しておけば、実行時に対象 origin の部分集合を要求できる。権限が不要になったら `permissions.remove()` を使う。

[activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab) は、action クリック・context menu・keyboard shortcut 等のユーザー操作後、現在のタブの main-frame origin に一時的な host access を与える。タブを閉じる/別 origin へ遷移するまでの範囲で、`scripting` と組み合わせて script/CSS を注入できる。これは手動チェックには適するが、ユーザーが明示的に操作しないリアルタイム常時検査は提供しない。

### 初期調査の権限候補と現在の採用結果

現在は次の4権限を採用。保存設定は `globalEnabled` と `enabledSites` のみで、閾値・モデル選択UIは未実装。初期比較での用途は次の通り。

- `storage`: サイトの有効/無効、閾値、モデル選択などの設定だけを保存する。文章本文、検出 span、ログを保存しない。
- `offscreen`: `WORKERS` reason の Offscreen Document を使う場合だけ追加する。

機能に応じて:

- `activeTab`: ツールバー/コンテキストメニューの手動チェック。
- `scripting`: ユーザー操作後に content script を注入する設計を採用する場合。
- `optional_host_permissions`: 自動チェックを有効にしたサイトだけ。初期実装は `https://*/*` と `http://*/*` を宣言し、個別 origin を runtime request するか、機能を限定して明示的なサイトリストを使う。

`tabs`、`<all_urls>`、`webRequest`、`externally_connectable`、`sidePanel` は P0 に必須とは判断しない。ポップアップだけでサイト設定を表示し、content script から受け取る tab ID/origin は Service Worker 側で検証する。権限追加は変更理由、警告、テストを同じ PR に記録する。

## メッセージングとセキュリティ境界

[Message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging) は、content script、Service Worker、extension page 間の JSON-serializable な一回通信または long-lived port を提供する。Chrome 公式は content script を Service Worker より信頼できないものとして扱い、入力の検証・sanitization、privileged action の範囲制限を要求している。ページへ送ったデータはページに漏れる可能性があるため、モデル内部の情報や他タブの文章を content script に返さない。

現在のメッセージ型は `extension/src/shared/types.ts`、検証は `shared/security.ts` と背景dispatcherを正とする。`check` は安全整数の `requestId` と最大20,000 UTF-16単位の `text` を検証する。senderのextension ID、tab/origin、許可・操作grantを確認し、外部メッセージを入口にしない。editor IDやschema versionは現在のpayloadには含まれない。結果はspan・label・confidenceに加えて検出部分のtext、推論時間、backend、modelVersionを含むが、永続保存・ログ出力はしない。古い結果はrequest IDと世代で破棄する。

非同期応答では、対象 Chrome の互換性を優先して `sendResponse` と `return true` を使う実装を検討する。[公式ページ](https://developer.chrome.com/docs/extensions/develop/concepts/messaging) は Chrome 148 以降の Promise listener を説明しているが、最小 Chrome での動作を別途確認するまで Promise だけに依存しない。

## ONNX Runtime Web と Transformers.js

### ONNX Runtime Web

[Get started](https://onnxruntime.ai/docs/get-started/with-javascript/web.html) は `onnxruntime-web` の ES module import を示し、WebAssembly は Chrome/Edge/Firefox/Safari 等で、WebGPU は対応する Chromium 等で利用可能とする。[WebGPU tutorial](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html) は、`onnxruntime-web/webgpu` の import と `executionProviders: ['webgpu']` を必要とする。軽量モデルでは default WASM を継続利用できると説明される。

[Deploying ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/deploy.html) は、WASM binary を必要な EP だけ package に含める考え方を示している。拡張機能では ORT の wasm path を `chrome.runtime.getURL('wasm/...')` に固定し、ネットワークからの runtime download を行わない。WASM SIMD/threading はブラウザの cross-origin isolation 等の条件を含むため、まず single-thread/SIMD の実測経路を持ち、threaded binary は capability check 後だけ使う。

WebGPU は Chrome/Edge の対応状況、GPU/driver、float16 対応、モデルの operator coverage に依存する。WebGPU E2E は GPU がある開発機と対応 CI ランナーで別ジョブにし、WASM の成功を WebGPU 成功として扱わない。`navigator.gpu` がない、adapter/device 取得に失敗する、モデルの未対応 operator がある場合は WASM に戻す。

### Transformers.js

[Transformers.js の Chrome 拡張機能ガイド](https://huggingface.co/blog/transformersjs-chrome-extension) は、背景 Service Worker をモデルの共有ホスト、side panel を UI、content script をページ操作とする MV3 構成を紹介している。[公式 browser extension tutorial](https://github.com/huggingface/transformers.js/blob/main/packages/transformers/docs/source/tutorials/browser-extension.md) は、拡張機能で Transformers.js を使用する導線を提供する。

Transformers.js は tokenizer、config、pipeline の対応を短時間で検証できるため、モデルの参照実装・ブラウザ smoke test に採用する価値がある。一方、モデルを一から同梱し、label ID と UTF-16 offset を厳密に管理する P0 では、runtime と後処理の境界を `packages/core` に固定し、Transformers.js の pipeline 出力に直接 UI を依存させない。必要なら ORT の直接 API に置き換えられる設計にする。

## Chrome Built-in Proofreader API との関係

[Built-in AI APIs](https://developer.chrome.com/docs/ai/built-in-apis) と [Proofreader API](https://developer.chrome.com/docs/ai/proofreader-api) は、Chrome 内蔵の生成 AI による文章の correction、label、explanation を提供する実験的 API の説明を掲載している。現行ページは Proofreader API を origin trial とし、Chrome 141–145 での試験導線、OS/RAM/GPU/ストレージ/初回ダウンロード要件を説明している。ページ更新や Chrome Status の変更を待たず、リリース時に再確認する。

Proofreader API は `Proofreader.availability()`、`Proofreader.create()`、`proofread()` を使い、`correctedInput` と correction の `startIndex`/`endIndex` を返す。Web Worker では利用できず、top-level window と same-origin iframe が既定の範囲で、cross-origin iframe は Permission Policy の `allow="proofreader"` が必要である。したがって、Kotoba Guard の Worker/WASM 推論とは実行場所も配布モデルも異なる。

採用判断は次の通り。P0 の必須経路には含めない。P1 で Built-in API と同じ文章に対する候補・説明・レイテンシーを比較するベンチマークは有用だが、WebGPU/WASM の完全ローカル同梱要件や日本語誤字モデルのラベル定義を置き換えない。

## 初期調査で推奨した構成と理由

以下は設計比較の記録。採用済み実装の数値上限・APIは [architecture.md](../architecture.md) を参照する。options画面は未実装。

### コンポーネント

1. **Content adapter**: textarea/input/contenteditable を検出し、`compositionstart/update/end`、`beforeinput`、`input`、selection を扱う。password、one-time-code、credit-card、hidden/file などの機密欄を先に除外する。
2. **Renderer**: Adapter から独立し、DOM の値を書き換えずに CSS Highlight または Shadow DOM の overlay を描画する。HTML injection を行わない。
3. **Service Worker**: site allowlist、permissions、tab/request routing、offscreen lifecycle、設定の永続化だけを担当する。モデル tensor や本文をグローバルに持続しない。
4. **Offscreen inference host**: 静的 `offscreen.html` から extension-owned Worker を起動する。Worker は model/tokenizer/ORT を一度初期化し、request ID でキャンセル・古い結果破棄を行う。
5. **Core SDK**: tokenizer の offsets、UTF-16 変換、chunk overlap、label mapping、confidence filter、span merge を pure TypeScript としてテストする。`wasm` と `webgpu` は backend interface の差し替えにする。
6. **Popup/options**: 権限状態、モデル状態、backend、site enable/disable を表示する。本文や検出結果を storage に保存しない。

### 推論フロー

- 入力が composition 中は request を出さず、compositionend 後に 300–500 ms の debounce を開始する。
- 同一 editor のリクエストは一つだけ実行し、新しい入力が来たら旧 request を Abort/ignore する。長文は overlap 付き chunk に分け、重複 span を一意化する。
- Worker の初回ロードは user-visible な準備状態として通知する。Service Worker の再起動・Offscreen の再生成後も同じ manifest/revision から再初期化できる。
- backend は capability probe の結果 `webgpu` -> `wasm` の順に選ぶ。ただし、WebGPU の fallback を成功と報告せず、実際に選ばれた backend を結果へ記録する。
- 最終的な span は JavaScript 文字列の UTF-16 index とし、Python/Unicode code point offsets を使う変換経路を単体テストする。絵文字、結合文字、改行、半角/全角を fixture に含める。

## 検証計画

| 領域           | 実験                                              | 合格条件                                             |
| -------------- | ------------------------------------------------- | ---------------------------------------------------- |
| MV3 ロード     | Chrome の unpacked install と manifest 検証       | CSP/permission エラーなし、静的資産のみ              |
| Service Worker | DevTools で停止・再起動後に同じ入力を検査         | state loss があっても再初期化し、古い結果を返さない  |
| Offscreen      | 2 タブ同時初期化、再接続、close/create            | 同時に 1 document、リクエストが取りこぼされない      |
| WASM           | ネットワーク遮断下で tokenizer + ONNX             | 参照ログと label/span が一致、外部 request 0         |
| WebGPU         | 対応/非対応 GPU、float16、未対応 operator         | 対応時のみ WebGPU、失敗時 WASM、backend を正しく表示 |
| 権限           | permission 未付与、許可、削除、別 origin 遷移     | 許可前は本文を取得せず、削除後は停止                 |
| IME            | composition 中/確定、取消、高速入力、paste/undo   | composition 中は推論せず、確定後の最新結果だけ表示   |
| 機密性         | password/OTP/card/file/hidden とログ/Storage 監視 | 対象欄の取得・保存・ログ出力が 0                     |
| XSS/メッセージ | 悪意ある DOM と不正 message payload               | `innerHTML`/eval を使わず、schema/sender を拒否      |
| オフライン     | DNS/ネットワーク遮断、キャッシュ消去、再起動      | 同梱モデルで初期化し、外部通信なし                   |

## 調査後の判断と残課題

- manifestの最小Chromeは116に固定済み。`runtime.getContexts()` と `sendResponse`/`return true` を採用する。116での実行試験は未実施、実検証はChromium159。通常UIはWebGPUを必要としない。
- Offscreen Document の `WORKERS` reason は Worker 生成の理由として公式に掲載されているが、ONNX Runtime Web の全 WASM 配置・threading 条件を保証するものではない。実際の unpacked extension で worker URL、WASM URL、CSP を検証する。
- `web_accessible_resources` は宣言せずに動作確認済み。Vite直接ビルドのextension-owned workerが同梱ORT/WASMを読む。配布ゲートもWAR追加を拒否する。
- Built-in Proofreader API の origin trial 状況と日本語のモデル品質は、P1 で公式 Chrome Status と実機を用いて再調査する。これを P0 の実装/受け入れ条件に混ぜない。

## 2026-11-27: 隔離したWASMマルチスレッド実験

Chrome公式の[拡張機能のcross-origin isolation](https://developer.chrome.com/docs/extensions/develop/concepts/cross-origin-isolation)は、manifestの`cross_origin_embedder_policy: {value: "require-corp"}`と`cross_origin_opener_policy: {value: "same-origin"}`を示す。推論はoffscreenから専用workerへ送る構成を維持し、service workerの状態だけで専用workerのisolationを推測しない。

[ORTの環境設定](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html)に従い、隔離コピーだけで2/4 threadsを実測した。モデル・CSP・権限は変更せず、proxy workerを有効化していない。popupでisolation/SABと初期化後のORT設定2/4を確認し、ローカルasyncify workerを観測した。128 token p50は151.8/128.6msで目標100ms未達。結果とメモリ範囲は[benchmarks](../benchmarks.md)を参照する。通常配布物への採用、offscreen-workerの実効設定、数値一致、全contextの通信監査は別途必要。

## 出典

### Chrome 公式

- [Extension service workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers)
- [Service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Manifest Content Security Policy](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
- [Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [Permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions)
- [The `activeTab` permission](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
- [Built-in AI APIs](https://developer.chrome.com/docs/ai/built-in-apis)
- [Proofreader API](https://developer.chrome.com/docs/ai/proofreader-api)

### 推論ランタイム

- [ONNX Runtime Web: Get started](https://onnxruntime.ai/docs/get-started/with-javascript/web.html)
- [ONNX Runtime Web: WebGPU EP](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)
- [ONNX Runtime Web: Deploying](https://onnxruntime.ai/docs/tutorials/web/deploy.html)
- [Hugging Face Transformers.js](https://github.com/huggingface/transformers.js)
- [Transformers.js Chrome extension guide](https://huggingface.co/blog/transformersjs-chrome-extension)
- [Transformers.js browser extension tutorial](https://github.com/huggingface/transformers.js/blob/main/packages/transformers/docs/source/tutorials/browser-extension.md)
