# M4: 最低Chrome版116の実行検証

事前登録: 2026-11-27。manifestの設計下限116は実測されていなかった。M2精度・M3数値一致とは別に、同じ開発runtimeの互換性を確認する。

## バイナリと対象

[公式Chrome for Testing milestone API](https://googlechromelabs.github.io/chrome-for-testing/latest-versions-per-milestone-with-downloads.json)の116はversion `116.0.5845.96`、revision `1160321`。Windows x64 [ZIP](https://storage.googleapis.com/chrome-for-testing-public/116.0.5845.96/win64/chrome-win64.zip)をプロジェクト内へ隔離取得した。システムインストール・既定browser変更・認証操作は行わない。

- ZIP: 135,737,736 bytes、ローカルSHA `58ce894d230738e5b05ec0e20f8283c77070a97afb21bae3175e13f2b0af08b7`
- API取得bytes SHA: `27ddeeec9062ba13a331f040db28023841cb7ebecb7f568bd9ba0a8cf5d7d560`
- chrome.exeのProductVersion: `116.0.5845.96`、ローカルSHA `7460094ab51e1cb2fa6abeef0683275bb99684ad00334556547d7f4a6dd84c4e`

APIはarchiveのSHAを公表していない。このSHAはローカル取得物の同一性を表し、公開済み署名hashと照合できたとは主張しない。取得日時・URL・API bytesは`.cache/chrome-for-testing-116.0.5845.96/`へ保存。展開前にZIP entryの出力先が隔離ディレクトリ内であることを確認した。

対象runtimeは既存`0dc814c`の全81資産をWindows ZIPと照合したもの。モデルは元のsanitized QUInt8 `dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab`を維持し、失敗したhybrid候補は使わない。`automatic.real.spec.ts`はfixture originだけを事前許可した隔離コピーを作る。これはnative権限承認の検証ではない。

## 実行条件・判定・停止

Playwright1.65.1の`executablePath`に上記exeを明示し、`--headless=new`を使う。[Playwright公式](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)は同梱版以外の動作を保証していないため、起動プロトコル失敗と拡張機能の非互換を区別する。版は実際の起動browserから確認する。通常のE2Eは引き続き同梱Chromiumを使い、選択を暗黙に切り替えない。

既存`tests/e2e/automatic.real.spec.ts`の1 testを、retry0で1回実行する。startup・offscreen/worker初期化、オフライン実モデル検出、textarea/input/contenteditable、合成IME確定・機密欄除外・自動チェック等、そのtestが持つassertionを維持する。外部通信監視は既存listener登録後の範囲であり、全startup通信の証明ではない。物理IME、native権限、実サービス、全OS、CPU/WASM数値一致はこのtestから合格にしない。

browserが起動できない場合はツール互換性の限界として保存し、Chrome116の拡張機能実行は未検証とする。拡張やWASMで失敗した場合は、その失敗と段階を保存する。好都合な再試行、別のChrome116patch選び直し、timeout緩和、assertion削除、Chromium159へのfallbackで成功にしない。起動前のrunner実装不具合はTDDで修正し、結果へ記録する。未通過のまま最低版の実証済み表示をしない。

test sourceをclean commitへ固定してから実行し、source・runtime source・ZIP/81資産・browser archive/exe SHA・JUnit/JSON・終了コード・制約を`artifacts/compatibility/chrome116/<test-source>/`へ保存する。過去の`artifacts/playwright.json`は上書きしない。

## 起動前のrunner検証

起動helperをRed（import不在）から実装し、通常channelの維持・明示した絶対exe・空／相対path拒否の5件を確認した。独立レビューで起動失敗時のfixture server残存を指摘され、起動・監視もtry内へ移し、context/serverを各5秒でcleanupするhelperを追加した。エラーを保持し、context失敗／未生成／timeoutでもserver cleanupを試行する4件が成功した。メソッドのthis bindingも維持する。

全TS248件・npm check（ESLint／型／Format）が成功し、独立レビューで起動前の重大指摘なし。3編集欄のハイライト可視性とcontenteditable本文保持もassertする。実行browserのversion/sourceはPlaywright annotationへ保存し、失敗時にも専用JSON/JUnitで追跡する。これはrunner検証であり、Chrome116の実モデル成功をまだ意味しない。

## 初回結果: c85e6d1 — テストassertion不備で失敗

clean source `c85e6d1ceeb4e55be3d5fd48288907220f381206`で登録した1回を実行した。実browser annotationは`116.0.5845.96`、retry0・skip0・flaky0、1件failed、終了コード1、外側timeoutなし。traceに含まれるtest sourceはこのGit commitのblobとbyte一致した。元runtime81資産・chrome.exe・以前のPlaywright/automatic reportは実行後も不変。

起動、site有効化、オフラインのtextarea・text inputでの実モデル検出と可視性assertionは通過。追加したcontenteditableの検査で`.kotoba-guard-mark`を30秒待ち、失敗した。しかし`HighlightManager.show()`はcontenteditableではCSS Custom Highlight APIを使い、このspanを作らない。既存manual E2Eも`CSS.highlights.get('kotoba-guard-errors')`を確認していた。rootが誤った検査を追加したことが原因で、Chrome116の非互換やモデル不具合とは判断しない。

保存画像`test-failed-2.png`にはcontenteditableの「移行」の赤い下線と「検出1件」が見える。trace snapshotにも入力本文が存在する。ただし、この回ではnative registryのrange/offsetを保存していない。後続の機密欄・全体無効化・storage・通信/page errorの最終assertionへ未到達なので、その成功や0件を主張しない。`automatic.json`は未生成だが、専用JSON/JUnit/trace/4画像を保持した。元の1回分の予算は終了し、失敗を成功へ変更しない。

成果物: `artifacts/compatibility/chrome116/c85e6d1ceeb4e55be3d5fd48288907220f381206/`。

- Playwright JSON SHA: `494a8d61fdfc4f070ba380c4c54a26fa5efb2ee4ba288408b06e9a75800fb02d`
- JUnit SHA: `0da56f3848608535d38589488c95eed7a698a740e139bbcb8768606019260b4b`
- trace SHA: `1446685a776f692e5f459ae20b5120815650ff541c64ad53516ea5733b0eb482`
- contenteditable画像SHA: `7f01d02543ea2aed047f353385a738aea4522abf6c8d58ab34a716a559ffb4c8`

## 訂正したハーネスの別検証を事前登録する

初回の誤りを回帰テストから修正する。contenteditableは実native registryから対象editor内のRangeを読み、text=`移行`、元本文のUTF-16 start/end一致、正のclient rectとviewportの交差、可視なsummary、本文保持を要求する。textarea/inputのoverlay検査と、それ以降の機密欄・停止・storage・通信assertionは保持する。global無効化後はnative Rangeも空になることを追加検証する。製品runtime・モデル・browser・推論設定・既存timeoutを変更せず、実装とは異なる表示形式を要求したtestだけを訂正する。

単一の自己完結した読み取り関数をunitと`Locator.evaluate`で共用する。native Rangeがありspanはないfixture、他editorのRange、registry欠落、0幅／viewport外のRangeをunitで検証する。DOMやselectionは書き換えない。

修正・unit/static・独立レビューを通した新しいclean sourceで、**訂正レーンとして1回・retry0**だけ実行する。初回の全成果物は保持し、`artifacts/compatibility/chrome116/<corrected-source>/`へ別保存する。失敗時はその段階と未到達assertionを記録し、timeout緩和・別browserへのfallback・同一sourceの再実行で合格にしない。通過しても最初の失敗を消さず、M2/M3/native権限/物理IME/実サービス/remoteの不足を代替しない。

訂正前のunit/static結果: native inspector4件、全TS252件、npm check成功。surrogate pairを含むnested textでUTF-16 start2/end4を確認し、DOMとselectionの不変性も検査した。独立レビューでselector訂正・Range/位置/可視性・無効化後消去・既存assertion維持を確認し、実行前の重大指摘なし。cleanupのthis binding回帰は修正後のGreenで確認したが、独立した修正前Redの実行記録はないため、それがあったとは記載しない。

## 訂正レーン結果: 31f7852 — 限定範囲で成功

clean source `31f7852553c71af8e0b1cd3d5e8df6a7056dd814`、同じ`0dc814c` runtimeとChrome `116.0.5845.96`で1 testが成功した。retry0・skip0・flaky0、終了コード0、外側timeoutなし。Playwright全test時間は約10.1秒、外側runnerは約10.9秒であり、推論速度のbenchmark値ではない。

成功したassertionは、オフラインのtextarea/input/contenteditable検出、3欄の表示、合成composition中の推論抑止・確定後検出、機密欄除外、global無効化後のoverlay/native Range消去と再入力後の非表示、本文保持、サンプル本文のstorage非保存。contenteditableは期待した「移行」のUTF-16範囲とviewport内の正のRange rect、可視な「検出 1件」summaryを確認した。通信監視登録後の予期しない外部通信とpage errorは0。

Playwright JSON/JUnitは全test成功を記録し、`automatic.json`は実browser version、fixture権限の制約、2 tabs、通信・errorの空配列とstorage keysを保存する。後者に全assertionの個別値が含まれるとはしない。`observations.json`にはsource4ファイルのSHAとGit blobとのbyte一致を記録した。

初回失敗を含む18保護ファイル、元runtime81資産、chrome.exeは実行後も不変。初回失敗は別sourceの不合格として保持し、訂正後の成功で書き換えていない。独立レビューでも実行source/runtime/binary/hash・件数・制約の整合を確認した。

成果物: `artifacts/compatibility/chrome116/31f7852553c71af8e0b1cd3d5e8df6a7056dd814/`。

- Playwright JSON SHA: `556bfa26d21039f07275a1a4de79b43611497b92290b6609496864f805bcf85e`
- JUnit SHA: `6eddf3d882288227a6b113cf71d68210e8546c0f11d1bffc6294c6f365b40ee6`
- automatic metadata SHA: `f373e2dd85b92e205392a0bef807fb9a03c4d50c9236fc113e9a18cb0c7b01e8`
- observations SHA: `801e38b62749994251dd823220fada354261b5cb76ac0b28ea334104aa1b45be`

両レーンは終了した。同source・同条件の再実行は次のタスクではない。Chrome116の限定fixture互換性を確認しただけで、全機能・全site・native権限・物理IME、全startup通信、精度・CPU/WASM parity・性能・M5の合格にはしない。
