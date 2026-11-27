# 競合・参考実装調査

調査日: 2026-11-25（Webページの確認日）。2026-11-26に実装との対応を見直した。外部製品の記述は調査時点の資料に基づき、今回の文書更新で現行製品の再調査はしていない。採用済みの構成は [architecture.md](../architecture.md) と [ADR](../adr/0001-tooling.md) を参照する。

## 調査の目的

Kotoba Guard の初期版（日本語専用、拡張機能にモデルとランタイムを同梱、入力を外部へ送らない構成）を設計するため、指定された競合・参考実装の公開情報を比較した。ここで記載する「事実」は公開資料で確認できた内容、「推論」はそこから導いた設計上の判断である。各製品のプライバシーや精度の主張を、第三者監査済みの事実とは扱わない。

## エグゼクティブサマリー

- `nknytk/chrome-extention-jp-proofreader` は、同じ日本語誤字検出と ONNX Runtime Web を扱う最も直接的な先行例である。選択範囲をコンテキストメニューから検査する設計で、リアルタイム入力監視とは異なる。モデル、TinySegmenter、ランタイムでライセンスが分かれるため、コードやアセットを再利用せず、著作権表示と依存関係の台帳だけを参考にする。
- Proofly は Chrome Built-in AI Proofreader API、Shadow DOM、CSS Highlights、サイドパネルを組み合わせた UX の参考になる。一方、Built-in AI の可用性、モデル配布、Chrome の実験段階に依存するため、Kotoba Guard の同梱 ModernBERT 推論の根拠にはしない。
- ONNX Community の ModernBERT/Ruri と `japanese-reranker-xsmall-v2-onnx-web` は、Transformers.js が使えるモデルファイル構成、WebGPU 用 FP16 と WASM 用 INT8 の分離、PyTorch/ONNX 差分の報告方法を示している。これらは typo detector ではないので、精度やラベル仕様を流用してはいけない。
- textlint/editor はルールを実装から分離したブラウザ向けリンターと、Worker・キャッシュを含む API 境界の参考になる。モデル検出結果を textlint のルール結果と同一視せず、将来の統合アダプターとして扱う。
- Shodo、Typoless、wordrabbit、Fude は、入力欄内のリアルタイム指摘、サイト対応、辞書・ルール・候補の UX を学べる。ただし、公開資料上はクラウド、アカウント、回数制限または外部モデル利用を含む製品であり、Kotoba Guard の完全ローカル・無制限という要件を満たす代替ではない。

## 直接的な競合・先行例

### 日本語誤字チェック（nknytk/chrome-extention-jp-proofreader）

#### 公開資料で確認できた事実

- [README](https://github.com/nknytk/chrome-extention-jp-proofreader/blob/main/README.md) は、選択文字列または右クリック位置の周辺文字列をコンテキストメニューから検査する操作を説明している。
- [manifest.json](https://raw.githubusercontent.com/nknytk/chrome-extention-jp-proofreader/main/manifest.json) は Manifest V3、`contextMenus` と `storage`、モジュール形式の Service Worker、`http`/`https`/`file` の静的 content script、`script-src 'self' 'wasm-unsafe-eval'` を確認できる。記載された説明は文字の置換・削除に対応し、文字追加は未対応である。
- [README のライセンス節](https://raw.githubusercontent.com/nknytk/chrome-extention-jp-proofreader/main/README.md) は、同梱の誤字チェックモデルを CC-BY-SA 3.0、TinySegmenter を New BSD、ONNX Runtime を MIT、その他のコードを MIT としている。これは個別アセットの再配布条件を確認する必要がある例である。
- [Chrome Web Store の掲載情報](https://chromewebstore.google.com/detail/%E6%97%A5%E6%9C%AC%E8%AA%9E%E8%AA%A4%E5%AD%97%E3%83%81%E3%82%A7%E3%83%83%E3%82%AF/kimgghbenifpmkblkhngkbbgkdaaggmc?hl=ja) は、同梱 JavaScript モデルのほか、任意の API サーバー接続を説明している。掲載ページのサイズ表示は 55.3 MiB、更新日は 2023-06-12 である。

#### Kotoba Guard への含意

選択範囲だけを検査する POC は速く作れるが、P0 の入力中検出には、対象エディターの値・選択範囲・IME 状態を観測する Adapter が必要になる。モデルを同梱する場合でも、モデルと推論ランタイムのライセンスを別々に台帳化する。競合のコンテキストメニューや実装コードはコピーせず、操作上の不足（追加誤りの未対応、リアルタイム性の不足）を受け入れ条件に反映する。

### Proofly

#### 公開資料で確認できた事実

- [README](https://github.com/onderceylan/proofly/blob/main/README.md) と [LICENSE](https://raw.githubusercontent.com/onderceylan/proofly/main/LICENSE.md) は、MIT ライセンスのオープンソース Chrome 拡張機能で、Chrome 141+、Chrome Built-in AI を利用する構成だと説明している。
- [manifest.config.ts](https://raw.githubusercontent.com/onderceylan/proofly/main/manifest.config.ts) は MV3、`offline_enabled`、Service Worker、`<all_urls>` の content script、`sidePanel`、`tabs`、`storage`、`contextMenus` を定義している。これは実装ファイルで確認できる権限・注入範囲であり、製品の安全性を証明するものではない。
- README は、入力欄・textarea・contenteditable、リアルタイム/手動チェック、色分け下線、修正候補、サイドバー、Shadow DOM、CSS Highlights API を特徴として挙げている。これらは UX の参照になるが、公開コードの自己説明である。
- [PRIVACY.md](https://raw.githubusercontent.com/onderceylan/proofly/main/PRIVACY.md) は、文章を収集・保存・送信しないこと、設定を Chrome sync storage に保持すること、モデルを Chrome のキャッシュに置くことを宣言している。Chrome Built-in AI の初回モデル取得は Google のサーバーから行うという記載もあるため、「同梱モデルで初回からオフライン」という Kotoba Guard の要件とは異なる。

#### Kotoba Guard への含意

問題表示はページ DOM に直接 HTML を挿入せず、Shadow DOM または CSS Custom Highlight と `textContent`/Range を使う。自動チェックと手動チェックを切り替え、低信頼度の結果を断定的に表示しない UX は採用候補である。Built-in AI への依存は P1 の比較実験に留め、P0 の成功条件は同梱 ONNX/WASM とする。

### textlint / textlint-editor

#### 公開資料で確認できた事実

- [textlint](https://github.com/textlint/textlint) は自然言語向けのプラガブルなリンターで、コアにルールを同梱せず、npm のルールプラグインを利用する設計である。リポジトリは MIT である。
- [textlint/editor](https://github.com/textlint/editor) はブラウザ向けの privacy-first linting tool と説明され、MIT ライセンスである。公開 API として `update`、`lint`、`fix`、`suggest`、`ignore` が記載され、Worker 用コードとブラウザ用コード、キャッシュを分ける構成が示されている。

#### Kotoba Guard への含意

コア SDK を「検出エンジン」と「表示/エディター統合」に分離し、将来 `textlint` ルールまたは textlint-editor に接続できる API を設計する。`Detection` の span、message、suggestion は textlint の range/message/suggestion に変換できるが、ModernBERT の token label を textlint の規則違反として公開するには評価と仕様化が必要である。最初の実装では textlint 本体を依存にせず、変換アダプターを P2 とする。

## ONNX・ブラウザ推論の参考

### Ruri v3 30M ONNX

[モデルカード](https://huggingface.co/onnx-community/ruri-v3-30m-ONNX) は、`cl-nagoya/ruri-v3-30m` を自動変換した ONNX 版（Apache-2.0）と説明し、Transformers.js の `feature-extraction` pipeline の使用例を掲載している。ModernBERT-Ja、SentencePiece のみの tokenizer、最大 8192 token、約 100K vocabulary という構成も記載されている。これは Kotoba Guard と系列長・tokenizer が近い参考であるが、埋め込みモデルであり、誤字の token classification モデルではない。モデルカードの評価値は Ruri の埋め込みタスクの値であって、Kotoba Guard の検出精度ではない。

### japanese-reranker-xsmall-v2-onnx-web

[モデルカード](https://huggingface.co/masahiroid/japanese-reranker-xsmall-v2-onnx-web) は、非公式の ONNX export を Transformers.js/ONNX Runtime Web 用に配布している。`onnx/model.onnx`（FP32）、`model_fp16.onnx`（WebGPU 向け）、`model_quantized.onnx`（動的 INT8、WASM/CPU 向け）を分け、動的 batch/sequence、PyTorch との logit 差、ファイルサイズを記録している。また [Security](https://huggingface.co/masahiroid/japanese-reranker-xsmall-v2-onnx-web/blob/main/SECURITY.md) へのリンクと ML-BOM/チェックサムの説明がある。ライセンスは MIT と表示されている。

この「ランタイム別のファイル分離、変換後の差分測定、SHA/系譜の記録」は採用する。一方、モデルカードの測定値は配布者の報告であり、Kotoba Guard のブラウザ実測を代替しない。INT8 の差分が大きい場合があるという記載から、量子化後に検出 span と label の一致率を必ず測る。

### ModernBERT NER CoNLL2003 ONNX

[モデルカード](https://huggingface.co/onnx-community/modernbert-ner-conll2003-ONNX) は、ModernBERT の token-classification モデルを自動変換した Apache-2.0 の ONNX 配布物で、Transformers.js の `token-classification` pipeline と `aggregation_strategy` の例を示している。これは、token classification の入力・出力と集約の実装を検証するための形が近い。ただし英語 NER であり、ラベル体系、データ、精度を日本語誤字検出へ流用してはならない。

### Transformers.js / ONNX Runtime Web

- [Transformers.js リポジトリ](https://github.com/huggingface/transformers.js) はブラウザ内推論用の Apache-2.0 ライブラリである。
- [Transformers.js の Chrome 拡張機能ガイド](https://huggingface.co/blog/transformersjs-chrome-extension) は、MV3 の Service Worker をモデルの共有ホストにし、content script をページ操作、side panel を UI、メッセージを型付きイベントにする構成を例示している。Service Worker の停止・再起動を前提にモデル状態を再初期化可能にする点が Kotoba Guard に有用である。
- [ONNX Runtime Web: Web](https://onnxruntime.ai/docs/get-started/with-javascript/web.html) は WASM、WebGPU、WebGL、WebNN の対応表を公開している。[WebGPU EP](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html) は `onnxruntime-web/webgpu` と `executionProviders: ['webgpu']` を使う。軽量モデルには標準 WASM を継続利用できると記載されている。

## 日本語校正サービス（機能・UX の参照）

### Shodo

[公式サイト](https://shodo.ink/) は Chrome/Edge 拡張で SNS、メール、note、Zendesk の文章を校正すると説明している。[公式ブログ](https://blog.shodo.ink/entry/2021/09/01/151024) の当時の説明では、拡張ポップアップから入力し、AI/ルールでチェックし、利用にアカウント登録が必要だった。公開資料からは完全ローカル推論とは確認できないため、クラウド型サービスの UX/サイト適応の参照とする。現在のプラン・通信仕様は実装前に公式のプライバシーポリシーで再確認する。

### Typoless

[ブラウザ拡張ガイド](https://typoless.asahi.com/guide/chrome-extension) は Chrome/Edge の入力欄を直接校正し、AI校正、ルール辞書、カスタム辞書、良文サポート、炎上リスク、除外リストを提供すると説明している。[公式サイト](https://typoless.asahi.com/) は置換・削除・挿入の指摘と候補反映、ルール辞書を説明し、[料金ページ](https://typoless.asahi.com/price) はプランごとの文字数上限や拡張機能を記載している。多層の検出種別と候補の操作は参考になるが、課金サービスであり、ローカル同梱モデルの証拠ではない。

### wordrabbit

[公式サイト](https://wordrabbit.jp/) と [料金ページ](https://wordrabbit.jp/services/pricing) は、独自 AI によるブラウザ校正、Word/PowerPoint/Chrome 拡張、API、カスタム辞書、表記ゆれ・誤字脱字・ビジネス表現の検出を説明している。[機能紹介](https://wordrabbit.jp/blog/97) は、助詞、漢字、ミスタイプ、表記ゆれ、差別語、不適切表現などを列挙する。多数の検出カテゴリを一つの画面で扱う UX の参照にはなるが、公開資料上はサーバー/API 型であり、Kotoba Guard の外部送信禁止要件とは別の設計である。

### Fude（筆）

[公式ページ](https://www.increoscale.com/products/fude/ja/) は、入力中のリアルタイム校正と Gmail/Slack/Notion 対応、50 以上のオフラインルールを説明している。同ページでは無料版の AI 校正を 1 日 10 回まで、Pro では Claude を使った高精度モデルを説明している。したがって「オフライン」はローカルルール部分を指し、AI 推論全体が同梱ローカルであることを意味しない。Kotoba Guard では、入力中の負荷抑制、確定後 debounce、サイト Adapter の検証を参考にする。

## 比較表

| 対象                   | 公開資料で確認した実行方式           | 入力 UI                                         | ライセンス/公開範囲                                    | Kotoba Guard が採用する知見               | 採用しない前提                                             |
| ---------------------- | ------------------------------------ | ----------------------------------------------- | ------------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------- |
| 日本語誤字チェック     | 同梱 JS/ONNX Runtime Web、任意 API   | 選択範囲・右クリック                            | コード MIT、モデル CC-BY-SA 3.0、TinySegmenter New BSD | MV3/CSP、モデルのライセンス分離           | API 接続、選択操作だけ、追加誤り未対応                     |
| Proofly                | Chrome Built-in AI                   | 入力欄・textarea・contenteditable、サイドパネル | MIT                                                    | Shadow DOM、CSS Highlights、手動/自動切替 | Built-in AI の可用性・初回ダウンロードを P0 の根拠にしない |
| textlint/editor        | ブラウザ lint、Worker/キャッシュ     | エディター                                      | MIT                                                    | `lint`/`suggest`/`ignore` の API 境界     | ML token label を textlint rule と同一視しない             |
| Ruri v3 ONNX           | Transformers.js/ONNX Runtime Web     | API/デモ                                        | Apache-2.0                                             | ModernBERT 系のモデル配布・tokenizer 参考 | 埋め込みモデルの精度を誤字検出へ流用しない                 |
| Japanese reranker ONNX | WebGPU FP16、WASM INT8/FP32          | API/ブラウザ                                    | MIT 表示                                               | 形式別モデル、差分、ML-BOM、チェックサム  | INT8 の精度を未測定で採用しない                            |
| ModernBERT NER ONNX    | Transformers.js token classification | API/デモ                                        | Apache-2.0                                             | token classification の集約方法           | 英語 NER ラベル・データを流用しない                        |
| Shodo                  | 公開資料ではクラウド型サービス       | Chrome/Edge、SNS・メール等                      | proprietary                                            | サイト適応、入力支援 UX                   | 完全ローカル、無制限、外部送信なしの根拠にしない           |
| Typoless               | 公開資料では AI + 辞書/サービス      | Chrome/Edge、CMS、メール                        | proprietary                                            | 指摘カテゴリ、候補反映、除外辞書          | 課金/アカウント/サーバー前提                               |
| wordrabbit             | 独自 AI、ブラウザ/API                | ブラウザ、Word、Chrome 等                       | proprietary                                            | API/辞書/長文校正 UX                      | 外部 API を Kotoba Guard に入れない                        |
| Fude                   | AI とローカルルールの併用            | Gmail/Slack/Notion 等                           | proprietary                                            | リアルタイム校正、ルール分離              | AI の日次制限・Claude 依存                                 |

## 調査時の設計推奨

以下は初期設計の比較記録。現在はTransformers.jsのtokenizerと直接ORT APIを組み合わせ、単一の変換manifestにraw資産、配布manifestにsanitized資産を記録する。FP32/FP16は通常拡張には同梱しない。

1. **推論層**: P0 は ONNX Runtime Web の WASM を必須経路とし、WebGPU は同じ `Detector` API の実行プロバイダーとして追加する。Transformers.js は tokenizer/model config の互換性を早く確認するために使い、bundle サイズまたは worker 制約が問題になった場合に直接 ONNX Runtime Web へ切り替えられるよう、サイト Adapter と分離する。
2. **モデル配布**: FP32/INT8/FP16 を別 manifest にし、元モデル ID・固定 revision・変換ツール・サイズ・SHA-256・ライセンスを保存する。モデルカードに書かれた値を自測定値として再利用しない。
3. **UI**: content script は DOM と IME の観測・ハイライトだけ、推論は extension-owned worker/offscreen に置く。表示は `textContent` と Range/CSS Highlight/Shadow DOM を使い、ユーザー文章を `innerHTML` やログに渡さない。
4. **権限**: 常時全サイト権限を初期値にせず、対象サイトのユーザー操作で optional host permission を取得する方式を優先する。手動検査は `activeTab`、自動検査は許可済み origin のみとし、拒否されたサイトは何も取得しない。
5. **誤検出抑制**: 既存製品のカテゴリ分けは参考にするが、モデルが修正候補を生成しない限り候補を作らない。低信頼度は「誤りの可能性」として表示し、候補生成は別機能に隔離する。
6. **検証**: 各 Adapter を fixture HTML で検証し、実サービスのログイン情報を CI に持ち込まない。ブラウザでの WASM 実推論、ネットワーク遮断、機密 input 除外、Manifest 権限差分を独立した品質ゲートにする。

## 未解決事項

- 日本語誤字チェックの最新 Chrome Web Store 配布物と GitHub main が完全に一致するかは未検証である。コード参照時はタグ/コミットを固定して確認する。
- Proofly、Shodo、Typoless、wordrabbit、Fude の現行通信経路・保存期間・精度は、公開ページの自己説明だけでは比較できない。Kotoba Guard の要件は各製品の主張を前提にせず、実装とテストで証明する。
- `sbintuitions` のラベル仕様・MIT・固定revisionの一次確認とCPU参照推論は完了した。[上流調査](upstream-model.md)、[変換手順](../model-conversion.md)、[モデルカード](../model-card.md) に分離して記録する。

## 出典

### OSS・モデル

- [nknytk/chrome-extention-jp-proofreader](https://github.com/nknytk/chrome-extention-jp-proofreader)
- [nknytk README（raw）](https://raw.githubusercontent.com/nknytk/chrome-extention-jp-proofreader/main/README.md)
- [nknytk manifest（raw）](https://raw.githubusercontent.com/nknytk/chrome-extention-jp-proofreader/main/manifest.json)
- [Proofly](https://github.com/onderceylan/proofly)
- [Proofly README（raw）](https://raw.githubusercontent.com/onderceylan/proofly/main/README.md)
- [Proofly manifest.config.ts（raw）](https://raw.githubusercontent.com/onderceylan/proofly/main/manifest.config.ts)
- [Proofly PRIVACY.md（raw）](https://raw.githubusercontent.com/onderceylan/proofly/main/PRIVACY.md)
- [Proofly LICENSE.md（raw）](https://raw.githubusercontent.com/onderceylan/proofly/main/LICENSE.md)
- [textlint](https://github.com/textlint/textlint)
- [textlint/editor](https://github.com/textlint/editor)
- [Transformers.js](https://github.com/huggingface/transformers.js)
- [Ruri v3 30M ONNX](https://huggingface.co/onnx-community/ruri-v3-30m-ONNX)
- [Japanese reranker xsmall v2 ONNX Web](https://huggingface.co/masahiroid/japanese-reranker-xsmall-v2-onnx-web)
- [ModernBERT NER CoNLL2003 ONNX](https://huggingface.co/onnx-community/modernbert-ner-conll2003-ONNX)
- [ONNX Runtime Web](https://onnxruntime.ai/docs/get-started/with-javascript/web.html)
- [ONNX Runtime Web WebGPU](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)

### 製品・公式ドキュメント

- [日本語誤字チェック Chrome Web Store](https://chromewebstore.google.com/detail/%E6%97%A5%E6%9C%AC%E8%AA%9E%E8%AA%A4%E5%AD%97%E3%83%81%E3%82%A7%E3%83%83%E3%82%AF/kimgghbenifpmkblkhngkbbgkdaaggmc?hl=ja)
- [Shodo](https://shodo.ink/)
- [Shodo 公式ブログ: ブラウザー拡張](https://blog.shodo.ink/entry/2021/09/01/151024)
- [Typoless ブラウザ拡張ガイド](https://typoless.asahi.com/guide/chrome-extension)
- [Typoless](https://typoless.asahi.com/)
- [wordrabbit](https://wordrabbit.jp/)
- [wordrabbit 機能紹介](https://wordrabbit.jp/blog/97)
- [Fude（筆）](https://www.increoscale.com/products/fude/ja/)
- [Chrome Built-in AI APIs](https://developer.chrome.com/docs/ai/built-in-apis)
- [Chrome Proofreader API](https://developer.chrome.com/docs/ai/proofreader-api)
