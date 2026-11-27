# Worker終了前のセッション解放

2026-11-27の事前登録。起点はclean `b841a2d`。M4/R05の追加診断であり、M2/M3やM5の受け入れを置換しない。

## 根拠と仮説

[先行試験](idle-worker-resources.md)ではWindows/Linuxとも3回目の初期化後に関連processのメモリが増えた。現行brokerはidle時にWorkerをterminateするだけで、SDKのdisposeは呼ばない。ORTの[公式API](https://onnxruntime.ai/docs/api/js/interfaces/InferenceSession.html)はreleaseをsessionと下層資源の解放と定義する。一方、[Worker終了の仕様](https://html.spec.whatwg.org/multipage/workers.html#dom-worker-terminate)から、終了前の非同期cleanup完了は保証できない。これらは明示releaseを試す根拠であり、欠けたreleaseが増加原因だったという証拠ではない。

idle後にSDK disposeを完了してからterminateすることで、再初期化後の増加が小さくなる可能性を検証する。allocator、debugger、測定cohortの影響は未特定のまま扱う。

## 固定する変更と受け入れ

- idle60秒、モデル、WASM1 thread、入力、閾値、fixture、2サイクル、6段階のOS測定、既存cleanup各5秒上限は維持する。
- pendingが0のidle終了だけにdisposeメッセージを送る。readyは直ちにfalseにする。
- disposeのack/errorを待つのは最大1秒。その後は必ずterminateする。エラー・無応答・送信失敗はメタデータとして区別する。故障/推論timeoutは従来どおり即時terminateする。
- 解放中の新規要求は既存のpending件数/timeoutに計上し、旧Workerの終了後に新Workerへ送る。解放中に複数のモデルWorkerを新規作成しない。旧イベントは新要求を完了できない。
- Workerはdispose開始後のdetectを受理しない。初期化中なら完了を待ち、SDK disposeの完了後だけ成功ackを返す。文章/例外内容をログ・保存・応答メタデータへ含めない。
- 内部statusには成功/失敗/timeout/送信失敗の累積件数だけを追加する。status参照でWorkerを生成したりidleを延長したりしない。

## 順序と予算

1. broker/Worker/entryのRedを記録してから実装し、関連Green、全TS、Lint/型/Format、独立レビューを行う。
2. clean commitからbuildし、source40桁・test SHA・全配布資産・モデルSHAを前後照合する。
3. Windows Chromium159で限定実モデル試験を**1回**行う。既存idle試験の全条件に、各cycleの成功release ack累積1/2、失敗系0を追加する。外部通信/本文保持/非保存/cleanup失敗もそのまま不合格とする。
4. 成功・失敗・途中結果を新しい`artifacts/graceful-release/<source>/`へ保持し、この実行予算を終了する。timeout延長、同じ条件の再実行、Linuxでの無変更の探索はしない。実行前に見つかったコード不具合はTDDで修正できるが、モデル実行後の追加試験は別登録を必要とする。

## 結果の判定

機能合格とメモリ仮説を分ける。6段階ともmeasuredの関連process working setをそのまま記録する。resume2/resume1が1.25以下なら「この1試行では大きな増加を再現しなかった」、超えた場合は「明示releaseだけでは増加を抑えられなかった」とする。1.25は今回の診断分類であり、製品の資源上限や事前の品質目標を引き下げる値ではない。過去との非同時対照から因果効果、拡張専用RSS、長期リーク不存在を主張しない。

機能が合格しても現runtimeのLinux/最低Chrome/全context監査とM5全条件は別途必要。既存0dc814c ZIPは更新・再ラベルしない。

## 実装前後の単体検証

初回Red7件（既存15成功）を`artifacts/graceful-release-red.log`へ保存した。実装後、従来の即時terminateを仮定した4件は明示ackを送ってから終了を検査するよう更新し、他のassertionは維持した。短い要求timeout中に旧Workerを残したままrestartする不具合も追加Red1で検出し、retirementを先に終了するよう修正した。待機中2件の上限、未使用Workerのdisposeと重複controlも確認した。全TS279件・Lint/型/Format成功。初回Format失敗と途中のunit失敗は保持する。これらはmock/単体の証拠であり、実セッション解放・ブラウザメモリ改善の証拠ではない。

独立レビューでは重大な実装問題なし。standalone E2Eは従来のworking-tree表示を許すため、そのreport単独では受理しない。登録実行では`.cache/record_idle_binding.py`のbefore/afterによりclean HEADの40桁・test SHA・全資産とreportのsource一致を必須にする。source未指定ならafterが失敗し、診断の受理を拒否する。

全体TS coverageはstatements1405/1594（88.14%）、lines1307/1439（90.82%）、branches913/1106（82.54%）、SDK statements92.42%/lines94.56%。`artifacts/coverage/graceful-release-precommit/`はコミット前のコード測定であり、後続実モデル試験のsource証拠とは区別する。Python/モデル変換は変更しておらず今回は再実行していない。

## 登録試行0f99811: 機能成功、メモリ増加は継続

clean `0f99811fb1a78a0a40c86ada6bda1fa5a42b10f7`からbuildし、Windows11 / Node24.15.0 / Chromium159.0.8154.6 / WASM1 threadで1回実行、終了コード0。2タブで4回のオフライン推論、Workerの0/1件・ID交代2回、成功release ack累積1/2とfailed/timedOut/sendFailedすべて0を確認した。本文保持・非保存、監視開始後の外部通信/page error0も成功。CDP detach4.97ms、context close1,301.53ms、server close1.12msで全cleanupが各5秒以内に完了した。本体156,855.80msは待機・測定を含みcleanupを除くため、推論速度ではない。

| phase            | Worker数 | 関連PID数 | working set合計bytes |
| ---------------- | -------: | --------: | -------------------: |
| before-inference |        0 |        10 |          684,392,448 |
| shared-inference |        1 |        10 |        1,040,285,696 |
| idle-1           |        0 |        10 |          793,268,224 |
| resume-1         |        1 |        10 |        1,047,572,480 |
| idle-2           |        0 |        10 |          787,144,704 |
| resume-2         |        1 |        10 |        2,468,036,608 |

全6段階はmeasured、欠落PIDなし。resume2/resume1は**2.35595785**で事前の1.25分類を超えた。今回の1試行では、**明示release単独で大きな増加を抑えられなかった**。最後の増加は同一renderer PID198964のcurrentBytes1,815,830,528に集中する。10 processの順次取得working setであり、拡張専用・同時RSS・長期リークや対照のある因果効果は測っていない。以前の試行より大きい数値も保持し、releaseによる悪化が確定したとも扱わない。

機能として解放手順を明示したが、資源問題を解決した修正とは扱わない。登録した実モデル予算は終了。同じ条件を反復したり、期限・分類値を変えて再試行しない。次の候補仮説はdebugger/related-target attachの影響だが、未登録・未検証であり、別の対照条件と停止を定める必要がある。

成果物は`artifacts/graceful-release/0f99811fb1a78a0a40c86ada6bda1fa5a42b10f7/`。report SHAは`d4fc262aa10c09069f558d7caac441b78bff53434aae908e8b6956b48e5ed82c`。build/final controlがclean sourceと全81配布資産の前後一致を確認した。独立レビューで照合を強化し、reportの選択7資産もbuild SHAと直接一致、testはGit blob SHAと一致、release count・cleanup名/順序/時間・6測定のunique10 PIDを検証した。`verified-evidence.json`へ元ファイル群のSHAと診断分類を保存した。旧6850aaf reportと0dc814c ZIPのSHAも不変。別途配布ディレクトリ検証はmodel5件・inventory80件（manifest自身を含め81）で成功した。

この実行は追加のWindows専用1件であり、既存10件回帰、Linux、Chrome116、全context監査、Python統合、再包装を新sourceで再実行した証拠ではない。M2独立gold/精度、M3数値/速度、native/実サービス/remoteとM5の条件は未達・未検証のまま。
