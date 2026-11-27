# 関連target監視を外した資源診断

2026-11-27事前登録。起点はclean `79ef355`。前回[明示release試行](graceful-worker-release.md)ではack2回でもresume2の関連process working setが2,468,036,608 bytes（resume1比2.35596）へ増加した。この登録はM4/R05の別条件であり、閉じた試行の反復やM5基準の変更ではない。

## 仮説と変更する条件

前回は所有するbrowser CDP sessionからoffscreen parentへ`Target.autoAttachRelated`し、子WorkerのIDを観測した。[公式CDP定義](https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-autoAttachRelated)は、関連targetへの自動接続を行う実験的APIとしている。この追加観測がprocessの資源使用へ影響する可能性を切り分ける。接続がメモリ増加原因だったとはまだ主張しない。

今回は同じ0f99811ビルドを再利用し、所有CDP sessionからの関連target attach/inventoryを行わない。`Target.setDiscoverTargets`と`SystemInfo.getProcessInfo`のみを許可するwrapperで誤操作を拒否する。Playwright自身の内部CDP接続は残るため、「デバッガなし」の試験ではない。

## 固定条件・観測の限界

- 前回の全81配布資産をbuild-controlと照合し、実行前後とも不変であることを必須にする。runtimeSourceCommitは`0f99811fb1a78a0a40c86ada6bda1fa5a42b10f7`、診断source/test SHAは新clean commitへ別に結ぶ。モデル、Tokenizer、WASM1 thread、閾値、idle60秒、release上限1秒、fixture2タブ、4推論、2idle/reload、6段階メモリ、cleanup各5秒を変えない。
- 既存`tests/e2e/idle.real.spec.ts`とWorker観測helperの内容・assertionは変更しない。独立した診断テストを通常のE2E外に置き、明示的configでのみ起動する。strict source/runtime/outputを起動前に必須検証する。
- 子WorkerのID/正確な0/1件数は観測できないため、reportにunobservedと記録し、既存の単一Worker・ID交代の機能受け入れをこの診断で代替しない。
- 各idleでready=false、成功release ack累積1/2、失敗系0、offscreen1件を検証。各再入力のready=trueとハイライト、本文保持・非保存、監視開始後の外部通信/page error0、6段階measured/欠落PIDなし、全cleanup成功を必要とする。
- reportには本文・例外内容・外部URLを保存しない。fixture pregrant、headless、OSメモリのCDP process cohortという限界を残す。working set合計は拡張専用/同時RSSや長期リークの証明ではない。

## 実行順序・予算・判定

1. restricted CDP、source/runtime/output、release status検証のunit Red→Green、全TS/check、独立レビューを行う。
2. clean診断sourceと旧runtime資産を照合した後、Windows Chromium159で**1試行だけ**実行する。timeout240秒、retries0。成果物は`artifacts/related-attachment-memory/<diagnostic-source>/`へ新規保存し、失敗・途中結果も保持する。
3. 成功・失敗にかかわらずこの予算を終了する。時間延長、同条件の再実行、Linux探索や追加サイクルへ進まない。実行前に見つかったコード不具合は修正できるが、実モデルの追加試行には別登録を必要とする。
4. resume2/resume1が1.25以下なら「この条件では大きな増加を再現しなかった」、超えた場合は「所有する関連target監視を外すだけでは増加を抑えられなかった」とする。この1.25は前回と同じ診断分類であり、製品受け入れの資源上限ではない。別時刻・単発の先行結果との差から因果効果や解決を断定しない。

M2独立gold/精度、M3数値/速度、native/実サービス/remote、新runtimeの他環境/全監査とM5全条件は維持する。旧ZIPは0dc814cのまま。

## 実行前の検査と証拠の結合

初回のunit Redはmodule不在による1 suite失敗・実行test0であり、3ケースのbehavioral Redとは扱わない。helper実装後3ケースが成功した。独立レビューで、全81資産のpreflightとの結合と固定Playwright出力先の上書きリスクを指摘され、追加Red1（既存3成功）からpreflight検証を追加した。最終unitは全TS283件・npm check成功。

登録実行は外側`.cache/bind_resource_diagnostic.py`のbefore/afterを必須とする。beforeでclean HEAD、runtimeと診断sourceの分離、旧build-controlの固定SHA、全81実資産と既存runtime/通常idle/helperの無変更を確認する。beforeが作る`build-control.json`のSHAを`KOTOBA_RESOURCE_PREFLIGHT_SHA256`へ渡す。診断自身もこのSHAとsource/runtime/clean/81資産metadataを起動前に検証し、reportへSHAを記録する。source/runtime/output/preflight SHAの不足や不正はfail-closed。standalone reportだけでは診断を受理しない。

Playwright JSONは試行専用のreport親ディレクトリへ保存し、既存report/JSONがある場合はconfig読込時に拒否する。モデルなしの実CLI sentinel probeは期待した終了コード1・既存ファイルSHA不変で、browser/model起動0。afterでreport・preflight・全資産の前後一致、専用Playwright stats/SHA、allowed CDP7コマンド、release/6測定/cleanupを結合する。ブラウザやモデルの重い処理は直列に実行し、失敗・途中reportも上書きしない。

再レビューでmemory sampler・その依存helper・browser options・cleanup・traffic・fixture HTMLもruntimeとの差分禁止対象とcontrol SHAへ追加した。idle60秒は不変のruntimeと既存unitで確認した設定値である。`idleObservedAfterMs`は直前のmemory snapshot後を起点にするため、60秒timerそのものの実測と扱わず、reportにもこの制約を記す。

## 登録試行3c900eb: 完了、増加抑制の仮説は不支持

clean診断source `3c900ebe60e35e33d0b5272658b297e48bf567e3`、再利用runtime `0f99811fb1a78a0a40c86ada6bda1fa5a42b10f7`で限定1試行が終了コード0。Windows11 / Node24.15.0 / Chromium159.0.8154.6 / WASM1 thread。2タブ4推論、idle/reload2回、release ack累積1/2と失敗系0、ready状態、offscreen1件、本文保持・非保存を確認した。監視開始後の外部通信/page error0。Worker数・IDはunobservedのままで、既存の機能受け入れに代用していない。

所有CDPの実行記録は`Target.setDiscoverTargets`1回と`SystemInfo.getProcessInfo`6回のみ。CDP detach5.75ms、context close1,505.05ms、server close1.46msで全cleanup成功。本体156,321.35msはidle待機と測定を含み、cleanupを除く。推論速度の値ではない。

| phase            | ready | 関連PID数 | working set合計bytes |
| ---------------- | ----- | --------: | -------------------: |
| before-inference | false |        10 |          680,484,864 |
| shared-inference | true  |        10 |        1,035,939,840 |
| idle-1           | false |        10 |          795,635,712 |
| resume-1         | true  |        10 |        1,043,570,688 |
| idle-2           | false |        10 |          789,073,920 |
| resume-2         | true  |        10 |        2,463,072,256 |

6段階ともmeasuredで欠落PIDなし、unique PID数は要求数と一致した。resume2/resume1は**2.360235185**で事前の1.25分類を超過。**所有する関連target監視を外すだけでは大きな増加を抑えられなかった**。最後の同一renderer PID205028のcurrentBytesは1,811,251,200。順次取得したprocess cohortのworking setであり、拡張専用・同時RSS・リークの原因/不存在を示す値ではない。Playwright自身のCDPは残るため、すべてのdebugger影響を否定したことにもならない。前回と近い数値でも、別時刻の単発対照から因果関係や厳密な同等性を主張しない。

成果物: `artifacts/related-attachment-memory/3c900ebe60e35e33d0b5272658b297e48bf567e3/`。report SHA `b6be9847b487979a717fdfc01f79a09ee7817ee9996357ef0ab89154b4ef3763`、Playwright SHA `eab262f8f6329b5c46361f95efedb1d5a7858d2e328277831c639a2c148eb54f`、final control SHA `2eb86dff86b0280ae349d8b0ffb8d81b83d8f5d30858bca88d40423aef05a1cf`。preflight SHA `3f09cd47bd0f4c8b879f010182b72082db0ccb5079efd6a896d4cfe3e6ff4f80`をreportと結合し、全81資産・全control SHAのGit blob一致・元runtime無変更を確認した。binding script本体とunit/失敗/probeログを含む16ファイルを`preserved-evidence.json`で凍結した。独立レビューでもblockingな不整合なし。

旧0f99811 reportを保持し、[0dc814cの開発用ZIP](../validation-0dc814c.md)もSHA `5f07c72e220f3fc6a68da9d309e84198671382a6572f4ae4c6ea2e10ef6f9aae`のまま不変。今回runtime・通常idle/helper・モデル・Tokenizer・WASM・閾値は変更していない。全TS283件は診断追加のコミット前コード検査で、新しい製品coverage測定や全回帰/他OS/最低版/全通信監査ではない。

登録予算は終了。同条件の反復、追加cycle、Linuxへの展開をしない。次はWASM線形メモリ・JS heap・process working setの内訳をコードから調べ、新しい観測が必要なら別の仮説・条件・停止を登録する。M2/M3、native/実サービス/remoteとM5の残条件は維持する。

## 追加推論なしの割当経路調査

同梱ORT1.31.1のbundle SHA `329cd956772397a1aedd668e911195d39afefb182f6fc14aafa4f08ac8d8f379`がinstalled packageと一致し、source map SHAも既存auditの`be90120f2752231a09e9470d98ba5877d8e0835455c6ab1a8196700207335b80`と一致した。map内`wasm-factory.ts`/`wasm-core-impl.ts`のcontentがinstalled sourceとも完全一致することを確認した。

`releaseSession`は名前bufferをfreeし、native session releaseとactiveSessions削除を行う。一方、factoryは初期化済みWASM moduleをmodule scopeに保持し、内部のfactory disposeはsession releaseと別である。これらはソース上の観測で、Worker終了後の保持や3回目の増加原因を証明しない。同梱sidecarにはmemory grow処理もあるが、今回の各段階の線形memory容量・JS heap内訳は未測定。内部関数の呼出しやGC強制、runtime変更、追加モデル実行は行っていない。`artifacts/related-allocation-source-inspection.json`にsource/map/bundle SHAと未証明事項を保存した。次はこの区別を保った観測設計と別登録が必要である。
