# Linux validation

文書確認: 2026-11-28。以下は旧sourceのLinux検証履歴。最新aea6caf previewの
Linux検証は未実施で、旧モデル/配布資産の成功を転用しない。[現在の検証](preview-validation.md)を参照。
開発停止中の文書保守ではDockerやCIを実行しない。

現配布物の[0ba3630 quality-only検証](research/deterministic-license-packaging.md)はLinux通常6ゲート・Python399/TS380とWindows/Linux全78配布ファイル一致に成功した。Linux実モデル7件は[949fe5e](research/instance-identity-linux-validation.md)の結果を保持する。後続[6c1a810の通信監査](research/instance-full-context-audit.md)はWindows限定で、Linuxの新しい通信監査ではない。以下は以前のruntime/sourceの履歴。

## 新runtimeの回帰検査（2026-11-27）

idle Worker追加後のruntimeを検査する前に、launcherの証拠保持を修正した。以前は新E2Eの`SOURCE_COMMIT`/`RUNTIME_SOURCE_COMMIT`がコンテナへ渡らず、階層下のidle/stress reportとtest-results traceも収集対象外だった。Red4から、2つのsource環境変数、階層を含む結果export、既存の非空出力の起動前拒否を追加した。exportの既存証拠・symlink・出力衝突・再帰コピーを拒否し、copy失敗は終了コード2とする。

exportは内部CLI `--collect-results`でDocker/Gitを使わずに実行する。EXIT trapは本体の非zeroを保持し、本体0でもexport失敗ならnonzeroにする。固定imageのネットワークなし・モデル/ブラウザなしprobeでも、検査/退避の終了コード4条件（0/0→0、7/0→7、0/2→2、7/2→7）を確認した。全Python383件、関連17件、全Ruff130ファイルが成功。全体Python coverageの新規測定や旧snapshotへの付け替えではない。

独立レビューの空/欠落evidence・出力先symlinkをRed3から修正した。初回全体再検査は385件成功・衝突検査のエラーメッセージ順序1件失敗となり、構造的衝突を空判定より先に検査して、全Python386件が成功した。テストの削除・期待値の緩和はない。追加3対策の再レビューもblocking指摘なし。失敗ログは`artifacts/linux-evidence-{red,review-red,review-green,final-green}-20261127.log`、4条件probeは`artifacts/linux-export-trap-20261127.json`に保持する。空exportは成功にせず、Linux本体の合格時にはchecks.json・Playwright結果・source-bound reportを別途必須照合する。

実行前に固定した条件: 次のclean sourceをtracked-only archiveとして固定imageで`--e2e`のみ1回検査する。通常6品質ゲートとreal E2Eを対象にし、`--model`/`--package`や閉じた数値候補・旧301秒試験は実行しない。新runtimeのLinux回帰であり、Windowsのclosedなidle試験の再実行ではない。source/モデルread-only・2CPU/8GB、実モデル7件には新idle2サイクルと通常24組の編集を含む。結果・失敗traceをsource別へ保存する。

clean `4296639b5c6728ccf3f2ebff0c531d2b68f96a5e`の1回実行は終了コード0、全7ゲート成功。Python386件・TS269件、実モデルE2E7件が成功し、skip/retry/flaky/unexpectedは0だった。E2E全体270,583msにはidle待機と編集を含み、推論速度として使わない。TSはstatements1,354/1,541（87.86%）、lines1,263/1,395（90.53%）、SDK statements92.42%・lines94.56%。Python全体coverageは今回測定していない。

新しいidle試験でも2タブ共有・2回の解放/再初期化・4推論と全cleanupが完了し、6段階すべて10 PIDでmeasured。最後の関連process RSS合計2,149,777,408 bytesを含めて保持する。Windowsのworking setとの単純比較、拡張専用メモリ、長期リーク不存在の根拠にはしない。[測定値と制約](research/idle-worker-resources.md#linux回帰4296639)を参照。通常24組編集も成功したがfixtureのpermission removalはfalseで、native成功にはしない。

成果物は`artifacts/linux-check/4296639b5c6728ccf3f2ebff0c531d2b68f96a5e/`。新collectorがnested idle/stress report、coverage47ファイル、test-resultsを退避し、launcher receiptも保存した。checks SHA `9dbbf2c9c68ef82f03bb07c48358fc4c9062b74b967f14e949f7680a3aba65fe`、Playwright SHA `934e992b643f3652e57fea33ba31363487918a33d0a66912d005542922e904e4`、launcher SHA `6c76a2f8f291666a73a986bfca3fcaa942fd4ddd3cfee38deeb44c5167f88c17`、idle SHA `10a7577541ba61e36d0f914d314c2a3bbba2325dab4b574a4ef0b767ac8a109d`。clean source/archive SHA `44957513e9a8d891f58d8e81128512adbb9d56649030dc459f8e47e837799dc7`とimage IDを照合し、各証拠の全ファイルhashは`verified-evidence.json`へ保存した。独立レビューでも整合性を確認した。

モデルと選択した5つの実行JSのSHAはWindows6850aafと一致したが、distribution-manifestのSHAは異なる。全配布資産のOS間同一性は主張せず、manifest差の原因も未確認のままにする。元モデル・通常変換・package・全context通信監査を今回再検査したとは扱わない。既存0dc814cのZIPは不変。これはローカルLinux回帰で、remote Actions・新全10ゲートsnapshot・M5公開候補の合格ではない。

以下は旧snapshotの履歴であり、今回のruntimeの合格として使わない。

Clean source `0dc814cda3bfec86379928f505c6d3ed2725b5dc` subsequently passed all ten gates on the same locked-20261127 image ID below: Python297, TypeScript234, real-model E2E5, conversion/tokenizer/build/package; zero skips/retries/flaky tests. ZIP53,019,197 bytes, SHA `4a9fbbfe36a4f98fffe72f9c5ecd664f94a881890a3c3998425b9f38a9ddc6c2`. Reports: `artifacts/linux-check/<full-commit>/`. See [current snapshot](validation-0dc814c.md). Use explicit `--image kotoba-guard-linux-check:locked-20261127 --image-id sha256:3e7e3086bb864bc828c283ed1224437464e1f97105d04cac46e9a8928840cca3`; the CLI default remains the historical image. Playwright OS dependencies are installed at runtime, so this is not a fully pinned OS package claim or remote Actions execution.

On 2026-11-27, clean source `67217cc172cacc36bff0a970a556a35ec5f16564` passed all ten gates with the tracked-recipe image `kotoba-guard-linux-check:locked-20261127` / `sha256:3e7e3086bb864bc828c283ed1224437464e1f97105d04cac46e9a8928840cca3`. All 249 Python tests, 182 TypeScript tests and five real-model E2E tests passed. The launcher used a Git-history-free archive and read-only model roots. ZIP: 53,018,173 bytes, SHA `3252e0d05e83e4c5a2a4a4dfb9a3bca93e79892d536b8e90730addbb96b0385f`. Reports are under `artifacts/linux-check/<commit>/`. See the [snapshot record](validation-67217cc.md). Later references to pending new-image validation are historical; GitHub Actions remains unexecuted.

`scripts/harness/linux_validation.py` runs the Linux validation lanes in an
isolated Docker container. It requires a clean Git checkout because the source
is passed as a tracked-only `git archive`; the host `.git` directory,
untracked files, Windows `node_modules`, Windows `.venv`, and the normal
Playwright cache are never mounted.

The reusable base image is pinned to:

```text
kotoba-guard-linux-check:d850fdf
sha256:2d1f93a0bdcdb63528771914a9027bf6382e1b8950d47384c823149d7b856b87
```

It contains Linux Node 24.15.0, npm 11.12.1, uv 0.12.20, Python 3.12.14,
the locked Python environment, and Linux `node_modules`. It does not contain
the pinned model or Chromium. The launcher overlays the clean archive into a
temporary container workspace, copies the image's Linux dependency trees,
then runs `uv sync --locked` and `npm ci` before the selected gates.

The historical image above was prepared outside this repository and remains a
valid evidence reference for the recorded checks. A tracked preparation recipe
is now available at
[`tools/linux-validation/Dockerfile`](../tools/linux-validation/Dockerfile).
It uses the official `node:24.15.0-bookworm-slim` image pinned to the inspected
digest `sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d` and the official uv
installer pinned to `0.12.20`; the project lockfiles pin the Python and npm
dependencies. The root [`.dockerignore`](../.dockerignore) sends only lockfiles,
version files, the README required by the Python project metadata, and the
workspace package manifest. Models, source archives, caches, `.git`, and local
dependency trees are excluded.

The tracked recipe was built locally on 2026-11-27 as
`kotoba-guard-linux-check:locked-20261127`, image ID
`sha256:3e7e3086bb864bc828c283ed1224437464e1f97105d04cac46e9a8928840cca3`.
The pinned rebuild log is `artifacts/linux-image-build-pinned-1d1bc73.log`.
This proves dependency-image preparation only; full validation using that image
must be recorded separately. The legacy launcher defaults above are retained;
pass the new image name and inspected ID explicitly when selecting it.

Build a new dependency image from a clean checkout without running validation:

```powershell
docker build --file tools/linux-validation/Dockerfile --tag kotoba-guard-linux-check:local .
$imageId = docker image inspect kotoba-guard-linux-check:local --format '{{.Id}}'
uv run --locked python scripts/harness/linux_validation.py `
  --image kotoba-guard-linux-check:local --image-id $imageId `
  --model --e2e --package
```

The recipe is a preparation aid and does not claim byte-identical output to
the historical image. Record the inspected image ID with each run. The uv
installer and Node base image references are documented by [Node's official
image](https://hub.docker.com/_/node) and [uv's official installation
guide](https://docs.astral.sh/uv/getting-started/installation/); no unverifiable
digest is invented here.

The model's upstream and converted directories are mounted read-only. A
dedicated `.cache/linux-playwright` directory is used for Linux browser files;
`.cache/playwright` from Windows must not be supplied. uv/npm caches are kept
under `.cache/linux-validation`. The dedicated caches and result directory
are writable from the container; source and model mounts are read-only.

Prepare the Linux browser cache and run all real-model lanes from PowerShell:

```powershell
uv run --locked python scripts/harness/linux_validation.py --model --e2e --package
```

The first `--e2e` run may execute `npx playwright install --with-deps chromium`
inside the container. This requires Docker network access and may install the
Linux browser OS dependencies in the disposable container layer. Later runs
reuse `.cache/linux-playwright` for the browser payload.

The launcher records the source commit, image ID, exact Docker argument vector,
and exit code in `artifacts/linux-check/<source-commit>/linux-validation.json`.
The container copies harness reports into that per-commit result directory.
A successful launcher
run is evidence only for the selected local Linux lanes; it does not prove
GitHub Actions, WebGPU, physical IME input, or a public release.

Use `--dry-run` after the checkout is clean to print the command without
starting Docker. The image ID is checked before execution; override it only
when intentionally preparing a new, reviewed validation image.

## Recorded preflight failure

On 2026-11-27, the first Windows preflight stopped before Docker started. The
launcher passed the checkout to Git as `safe.directory=C:\\...`; Git exited
128 under the sandbox's ownership check. The launcher now normalizes the
per-command `safe.directory` value to forward slashes and converts
`subprocess.CalledProcessError` into a sanitized exit code 2, without a
traceback. This was covered by a regression test. No Linux model, browser, or
package lane ran during that failed attempt.
