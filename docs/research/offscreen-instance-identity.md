# Offscreen instance識別子の照合

2026-11-27事前登録。起点はdocs29882da / runtime72236f2。[前回の機能成功と残る制約](offscreen-brokered-identity.md)からの新しいsecurity条件。過去のモデルなし/idle/resource予算は再実行しない。

## 実装と単体条件

[ADR-0010](../adr/0010-offscreen-instance-identity.md)に従う。文書ごとのimmutable crypto.randomUUID、SW専用のinstance probe、before/probe/afterのdocID照合、callerごとの識別子比較、厳密な二/四キーschema、全体5秒の単一実照会、close lease、retiringのfail-closedを検証する。

TDDはoffscreen entryでRed10件、専用probeでRed2件、lifecycleでRed8件、背景境界でRed6件。期限後に次APIを開始していた点は追加Red1件を保存して修正した。最初のlifecycle Redでは早期に解決したrejects assertionに未処理rejectionが出たため、結果を先に捕捉するテストへ直し、Red8件・unhandled0を改めて保存した。機能assertionは維持した。正しい/古いcallerの同時照会、null sender+current ID+古い識別子、文書交代、probe欠落/不正/余分なkey、late resolve/reject、退役中の応答、crypto API欠落を含む。

全TS/check・coverage・独立レビュー後、clean source/runtimeと全81資産を固定する。model/hash/文章/閾値/権限は変更しない。

## A: モデルなし・実message経路

新script/outputで**1 browser、2文書世代、推論0、body45秒・cleanup5秒・総予算60秒、retry0**。

1. 固定URLの診断routerから同梱の実製品offscreen.jsをロードする。背景Service Workerの実URLはbackground.jsを維持し、背景/Offscreen JS bytesを変更しない。identity probeとstatusの識別子が有効・同一、ready=falseを確認する。識別子はbrowser内の一時メモリにだけ保持する。文書を閉じ、消失を確認する。
2. 次の文書で診断stubをロードし、新しい識別子を生成する。前文書の識別子が異なることを確認する。現在の識別子によるidentifyは成功、古い識別子によるidentifyは拒否、**現在のdocumentIdと古い識別子を組み合わせたidle**はclosed:falseで文書を維持する。その後、現在の識別子でidle通知し文書0を確認する。
3. 最大identify2回/idle2回、strict schema/送信元metadata/release整数4値/UUID有効性とredactedな判定結果を保存する。raw instanceIdはreport・ログ・storageへ出さない。送信元documentIdはnullまたは一致であること。失敗時も観測済みの結果だけを残し、未観測値を0で補完しない。

fixtureは背景/Offscreen JS・icon・router/stubだけとし、model/tokenizer/WASMを含めない。製品JSの第一段階と、古いmarkerで製品背景を攻撃する第二段階の範囲を区別する。診断stubだけで実製品の全退役経路を成功扱いしない。source/tree/clean、script/fixture/hash、製品81資産の前後不変、cleanup/web errorを保存する。A成功前にBを開始しない。

## B: 実モデルの新protocol機能確認

A成功後、別のsource-bound outputへ**1試行、2推論、1idle周期、2文書世代、test180秒/body120秒、idle85秒、control/cleanup各5秒、retry0**で実施する。通常配布の固定QUInt8/WASM1thread、同じ誤字文章を使う。初回検出span13–15、本文保持/非保存、idle後の通知schema/ACK completed1・失敗0/文書0、次の入力の新documentIdと同じ検出を確認する。raw markerは保存しない。

新protocolを実モデルで通すsecurity機能試験であり、前回の4推論/2周期/OS6sample資源試験を再実行したり短縮して合格させたりするものではない。OS process比率・メモリ改善・長期上限は測らず、資源問題の未達を維持する。通常回帰10件（resource idleを除く）は別途、出力を分けて検証する。

## 証拠・停止

clean source/runtime、全81資産/モデルSHAを前後照合し、旧72236f2のsmoke16ファイルreceipt `3fd398afbc67e70ed3e208113b149679ec934fd99159967fe2a683c0869dbb5f`、実モデル70ファイルreceipt `207978339cb2fb13976ca1b02e408c8fa50bb21ad55c3ad6e51daf5e6cc38daf`、通常回帰24ファイルreceipt `221edafc33131fd16a59d08fb520afe8867c60592164eeb340d050d188866b6e`と各実ファイルを維持する。旧ZIP/source、旧失敗・heap証拠も保持する。

それぞれ成功/失敗で予算終了。失敗したら後続laneへ進まず保存し、同条件のretry・時間延長・追加推論を行わない。結果の外側bindingと独立レビューを行う。A/Bに成功してもM2精度/独立gold、M3数値/性能、資源問題、他OS/最低Chrome/全context監査、native IME/権限/実サービス、remote CIとM5は未完了。

## 結果: instance世代照合と実モデル機能は成功

clean source/runtime `0e13b127cbb79f0ad799b97d1521660919f23657`、tree `129645530ab5fdd94deb24ed7c46a2168ef880da`で実施した。Windows、Node24.15.0、Chromium159.0.8154.6、通常配布QUInt8/WASM1thread。元モデルrevision `8d640720bddeb64c89dc1fa7780c3ea29fa523e8`、同梱QUInt8は37,789,676bytes / SHA `dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`で不変。後続の文書commitへ実行sourceを付け替えない。

単体は全39ファイル380件、npm check、build、配布検証（modelFiles5/distributionFiles80）が成功。全entrypointを含むcoverageはstatements88.85%（1555/1750）・branches83.77%（1053/1257）・lines91.36%（1439/1575）、SDK statements92.42%・lines94.56%。platform cryptoがUUID以外を返す追加Red1件も保存してfail-closedへ修正した。初期のRed/Green途中失敗、期限後API開始、未処理assertionの訂正logも保持した。Python・精度・WebGPU・OSメモリは今回再測定していない。

### A: モデルなし

1ブラウザ・2文書・推論0・retry0の1試行が2,561.6899msで成功。第1文書では実製品offscreen.jsのinstance probeとstatusが有効かつ同一でready=false。第2文書のstubから、現在markerでidentify成功、旧markerでidentify拒否、current documentId＋旧markerのidleにclosed:false、その後current markerのidleで文書0を確認した。

identify順はcurrent/old、idle順はold/current。送信元documentIdはどちらもnullで、strict二/四キー・release四値（completed1/他0）・新旧文書/marker差を確認した。probeCountBeforeOwnIdle=3は最後のcurrent idle送信**前**のsnapshotであり、最終closeを含む総probe数ではない。raw markerはbrowser private memoryだけに保持し、report/log/storageへ出していない。web error0、cleanup成功、source/head/treeと製品81資産・fixture12ファイルが前後一致。

scopeは第1段階が製品Offscreen、第2段階が製品backgroundへの診断stubによる旧marker攻撃。stubだけで実モデル退役の全経路を成功扱いしない。

### B: 実モデル

Aの固定control/report/receiptを照合してから、別出力の1試行が成功。body68,075.9998ms、総68,859.5706ms、2 check要求・2検出、1idle周期、2文書世代、retry0。初回と再開後の検出はUTF-16 span13–15、backend WASM。旧markは2回目入力の同一evaluate内で消えたことを確認し、checkCount2と新しいready/markを待った。古い表示を再検出として採点していない。

idle通知はtotal/valid/matching marker/matching document各1件。Worker dispose ACKはcompleted1/failed0/timedOut0/sendFailed0、その後modelReady=false・実document0を確認。ここでの「ACK」はWorker解放件数を指し、Offscreen close返信のclosed:trueを直接収集したという意味ではない。次の入力で別documentId・別markerとなり、各世代でprobe/statusのmarker一致をbrowser内だけで比較した。

初回・idle後・再開後の本文保持、設定2キーだけのstorageと本文非含有を確認。監視開始後のunexpected request/page error/WebSocketは各0。browser context339.8943ms/server1.1021msでcleanup成功。監視は初回fixture navigation後からであり、全起動経路の通信監査ではない。fixture拡張コピーは削除せず、外側binderの照合証拠として保持する。browser/serverの終了と証拠ファイルの保持を区別する。

OS process/heap/資源比率は採取していない。前回72236f2の資源問題を修正・再合格させた結果ではない。A/Bとも登録予算は終了し、同条件のretry・追加推論を行わない。

### 通常回帰と外側照合

通常回帰はmock4・real6の計10件が113,361.802msで成功。skip/retry/flaky0。IMEイベント・機密入力・XSS表示・手動/自動・再起動/無効化・Undo/Redo/長文と24組の連続編集を含む。resource idleは重複実行しない。旧出力を守るためmanual specの出力prefix6箇所だけをコピー内で変更し、他のtest/helper bytes・assertion・timeoutは不変。実際に書かれたconfig bytesをhashした。

stressのpermission removalはfixture pregrantにより`permission-remove-failed`であり、native権限解除成功にはしない。通信0もpost-listener scopeに限定する。新runtimeのLinux/最低Chrome/全監査をこのWindows回帰や旧sourceの成功から推定しない。

各laneは実行前bindingを保存し、実行後のsource/tree/clean、script/fixture、全81配布資産、固定モデル、旧722の16/70/24証拠receiptと各ファイル、旧ZIPの前後不変を外側で照合した。Bのfixtureはmanifestのfixture host grantだけが異なり、他80資産は同一。raw markerをreportに含めないことも確認。独立レビューでは初回にprobe snapshot位置を誤読した指摘を再読で撤回し、最終A/Bの成功条件・scopeにblockingなしと確認した。B試験コードのpreflight/schema/sort/期限/部分証拠の不足は**実行前**に修正した。ブラウザ試行のretryではない。

## 保存先とSHA-256

| 対象                                  | 保存先（artifacts以下）                                                    | report SHA-256                                                     | receipt SHA-256                                                    |
| ------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| A: 86証拠（fixture12を含む）          | `offscreen-instance-smoke/0e13b127cbb79f0ad799b97d1521660919f23657/`       | `519998c78d9e3fdda2d35383d0c868718c62c90e37eea316bee5f61c739f4c2e` | `fcf553f17561c5da0a8bb8713facf4eb6233f32efa4c029ffbb8b26c2cff3144` |
| B: 9証拠                              | `offscreen-instance-real/0e13b127cbb79f0ad799b97d1521660919f23657/`        | `96765e5099b4eb7f2d6d7272643849bdb024746d99c0ce4db4453b41ba2fc5a0` | `570853bb676bd5631d9611f716d291768edae4680c77f1c7ad789abbcf916ac4` |
| 通常回帰: 27証拠                      | `offscreen-instance-regressions/0e13b127cbb79f0ad799b97d1521660919f23657/` | `playwright.json`とsource-bound controlを参照                      | `2ac9df3a2b19460725e9852a79ed730f7f9d97a50f97567ec87e070c69a8f3b6` |
| runtime81資産＋control/script: 83証拠 | `runtime-baseline/0e13b127cbb79f0ad799b97d1521660919f23657/`               | `runtime-control.json`を参照                                       | `b3fd34d72f1ba39b466f6c8c47f4a7af7012f98738c56efb4ed50e226a025b4f` |

証拠、coverage、実行script、fixture、runtime baselineはignoredなローカル成果物で、Gitへ巨大モデル・report本文を追加しない。旧ZIPはsource0dc814c、53,015,274bytes / SHA `5f07c72e220f3fc6a68da9d309e84198671382a6572f4ae4c6ea2e10ef6f9aae`のまま。新しいZIPや公開候補を作成したという意味ではない。

## 再開

1. A/Bと旧診断は終了済み。`node .cache/offscreen-instance-real.mjs`等を再実行しない。source/control/receiptを読んで維持する。
2. 新runtimeのLinux・最低Chrome・全context通信監査の既存gateを、専用outputとsource/asset bindingを用いて実施する。旧sourceのreportを付け替えず、実行したplatformだけを更新する。
3. 資源問題には別のコード根拠と観測条件を先に登録する。Bの機能成功をメモリ改善や長期上限の証拠としない。
4. M2独立gold/参照精度、M3数値/性能、native IME/権限/実サービス、remote CIを解決し、同一clean sourceの全品質・SBOM・監査・ZIPを揃えてからM5判定する。正式公開・課金・認証情報の変更は今回行っていない。
