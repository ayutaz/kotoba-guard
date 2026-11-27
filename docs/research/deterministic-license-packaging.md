# OS別native依存と配布ライセンスの決定性

2026-11-27。[Linux949fe5eの回帰](instance-identity-linux-validation.md)で全配布物が82対81件となった差分を修正する。以前の失敗判定と167+2証拠は変更しない。

## 原因と実装

`scripts/licenses.mjs`はインストールされたoptional Sharp/libvipsのmanifestとlicenseを列挙していた。実bundleに非収録でもOS固有のlicenseをコピーし、dependency-licenses.jsonとbundled-runtime-audit.jsonにもOS差が生じていた。

修正後はproduction lock graphからSharp/`@img/sharp-*`のname/version/licenseを記録し、filesを空にして明示的なnotBundledReasonを付ける。インストール有無に依存しない。除外には従来どおり非空のcore source mapが必要で、Sharp由来sourceを含めば失敗する。同梱コードのlicense text要求とORTのprovenance検証は維持する。これはsource mapで除外を証明したnative image依存への限定変更であり、全optional依存・全OSへの一般的保証ではない。

## TDDとローカル検査

最初のpytestは既定Tempのアクセス拒否で5成功/3setup errorとなったため、そのログを残し、workspace内の新規basetempを指定した。実装前のWindows/Linux依存fixtureでは配布物比較が1失敗/7成功。修正後は8成功、全Python394成功、関連Ruff/format、npm check、Windows build、配布directory検証が成功した。最初のbuildもUV_CACHE_DIR未指定のアクセス拒否を保持し、workspace cache指定後に成功した。fixtureと実Windows buildは、commit前の作業treeでの検査として扱う。

Windows buildは78ファイル（manifest自身を除く検証77件）。保存済みWindows0e13b12に対し実行資産/modelの重複を除く16件のbytes/SHAは不変。これは配布メタデータ修正であり、新しい精度・モデル推論・IME・通信監査・資源改善の実測ではない。独立コードレビューにblockingなし。

ログはartifacts/deterministic-licenses-{red,behavior-red,green,python,npm-check,build,build-green}.log。Redとsetup失敗を成功ログへ上書きしない。

## 固定Linux検証の事前登録（実行前の記録）

この実装と文書を含む次のclean commitで、Windows配布物を新規source別保存先へ固定する。tracked-only archiveとimage IDを照合し、Linux launcherを**--e2eなしで1回だけ**実行する。通常6品質ゲートとbuild/exportだけを対象にし、モデル変換・AI推論・ブラウザ・package・GPUは実行しない。モデル資産は既存のread-only入力をコピーする。

```text
uv run --locked python scripts/harness/linux_validation.py --quality-only --image kotoba-guard-linux-check:locked-20261127 --image-id sha256:3e7e3086bb864bc828c283ed1224437464e1f97105d04cac46e9a8928840cca3 --cache-dir .cache/linux-instance-validation --output-dir artifacts/linux-license-check
```

実行前にsource commit/tree/clean、実archive bytes/SHA、scripts/licenses.mjsとlockfileのGit blob、既存receipt、Windows全配布bytesを保存する。既存出力を上書きしない。受け入れには6ゲートexit0、Linux/Windowsの全ファイル名・サイズ・SHA一致と各manifest自己整合性が必要。固定件数だけで判定せず、全inventoryを比較する。成功/失敗で予算終了とし、同条件での推論やブラウザ試行は追加しない。失敗なら差分をそのまま記録する。

この比較の成功も、全品質・精度・最低Chrome・全context監査・native/実サービス/remoteを同一sourceへ揃えたM5受け入れや正式公開を意味しない。既存ZIPは0dc814cのまま保持する。

実行準備時に、既存CLIが--model/--e2e/--packageのいずれかを要求すると確認した。その時点ではLinux試行を起動せず、Red5件から明示的な--quality-only laneを追加した。他lane/collectとの併用を拒否し、既存の通常6ゲートとbuildだけを実行する。修正後のclean sourceで上記コマンドを実行した結果は次節に記録する。

## 固定試行の結果（予算終了）

clean source `0ba36301cdb1b2b9759ce81dbdc8fb6837648bbe`、tree `9ae524a19e346cfa1106fd222a360d05e6e9b397`で上記のquality-only試行を1回実施した。launcher/collectorと通常6ゲートはすべてexit0。LinuxのPython399件、TS380件が成功し、全entrypoint coverageはstatements1,555/1,750（88.85%）、lines1,439/1,575（91.36%）。SDK lines94.56%。モデル推論・変換・ブラウザ・E2E・通信監査・packageは実行していない。

同じclean sourceのWindows buildも成功した。最初に保存した78資産との一致を再確認し、後から記録したことを明示したwindows-build.jsonとbuild logを保存した。Linux/Windowsの**全78ファイルで名前・サイズ・SHAが一致**し、distribution-manifest自身も一致した。各manifestは残る77資産と整合する。今回の両OS/x64依存構成での配布差は解消した。949fe5eの82対81件の失敗は保持し、新結果で書き換えない。

事前/事後に先行374証拠・6receiptと旧ZIPの不変を照合した。archiveは303 tracked files、3,215,360 bytes、SHA `abdaea262574c82e8207d83ee9381153fb268f506ad700800e8c45d091b1b107`。固定image ID・実行command・Git blob・archive実bytes・配布bytesを外側で結合した。JS/WASM/ONNX11件とmodels配下6件（重複を除く16件）は旧Windows0e13b12と同一で、推論結果を新sourceへ付け替えていない。

結果は `artifacts/linux-license-check/0ba36301cdb1b2b9759ce81dbdc8fb6837648bbe/`、control/Windows配布物/失敗ログは `artifacts/license-packaging/0ba36301cdb1b2b9759ce81dbdc8fb6837648bbe/` に保存。後者のpreserved-evidence.jsonが両ディレクトリの230ファイルを固定する。receipt SHAは `8cddfdbc5c4a3c305d98054d21c0367e2cb74cdd3ecb4a818266734b47194d09`、preflight SHAは `1731d8ed2ee1ec5974a3ac9971b24ee69a36b7a5e177ebd11fd6faf6385323b5`。qualityGatesAcceptanceとallDistributionAssetsIdenticalはtrue、fullM5Acceptanceはfalse。独立レビューで実装・外側controlを確認した。

次は現runtimeの全context通信監査を準備する。既存scriptの初回extension page読込より先にofflineを設定すること、全配布資産とsource/tree/cleanを束縛すること、既存出力を拒否することをTDDで確認し、登録した別試行でのみ実行する。最低Chrome、資源増加、M2精度/独立gold、M3数値/性能、native IME/権限、実サービスとremote CIも未達。旧ZIPの更新・正式公開は行っていない。
