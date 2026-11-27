# Instance identity runtimeのLinux回帰

2026-11-27事前登録。起点はdocs `a77eb9b`、Windowsで検証したruntime `0e13b127cbb79f0ad799b97d1521660919f23657`。[A/Bの証拠と制約](offscreen-instance-identity.md)を維持し、新runtimeの他OS受け入れを進める。Windowsの閉じたA/B・旧資源診断は再実行しない。

## 検証前のハーネス修正

従来のLinux collectorはartifacts/coverage/test-resultsだけを退避し、Linuxでbuildした配布資産をcontainer終了時に失っていた。`dist/extension`も`results/extension`へ保存し、Windowsの固定81資産と全ファイルのサイズ・SHAを比較できるようにする。runtime/モデル/検出閾値/権限/通常E2Eのassertionは変更しない。

実ファイル退避、dist/extensionと祖先/配下symlink、artifacts/extensionとの衝突にRed5件を確認し修正した。関連25件、全Python391件、関連Ruff/formatは成功、独立レビューにblockingなし。既存証拠・空/欠落・再帰先・symlink・衝突を拒否し、元の失敗statusを保持する。coverageの新しい全体値は測っていない。

## 固定する実行条件

- この文書と修正を含む次のclean commitをtracked-only archiveにし、1回だけ実行する。archive/commit/tree、launcher/test/lockfileのGit blob、モデルread-only入力、実行コマンドと結果をsource別へ保存する。
- Linux自身のsourceCommit/runtimeSourceCommitはその新commitに揃える。Windows基準0e13b12へ書き換えず、extension/packages/通常test/build/設定/lockfileの対象Git blobを比較してruntimeコードの関係を証明する。collector/test/docの追加差分は明記する。
- image `kotoba-guard-linux-check:locked-20261127`、ID `sha256:3e7e3086bb864bc828c283ed1224437464e1f97105d04cac46e9a8928840cca3`。実行前にローカルimage IDを再照合する。Node24/Python3.12、2CPU/8GB、専用Linux uv/npm/Playwright cacheを使い、モデルrootはread-onlyでmountする。
- `scripts/harness/linux_validation.py --e2e`だけ。通常6品質ゲート（Python lint/format/test、TS check/coverage、build）とreal E2Eの計7ゲート。`--model`・`--package`、新しい変換/量子化/精度評価、GPU、旧301秒試験は実施しない。
- 既存real E2E7件は変更しない。通常6件と現行idle1件を含み、idleは2タブ4推論/2終了周期/3文書世代、通常編集は24組。Windows A/BとはOS・ゲートが異なる回帰であり、A/Bを追試してreceiptを付け替えるものではない。
- 各testの既存timeoutとretry0を維持する。成功/失敗でこのLinux試行を終了する。同一source/条件のretryや時間延長、失敗後の追加推論は行わない。途中観測がtimeoutしても、生きた実行handleを確認せず新規起動しない。
- uv sync --locked/npm ciとPlaywright OS dependency bootstrapを使う。これは無料のローカルDocker検証であり、remote CI・完全固定されたOS package環境の証明ではない。外部公開・課金・認証変更は行わない。

## 実行手順

clean sourceを確認し、出力を既存のlinux-checkから分ける。PowerShellの標準出力は新しい専用logへ保存する。

```text
uv run --locked python scripts/harness/linux_validation.py --e2e --image kotoba-guard-linux-check:locked-20261127 --image-id sha256:3e7e3086bb864bc828c283ed1224437464e1f97105d04cac46e9a8928840cca3 --cache-dir .cache/linux-instance-validation --playwright-cache .cache/linux-playwright --output-dir artifacts/linux-instance-check
```

最初のcacheには既存Linux dependency cacheを使う場合も内容を削除・上書きせず、専用ディレクトリへコピーする。imageの依存treeとlockfileで環境を再現し、モデルはdownloadせず既存の固定revisionを参照する。

## 判定と証拠

1. launcher本体/collectorのexit0とchecks.jsonの全7コマンドexit0、Python/TS件数、coverageの実値、Playwright7件・skip/retry/flaky0を照合する。実行されていないgateを成功にしない。
2. idleの実document/Worker終了と別世代での再検出、本文保持/非保存、dispose ACK、全cleanupを確認する。通常idle listenerはmarker形式を確認するがraw markerを保存しない。Linux上でWindows Aの旧marker攻撃を実施したとはしない。
3. collectorが保存したLinux extension全81資産を実際にhashし、inventoryの自己整合性とWindows固定runtimeの81ファイルを全比較する。不一致はfile名・サイズ・SHAと原因を記録し、selected JS一致だけで全配布物の一致を主張しない。差分を無根拠にwhitelistして再現性を合格させない。
4. `artifacts/runtime-baseline/0e13b127cbb79f0ad799b97d1521660919f23657/`の81資産/83証拠receipt `b3fd34d72f1ba39b466f6c8c47f4a7af7012f98738c56efb4ed50e226a025b4f`、A86/B9/通常回帰27receiptと各実ファイル、旧ZIPを前後で維持する。receiptのsourceをLinux sourceへ変更しない。
5. Linux archive/test/runtime/sourceの関係を外側controlで照合し、report・trace・coverage・配布bytes・実行logを保存して独立レビューする。後続docs commitによる再ラベルを行わない。

実行前の外側controlにはclean source commit/tree、保存したarchive実bytesとSHA、launcher/全通常test/build/lockfileのGit blobと作業tree SHA、image ID、出力先・実行commandを記録する。実行後も同一値を照合する。launcherの通常receiptだけを根拠に受け入れず、archive/control欠落・不一致は受入不可とする。

機能/ビルド回帰成功と資源受け入れを分離する。idleのprocess RSSは記録するが、比較対象/観測scopeが違うWindows working setとの比率やメモリ改善は主張しない。通信は各既存testのpost-listener scopeに限定し、全context起動監査を代替しない。

M2精度/独立gold、M3数値/性能、資源増加、最低Chrome/全context監査、native IME/権限/実サービス、remote CIとM5の未達は維持する。既存development ZIPは0dc814cで、新ZIP・正式公開候補・公開成功を作ったことにはしない。

## 実行結果（2026-11-27、予算終了）

clean source/runtime `949fe5e77c0198e8263b0145a34f4234861df69e`、tree `b28dd7ee30e462bc8075bc5bc8485682e1082032`で登録した1回だけを実行した。上記image IDとコマンドを照合し、launcher/collectorと全7ゲートがexit0。Python391件、TS380件、実モデルE2E7件が成功し、skip/retry/flakyは0。TS全entrypointのstatementsは1,555/1,750（88.85%）、linesは1,439/1,575（91.36%）。新しい全体Python coverage、モデル精度、WebGPU、package、remote CIは測っていない。

idle試験は144,484.144528ms、4推論・2終了周期・3文書世代でstatus/cleanup completed。各周期のreleaseはcompleted1、failed/timedOut/sendFailedは0で、文書とWorkerの交代、本文保持・非保存を確認した。通常Linux idle試験は旧marker攻撃を追加しておらず、Windows A/Bの証拠を置き換えない。通信/page error0は各testの監視開始後の範囲に限る。

6段階すべてで関連process10/10件のRSSを取得した。最後のresume-2合計は2,197,364,736 bytesで、resume-1とPID/role/parentPid cohortが異なるため比率はnull。拡張専用RSS、同時peak、Windows working setとの比較、資源改善の証明にはしない。memoryAcceptanceとfullM5Acceptanceはfalse。

### 配布物の不一致

Linux実配布物は82件、Windows固定基準は81件だった。共通80件のうち77件のbytes/SHAが一致し、JS/WASM/ONNX全11件とmodels配下全6件は一致した。両source mapのSHAも一致した。一方、次の差分を保持する。

- Linuxだけのlicense: `@img__sharp-linux-x64@0.35.5/LICENSE`、`@img__sharp-linuxmusl-x64@0.35.5/LICENSE`。
- Windowsだけのlicense: `@img__sharp-win32-x64@0.35.5/LICENSE`。
- 共通のJSON差分: `dependency-licenses.json`、`bundled-runtime-audit.json`、`distribution-manifest.json`。auditの変更keyはexcludedNativeImagePackagesのみ。Linuxの自己manifestは実82件に整合した。

`scripts/licenses.mjs`がインストール済みのOS別optional Sharp/libvipsを列挙し、bundle非収録でもlicenseをコピーすることが原因だった。実行資産の一致を全配布物の再現性へ拡大せず、allDistributionAssetsIdenticalとcrossOsNonLicenseAssetsIdenticalはfalseのままとした。次はbundle非収録の根拠を維持した、lockfileに基づく決定的なlicenseメタデータをTDDで実装する。

### 外側検証の失敗と追加監査

初回postflightは、preflightのJSON listとPython内tupleの表現差で停止した。元script/logを保持し、JSON正規化後にbinding全体が一致すると確認した。比較式1か所だけを正規化する読み取り専用監査は、その後81件という誤った想定で停止した。この失敗も保存した。追加監査で元のsource/archive/ゲート/idle assertionを照合し、実82件を全inventoryとして記録した。失敗した元postflightが成功したとは扱わない。元preflight/report/scriptの編集、追加のモデル・ブラウザ実行、再試行は行っていない。

### 保存場所とSHA-256

実出力は `artifacts/linux-instance-check/949fe5e77c0198e8263b0145a34f4234861df69e/`、外側controlは `artifacts/linux-instance-controls/949fe5e77c0198e8263b0145a34f4234861df69e/`。archiveは302 tracked files、3,194,880 bytes、SHA `760837d1da29e144b5b57c3510fe7b1cbc977bba1fd92f1becc2bef73b19b66c`。結果・全配布bytes・失敗・controlの167証拠をpreserved-evidence.json（SHA `517b2fb799a2e394b8fd20983e8192d8c03c6399c37037d5f57eb8b067ded6e2`）に固定した。

解釈の追加2ファイルは `artifacts/linux-instance-asset-analysis/949fe5e77c0198e8263b0145a34f4234861df69e/` に別保存した。analysis.jsonのSHAは `151b556048953674546bf7b063dafe3fff9dd1b60a5231bfcec54b345c29ce14`、receiptのSHAは `ed047fcf79d7a7fc9950208a9eb49bd6b3a85042c36f805e350aa42e954324e6`。先行Windows205証拠と旧ZIPは不変。独立レビューにblockingなし。Linux機能回帰の成功と、配布再現性・資源・M5の未達を分けて再開する。
