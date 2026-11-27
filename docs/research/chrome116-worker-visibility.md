# Chrome116のモデルなしWorker観測probe

2026-11-27事前登録。起点はclean `3f6ca45`。[現runtimeの実試行7554a69](current-runtime-chrome116.md)は2タブ検出後にWorker観測0件で失敗し、idle0回だった。raw inventoryがないため原因は未確定。この閉じた実モデル試行は反復せず、モデル・製品コードを含まない最小MV3 fixtureで観測方法を調べる。

## 仮説と変更条件

Chrome116では、所有Offscreen/WorkerのCDP typeやURL公開、関連attach前後の可視性が既存observerの条件と異なる可能性がある。今回のfixtureは新規6ファイルだけで、背景からOffscreenを1回作り、module Workerの固定ping/pongを1回確認する。worker生成後に親へautoAttachRelatedを行う順序を旧試行に合わせる。モデル、Tokenizer、WASM、HTTP server、入力ページ、学習・推論・memory割当は使わない。

Browser-level `Target.setDiscoverTargets({discover:true})` と `Target.getTargets({filter:[{}]})` を使う。Chrome116固定tagの[公式PDL](https://raw.githubusercontent.com/chromium/chromium/116.0.5845.96/third_party/blink/public/devtools_protocol/browser_protocol.pdl)を先行試行で保存・hash固定済み。メソッド定義の存在を実行成功と同一視しない。owned OffscreenのURL完全一致で親を選び、1件だけなら `Target.autoAttachRelated({targetId,waitForDebuggerOnStart:false,filter:[{}]})` を1回送る。親0/複数、protocol error時は部分値を保存して失敗とし、別attach方式・filter変更・fallbackは行わない。

initial → worker-ready-before-attach → after-attach → poll1〜10（各1秒）→ after-close のinventoryを保存する。targetCreated/targetInfoChanged/attachedToTargetは同じ分類情報で最大256件、destroyed/detachedは件数だけを記録し、超過は失敗にする。途中でsetAutoAttachは呼ばない。観測用接続は計測条件の一部である。

## 記録範囲と判定

targetのtypeは固定allowlist外をunknownへ丸める。URLは所有offscreen/worker/extension-other、empty-url、foreignに分類し、URL本文・query/fragment値・foreign ID・raw unknown typeを保存しない。所有target IDだけを世代の照合用に記録する。exactLocationとhasParentはboolean。元文章・private instance marker・heap snapshotは扱わない。request listenerは外部HTTP/WebSocketの件数のみを数える。

sourceCommitは実HEADの40桁、実Git tree/cleanと7controlのGit blob/raw SHAを前後照合する。固定Chrome for Testing116.0.5845.96の絶対executablePathを必須とし、取得exe SHA `7460094ab51e1cb2fa6abeef0683275bb99684ad00334556547d7f4a6dd84c4e`、ZIP SHA `58ce894d230738e5b05ec0e20f8283c77070a97afb21bae3175e13f2b0af08b7`を外側で前後照合する。実browserVersionを成功/失敗の両方へ残す。出力 `artifacts/chrome116-worker-visibility/<clean-source>/report.json` は起動前にwxで予約し、既存file/祖先symlinkを拒否する。fixture全6資産を前後照合し、外側では製品全78資産、旧ZIP、9receiptの649証拠・旧Chrome27・未実行preflight8も保護する。

この文書・実装を含む次のclean sourceで**browser1試行・モデル推論0回・Offscreen1世代**だけを実行する。Playwright workers1/retries0、test180秒、launch30秒、CDP/newPage/message/getContexts/offline操作は各5秒、親接続後10回の1秒間隔poll、CDP/context cleanup各5秒とする。応答timeout後は次のphaseに進まず、既存接続のcleanupへ移る。観測待ちのtimeoutだけで新しいbrowserを起動しない。

```text
node node_modules/@playwright/test/cli.js test --config playwright.visibility.config.ts
```

モデルなし機能成功には固定version、ping/pong、稼働中context1（document IDあり）、明示close後context0、source/fixture不変、監視開始後の外部通信/page error0、全cleanupが必要。CDP観測は `strictWorkerVisible`（type=workerかつURL完全一致）と `anyOwnedWorkerVisible`（所有workerパスの全type/URL変種）を分け、分類・eventとともにそのまま記録する。前者falseでもfixture機能と観測処理自体が完了すれば診断はcompletedとなるが、Worker観測互換性を合格にはしない。parentを選べない/attach失敗の場合はtest自体が失敗する。

成功/失敗で予算は終了。旧reportを補完せず、新しい事実だけを記録する。probe成功から製品のidle2回・旧marker拒否・メモリ改善・精度/parity/性能・native権限/物理IME・全startup通信・実サービス/remote CIやM5の成功へ拡大しない。旧ZIP0dc814cと製品0ba3630の資産は変更しない。次の実モデル試行が必要なら、得られた根拠に基づく観測変更・条件・予算を改めて登録する。

## 実行前検査

分類helper不在のRedとtimeout helper不在のRed1を保持し、deadlineの早期完了・失敗時のtimer解放を含む7 unitが成功した。最初の型検査は分類結果のoptional propertyで失敗し、明示型へ修正した。全TS420件とnpm checkが成功し、コードの独立レビューにblockingなし。外側binderの実行前レビューとclean source固定後にbrowserへ進む。

## 初回の結果（予算終了）

clean source `30dfb5cf0cfc7124439f092f3d0479585672e9aa`、Windows11/Node24.15.0/Chrome116.0.5845.96で登録した1回を実行し、parent-inventoryで失敗した。Worker ping/pongとcontext1/document IDありは確認できたが、URLだけの親選択がpageとtabの2件を数えたため、autoAttachRelatedは未実行。poll10回と明示close検証も未実施で、診断全体は合格にしない。既存の実モデルobserverはtabを除外しており、このprobe側の選択ミスを7554a69の原因と同一視しない。

初回inventoryは3件、Worker応答後は7件で、その内の所有Offscreenがpage1/tab1だった。eventはcreated4/changed4、attached/detached/destroyed0、overflowなし。未知URLやforeign IDは保存していない。cleanupはCDP3.4507ms/context2,466.8633msで完了。本文/モデルは扱わず、製品全78資産・旧649証拠・旧Chrome27・preflight8・旧ZIP・binary/PDLは前後一致した。内部sourceAfter・通信件数は失敗前の最終phaseへ届かず未取得で、外側のsource/fixture照合と区別する。

全体14,270.256ms、外側process16,443.195699946955ms、exit1。証拠は `artifacts/chrome116-worker-visibility/30dfb5cf0cfc7124439f092f3d0479585672e9aa/` に保存した。report SHA `c8da2e5c15b0d3db2d6aabb7ab2cebdef850b2856b0792e7148bf3ad8cd952fa`、preflight SHA `4cf76f3ec603adf2685622b5d2664cdd9f2205027b2c39f65692b9f6701c2e2e`、26ファイルのreceipt SHA `4700b29c7f25d99db6ebf9df9bd2b7784a4966e1cb2462e5de5b5b2de9c8bf60`。初回予算は終了し、既存report/trace/画像/source archive/controlを編集しない。

## 親選択の訂正と別試行の事前登録

`findProbeParents`をRed1から追加し、同一URLのtab wrapperを除外してpage/other/background_pageだけを数える。実モデルobserverと同じ選択条件にする修正で、親0・複数を無条件に受理する変更ではない。8 unitでpage+tab→page1、tabのみ→0、page2→2を検証した。

訂正後の全TS421件とnpm checkは成功。初回の失敗・現在のコード差分・新しい予算と既存証拠の保護を独立レビューし、clean sourceでの訂正1回へ進む。

この訂正と本補足を含む次のclean sourceで、**訂正版のモデルなし1試行のみ**を登録する。fixture・Chrome116固定exe・モデル0・Offscreen1世代・launch30秒/CDP5秒/test180秒・1回の関連attach/10poll1秒・cleanup5秒・分類/privacy・診断値と製品受け入れの分離は変更しない。初回26証拠を追加し、10receipt/675証拠と旧Chrome27/preflight8/ZIP/全78製品資産を前後保護する。旧26証拠のreceiptとscriptを上書きしない。成功/失敗でこの訂正予算も終了する。親を正しく選べてもworker観測が成立しなければ、その新しい結果から別の観測方法を検討し、実モデルへ進まない。

## 訂正版の結果（診断完了、予算終了）

clean source `905c773b8c661d9707d17663a23642b51c6185f2`、tree `43458585f0de3370f87ea81249ec30087a94c1d5`で1回を実行した。Windows11/Node24.15.0/Chrome116.0.5845.96、モデルなし、test1件passed、retry/skip/flaky0、外側exit0。Worker ping/pong、稼働中context1/document IDあり、pageの親1件へのautoAttachRelated完了、明示close後context0、全6 fixture資産とsourceの前後一致を確認した。

全14 snapshotsのgetTargetsには所有Workerが0件で、after-attach後10回のpollでも現れなかった。`strictWorkerVisible=false`、`anyOwnedWorkerVisible=false`。一方で、保存したeventには所有Workerのcreated1/changed2/attached1があり、すべて同じtarget ID・type worker・exactLocation=trueだった。全event件数はcreated5/changed8/destroyed2/attached3/detached2、overflowなし。root CDPのinventoryとeventの可視性に差があることをこのfixtureで再現した。生成・接続eventを使う観測方式を次の候補とする。

これはWorker機能が動いていても既存のinventoryだけのobserverでは0件になり得るという根拠である。7554a69にはraw inventory/eventがないため、その実モデル失敗が全く同じ状態だったとは断定しない。destroyed/detachedは件数だけのため、Worker ID単位の終了対応はこのreportからは証明しない。製品idle終了・再生成、旧marker拒否、長期資源、最低版の全互換性は未検証のまま。

監視開始後の外部通信/page errorは0。CDP cleanup4.7909ms/context3,981.07ms、全体27,717.1273ms、外側29,352.770500117913ms。所要時間はモデル推論性能ではない。source/control、全78製品資産、675先行証拠/10receipt、旧Chrome27、preflight8、旧ZIP、exe/ZIP/PDLは前後一致した。新26証拠を固定し、診断の受け入れだけtrue、製品互換性/M5はfalse。両probeの予算は終了し、同条件で反復しない。

証拠は `artifacts/chrome116-worker-visibility/905c773b8c661d9707d17663a23642b51c6185f2/`。archiveは314 tracked files、3,307,520 bytes、SHA `f2a7500a12cfef1c27af947b128c2ba99ff5836f7d44c1c4d8e6a01a2089f140`。report SHA `c0ecde52064cf0a1ccc74ddb5e5006f83446ada185615250f462a9edc7f787d5`、preflight SHA `25de9671f185ad1fb99ee6ce3d0069df347f30ccab376464ce987d533ff8912a`、26ファイルのreceipt SHA `225f992c0b49dd1ad2ccd82d29036c1cc81c8784e1abed00daf5827037986d66`。

次は既存observerへ所有WorkerのCDP event台帳を追加する。URL/type/所有親の束縛、foreign event拒否、targetDestroyed/関連session detach/親交代による削除、廃棄後event無視、IDの重複統合を先にTDDで検証する。単なるeventの追加件数を実在Worker数と扱わず、古いeventでidle時に1件を残さない。新しいモデルなし1世代試験で生成1→終了0を確認してから、必要な実モデル試行を別登録する。製品コード・モデル・旧ZIPは変更しない。
