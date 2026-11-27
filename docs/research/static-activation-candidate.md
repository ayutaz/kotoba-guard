# M3: 固定activation量子化の限定候補

事前登録: 2026-11-27。以下は実行前に固定した条件。後述の`35d0a1b`の1回で数値ゲートに失敗し、この候補は不採用・終了した。閉じた[attention出力hybrid](attention-output-hybrid.md)の再試行ではなく、全activationの量子化パラメータを固定する別仮説である。配布runtimeと既存の失敗記録は変更しない。

初回の登録commit `5b3ccbe`にはrootの指定と異なる調査用文案が混入した。モデル実行前のレビューで確認し、`f50ac89`で条件を訂正した。初回commitは履歴として保持し、実行条件には使わなかった。訂正時点では実行予算を消費していなかった。

## 根拠と限界

[ORT公式](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html)では、static方式は校正データからactivationのscale/zero-pointを事前計算し、dynamic方式は入力ごとに計算する。Transformerには通常dynamic方式を推奨しており、本案の精度・速度の優位性は未検証。[ONNX QuantizeLinear opset13](https://onnx.ai/onnx/operators/onnx__QuantizeLinear.html#quantizelinear-13)のscalar FLOAT scale/UINT8 zero-pointと丸め・飽和を使う。

[block5診断](block5-parity-diagnostic.md)では、既に微小float差のある入力でDQLの整数1要素差が観測された。固定scaleなら入力別min/max計算による感度を除ける可能性がある。ただし固定QuantizeLinearにも丸め境界があり、上流float差や最適化差は残る。数値一致の保証、kernel故障の説明、参照モデル自体の精度改善とはしない。

## 変更と校正を固定する

- 入力モデルはsanitized QUInt8、SHA `dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`、元revision `8d640720bddeb64c89dc1fa7780c3ea29fa523e8`。
- 全42個のDynamicQuantizeLinearを、同じactivation入力とquantized出力名を持つQuantizeLinearへ置換する。元のscale/zero-point出力名にscalar initializerを追加し、consumerを維持する。42個のMatMulInteger、embedding、全既存initializer、対象外nodeは変更しない。実際の結合・型・名前衝突・共有を検査し、曖昧なら拒否する。
- 校正は既存`artifacts/corpus/jwtd-v1/development.json`（SHA `94f257e7968e496dd2ff043b7c58fa3a547a665e185b81e97d5c3384b7dcbdd1`）だけを使う。manifest SHA `0ee9a84e9c81597ee5f3fe2421d9f695c01818a586d49a5a98fbef5dbf8279be`も照合する。train-exposed・非独立の64 examplesで、SHA-256(item ID)昇順の先頭を結果を見る前に選ぶ。全itemのtrain属性を検査する。
- Tokenizer SHA `6a0734cf21c802169defaffe719bc2ef12bb9d0be37e54b61ed27aa89394723d`。単文、batch1、128 token上限の固定truncation（特殊tokenを含む）を使用する。paddingは行わない。ID/maskと選択IDのhashを記録し、本文・token文字列をログ/Gitへ出さない。
- CPU ORT1.32.0、disabled、intra/inter1で元QUInt8の42 DQL入力float32を1回ずつ捕捉する。全64例のfiniteな値を各入力のMinMaxへ集約し、0を含める。scaleはFLOAT `(max-min)/255`、zero-pointはその格納scaleに対するnearest-evenの`-min/scale`を0..255へclipしたUINT8。全0の場合はscale1/zero0。正のfinite scaleへ表現できなければ拒否する。
- 校正はFP32モデルの通常static変換ではなく、既存QUInt8経路のactivation範囲を固定する実験である。変換後は下流activation分布が変わり得る。短い校正文によるclipping・長文での範囲不足、精度低下の可能性を保持する。固定64例・test/goldの入力や出力を校正に使わない。
- 準備済みtrainのpage/正規化pre/post除外方針に加え、校正64例と固定64比較fixtureのID・pair・NFC/空白正規化textが重複しないことを拒否検査する。比較fixtureは重複検査にだけ読み、選択順序・校正統計へ使わない。ID一覧自体を通常Gitへ追加せず、両集合のhashと重複件数0をmanifestへ保存する。
- 校正用scratch graphと候補は新しい出力先だけに書く。最初の校正1例で、元QUInt8グラフと校正出力を追加した同じグラフのlogitsを別途比較し、dtype/shape/finite・最大差0.001以下を要求する。これは計測の健全性ゲートであり、候補との関数保存の条件ではない。超過なら校正・候補比較を中止し、最適化や校正件数を選び直さない。捕捉はkernel原因の診断ではない。

## 実行予算と判定

TDD、関連回帰、Ruff、独立レビュー後にsourceをcommitし、clean sourceで実行する。校正64例1回・変換1候補・CPU基準64例1回・WASM64例1回が上限。実装不具合は数値比較前に原因・失敗を残して修正する。比較後にcalibration件数・順序・範囲・対象層・最適化・閾値を変更して再試行しない。

既存の固定64例fixture（SHA `4bc05c93b39be219eeff70f57a8da18fd85271b74fec4be4a156800f49e72f47`）の本文・ID・mask・offset・順序を保持し、新しいCPU logitsだけを別fixtureへ保存する。CPUはdisabled/intra/inter1、WASM ORT Web1.31.1は通常要求all・1 thread。新しいdtype検査を使う。モデル50MB以下、全例の実float32/shape/finite、入力一致、通常token logit差0.001以下、argmax/span不一致0、監視登録後の外部通信/page error0を必要条件とする。

失敗したら不採用とし、精度2,000例・性能・メモリ・通常offscreen/workerへ進まない。成功した場合も、その各段階は別途条件を固定して評価する。校正データを含む開発用精度は独立性能ではなく、M2の独立gold・実用精度を満たす証拠にしない。M5の全条件と正式公開の許可範囲は維持する。

CPU/WASMの数値一致は同じ候補の実行再現性だけを判断する。固定化によりモデル関数は変化するため、元QUInt8とのlogit0.001以内という関数保存は本案の条件ではない。元referenceからの差は別診断として保持し、数値一致しても精度維持とは呼ばない。先へ進む場合はPyTorch参照に対するF1低下0.01以内、実用Precision/Recall/正常文誤検出率を別々の必須ゲートとして評価し、両実装が同じ誤答を返す候補を採用しない。

出力先は`artifacts/candidates/static-activation/<source-commit>/`。sourceとmodel/dataset/tokenizer/protocol SHA、選択hash、校正条件、42個の結合・範囲・scale/zp、対象外不変性、候補SHA/bytes、ツールversion、CPU/browser reportを保存する。重み・本文付きfixture・raw logは通常Gitに含めない。元runtime81資産と既存ZIPのSHAを実行前後に照合する。

## 実装検証（実モデル実行前の記録）

`scripts/static_activation_quantize.py`と2つの専用test fileを追加した。初回module欠落のRed後、root独立契約4件、長文・train属性・manifest/scratch保護・cleanupの5件、共有q/切断scaleの2件、Git sourceとruntime入力metadataの7件もRedを確認して修正した。修正後のみGreenを確認した追加回帰は、このRed件数には含めない。

全Python358件・関連60件と全Ruff check/format、直接CLIの`--help`が成功。小型ONNXによる実ORTの捕捉→変換→CPU推論も成功した。実モデルの構造だけを別途読み取り、DQL→MMI→Cast→scaleの42接続が一意に対応すると確認した。この実装確認時点で実モデルの校正・変換・比較は0回だった。

CLIはSOURCE_COMMITと現在HEADの一致・clean状態を校正前と出力前に検査する。全入力SHAとproductionの64例/128 token、42経路を固定する。fixture用APIの明示的なhash/count指定とは区別する。新scriptをcoverage宣言へ追加したため対象は28ファイル。従来27ファイル81.40%は過去sourceの結果で、新28ファイルの全体coverageは未測定である。

実行はソースcommit後のclean状態で、元runtime/ZIPの81資産を照合してから開始する。配布モデル・通常UI・ZIPは変更しない。巨大モデル・本文付きfixture・raw logはGitに含めない。

## 実測結果: 35d0a1b — 不採用・終了

clean source `35d0a1bc3b226d5e05f902f255cec1632c42e086`で、登録した校正64例1回・候補変換1個・CPU基準64例1回・WASM比較64例1回を完了した。CPU ORT1.32.0はdisabled/intra/inter1、WASM ORT Web1.31.1は要求all/1 thread、Chromium159.0.8154.6・Node24.15.0・Windows x64。内部optimized graphは観測していない。

| 項目                                            | 実測                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| 候補サイズ                                      | 37,792,088 bytes                                                   |
| 候補SHA-256                                     | `42aeaa2708a22f753e5dba41f555452d5543bd48e066c42e81dc1e6093955850` |
| 校正                                            | train64例、DQL入力42個、paddingなし、上限128 token                 |
| 校正選択ID SHA                                  | `f6ccbad512daa9045a79d152288edf027fb0c6054f7db6b811600a93cefb8936` |
| 比較集合とのID/pair/正規化本文の重複            | 0 / 0 / 0                                                          |
| 最初の校正例・捕捉前後logit最大差               | 0                                                                  |
| 変換                                            | DQL42→0、固定QuantizeLinear42、MMI42を保持                         |
| 対象外node・全既存initializer・embedding        | byte/fingerprint不変                                               |
| CPU/WASMのID/mask/offset/shape/実float32/finite | 全64例で一致                                                       |
| 通常token logit差0.001超過                      | 25/64例、最大2.7389049530029297                                    |
| argmax不一致／検出span不一致のある行            | 2/64例 ／ 1/64例                                                   |
| 監視登録後の外部通信／page error                | 0 ／ 0                                                             |
| 校正変換／CPU基準／browser終了コード            | 0 ／ 0 ／ 1                                                        |

failureは基準別28件（logit25・argmax2・span1）で、重複を除く失敗行は25件。元fixtureのlogits以外の全field・順序が不変で、新CPU logitsだけを保存した。CPU/WASM両方で強化後のraw float32検査を通過した。初期化前の全startup通信や通常offscreen/workerを検証した結果ではない。

元runtimeと隔離runtimeの基礎81資産は、実行前後とも`0dc814c`のZIPと一致した。候補は隔離コピーへ追加しただけで、配布モデル・通常UI・既存ZIPは更新していない。source checkout・元モデル・dataset/manifest・Tokenizer/config・protocol・比較fixture・校正feedのSHA、42接続と不変性、tool versionは変換manifestへ保存した。

この条件ではactivation範囲を固定しても数値一致しなかった。旧候補との件数差を一般的な改善とは呼ばず、kernel原因や精度維持も証明しない。**登録予算は終了。不採用。** disabled fallback、校正順序・件数・範囲や対象層の変更、精度2,000例・性能・メモリ・通常workerの評価へ進まない。M2の独立gold・実用精度とM3の数値／性能、M4 native/実サービス/remote等の未達は残り、M5公開候補は未成立。

成果物: `artifacts/candidates/static-activation/35d0a1bc3b226d5e05f902f255cec1632c42e086/`。モデル・本文付きfixture・raw logは通常Gitに含めない。

- 変換manifest SHA: `fadc7b28084a5d1d226ed451ba365686d52963204d3f57cecbd7e76347698737`
- build-control SHA: `95b9dbb17b3b8377078d4fb1aeb1487a0fbbd00a1cb7f5562cdca999c798743d`
- CPU fixture SHA: `aacc26869e1b5e2f4a851860209fbd627b5a0192bae21ebfeb40664142d174be`
- CPU report SHA: `3d0bb934f25e840609c5b5a0db353d6d6b56315bc9c73f065762151124178b4b`
- browser report SHA: `0ecb39468619df923955bb566ee2fdbfc7732243e95bc4f808828f6396fefa77`
- observations SHA: `70cd133ce4da2d5fcc0c159cb3e9097e721f04bdebc977e7af39a0d6065d0d56`

独立レビューでも件数、dtype・入力、source/runtime、モデル／manifest、81資産と閉じた予算の整合を確認した。

## 全体coverageの初回失敗とハーネス修正

同じ`35d0a1b`の新28ファイル測定は、unitの共通basetemp `.cache/pytest-coverage-harness`の既存フォルダーを削除する際にWinError5となり、148 passed・210 setup errors、終了コード1で停止した。後続8コマンドは未実行で、coverage合格にしない。失敗は`artifacts/coverage/python-overall-35d0a1bc3b226d5e05f902f255cec1632c42e086/`へ保持した。

共有フォルダーの削除・ACL変更は行わず、測定outputのSHAから導いた新しい短い`.cache/coverage-pytest/<20hex>`を使う修正をRed1件→関連16件Greenで確認した。起動失敗の記録3経路もRed→Greenで補強した。既存tempは拒否し、出力・過去coverageを再利用しない。

修正source `d7f100c67a34bd60765a5a9b81d3f84efddbcd51`の測定では、rootがtemp親フォルダーの作成を漏らしていたためFileNotFoundError/WinError3となり、145 passed・216 setup errorsで停止した。後続8コマンドは未実行。この失敗も別outputへ保持した。親なし状態から実pytestのtmp_path書込fixtureを起動する回帰でRed1を確認し、親作成を追加して関連20件がGreenとなった。次のclean sourceで全9コマンドを別outputへ実行する。候補の校正・数値比較は再実行せず、候補結果のsource `35d0a1b`も付け替えない。

後続のclean source `8432112e94144d558a4812c2e65ed7b7fb8ea52e`で[全28ファイルcoverage](../python-coverage.md)が成功した。全9コマンドexit0、unit362件、line3,859/4,693（82.23%）・branch1,372/1,888（72.67%）。static変換器自体は412/510 lines（80.78%）。通常pytest cacheの保存ACL警告1件は残した。旧失敗・除外・閾値を変更せず、候補再実行やLinux／通常runtimeの再検証には数えない。レポートSHAは`d469bb90b9e9dec0f5ad9add040073b516933d839e7acd30ea76f44e86dd9f35`。測定後もcanonical81資産のSHA不変を確認した。
