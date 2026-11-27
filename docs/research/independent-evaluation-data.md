# 独立実用評価データの実現可能性

確認日: 2026-11-27。これはM2の調査記録であり、新しいデータの取得、注釈、モデル実行、学習、外部連絡は行っていない。合成データ、JWTD由来データ、弱い自動ラベルだけで独立した実用精度を主張しない。

## 結論

現在の制約（課金なし、アカウント不要、外部連絡なし、ユーザーへの注釈依頼なし）では、業務メール・SNS・技術文書の3文体について、自然発生誤りと独立goldを備え、Kotoba Guardの評価に再利用できる公開データは確認できなかった。

最も現実的な候補は、技術文書については許諾を個別確認できるGitHub修正履歴、controlled評価については公開されている生成手順である。ただし、前者は自動弱ラベル、後者は合成誤りであり、どちらも独立した実用goldではない。メールとSNSについては、文体に近い資源はあるが、アクセス制限または誤字goldの欠如がある。

したがって、M2の受け入れ条件は未達のまま保持する。独立goldを確保できるまで、Precision 95%以上、Recall 80%以上、正常文の誤検出率2%以下という既存目標を、合成・JWTD・弱goldの結果から実用評価として表示しない。

## 候補の調査

### GitHub Typo Corpus: 技術文書の自然修正に近い弱gold

[公式リポジトリ](https://github.com/mhagiwara/github-typo-corpus) は、GitHubのcommitから誤り修正候補を抽出し、`src`、`tgt`、repository URL、commit、ファイルパス、言語、`prob_typo`、`is_typo`などをJSONLで提供する。日本語のMarkdownやドキュメントに絞れば、技術文書の自然な修正履歴に近い候補になり得る。

ただし、`prob_typo` と `is_typo` は抽出器による分類であり、全レコードの独立人手goldではない。本文とcommitの権利は元リポジトリの条件に従うため、単一のOSSライセンスとして扱えない。採用するなら、元repository、commit、ファイル、ライセンス、取得時点を個別にallowlist化し、許諾確認できるものだけを隔離評価する。全Corpusの一括再配布や、元本文を公開成果物へ含めることはしない。

2026-11-27の追加確認: [公式README](https://github.com/mhagiwara/github-typo-corpus#dataset)は`is_typo`を`prob_typo > 0.5`の予測結果と定義する。[公式論文](https://aclanthology.org/2020.lrec-1.835.pdf)の5.2/5.4節では、英語・中国語・日本語を各200件ずつ流暢話者が注釈し、そのラベルで言語別分類器を作って配布全件へ自動ラベルを付けたと説明する。この日本語200件の独立goldファイルを公開README・配布ツリーから取得できる根拠は確認できなかった。人手注釈を使った分類器と、配布レコードが人手goldであることを区別する。本文の取得・外部連絡はしておらず、M2の独立gold未確保という判定は維持する。

これは `natural` に近い弱gold候補であり、`practical` の独立受け入れgoldとは区別する。採用前に、誤り判定・誤り種別・span位置を2名以上がモデル出力を見ずに確認する必要がある。注釈者または既存の独立goldを確保できない場合は、技術文書の弱gold診断に留める。

### JGECM: BCCWJ由来のcontrolled評価

[公式リポジトリ](https://github.com/hideyoshikato/JGECM) は、BCCWJの文から助詞、語彙、表記、動詞などの誤りを生成する評価用コーパスで、誤りの種類と位置を持つ。リポジトリで公開されるCSVとスクリプトはCC BY 4.0と説明されているが、スクリプトでBCCWJを使って生成したデータはBCCWJの利用規約に従い、NINJALとの利用契約が必要とされる。

したがって、これは `controlled` の候補であり、自然発生誤りの実用評価ではない。BCCWJの契約や費用を確認せずにデータを取得・再配布しない。公開リポジトリのschemaと生成手順の調査だけは可能だが、実データの取得はM2受け入れ条件の確認後に限る。

### JFLEG-JA: 人手修正を含むが主にAI生成で、権利表示も不一致

[dataset card](https://huggingface.co/datasets/ronantakizawa/jfleg-japanese) は1,335文、validation 711文、test 624文、各4修正文を説明している。文法・流暢さのGECベンチマークであり、誤字脱字検出専用ではない。READMEは誤りの大半がGPT-4生成であると説明しているため、`natural` ではなく主に `controlled` と扱う。

さらに、READMEのライセンス表示はCC BY-NC-SA 4.0だが、Hugging Faceのdataset metadataはMITとなっている。この不一致を解消する一次的な権利確認なしに、評価データまたはOSS成果物へ取り込まない。商用・公開可能なライセンスが確定しても、既存の日本語誤字検出目標とは別のGEC補助評価にする。

### Japanese Business Email Corpus: 文体は適合するがアクセス制限とgold不足

[公式リポジトリ](https://github.com/Liumx2020/japanese-business-email-corpus) は、PACLIC 2023のビジネスメール資源を案内している。論文では社会的状況をもつメールを扱うが、誤字脱字のspan goldを提供する資源としては確認できない。

公式READMEはデータをリポジトリから直接配布せず、アクセス申請を必要とする。付属ライセンスも、許可を得た利用者の研究・評価利用に限り、元データ・加工版・注釈版を再配布できないとしている。外部連絡なしという現在の条件では利用候補に進めない。後日許可が得られても、メール文体の正常文候補または独立注釈の対象であり、誤字goldがあるとは推定しない。

### WRIMEとGSK正規化資源: SNS文体だが誤字goldではない

[WRIME公式リポジトリ](https://github.com/ids-cv/wrime) はSNS投稿に感情ラベルを付けた資源で、誤字・脱字・誤変換の正解spanを提供するものではない。ライセンスはCC BY-NC-ND 4.0である。

[GSK2025-A](https://www.gsk.or.jp/catalog/gsk2025-a/) はWRIME投稿にテキスト正規化情報を付けた資源を案内しているが、学術研究目的限定、利用申請、料金、配付条件がある。正規化は誤字検出goldと同一ではない。料金・申請・外部連絡を避ける現在の条件では取得候補にしない。

### Lang-8 / TEC-JL: SNS由来だが学習者GECで、日常日本語の独立評価とは別

[NAIST Lang-8 README](https://sites.google.com/site/naistlang8corpora/home/readme-raw) は学習者SNSの修正履歴をJSONで説明している。研究・教育用途限定で、商用利用には別途確認が必要であり、元データにはノイズが含まれ得る。

[TEC-JL](https://github.com/koyama-aomi/TEC-JL) はLang-8から作る日本語学習者GEC評価資源である。JWTDとは別ソースだが、日本語学習者の作文・文法訂正を対象とするため、日常のメール・SNS・技術文書に対する独立実用評価とは別に集計する。学習者データのライセンスと元データ条件を確認せずに採用しない。

### 技術書コーパス: 正常文候補だが校正済みgoldではない

[technological-book-corpus-ja](https://github.com/textlint-ja/technological-book-corpus-ja) は再配布可能な日本語技術書を集め、各文書のURLとライセンス情報を管理している。本文のライセンスは文書ごとにMIT、BSD、CC BY、CC BY-NCなどが混在する。リポジトリ自身が、文書が十分に校正されているかを収集条件にしていないと説明しているため、正常文goldとは呼ばない。

採用する場合は、商用・再配布条件を確認できる文書だけを抽出し、本文を公開評価資産に含めない。正常文の補助候補であり、自然誤りの検出Recallや正常文false-positive率の確定根拠にはしない。

### BCCWJ: 文体は広いが契約・コピー制限がある

[BCCWJ利用規約](https://clrd.ninjal.ac.jp/corpus-terms/BCCWJ1_TermsOfService.pdf) は、個人の研究・教育目的に限定し、申請書、データの複製・大量ダウンロードの制限、場合によっては年額利用料を定めている。個別データの権利も原著作者に帰属する。ブログ、フォーラム、業務報告など文体面では有用だが、誤字goldを持つ公開データではない。契約なしに取得・保存・再配布しない。

## 追加候補の確認（2026-11-27）

[LREC 2026 IME benchmarkの日本語データ説明](https://github.com/junli-cuny/llm-ime-benchmark/blob/main/data/japanese_error_dataset/README.md)は、Snow Simplified Japanese Corpus由来の文にローマ字の脱落・追加・隣接キー置換・転置をプログラムで加えたと明記する。[リポジトリのライセンス](https://github.com/junli-cuny/llm-ime-benchmark/blob/main/LICENSE)はMITだが、漢字変換後の自然発生誤字を人手で検証したgoldではない。元コーパスの権利も別確認が必要であり、M2の独立goldへ取り込まない。本文は取得していない。

[huytd189/japanese-grammar-correctionのcard](https://huggingface.co/datasets/huytd189/japanese-grammar-correction/blob/main/README.md)は、学習コミュニティからの手動選別とLLM合成を混合し、学習者向け文法・文体訂正を対象と説明する。metadataはBSD-3-Clause-Clearだが、cardには各例の出典・取得許諾・合成との区別・独立検証者の手順を確認できない。`already_correct`や`business_japanese`という分類名だけで正常文goldや業務メールの自然goldとは判定せず、取得・評価候補へ進めない。

[2026年の日本語GEC評価論文](https://www.anlp.jp/proceedings/annual_meeting/2026/pdf_dir/B9-21.pdf)も確認した。FLUTECはLang-8学習者文の流暢性を重視した再添削、NAIST誤用コーパスは学習者の課題作文であり、JWTDと同じ用途の母語話者3文体goldではない。既存候補の不足を埋める根拠にはならなかった。これらは候補を除外するmetadata確認であり、新しい実用評価を完了したという結果ではない。

## JWTD・モデル学習データとの重複

JWTDは日本語Wikipediaのrevision history由来であり、上記のGitHub、Lang-8、Business Email、WRIME、BCCWJとは一次ソースが異なる。ただし、同一文章や派生転載をゼロと推定しない。候補を採用する際は、URL、repository/page ID、commit、文書ID、NFC・空白正規化本文hash、near-duplicate fingerprintで重複を検査する。

SB Intuitionsモデルの学習・事前学習データに今回の候補本文が含まれるかは、公開資料だけでは判定できない。各候補について `training_overlap: unknown` を初期値とし、モデルの学習済みデータに含まれないと主張しない。JWTDのtrain由来開発データは独立評価に使わず、閾値校正専用にする。

## 取得前ゲートとゼロコスト候補

大規模取得の前に、以下のmetadata-onlyゲートを通す。

1. 出典URL、固定revision、取得日、データ件数、文体、gold形式を記録する。
2. 元データ・派生データ・評価結果の利用、再配布、公開範囲を確認する。
3. 料金、申請、ログイン、外部連絡の要否を確認する。いずれかが必要なら現在のM2候補から外す。
4. 既存JWTD・gold・モデル評価データとの重複検査方法を先に固定する。
5. 独立goldの作成者、注釈数、注釈手順、曖昧例の扱いが明示されているか確認する。
6. 本文をGitや公開artifactに入れず、許諾範囲内のローカル隔離とSHAだけを保存する。

現時点で追加費用・外部連絡なしに進められるのは、公開schemaの調査、許諾条件のmetadata整理、GitHub Typo Corpusの候補repositoryを個別allowlist化する設計、許諾済み技術書のclean候補設計までである。本文の大量取得、注釈、外部サービスへの登録はまだ行わない。

独立goldがないまま、自己作成のメール・SNS文、JGECMや類似の合成600例を「実用評価の達成」と扱わない。合成600例は実施していないし、実施してもcontrolled回帰として別集計する。

## 30Mモデルの採否

独立した自然goldが得られない間は、30Mモデルを開発用ローカル推論経路として維持するが、MVP完成・release candidate・正式公開の根拠にしない。JWTDでの既存未達、合成データ、弱goldの結果だけで閾値や品質目標を下げない。

独立評価が得られた後は、次を別々に判定する。

- 参照モデルの自然文体別Precision/Recall/正常文false-positive率
- QUInt8のreferenceからのF1差
- FP32/QUInt8のCPU・WASM数値parity
- 拡張機能の検出・表示・入力保持という製品挙動

参照モデル自体が独立評価で目標未達なら、量子化やthresholdだけで採用可とはしない。参照能力、別モデル、追加学習、用途限定を比較する次段階へ進む。追加学習はデータ権利、費用、再現手順、独立testを確認するまで開始しない。
