# Chrome Web Store 掲載準備 / Store Listing Draft

文書照合: 2026-11-28。以下は申請前の文案で、申請/公開は未実施。開発停止中。
最新preview sourceはaea6caf、build/E2E7件成功だが監査cleanup失敗でZIP/SBOM未生成。
48.19MBのFP16保存モデルはp50=150.1msで速度目標未達、一般精度は未評価。
旧QUInt8の速度・精度や「世界初」「高精度」「100ms以下」を最新previewの掲載根拠にしない。
下記67217cc等の掲載画像は過去の選定記録。最新previewのmanual E2E画像は保存済みだが、
今回目視レビュー・掲載用選定をしていない。提出候補sourceと画像を揃える作業は残る。
[現在の検証](preview-validation.md)、[公開手順](release.md)を優先する。

2026-11-27時点の掲載文案。Kotoba Guardはローカル開発版で、Chrome Web Storeには未公開。公開URL、サポートURL、プライバシーURLは公開先とサポート窓口が確定するまで空欄のままにする。

## 掲載前チェック

2026-11-27時点で目視確認した掲載サイズ候補は`67217cc`の実モデルE2Eから取得した `artifacts/validation/67217cc172cacc36bff0a970a556a35ec5f16564/screenshots/store-editor.png`（1280×800）、SHA `2a8d097ade61eb690491942d876cdad22c4d0fffe7462b7fb43f5b0cb2228103`。同じディレクトリのpopup画像は330×357、モデル初期化前。両方を目視確認した。下記の従来の「現行画像」SHAは過去の生成時点の記録であり、新しい画像へ付け替えない。公開URLと申請は未確定・未実施。検証範囲は[開発用snapshot](validation-67217cc.md)を参照する。

- 128pxアイコン: `extension/public/icons/icon128.png`（generator: `scripts/generate_icons.py`）。16/32/48/128pxも同じ幾何デザインから生成する。
- 既存スクリーンショット: `docs/images/editor.png` は **1280×897**、`docs/images/popup.png` は **330×357**。現状のファイルを掲載画像の完成条件とは扱わない。公式掲載サイズに合わせた最終画像の選定・切り出しは公開前に行う。
- 実モデルE2Eからのストア候補キャプチャ: `artifacts/screenshots/store-editor.png` を1280×800 viewport、`fullPage: false`で生成した。新UIを含むソース`2a6188e`のWindows全E2E9件に続き、`b05dcfe`のキーボード・選択保持E2E1件が成功して同パスを再生成した。現行画像のSHA-256は `7f88fc753b5dba0b920ab3d8522ab4955a4535bec5544cb11620e08db4660791`。親エージェントが現行画像も確認し、検出件数の表示が次の入力欄のラベルを覆わないことを確認した。先行画像のSHA `dea4f5970345234975bdc8f02432d48233316f1e83790780cc6c5d6b5100e895`とは区別する。生成画像はignoredローカル資産であり、未公開。
- 最低1枚の掲載サイズ候補は用意できた。最終候補のソースが変わった場合は実モデルE2Eから再取得し、実画面と説明文が一致することを確認して選定する。
- ホームページURL: **未定**
- サポートURL: **未定**
- プライバシーURL: **未定**（公開URL確定後に `extension/public/privacy.html` の内容を公開ページへ反映する）
- 公開先、連絡先、Chrome Web Store申請は未実施。

Chrome Web Storeの掲載画像・アイコン要件は、[Chrome Web Store Dashboard listing documentation](https://developer.chrome.com/docs/webstore/cws-dashboard-listing) を申請時点で再確認する。現時点では128pxアイコンと最低1枚のスクリーンショットを必須入力として扱う。

## 日本語掲載文案

### 拡張機能名

Kotoba Guard

### 短い説明

文章を外部送信せず、端末内で日本語の誤字脱字の可能性を検出します。

### 詳細説明

Kotoba Guardは、日本語の文章入力中に誤字脱字の可能性を検出するChrome拡張機能です。推論は拡張機能に同梱したJavaScript、WASM、モデルを使って端末内で実行します。

対応を確認している一般的な入力欄は、`textarea`、単一行の`input`、`contenteditable`です。日本語IMEの変換中は検出を待ち、確定後に遅延検出します。検出箇所は入力欄の外側に表示し、文章の値、カーソル、選択範囲、Undo履歴を拡張機能が書き換えない設計です。

サイトごとの自動チェックは、ユーザーがそのサイトを明示的に有効化した場合だけ使用します。手動チェックは現在のタブでユーザーが操作した場合に限ります。パスワード、支払い情報、認証コード、hidden・file入力などの機密性が高い入力欄は検出対象から除外します。

モデルはSB Intuitionsが公開した日本語誤字検出モデルを利用します。モデルは誤りの可能性を検出するもので、修正文章や修正候補を生成しません。表示する信頼度は校正済みの正解確率を保証する値ではありません。誤検出と見逃しがあるため、表示結果は確認してから利用してください。

入力文章、検出結果、利用履歴を外部へ送信しません。アカウント、APIキー、テレメトリーは必要ありません。保存するのは有効化状態や許可サイトなどの設定だけです。

### 権限の理由

| 権限                                    | 掲載時の説明                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `activeTab`                             | ユーザーが手動チェックを選んだ現在のタブだけを一時的に検査するため。                                 |
| `storage`                               | グローバル設定、サイトの有効化状態を保存するため。入力文章や検出結果は保存しない。                   |
| `scripting`                             | ユーザーが明示的に許可したサイト、または手動チェックを選んだタブへcontent scriptを登録するため。     |
| `offscreen`                             | 拡張機能ページのライフサイクルから分離したローカル推論ランタイムを実行するため。                     |
| `http://*/*`, `https://*/*`（optional） | 全サイトを初期状態で読むためではなく、ユーザーが個別に自動チェックを有効化したサイトに限定するため。 |

### プライバシー申告の下書き

- データを収集する: **いいえ**
- ウェブサイトのコンテンツを収集する: **いいえ**
- 個人を特定できる情報を収集する: **いいえ**
- 健康・金融・認証情報を収集する: **いいえ**
- データを第三者へ販売する: **いいえ**
- データを第三者へ送信する: **いいえ**
- 入力文章を学習に利用する: **いいえ**
- 入力文章を永続保存する: **いいえ**
- 外部コード、外部JavaScript、外部WASM、外部モデルを読み込む: **いいえ**

上記は現在のmanifest、content script、background、offscreen、workerの設計に基づく申告案であり、Chrome Web Store申請時に配布物の実体と再照合する。

## English listing draft

### Extension name

Kotoba Guard

### Short description

Detect possible Japanese typos locally without sending your text outside the device.

### Detailed description

Kotoba Guard detects possible Japanese typos while you write in Chrome. Inference runs locally with JavaScript, WebAssembly, and the bundled model. No server, account, API key, or telemetry is required.

The verified general editor targets are `textarea`, single-line `input`, and `contenteditable`. During Japanese IME composition, checking waits until the composition is committed and then runs after a short debounce. Results are shown outside the editor so the extension does not rewrite the editor value, caret, selection, or undo history.

Automatic checking is enabled only for sites that the user explicitly enables. Manual checking is limited to a user action on the current tab. Password, payment, one-time-code, hidden, and file inputs are excluded as sensitive fields.

The bundled model is a Japanese typo-detection model released by SB Intuitions. It detects possible errors; it does not generate corrected text or correction suggestions. The displayed confidence is not a calibrated probability of correctness. False positives and missed errors are possible, so review every result before using it.

Input text, detections, and usage history are not sent outside the extension. Only settings such as enabled sites are stored locally. Site-specific services and real-world login flows have not been claimed as verified in this draft.

### Permission reasons

- `activeTab`: temporarily inspect the current tab only after the user chooses a manual check.
- `storage`: store global settings and enabled-site state; never store input text or detections.
- `scripting`: register the content script for a site explicitly enabled by the user or for an explicitly requested manual check.
- `offscreen`: run the bundled local inference runtime outside the extension page lifecycle.
- Optional `http://*/*` and `https://*/*`: request site access only when the user enables automatic checking for that site; no site is enabled by default.

### Privacy declarations draft

- Data is collected: **No**
- Website content is collected: **No**
- Personally identifiable information is collected: **No**
- Health, financial, or authentication data is collected: **No**
- Data is sold or transferred to third parties: **No**
- Input text is used for training: **No**
- Input text is persistently stored: **No**
- Remote JavaScript, WASM, model, or other executable code is loaded: **No**

### URLs

- Homepage: **TBD before submission**
- Support: **TBD before submission**
- Privacy policy: **TBD before submission**

## Evidence boundary

The local status record is the source for completed verification. General accuracy targets, real-service compatibility, physical IME behavior, native permission UI, and WebGPU product behavior remain unverified or outside this listing draft. This document does not claim Chrome Web Store approval, publication, or support for sites that have not been tested.
