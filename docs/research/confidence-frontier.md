# M2: confidence閾値の全状態診断（事前登録と結果）

2026-11-27。目的は、固定30Mモデルのconfidence閾値だけで既存の開発用精度目標へ到達できる余地を確認すること。製品閾値0.5・モデル・採点・品質目標を変更しない。独立goldを確保したことにも、実用精度の受け入れにもならない。

## 固定入力・実行予算

既存M1の[採点感度診断](scoring-sensitivity.md)と同じdevelopment-v1の2,000例、4モデルの保存済みlogits、baseline・manifest・protocol・config・tokenizer・モデルのSHAを検証する。dataset SHAは`94f257e7968e496dd2ff043b7c58fa3a547a665e185b81e97d5c3384b7dcbdd1`、baseline SHAは`fe1926d09ac6051e8180ecf726e11cbc2335c843b85226eb2b2ac0311a727328`。新規推論・held-out参照・本文の出力・ネットワーク取得は行わない。

実装とtoyテストの後、cleanなsourceから全4モデルのcache診断を1回実行する。入力やbaseline不一致は出力前に停止し、条件を選び直して再試行しない。既存のM1結果と候補比較の実行予算は別であり、量子化・ブラウザ比較を再実行しない。

## 全状態の定義

既存`spans_from_logits`と同一dtype・計算順のsoftmax、argmax、通常token、confidence以上という包含判定を使う。confidenceの等値tokenは同時に除外する。定義域は閾値`[0,1]`。0、通常の非OK tokenの各confidenceをfloat64で直後へ進めた値（1以下）、1を昇順に列挙する。各区間の予測は一定なので、この代表点は定義域の全予測状態を網羅する。特殊tokenとOK tokenは境界を作らない。confidenceが1のtokenは閾値1でも残る。

除外で隣接spanが分離し、真陽性が増える可能性もあるため、結合済みspanを単純に消す方法やRecallの単調性を仮定しない。各境界で影響する文書だけ既存関数で再構成し、既存containmentの一対一対応と、文書ごとの完全なgold再構成のうちTP最大のbestを使う。曖昧goldを混合しない。全体countsと正常文の指摘有無を差分更新し、等値境界の途中経過を判定しない。toyでは全件の総当たり再採点と比較する。

## 出力と判定

全代表点のthreshold、TP/FP/FN、Precision/Recall/F1、正常文の母数・指摘数・率をJSONへ保存する。Precision95%以上・Recall80%以上・正常文誤検出2%以下を同時に満たす点の有無・件数を固定基準で出す。正常文母数0なら率不明・同時達成不成立とする。最大Recallと最大F1の代表点も保存し、同値は最小thresholdを選ぶ。最適点を新しい製品設定にはしない。

結果を確認する前に本条件をcommitする。合格点がなくても閾値・範囲・gold・採点・モデルを変えて診断を繰り返さず、30M参照能力と独立評価の不足として採否記録へ反映する。事前登録時点では数値結果は未測定。

## 実装時の検証

事前登録commitは`6479887`。`analyze_scoring_sensitivity.py`へopt-inの`--threshold-frontier`を追加し、既存の入力検証・baseline再現・source確認を共用する。単体10件とopt-in統合1件で未実装のRedを確認した後、span分離・等値の同時変更・特殊/OK token・confidence1・母数0・float32/64の包含境界・不正入力を実装した。既存scorerで各代表点を総当たり再採点し、一致を確認する。CLIも既定とopt-inの両方を実行し、本文を出力しないことを検査する。全Python374件が成功、Ruff check/formatとCLI helpも確認した。新しい全体coverageは未測定で、`8432112`の82.23%をこの変更へ付け替えない。

関連46テストの限定coverageは、この診断scriptのline193/207（93.24%）・branch70/74（94.59%）。`artifacts/coverage/confidence-frontier-6479887/coverage.json`は実装時の測定で、全28ファイルやclean sourceの実データ診断の証拠ではない。独立レビューでは包含境界、同時変更、非単調span、入力来歴、本文非出力についてblocking指摘なし。ここまでは実データ結果を見る前の検証記録である。

## 固定cacheでの結果（完了・実行予算終了）

clean source `d9c44d62f0e08e0df103792f24fc7b5231421d48`で、登録した4モデルの診断を1回実行しexit0。`baseline_reproduced=true`、`canonical_development_v1=true`、`inference_performed=false`を確認した。全モデル・全代表点で3目標の同時達成は0件だった。

| モデル      | 代表点数 | 最大Recall（TP / gold） |   最大F1 | 最大F1時のPrecision / Recall | 最大F1時の正常文指摘 |
| ----------- | -------: | ----------------------- | -------: | ---------------------------- | -------------------- |
| PyTorch     |    1,340 | 687 / 1,027（66.89%）   | 0.719017 | 79.64% / 65.53%              | 55 / 1,000（5.5%）   |
| ONNX FP32   |    1,340 | 687 / 1,027（66.89%）   | 0.719017 | 79.64% / 65.53%              | 55 / 1,000（5.5%）   |
| ONNX QUInt8 |    1,332 | 672 / 1,027（65.43%）   | 0.704034 | 76.19% / 65.43%              | 66 / 1,000（6.6%）   |
| ONNX FP16   |    1,340 | 687 / 1,027（66.89%）   | 0.719017 | 79.64% / 65.53%              | 55 / 1,000（5.5%）   |

最大Recallの最小閾値は全モデル0。最大F1の最小閾値はPyTorch `0.4897576272487641`、FP32 `0.4897578060626984`、QUInt8 `0.30381053686141973`、FP16 `0.49350848793983465`。これらは診断結果であり製品の設定値として採用しない。代表点数は0と1を含み、同じ予測になる端点があっても別の代表点として記録する。全1,000正常例・1,027 gold eventを保持し、個別文やIDは出力しない。

この固定データ・argmax・span結合・best採点仕様では、単一の全体confidence閾値だけでRecall80%へ到達できない。粗い閾値列の間に受け入れ点を見逃した、という仮説を否定する。ラベル別閾値、別モデル、学習、自然な実用文体での性能を実測した結果ではなく、独立gold不足も解消しない。M2/R03は診断前進・製品未達、M5は未達を維持する。同じcacheで閾値を再走査しない。

証拠: `artifacts/confidence-frontier/d9c44d62f0e08e0df103792f24fc7b5231421d48/sensitivity.json`と`summary.md`。JSON SHA-256は`760332d590016790b51429e4793715886cd5fa20b7fd7b1dd465330ea973e049`。全境界点のcounts、固定targets、maxima、cache・モデル・tokenizer・採点・診断sourceのSHAを保存した。runtimeや既存ZIPは変更していない。

独立した結果監査でも、JSON SHA・source/診断script SHA・baseline互換性・cache来歴・全点の昇順/非負counts/母数・maxima・目標達成0点・本文非出力にblocking指摘なし。M2の製品受け入れは別であり、この結果を合格へ読み替えない。
