# 現runtimeのChrome116 idle互換性

2026-11-27事前登録。旧[Chrome116 fixture試験](chrome116-compatibility.md)は0dc814c runtime限定で予算終了済み。0dc→0baの製品変更はbackground/offscreen/workerの文書世代照合と解放経路にあり、content/coreの変更はない。現runtimeの変更箇所を、既存のidle試験で一度検証する。旧編集fixture・Windows159 instance A/B・Linux・全context監査は繰り返さない。

## 条件と束縛

この文書とreport source分離の修正を含む次のclean commitをtest sourceとする。runtime asset sourceは `0ba36301cdb1b2b9759ce81dbdc8fb6837648bbe`、固定済みwindows-extension全78資産を再利用する。root distも全path/bytes/SHAが一致することを前後検査する。モデルrevision `8d640720bddeb64c89dc1fa7780c3ea29fa523e8`、QUInt8 SHA `dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`、WASM1thread、閾値と製品runtimeは不変。

Windows11 / Node24 / Playwright1.65.1 / 既存のChrome for Testing116.0.5845.96を使用する。exe SHAは `7460094ab51e1cb2fa6abeef0683275bb99684ad00334556547d7f4a6dd84c4e`、取得ZIP SHAは `58ce894d230738e5b05ec0e20f8283c77070a97afb21bae3175e13f2b0af08b7`。外部download・machine/browser設定の変更は不要。これらのhashはローカル取得物の来歴であり、公式署名の代用ではない。

Chrome116固定tagの[公式CDP定義](https://raw.githubusercontent.com/chromium/chromium/116.0.5845.96/third_party/blink/public/devtools_protocol/browser_protocol.pdl)にTarget.autoAttachRelatedとoptional filter、SystemInfo.getProcessInfoが存在することを静的確認する。autoAttachRelatedはBrowser target限定のexperimental API。現在のhelperはbrowser CDPで呼ぶ。定義の存在は実行成功の保証ではなく、実際の1試行で受理・Worker観測を確認する。[PlaywrightのexecutablePath](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-executable-path)による任意Chromeはbundled Chromiumと同じ保証対象ではない。

idle reportは従来runtimeSourceCommitへtest sourceを複写していたため、明示的RUNTIME_SOURCE_COMMITを独立記録する小さいhelperを追加した。環境指定は40桁lowercase commitを検査し、不正値とtest sourceなしのruntime指定を拒否する。未束縛の通常ローカル実行はworking-treeを明記する。これは実Gitや配布資産の検証を代替せず、外側controlが実HEAD/tree/clean、control Git blob/raw SHA、全78資産、実行cloneのmanifest以外77ファイルと唯一のfixture host grant差分を前後照合する。

未実装helperをimportするRedを保存した後、source分離・同一source・未束縛・不正値・runtimeだけの指定拒否を5テストで確認した。関連10件、全TS411件とnpm checkが成功。独立レビューでは上記の実HEAD・実browser・clone資産束縛を必須と確認した。製品runtime・モデル・依存関係は変更していない。

`2adeee5`では起動前preflightのみ成功し、browser/modelは未実行。外側binderの独立レビューでcycle長だけの再判定不足を指摘されたため、IDの3世代連鎖・release各値・6 phaseとidle/ready状態・snapshotとの対応を明示検査する。symlink拒否と公式PDL取得bytesのSHA `685dfe50fca9d91116412afeb42990d5f7a38857cb8336d4729a75650f166390`も固定する。旧preflight8ファイルは編集せず保護し、この補足を含む次のclean sourceで初回browser試行を行う。これは失敗したbrowser試行のretryではない。

外側controlはGit archive、実行script/config/command、exe/ZIP/公式protocol取得bytes、既存8receiptの626証拠と旧0dc ZIP、旧Chrome116両試行の27ファイルを保護する。出力は `artifacts/current-runtime-chrome116/<test-source>/` に新規作成し、既存outputを拒否する。SOURCE_COMMITは実HEAD、RUNTIME_SOURCE_COMMITは0baの40桁を指定する。Playwright JSON/JUnit/last-run/trace/logもこの出力内へ分離し、既存reportを上書きしない。

## 実行予算と合格条件

```text
node node_modules/@playwright/test/cli.js test tests/e2e/idle.real.spec.ts --project=real --workers=1 --retries=0 --reporter=line,json,junit --output <source別test-results>
```

試行は既存idle.real.spec.tsの1件・1回のみ。2タブ4推論、idle2回、Offscreen文書/Workerの3世代、6段階のOSメモリsampleを確認する。test240秒、idleごと85秒、cleanup各5秒の既存上限は変更しない。起動・観測・assertion・cleanupのいずれかに失敗した場合も途中report/trace/logを保持し予算終了とする。skip/fallback/同条件retry・モデルや設定変更による再試行はしない。観測待ちが切れても同じprocess handleの終了を確認し、別のbrowserを起動しない。

合格には実browser version116.0.5845.96、test1件passed/skip・retry・flaky0、offline WASM検出4回、各idleでmodelReady=false/Worker0/Offscreen0、文書ごとrelease ACK completed1/他0、新しい文書IDとWorker IDでの再検出、本文保持・非保存、監視開始後の外部通信/page error0、全cleanup completed、source/全資産/旧証拠/実行cloneの不変照合が必要。OS sampleは全6段階measured・rows非空とし、PID cohortとworking set/HWMをそのまま記録する。

UUID形式はnoticeで検査するが、raw instance markerを保存・世代比較しない。旧marker攻撃拒否はWindows159の別試験の証拠であり、今回の116試験から保証しない。fixtureへのhost grantは隔離コピーのmanifest overrideであり、native権限承認・取消ではない。offline切替はfixture/popup読込後、推論前。通信はlistener設置後のみで全startup監査ではない。物理IME・実サービス・全116patch・WebGPU・精度・parity・性能・長期資源・remote CIとM5へ成功範囲を拡大しない。旧ZIPは0dc814cのまま、公開は行わない。

次の作業は試験結果の固定と独立レビュー。その後もM2独立gold/実用精度、M3数値/速度、資源増加、native/実サービス/remoteの不足を保持する。

## 実行結果（予算終了）

実行sourceはclean `7554a696d3b7bffe6c14503f7f4830655e9ebaa8`、runtime asset sourceは固定0ba3630。1件を1回実行しexit1、試験本体52,389.1046ms、外側process57,621.2472000625msで失敗した。2タブのmarkとWASM readyのassertion後、`idle.real.spec.ts:342`のWorker観測が30秒以内に1件とならず、0件のままだった。2件の検出を通過したことは保存trace/logの実行順から確認するが、reportのcompletedInferencesは成功時にしか保存していなかったため欠落している。idle/reloadは0回であり、互換性は合格にしない。

固定exeのProductVersionは116.0.5845.96、前後SHAは一致し、traceのfixture request UAにはChrome/116.0.0.0を確認した。ただし実行中に取得したbrowserVersionもfailure reportへ転記しておらず、report単体の実version検証は不成立と記録する。UAのreduced versionだけでpatchを補完しない。`Target.autoAttachRelated`のprotocol errorで停止したわけではないが、raw target inventoryを保存していないため、parentの未発見・空URL・target type・関連attach後の非公開のどれかは断定できない。Workerの未観測を製品側Worker不存在や推論失敗と同一視しない。

before-inferenceのOS memory1 sampleのみ取得した。9 PIDでmeasured、idle/resumeの5 sampleは未取得。観測後の外部通信/page errorは0。cleanupはCDP3.3119ms、context3,358.8509ms、fixture0.7477msですべて5秒内に完了した。source/control・全78元資産・cloneの77資産と唯一のfixture manifest grant差分・binary/ZIP/PDL・先行626証拠と8receipt・旧Chrome27証拠・旧ZIP・未実行preflight8ファイルの一致を確認した。cloneを実配布の権限構成と混同しない。

`artifacts/current-runtime-chrome116/7554a696d3b7bffe6c14503f7f4830655e9ebaa8/` にreport・Playwright JSON/JUnit・trace・失敗画像・source archive・control・clone照合・logを保持した。archiveは309 tracked files、3,256,320 bytes、SHA `ea022647964a566457ebf7d267465e02190e1c37eff22ba90ec7ce159b4bb1f3`。idle.json SHA `cb306c13a8e542d7b10d4a389fa38c7d8b27209c29f91e3e3f3fa601f55086c5`、preflight SHA `dd83a76389d6dfee56aa224a5683f35c7d1c5bbbca02ec2333465a724d3bffe4`。23ファイルを束縛したreceipt SHAは `4afc4bb7d14318de02d2698d6e00535d4106cfc81bafd7e941ee77ba4669c45b`。comparisonのboundedCompatibilityAcceptance、memoryGrowthAcceptance、fullM5Acceptanceはfalse。成功の既存Chrome116/159レポートへ結果を付け替えない。

## 次回の観測改善

失敗後、worker observerへURLやtarget IDを含まない件数診断をTDDで追加した。全target数・所有Offscreen数・所有Worker数・URL空Worker数・関連attach試行/成功parent数・観測stageだけを通知する。idle試験では最後の1件だけ保持し、browserVersion（未取得ならnull）と完了検出数も成功/失敗の両方に保存する。失敗伝播とforeign URL等の非記録を含む単体3件、全TS413件、npm checkが成功。これは将来のハーネス変更であり、凍結した失敗reportの補完ではない。新規browser/modelは実行していない。

次はモデルをロードしないChrome116のtarget観測probeを別登録する。所有Offscreenと最小Workerを1世代だけ作り、CDP inventoryの分類と関連attach前後、終了/cleanupを確認する。まず観測手法の成立を確認し、同じ実モデル試験を再起動しない。旧23証拠を保護し、必要な変更条件・source・予算・中止・新しい受け入れを事前固定する。現runtimeのChrome116 idle互換性・native/実サービス/remote・資源・M2/M3とM5は未達のまま。
