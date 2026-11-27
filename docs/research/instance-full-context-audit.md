# 現runtimeの全context通信監査

2026-11-27事前登録。前回の[配布再現性検査](deterministic-license-packaging.md)でWindows/Linux全78資産は一致した。現runtimeの全context起動監査は旧0dc814cから更新していないため、監査の証拠束縛を修正したうえで別の1試行を行う。旧instance A/B・資源診断・Linux試行は再実行しない。

## 監査ハーネスの変更

- positive control完了後、Extensions.triggerAction・popup生成・最初の拡張page navigationより先にofflineを設定する。
- 各入力で旧markが消えたこと、WASMのmodelReadyと新mark、本文/selection保持を確認する。本文・推論出力をreportへ保存しない。
- report出力を最初にopen(wx)で原子的に予約する。既存file/directory、symlink祖先、競合を拒否し、source/資産preflight前にbrowser/server/port/profileを開始しない。preflight失敗は診断値を含まないfailure receiptへ残す。
- 実GitのHEAD/tree/clean、監査・build・lockfile等のGit blobと作業tree SHAを取得する。SOURCE_COMMIT指定時は実HEADとの一致を要求する。全配布ファイルを再帰hashし、manifest全宣言/実ファイルの一致、symlink/余分/欠落/改変/path escapeを検査する。manifest自身は自己参照から除外し、inventoryには含める。
- 実行後にsourceと全資産を再照合する。report schema2にpre/postを保存し、cleanup後に予約済みhandleへ一度だけ書く。popup cleanup失敗も元の推論失敗と分けて保持する。

Redは初回の未実装module、テスト側Promiseモックの不備、実際のoffline順序、旧mark受理、preflight failure receipt、cleanup欠落を各ログに保持した。修正中のLint（finallyのthrowと不要初期値）、型検査（control map型）の失敗も保持する。既存reportを編集して補完しない。

commit前の関連76件・全TS406件、npm check、全entrypoint coverage（statements88.85%/lines91.36%、SDK lines94.56%）が成功した。CLI経路でも既存output/失敗preflightがnetwork listenとbrowser launchより先に拒否されることを確認した。独立実装・事前登録レビューにblockingなし。Python/モデル/ブラウザはこの単体検証では再実行していない。

## 固定する試行条件

この実装・文書を含む次のclean sourceをaudit sourceとする。runtime asset sourceは `0ba36301cdb1b2b9759ce81dbdc8fb6837648bbe`、対象はその固定済み `artifacts/license-packaging/0ba36301cdb1b2b9759ce81dbdc8fb6837648bbe/windows-extension` 全78資産。runtimeコード/build/lockfileの対象Git blobは新audit sourceと比較し、別のsourceを同一ラベルに変更しない。

Windows11 / Node24 / repository内Playwright Chromium159を使用する。通常WASM1thread・同じ固定QUInt8/モデルrevisionを維持し、モデル/閾値/権限/製品runtimeを変更しない。ブラウザ・モデル仕事はこの1つだけで直列実行する。

```text
node scripts/browser_security_audit.mjs --extension-dir <固定Windows78資産の絶対パス> --output artifacts/instance-full-audit/<audit-source>/audit.json
```

SOURCE_COMMITには実HEADの40桁を指定する。外側controlでclean commit/tree、Git archive実bytes/SHA、実行script/helper/lockfile、全78資産、command/exit code、実report SHAを前後照合する。先行7receipt/604証拠と旧ZIPも前後照合する。既存出力を上書きせず、失敗でも実report/log/controlを保存する。

試行は1回。既存scriptのHTTP/WebSocket陽性対照と、短文2・長文1・連続3のmanual check計6件だけを実行する。成功/失敗で予算終了とし、同条件でのretry、入力追加、モデル精度・量子化・GPU・Linux・Chrome116・旧idle周期の再試験は行わない。既存のCDP5秒、各check最大240回×250ms、sampler終了45秒、cleanup5秒の上限を維持する。観測timeoutは実行handleの終了を意味しない。生きたhandleを確認して継続監視し、新規試行を起動しない。

## 判定

通信受け入れにはexecution completed、securityFailures空、全target coverageComplete、HTTP scopesがpage/dedicatedworker/fixture-service-worker、WebSocket scopesがpage/dedicatedworker、unexpectedRequests・missing scopes・unmonitored targets・監視gap・unsupported targets・fatal errors・pending tasksの全て0が必要。全source/資産pre/post一致とcleanup completedも必須にする。

process memory/JS heapは従来通り取得するが、計測の完整性とメモリ増加問題の解決を区別する。関連process HWM合計は同時RSS peakでも拡張専用メモリでもない。通信監査の成功から長期資源受け入れやM5へ拡大しない。

CDP監視はChromium起動後・Extensions.loadUnpacked前に開始する。監視前のbrowser bootstrap通信は対象外で、positive controlのfixture通信も拡張の外部通信と区別する。物理IME/native権限・実サービス・remote CI、M2精度/独立gold・M3数値/性能・最低Chrome・資源増加とM5の未達を維持する。旧ZIPは0dc814cのまま、正式公開は行わない。

## 実行結果（2026-11-27、予算終了）

audit source `6c1a810bd29d17a466ba66d57697c4d0559f511f`、tree `42927bb7fc5c12c5070a40a06e24526df740991a`のclean状態で、登録した1回を実行した。runtime asset sourceは上記0ba3630のまま。Windows11 / Node24.15.0 / Chrome159.0.8154.6、WASM固定モデルで、全体42,133.10189987533ms・exit0となった。これは監査全体の時間であり、推論レイテンシのbenchmarkではない。

HTTPのpage/dedicatedworker/fixture-service-worker、WebSocketのpage/dedicatedworkerの陽性対照をすべて検出し、event25件を記録した。対象9件はlive-coveredまたはterminated-coveredで、background/page/offscreen/専用Workerの拡張scopeも満たした。観測された10件のうちbrowser-ui1件は監査対象外でlive-unmonitoredのまま保持する。missing scope/unmonitored target/gap/unsupported/fatal error/pending taskとunexpectedRequestsはすべて0。Chrome自身の全通信を監視したとは扱わない。

offlineBeforeAction=true、completedChecks=6、previousMarksCleared=6、backend=wasm。最初の拡張pageを開く前のoffline設定と、短文2/長文1/連続3の新しい検出、本文/selection保持を確認した。初期backgroundの読込は監視開始後・offline切替前であり、モデル初期化と推論はoffline区間で行った。popup/CDP/context/browser/fixture/profileのcleanupはすべてtrue。

limitationsには重複sessionのdetach時の`No session with given id`警告4件も保持した。fatalMonitorErrorsと監視gapは0、最終cleanupの各operationはtrueだが、警告のない実行だったとは扱わない。

sourceと全78資産のpre/postは一致し、reportの監査script SHAも固定ソースと一致した。先行604証拠・7receiptと旧ZIPは不変。source archiveは306 tracked files、3,246,080 bytes、SHA `5561001725f6f74a120f3286c6d95d705b66489b8e110bb12f305f32bdbd1cd1`。元のモデルrevision/SHAは変えていない。

process memoryは9 processを3段階で測定し、current合計は初期520,388,608、interval928,378,880、最終928,604,160 bytes。HWM合計の最大観測は1,342,283,776 bytesで、同時RSS peakではない。fixture pageのJS heapは65 sample取得した。計測完整性のgateは成功したが、旧idle周期試験と条件が異なり、長期増加・Worker heap・上限・リーク不存在の受け入れには使わない。

証拠は `artifacts/instance-full-audit/6c1a810bd29d17a466ba66d57697c4d0559f511f/` に保存した。audit.json SHAは `c80962687f7bac1a2259a78af8a1b7040dcd77c8890a60a138460af7c5d5b070`、preflight SHAは `47d8d2f84cc5074afc9376ea81f5f90d99144e574574e203c7810926125b497e`。report/log/control/archive/単体失敗ログなど22ファイルのpreserved-evidence.json SHAは `036e21f9d1624c6eda2f5ec6fdab7567f8cc560903eadc629238e78414c03d20`。communicationAcceptanceとresourceMeasurementGatePassedはtrue、memoryGrowthAcceptanceとfullM5Acceptanceはfalse。試行予算は終了し、同じ監査を文書更新だけで再実行しない。

次は現在の配布runtimeに対する最低Chromeの互換性を別条件で固定する。M2/M3・長期資源・native IME/権限・実サービス・remote CIとM5は未達。旧ZIPの更新や正式公開は行っていない。
