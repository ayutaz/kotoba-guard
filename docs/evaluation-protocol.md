# JWTD評価仕様 v1

2026-11-27、実モデルのコーパス推論前に仕様を固定する。機械可読な定義は [jwtd-v1.json](../benchmarks/protocols/jwtd-v1.json)。これはSB Intuitionsの公表した評価の考え方を参考にした本プロジェクトの再現仕様であり、非公開の前処理・採点コードと完全に同一とは主張しない。

## データと分割

京都大学JWTD v2の公式testを最終評価として維持する。学習側から固定抽出した開発用データで閾値を選び、test/goldの全ページ・正規化本文との重複を除外する。開発用データはモデル学習に露出した可能性があり、独立評価ではなく較正に限定する。事前学習でのWikipedia露出は不明。

元データのdiffは絶対位置を持たない。全diffの置換で修正前文から修正後文を再構成する。同じ文字の重複などで複数の位置が等価な場合、成立する全ての**組み合わせ**を保持する（探索10,000訪問まで）。再構成不可能・モデル未定義カテゴリ・探索上限超過はIDと理由をquarantineへ記録し、元の件数と評価対象数を必ず併記する。goldには誤りカテゴリがないため推測せず、修正後文の誤検出を補助評価する。本文・rawデータ・生成レポートはGit管理しない。train/testの各採用pairは修正前の誤り文と修正後の正常文の2例とし、母数を区別する。

## 採点と公開目標

主指標は、1件のdiffを独立した誤りeventとして保持した、ラベル付き包含のPrecision/Recall/F1。予測範囲がgold範囲全体を含み、ラベルが一致すれば候補matchとする。二部グラフの最大一対一対応を求め、1つの広い指摘を複数誤りの正解として再利用しない。脱字の0幅gapは包含を両端込みで判定する。文書間で同じoffsetを共有しても別eventとして数える。

等価な修正位置がある文書では、一つの成立する組み合わせ内で一対一match数が最大のものを選ぶ。異なる組み合わせの位置を合併して得点しない。ラベル別集計も同じ選択に従う。位置のみの補助指標は位置matchで選び、raw完全一致・token投影の診断は決定的な先頭の組み合わせを使う。曖昧文書数を出力する。この方式は実推論前のデータ整備でtestの539/5,440文が複数位置を持つと分かったため固定したもので、モデル結果を見て変更したものではない。

位置のみの包含、raw文字範囲の完全一致、tokenへ投影したspan、token分類、ラベル別、文書内の一部/全誤りの検出を別々に出力する。token投影の衝突・未被覆は件数を記録し、主指標からその文書のeventを除かない。0幅gapのtoken診断では含有token、文末では末尾の通常tokenへ割り当てるが、これは独自の明示的な診断規則であり、公式ラベル生成の再現とは扱わない。

正常文誤検出率は「1件以上指摘された正常文数 / 正常文数」。正常文数0は未定義とし、受け入れを失敗にする。公開目標はPrecision95%以上、Recall80%以上、正常文誤検出率2%以下、正常文1,000件以上、QUInt8のF1低下0.01以内。FP32最大logit差0.001以内も変換検査する。Wilson95%区間は記述的な二項区間で、ページ相関や一般文章への外挿を保証しない。

公式例に対応するargmax非OK（閾値0）を別に保存する。製品向け閾値は開発用データで0.5/0.6/0.7/0.8/0.9/0.95/0.99を比較し、Precision/Recall/誤検出目標を満たすものからRecall、Precision、低い閾値の順で選ぶ。該当なしなら0.5を診断用に維持し、不合格のままとする。最終評価で閾値を選び直さない。

## 実行と証拠

固定したモデル・Tokenizer・データ・評価コードのSHAをlogits cacheへ記録する。cacheの入力・内容hashが違えば再利用を拒否する。特殊tokenを除いたargmax一致率とlogit差を比較し、非有限値・shape/offset不一致・系列長超過を失敗にする。8192を超えた入力を切り捨てて成功扱いしない。

実装は [corpus_evaluation.py](../scripts/corpus_evaluation.py)、[run_corpus_evaluation.py](../scripts/run_corpus_evaluation.py)。実行手順と結果はデータ準備後にstatusへ追記する。既存の合成40文の変換回帰ゲートは別の証拠として維持する。

## 開発用cacheの採点感度診断

`scripts/analyze_scoring_sensitivity.py`は新たな推論をせず、固定した開発用cacheのcanonical/best/worstを比較する。bestは既存評価を全項目で再現する。worstも文書ごとの完全な再構成を選び、異なる再構成の位置を合併しない。ラベル付きと位置のみの主指標はそれぞれ選択し、ラベル別集計はラベル付き指標と同じ再構成を使う。raw exact・token投影・token指標は全方式でcanonicalのまま保持する。

```powershell
uv run --locked python scripts/analyze_scoring_sensitivity.py `
  --dataset artifacts/corpus/jwtd-v1/development.json `
  --dataset-manifest artifacts/corpus/jwtd-v1/manifest.json `
  --protocol benchmarks/protocols/jwtd-v1.json `
  --baseline artifacts/corpus-evaluation/development-v1/evaluation.json `
  --cache-dir artifacts/corpus-evaluation/development-v1 `
  --upstream-dir models/upstream/8d640720bddeb64c89dc1fa7780c3ea29fa523e8 `
  --converted-dir models/converted/8d640720bddeb64c89dc1fa7780c3ea29fa523e8 `
  --output artifacts/scoring-sensitivity/NEW-SOURCE-COMMIT
```

実行前にcleanなsource commitを確認し、出力先名へ記録する。CLIは既定でGitのclean状態を要求し、診断元commitと状態を保存する。実行中のcommit/状態の変化も拒否する。baseline自体は凍結SHA `fe1926d09ac6051e8180ecf726e11cbc2335c843b85226eb2b2ac0311a727328`へ固定する。入力SHA・sidecar・重み・両方のTokenizer/config・凍結採点関数との互換性を照合し、best再現後にJSONとMarkdownを書く。欠落cacheからの推論へのフォールバック、held-out利用、既存出力の上書きは行わない。本文はレポートに含めない。この診断だけでは製品精度の受け入れを確立しない。

小さなfixture等の別baselineは`--baseline-sha256`で別の期待SHAを明示し、レポートの`canonical_development_v1`がfalseになる。`--allow-dirty-source`も診断限定の明示オプションで、実際のdirty状態を保持する。Gitなしのarchiveではこのオプションを指定した場合だけ`commit: unknown / clean: false / git_unavailable: true`としてfixture診断できる。既定のsource bindingは失敗する。これらを使った試験はcleanな凍結baseline再集計の証拠にしない。

### confidence閾値の全状態診断

`--threshold-frontier`を明示した場合だけ、上記と同じ検証済みcacheで閾値`[0,1]`の全予測状態を追加集計する。[事前固定した条件](research/confidence-frontier.md)に従い、同値confidenceの変更を同時処理し、token除外によるspan分離も再採点する。`models.<name>.threshold_frontier`へ全代表点と固定目標の達成点数を保存し、既存の`modes`は維持する。出力先は新しい`artifacts/confidence-frontier/<source-commit>/`を使う。製品閾値や品質目標の変更・独立実用評価の代替には使わない。
