# session release runtimeの既定経路・全context監査

2026-11-27事前登録。起点は文書commit `76661f8`、製品runtime/assets sourceは`afbdd24de0c3c7f32f3afa3481f087c2b4a83d3d`。[対照/保持試験](retained-session-trial.md)の両予算は終了したまま、新しい既定経路の通信監査を1回実施する。[旧0ba資産の監査](instance-full-context-audit.md)の合格を新資産へ付け替えない。

## 対象と受け入れ条件

固定資産は`artifacts/retention-trial-build/afbdd24de0c3c7f32f3afa3481f087c2b4a83d3d/control`の78ファイル。既定の保持0で、通常dist・retained資産・モデル・閾値・権限を変更せず、再buildもしない。この文書と検証script/testを含む次のclean commitを監査sourceとし、runtime sourceと区別する。両sourceのextension/packages/build/lock/config blob一致を外側binderで要求する。

Windows11 / Node24.15.0 / Playwright1.65.1 / Chromium159.0.8154.6、ORT Web1.31.1 / WASM1thread。モデルrevision `8d640720bddeb64c89dc1fa7780c3ea29fa523e8`、QUInt8は37,789,676 bytes、SHA `dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`を維持する。既存browser全305ファイルを照合し、downloadや認証/マシン設定変更はしない。

実行するのは既存`browser_security_audit.mjs`のHTTP/WebSocket陽性対照とmanual check6件（短文2・長文1・連続3）だけ。新しい文章やidle周期・再推論・GPU/モデル比較を追加しない。監視はbrowser起動後、Extensions.loadUnpackedより前に開始し、陽性対照後、ツールバー操作と最初の拡張pageより前にofflineへ切り替える。browser bootstrapは範囲外。

実行completed、gateのfailure/security/resource各配列が空、全eligible targetの生存期間監視、HTTPのpage/dedicatedworker/fixture-service-worker・WebSocketのpage/dedicatedworker陽性対照、background/page/offscreen/extension Workerの観測、通信/監視gap/未知target/欠落scope/fatal error/pending0を要求する。claimされたpassing flagだけでなくtarget/eventとsource/assetを外側で検証する。短文/長文/連続6件、前mark消去6回、WASM、offline順序、本文/selection保持、全cleanupも必要。

eligible scopeはpage/offscreen/background-service-worker/extension-dedicatedworker/dedicatedworker/fixture-service-worker/sharedworker。browser-ui、tab-container、拡張に属さないother-targetはこの監査のNetwork監視対象から除外する。拡張に属する未知scopeや監視gapを除外して成功にしない。

`scripts/audit_report_acceptance.mjs`とunit fixtureは、source/asset/model manifest完全性、通信陽性対照、隠れた監視gap/欠落scope、不完全cleanup、OS sample/JS heapの欠落を拒否する。元のaudit script・製品runtimeには変更を加えない。モデルmanifestの必要fileをreportから省略できる欠陥を、実際の失敗assertion（Red）から修正した。最初のimport不在Redと、pre/post不一致で先に拒否されたfixtureのGreenも別ログに保持し、実際の欠陥Redと混同しない。

process memoryのscopeはCDP関連browser process、JS heapはfixture pageだけ。OS sampleの各PID/role・current/peak・合計の完整性を検査する。これを拡張専用RSS、同時peak、Worker専有容量、長期上限やメモリ改善にはしない。今回の時間も監査全体で、推論速度benchmarkではない。

準備検査: 新validator29件とsupervisor12件を含む全TypeScript565件（52 files）が成功し、npm checkも成功した。初回の型検査ではfixtureのsamples[0]の存在を保証しておらず2エラーとなり、初期sampleの存在検査を加えて修正した。失敗ログは保持した。全entrypoint coverageはruntime不変のafbdd24準備時91.67%を参照し、今回へ再ラベルしない。旧audit reportを新validatorで読み戻せたことはschema互換の確認であり、新資産の通信監査成功ではない。

## 予算・証拠固定

監査は1回、retry0。内部CDP5秒、各check240×250ms、sampler stop45秒、cleanup5秒は既存のまま。外側process上限600秒。起動/推論/観測/cleanup/事後照合が失敗してもこの予算を終了し、同条件のretryや期限延長は行わない。観測のyield/timeoutでは同じlive handleを確認して追跡し、別processを起動しない。

上記600秒は監査子processの実行期限。新設した外側のCIM識別・tree終了・終了待ち・事後確認は各10秒までとし、timeout後の後処理は最大50秒に制限する（監査内部の5秒cleanupを延ばすものではない）。正常終了時に残った子は、不確かなPIDへ強制終了を追加せずcleanupVerified=falseとして残す制約がある。全PC metadataは親子関係の一時照合だけに使い、保存するのは所有treeのPID/親PID/creation identityだけとする。

独立レビューにより、外側timeoutの単純なNode強制終了では子孫browserが残り得る点を起動前に検出した。Windows専用supervisorで所有する新規processのPIDとcreation identityを確認し、timeout時のtree終了と事後確認を記録する。identity未確認のPIDへtaskkillせず、所有child handleへのfallbackと子孫のunknownを残す。timeout/cleanup未確認はaudit reportのpassing flagによらず不合格にする。process/report失敗と事後binding失敗も配列に併記し、後の理由で前の失敗を上書きしない。

外側wrapperは`.cache/bind_session_control_audit.mjs`。次のclean sourceで以下を行う。

```text
node .cache/bind_session_control_audit.mjs prepare <audit-source>
node .cache/bind_session_control_audit.mjs run <audit-source>
```

出力は`artifacts/session-runtime-full-audit/<audit-source>/`へ排他的に作成する。source commit/tree/全tracked raw SHA/Git blob・source archive、wrapper自身とコピー、script/helper/lockfile、全78対象資産・両旧build、原dist/78資産、先行14receipt/791証拠、afbdd24の277-file receiptと実ファイルを起動前後に照合する。receipt SHAは`3e27e10c98d38a737da61563625c28314b536d28d0ad6a7504c2a33f3546167b`。旧affc失敗・旧ZIP・旧browser・native接続不可記録も既存保護経路で維持する。古いreceiptやreportは補完・上書きしない。

audit自身のsource/資産pre/post、外側process/log/command/environment/preflight SHA、実report SHA・判定・予算終了を保存する。preparationだけの失敗とbrowser仕事を開始した失敗を区別する。空/欠落/失敗reportを成功へ読み替えない。独立レビュー後に証拠receiptを固定し、後続文書commitへ実測sourceを付け替えない。

schema2 audit reportのenvironment.sourceCommit/treeは監査sourceであり、runtime sourceはreport単体では検証していない。runtime source afbdd24のauthoritative bindingは、外側preflightのGit blob一致・固定資産/provenance・277-file receiptとその事後照合である。validatorのruntimeSourceAuthorityはexternal-preflightとし、report単体からruntime source一致を主張しない。assetIdentity.extensionの固定7キー（manifest/core/background/content/offscreen/worker/model manifest）の欠落を受理した問題もRed→Greenで修正した。

### 起動前の所有process検証

最初のモデルなしsmoke1回は通常sandbox内のCIM権限拒否でroot identityを確認できず、timeout/cleanupVerified=falseとなった。`.cache/audit-process-supervisor-smoke.json`をそのまま保存し、この予算は終了した。既定のPowerShell非終端errorが空JSONに化けたため、ErrorAction Stopを明示した。hanging snapshot、拒否時の反復、親終了後に初めて見つかった子、root終了後のPID kill競合も実Red→Greenで修正した。通常unitから実process smokeを除去し、繰り返し起動しない。

別の許可された読み取り実行では旧親210912不在・直接子0を確認し、CIM照合は5,285.7898msだった。これは元smokeのcleanup成功への補完ではなく、後続の観測記録とする。

次のclean sourceで、CIMを使用できる承認済みローカル実行条件だけを変えた別probeを1回登録する。`.cache/probe_session_audit_elevated.mjs <source>`で新規Node親子2processだけを起動し、実行期限15秒・観測/終了各10秒で意図的timeoutを検証する。root/childのPID・creation一致、両方のtimeout前観測、終了後の所有tree0、cleanupVerified=true、unknownなしを要求する。supervisorのacceptedはtimeoutゆえfalseが正しい。出力は`artifacts/session-audit-supervisor/<source>/`へ排他的に固定する。browser/modelは0。成功/失敗でこの別probeも終了し、失敗時は監査子processを起動しない。これは旧smokeのretryやモデル試行の追加ではない。

## 成功しても残る範囲

今回の対象は新runtimeの保持0による初回/連続入力経路。保持60秒のsession release中・保持期限の通信監査は含まない。既定値への採用は行わず、両経路のLinux/最低Chrome116、長時間資源、M2独立gold/精度、M3 CPU/WASM parity/性能、物理IME/native権限、実サービス/remote CIとM5は未完了。旧ZIP0dc814cは維持し、新ZIP・モデル/Store/npm/GitHub公開は行わない。

## 実行結果（予算終了）

2026-11-27、clean監査source `d3069483ab5cb6023d6baced69b53df65a202e06` / tree `bc59f2e95d3df1a225c4b9c37341b3740e6f6a79`で成功した。runtime sourceは`afbdd24de0c3c7f32f3afa3481f087c2b4a83d3d` / tree `b8552293b0e74ba28f95c89495cbbda561ef5fb2`のまま。全342 tracked controls、runtime関連72 blobと固定78資産を照合した。モデル5ファイル・revision/QUInt8 SHAも一致した。上記の登録手順は履歴であり、再実行指示ではない。

同じsourceの別権限条件probeは新規Node親子2processを起動し、OS上の所有tree4記録を観測、意図的15秒timeout後0件・cleanupVerified=true・unknownなしとなった。supervisor自体のaccepted=falseはtimeoutによる正しい拒否で、probeの動作検証accepted=trueとは別である。最初のCIM拒否smokeと後続postcheckを保持した。両probe予算は終了した。

実監査はWindows11 / Node24.15.0 / Playwright1.65.1 / Chrome159.0.8154.6 / WASM1threadで、offline前提のmanual check6件、前mark消去6回、本文/selection保持と陽性対照に成功した。25 network eventsに予期しない通信は0件。観測10 target中eligible9件は全生存期間covered、browser-ui1件はexcluded/live-unmonitored。background、offscreen、extension Workerを実観測した。欠落scope・eligible監視漏れ・gap・unknown・fatal・pendingは0。重複sessionのdetach警告4件（No session with given id）はlimitationsに残り、警告なしとは主張しない。

popup/browserCdp/cdp/context/browser/fixture/profileの全7cleanupに成功した。外側supervisorもnormal/exit0、accepted=true、所有tree6→0、unknown=[]、cleanupVerified=true。supervisor elapsedは54,984.9001msで、監査bodyのみや推論速度の値ではない。事後bindingErrors=[]、budgetClosed=true。独立レビューはaccepted-with-limitations、blockingFindings=[]だった。

| 資源sample | 関連process行数 | current bytes合計 | process HWM bytes合計 |
| ---------- | --------------: | ----------------: | --------------------: |
| initial    |               9 |       522,014,720 |           528,322,560 |
| interval   |               9 |       974,143,488 |         1,354,964,992 |
| final      |               9 |       974,594,048 |         1,356,673,024 |

fixture-page JS heapは67 samples。これは資源観測の完整性の合格で、拡張専用RSS・同時peak・Worker容量・因果的改善・長期上限を示さない。communicationAcceptance/resourceMeasurementGatePassed=true、memoryGrowthAcceptance/fullM5Acceptance=falseを維持する。新しい精度/parity/WebGPU/latency/coverage測定は実施していない。

証拠は`artifacts/session-runtime-full-audit/d3069483ab5cb6023d6baced69b53df65a202e06/`、モデルなしprobeは`artifacts/session-audit-supervisor/d3069483ab5cb6023d6baced69b53df65a202e06/`。最終receiptは38ファイルを固定し、旧277/791証拠・先行失敗・旧dist/ZIPを再照合した。receipt自身は自身の一覧に含めない。

| 証拠                    | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| 最終38-file receipt     | `8698abb4bf085a048b0ba2c8c3e99fb9bec042c19bd6cbeb00aa575dcc720736` |
| preflight               | `638060bfe2e5614ac91c10264df2f051cd71c43c2a7d47b7bc102de3d24ca7b8` |
| source archive          | `7358c3332f7f608baf5bbb7373c4635598ef88a16ffdb6b919bf868ea60a5971` |
| trial/audit.json        | `18d6ab4189cb1e56cd3b3d906092de3414c6cbadb6ea0c1f04e38b34783f38b0` |
| independent-review.json | `2d75f0efd735c054917d9fbbcb32c848c6a9b591a8d31b59bbd4e45d04baed4c` |
| probe receipt           | `191ccc5658526cdb3b1cdfe9ded20078fb5ca4fd1bae5ce168e26bbc1f3beeb0` |

証拠固定scriptの初回はローカル変数processがNode globalを隠すTDZエラーで、書き込み前に停止した。変数名を修正して固定処理だけを成功させた。browser/model/probeの再実行もreportの変更も行っていない。後続文書commitは監査sourceを置換しない。
