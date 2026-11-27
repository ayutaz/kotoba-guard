# 背景側で照合するOffscreen文書identity

2026-11-27事前登録。起点clean `f2f2cea`。先行の[宣言ID案](offscreen-declared-document-id.md)を訂正する。先行smoke1回は終了、そこで予定した実モデル試行は未実行のまま取り消し、本条件へ置き換える。

## 失敗と根拠

clean `f2f2cea6b58498e92edd4774a2d87b4eb902a172`のモデルなしsmokeは推論0・通知受信0・文書1のままで失敗（4,990ms、cleanup成功、assets不変）。report SHA `3d6e2f5fee5bf38df468deaae48cae06729fa5b0783a4bfce4ee170df1932d21`、script/fixture/logを含む15証拠receipt SHA `5d16bfd77eef1dc7e3ca470e11237abd7016b47f5530c520f1f727ed417a4ab0`。directoryは`artifacts/offscreen-declared-id-smoke/f2f2cea6b58498e92edd4774a2d87b4eb902a172/`。

「offscreenはruntime APIを使える」から全methodを利用できると誤って解釈していた。[Chromium公式のAPI feature定義](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/common/api/_api_features.json)ではgetContextsはprivileged_extensionのみ、sendMessage/getURL等はoffscreen_extensionにも許可される。確認したmain定義と失敗挙動は整合するが、失敗reportはTypeError自体を記録していないため生例外を確認したとはしない。159のversion tag URLは取得できず、mainを当該配布バイナリの完全なsource証明にしない。

## 訂正protocol

- Offscreenは利用可能なruntime.sendMessageで`{type:"offscreen-identify"}`を背景へ送る。getContextsをoffscreenで呼ばない。実環境と同じくmockにもそのmethodを置かない。
- 背景は拡張ID/完全一致offscreen URL/tabなし/単一keyを検証し、背景側getContextsの単一current文書IDを返す。sender.documentIdが非nullならcurrent IDとも一致すること。型・欠落・複数文書・失敗は拒否し、本文を含めない。
- identity queryは5秒上限、未完了の実APIを1件だけ共有してtimeout後も呼出しを増やさない。offscreenは返却IDを通知へ宣言し、背景がclose直前にcurrent IDと再照合する。旧宣言IDは新文書を閉じない。
- retiringは取得前に立て、closed:false後にも背景へ同じ照会を行い、元IDと一致する場合だけ解除する。未知の結果はfail-closed、既存のpending/close lease/再起動防御を維持する。

TDDでoffscreenにgetContextsがない状態のRed、背景のtrusted/untrusted/stale ID、identity queryのtimeout/実API共有/回復を検証する。全TS/checkと独立レビュー後、clean sourceと全81資産を固定する。

実装時の背景Redは2件（identity endpoint未実装とidentify method未実装）、Greenは背景/lifecycle計32件。訂正後のoffscreenを含む3ファイルは50件、全39ファイルは354件成功。成功reportにも2通知の宣言ID・任意sender ID・release数を保持するよう修正した。この単体結果は実ブラウザの成功を意味しない。

独立レビュー後、背景を経由せずpopup/optionsから直接offscreen推論を呼べる送信元判定を修正した。背景Service WorkerのURLなし、または完全一致background.jsだけを許可し、tab付senderを拒否する。回帰Red2件→Green21件。offscreenにgetContextsがない条件のRed7件は端末出力のみで、保存logはない。c4415d2の全TS354/coverageは後続修正前の結果として保持する。

保証範囲: 作成済みの旧宣言IDを持つidle通知はcurrent ID不一致で拒否する。一方、sender.documentId欠落時のidentify返信は現在の単一文書IDであり、呼出元isolate固有の証明ではない。旧isolateが文書交代後にも照会/実行できる仮想raceをnonceで防いだとは主張しない。製品側はclose完了後にだけcreateするが、破棄済み文書へのChromeの遅延message配送まで今回の試験では検証しない。公開前のidentity強化検討項目として残す。

回帰全体の初回は監査用テスト1件が失敗（355成功/356件）。primary resumeの20ms待機前にdetachする意図を実時間0ms待機で表しており、負荷によりsecondaryが先に退役した。失敗log `artifacts/offscreen-sw-only-unit.log`を保持し、当該順序を仮想時計0ms/20msで固定、最後のpending0も検証した。監査用50件は成功。実APIや監査実装の制限・timeoutは変更していない。

## 予算・停止

モデルなしsmokeは新script/outputで**1 browser/通知1件/推論0/60秒/retry0**。背景identify返信によりIDを取得した診断offscreenから通知し、宣言ID/送信元metadataとgetContextsの文書消失を確認する。全fixture/hash/source/cleanupを保存し、成功前にモデルを動かさない。

次の実モデルは訂正した本protocolの**1試行/retry0/4推論/2idle/3世代/240秒**だけ。body受付190秒・idle各85秒・CDP/control/cleanup各5秒・OS query15秒、fixture/offline/WASM1thread/固定モデルSHA/文章/閾値/6sampleは先行と同じ。成功時も2通知の宣言ID/任意sender ID/退役文書との対応をreport/binderに保存する。PID/role pairが異なれば比率unknown。機能成功と製品メモリ受け入れを分離する。

先行46+15+15証拠・元heap観測・旧ZIPを前後照合して変更しない。成功/失敗でそれぞれの予算を終了し、無変更retry・追加推論・閾値/時間延長を行わない。正常回帰10件（本資源idleを重複実行しない）、coverage、他OS/最低版/全監査/新packageは別範囲として記録する。M2/M3/native/実サービス/remoteとM5の未達は維持する。

## 結果: 機能成功、資源受け入れは未解決

実行source/runtimeはclean `72236f2da19d942cfc694ac9bd0eea245e78ef47`、tree `c07e273b7cfbfc9defc39fe63fa23c6c0e2dfa8d`。Windows、Node24.15.0、Chromium159.0.8154.6、WASM1thread。元モデルrevision `8d640720bddeb64c89dc1fa7780c3ea29fa523e8`、配布QUInt8は37,789,676bytes / SHA `dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`で不変。新規のPyTorch/精度/速度評価は実施していない。

- 全TS356件とnpm check成功。coverageは全entrypointを含み、statements88.59% / lines91.08%、コアSDK statements92.42% / lines94.56%。初回の監査テスト失敗と型検査失敗も保持し、修正後結果と区別する。
- モデルなしsmoke1回は1,578.11ms、通知1件、文書1→0、cleanup成功、web error0。popupのgetContextsはfunction、offscreenはundefinedで、背景返信のIDと退役文書が一致した。推論0、model/tokenizer/WASMをfixtureに含めない。予算終了。
- 実モデル1回はbody158,592.02ms、4推論・2idle周期・3世代の文書/Worker/親target、2通知を確認した。通知の宣言IDと各退役文書が一致、各dispose ACK completed1/失敗0、idle後は文書/Worker/親target0、再開後は新IDで各1。全推論の検出span13–15、本文保持、本文保存なし、backend WASMを確認した。
- 所有child sessionのdetach通知/active0と親detachを確認。最終CDP4.42ms/context1,606.82ms/server1.23msのcleanup成功。監視開始後の外部unexpected request/page error0。全起動経路の通信監査を置き換えない。実モデル予算終了。
- 続く通常回帰はmock4件・実モデル6件の計10件、retry0で112.62秒、すべて成功。手動・自動/IMEイベント、再起動/無効化、Undo/Redo/長文、24組の編集を含む。idle試験は重複実行していない。fixture pregrantのためpermission-remove-failedは保持し、native権限解除の成功とはしない。

| phase            | 関連process working set合計 bytes |
| ---------------- | --------------------------------: |
| before-inference |                       691,728,384 |
| shared-inference |                     1,059,639,296 |
| idle-1           |                       804,589,568 |
| resume-1         |                     1,051,549,696 |
| idle-2           |                       793,911,296 |
| resume-2         |                     2,669,510,656 |

6段階とも10/10 PIDを測定し欠落0。ただしresume pairのPID/role構成が異なるためcohortMatch=false、ratio=null。最終値は約2.67GBで、文書終了が資源問題を解消したとは判断しない。これはCDP関連processの合計であり、拡張だけのRSSや同時peakではない。機能観測acceptance=true、productMemoryAcceptance/fullM5Acceptance=false。

## 証拠と検証範囲

- smoke: `artifacts/offscreen-brokered-identity-smoke/72236f2da19d942cfc694ac9bd0eea245e78ef47/`。report SHA `a38be6b60e7685344410d45158cb459e4512a1476986e1c385c2b1c4711c5067`、16ファイルreceipt SHA `3fd398afbc67e70ed3e208113b149679ec934fd99159967fe2a683c0869dbb5f`。
- 実モデル: `artifacts/offscreen-idle-recreation/72236f2da19d942cfc694ac9bd0eea245e78ef47/`。report SHA `831d105d14ba81efdc240a05d17a9017647b9c7a522097ee040356d65c656426`、final-control SHA `565c3d57e1f4f940980b353d6e60ebfeaac5af6f1e5d8475f5d94ce48f56bfa9`、70ファイルreceipt SHA `207978339cb2fb13976ca1b02e408c8fa50bb21ad55c3ad6e51daf5e6cc38daf`。変更3資産のbytesも保存した。
- 通常回帰: `artifacts/offscreen-regressions/72236f2da19d942cfc694ac9bd0eea245e78ef47/`。24ファイルreceipt SHA `221edafc33131fd16a59d08fb520afe8867c60592164eeb340d050d188866b6e`。旧出力を上書きしないためmanual specの出力prefix6箇所だけをコピー内で変更し、他のtest/helper bytesは同一。source/copy/config hashesと変換内容を外側で照合した。config初回照合はWindows CRLF展開で失敗し、実行bytesを保持したままraw/LF正規化SHAを両方記録した。assertionや制限は変更していない。

モデル前smokeはscript内の実ID/通知/文書消失検証を通過した。外側の最初のbinderはsmoke全項目を独立再採点しておらず、独立レビュー後に追加semantic-auditを保存した。これはtrial開始後の追加監査であり、事前preflightと呼ばない。smokeのrelease数値はruntime reportには記録されず、固定fixture sourceの値で検証した。一方、実モデルの2通知ではrelease数値を実測・保存・外側照合した。元16ファイルreceiptは不変。

独立レビューで機能観測/cleanup/ID/6sample/受け入れflagを確認済み。全81 build資産、固定モデル、旧runtime baseline、先行失敗46+15+15証拠・heap証拠・旧ZIPは前後一致。旧ZIPのsourceは引き続き0dc814cで、新packageは作成していない。後続の文書commitへ測定sourceを付け替えない。

## 次の作業

1. null sender identityのisolate固有照合を強化する設計をTDDで検討する。新しいbrowser条件は別登録し、本予算を再実行しない。
2. 常駐Worker再利用等の別資源仮説をコードから比較し、必要な場合だけ固定予算で事前登録する。今回の機能成功をメモリ改善として採用しない。
3. 新runtimeのLinux/最低Chrome/全context通信監査を別の受け入れとして揃える。今回のpost-listener通信0と旧sourceの成功を代用しない。
4. M2の独立gold/参照精度、M3の数値一致/性能、native IME/権限/実サービス、remote CIを解決してから、同一sourceの全品質・SBOM・監査・ZIPを固定する。M5完成・正式公開は未達。
