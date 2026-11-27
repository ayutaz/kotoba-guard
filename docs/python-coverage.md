# Python coverage gate

現在はGitHub v0.1.0プレビュー公開済み。[v0.1.0公開記録](validation-v0.1.0.md)を参照。以下の測定・停止記録は各記載日時点の範囲を示す。

Documentation checked 2026-11-28. These are historical source-bound coverage
measurements. The latest aea6caf preview has only the scoped unit evidence listed
in [preview validation](preview-validation.md), not a fresh full Python coverage
measurement. Development is paused; this maintenance did not rerun integrations.

Subsequent source `d9c44d6` adds the opt-in confidence frontier to the existing diagnostic script. All374 unit tests passed; the scoped diagnostic measurement reached193/207 lines (93.24%) and70/74 branches (94.59%). This is separate from the full28-file measurement below and does not rebind it to later code. See the [diagnostic and its evidence](research/confidence-frontier.md).

Latest clean source `8432112e94144d558a4812c2e65ed7b7fb8ea52e` passed all nine unit/isolated real-model integration commands across **28 declared files**. Lines: **3,859/4,693 (82.23%)**; branches: **1,372/1,888 (72.67%)**. Unit tests: **362 passed**. The static converter itself reached412/510 lines (80.78%). No exclusions, threshold changes or historical-fragment reuse. Evidence: `artifacts/coverage/python-overall-8432112e94144d558a4812c2e65ed7b7fb8ea52e/report.json`, SHA `d469bb90b9e9dec0f5ad9add040073b516933d839e7acd30ea76f44e86dd9f35`.

One nonfatal warning recorded that pytest could not save its ordinary `.pytest_cache` node-ID cache due to WinError5; all tests and phase exits still passed. No ACL change or warning suppression was used. The failed runs below are retained. This is Python coverage evidence; it does not rerun the rejected static candidate, rebind the existing runtime/ZIP, establish product accuracy, or verify Linux/remote/native operations.

The first28-file measurement at clean source `35d0a1bc3b226d5e05f902f255cec1632c42e086` failed during pytest setup: a pre-existing shared `.cache/pytest-coverage-harness` directory could not be removed (WinError5). Unit results:148 passed/210 setup errors; all eight later integration commands were unexecuted. The failed report is retained under `artifacts/coverage/python-overall-35d0a1bc3b226d5e05f902f255cec1632c42e086/`. It is not a coverage pass and does not replace the27-file evidence below.

The harness derives a short, measurement-specific cache directory from the output path and refuses existing temp directories. It also records process creation failures as exit127 in phase/coverage reports. Regression Red1+3 was followed by19 passing harness tests and Ruff. The next clean `d7f100c67a34bd60765a5a9b81d3f84efddbcd51` run exposed an implementation omission: the parent directory was not created, so pytest raised FileNotFoundError/WinError3 (145 passed/216 setup errors; integrations unexecuted). That failure is preserved in its own output. A real subprocess pytest fixture reproduced the missing-parent failure before adding parent creation; all20 harness tests then passed. The fresh28-file measurement above completed afterward. The rejected candidate's calibration/parity budget is closed and will not be repeated.

Clean source `a110acb97c99454c7be419813bf50abc8800f2a8` passed all nine unit/real-model integration commands across all **27** declared files, including `scripts/hybrid_quantize.py`. Lines: **3,396/4,172 (81.40%)**. Branches: **1,203/1,662 (72.38%)**. The unit phase passed314 tests. No source exclusion, threshold change or historical fragment reuse. The new converter itself covered239/298 lines (80.20%). Evidence: `artifacts/coverage/python-overall-a110acb97c99454c7be419813bf50abc8800f2a8/report.json`, SHA `07128299aaba299432b148b2c984d1861f91c7ad3a4ea4f5648f71c133e16c88`.

This is fresh Windows Python quality evidence, not a new full-OS/runtime/package snapshot or a repeated hybrid parity comparison. Integration converted the original pinned model in an isolated sandbox; the rejected attention-output hybrid candidate remained closed. Linux, browser parity, product accuracy and M5 acceptance are separate gates. The original runtime/package remains bound to `0dc814c` below.

Clean source `0dc814cda3bfec86379928f505c6d3ed2725b5dc` passed all nine unit/real-model integration commands over all 26 declared files: lines3,047/3,748 (81.30%), branches1,057/1,456 (72.60%). No source exclusion, threshold change or historical fragment reuse. Evidence: `artifacts/coverage/python-overall-0dc814c/report.json`, SHA `a040814cb8a284df26277fe41ba7e9d6f179966f4aa777b2426e1c493dc07f8f`. The original isolated worktree and copied top-level evidence remain separate from canonical models. See [current snapshot validation](validation-0dc814c.md).

The M1 scoring-sensitivity implementation adds `scripts/analyze_scoring_sensitivity.py`
to the declared inventory (25 files). The subsequent bounded M3 intermediate
diagnostic adds `scripts/diagnose_quantized_intermediates.py` (26 files).
The historical 24-file measurements below retain their tested commits; they
are not rebound to the later 26-file source.

Earlier clean source `67217cc172cacc36bff0a970a556a35ec5f16564` passed all nine unit/real-model integration commands across all 24 declared source files. Line coverage was 2,703/3,352 (80.64%), branches 955/1,324 (72.13%). No historical artifacts or target exclusions were used. Evidence: `artifacts/coverage/python-overall-67217cc/report.json`, SHA `5afd39d09b38f756510cd8ea2c2651c5a933ae2cd42ce9865e72d1f051469b55`. See [snapshot validation](validation-67217cc.md). Measurements below retain their earlier source commits.

The clean final-verification source `5ea825681c3be203da12700736c89dfaf79eafb5`
passed all nine unit/integration commands with 2,691/3,337 lines (80.64%) and
948/1,316 branches (72.04%). No declared source file or command was missing.
The report is `artifacts/coverage/python-overall-5ea8256/report.json`, SHA-256
`611e291dc5f2ccb187ffe553d47dd15ae84d921ac3a018e7c11be61793e3aefe`.
An earlier complete run at `1fdebfc` also passed (80.43% lines). These reports
do not cover subsequent source changes. The following failed measurement is
retained as historical evidence.

The complete run at `2b7d61f` finished every unit and real-model integration
command, then failed the 80 percent line gate: 1,939/2,573 statements (75.36%).
Branch coverage was 652/948 (68.78%). No declared Python files were missing.
The immutable report is `artifacts/coverage/python-overall-2b7d61f/report.json`;
its SHA-256 is `ff0e3480173835f20b38043acc4687138930b3ebf0407e100308440eed954ad6`.
The original isolated-worktree output is also retained. This result predates
the experimental converter and subsequent tests, so it does not measure those
changes. Add meaningful tests for uncovered paths and rerun the complete gate;
do not exclude CLI wrappers or lower the threshold.

`python_coverage.py` measures the Python implementation from the current clean
source commit. It runs the complete unit test suite and the frozen model
integration commands with one parallel Coverage.py data stem, then combines the
fragments into one report. The integration phase is real execution of the
existing icon generation, reference, export, quantization, FP16 conversion,
manifest, evaluation, and model validation commands; a unit-only run is not
evidence for this gate.

Run the manifest/assets step before evaluation: the fresh sandbox initially
contains only the upstream snapshot and conversion outputs. Evaluation needs
the copied tokenizer/config files in the converted directory. The first full
run at `a8f01fc` completed export and quantization but failed here because
those files had not yet been copied; its failure report is retained.

The driver passes an absolute `COVERAGE_RCFILE` for every phase, including the
isolated model sandbox. Coverage.py otherwise reads different configuration
from the different working directories: the first corrected integration run
at `fbd83d0` completed all model commands but failed to combine branch data
with statement-only data. A real two-workspace subprocess regression covers
this failure. Combining uses `--keep` so original fragments survive a failure.

The unit phase uses a fresh `.cache/coverage-pytest/<output-path-hash>` directory
inside the clean checkout. The driver creates its parent and refuses an existing
leaf, so restricted Windows hosts do not depend on access to the system temporary
directory or deletion of a shared pytest basetemp.

Run it from a clean worktree in the parent agent's serial model slot:

```text
uv run --locked python scripts/harness/python_coverage.py \
  --output artifacts/coverage/python-overall-<commit>
```

The driver refuses a dirty worktree and an existing non-empty output directory.
It records the commit, source inventory, per-command phase and exit code, raw
logs, coverage fragments, combined JSON, and the final `report.json`. The
integration commands run in a fresh hard-linked model sandbox under the output
directory, so conversion and evaluation cannot overwrite historical
`models/converted` files or benchmark results. Current
results are written under a new directory; the historical
`artifacts/coverage/python-overall-initial.json` file is never reused or
overwritten.

The inventory declares every `scripts/**/*.py` file. A missing declared file,
an unexpected Python file, a coverage entry missing for any declared file, a
non-empty exclusion list, or a failed command makes the report fail. There are
no exclusions. The driver-enforced line coverage threshold is 80 percent;
branch coverage is reported separately without an unrecorded acceptance rule.
A failed result must remain failed; it cannot be relabeled as a passing
snapshot.

Coverage.py is configured with `skip_empty=true`, but the current pinned
Coverage.py still emits an empty `scripts/__init__.py` entry in JSON. The
focused regression test exercises a real Coverage.py subprocess and preserves
that behavior as evidence for the complete inventory.

The output separates `unit` and `integration` in `commands` and
`phase_results`. The model phase uses the pinned revision in
`scripts/harness/python_coverage.py` and writes through the existing model
pipeline. Do not start it concurrently with another model export or browser
run, and do not treat an unrun or interrupted integration phase as current
evidence.

The focused tests for the driver cover command failure propagation, explicit
missing-file reporting, and threshold enforcement:

```text
uv run --locked pytest -q tests/test_python_coverage.py
```
