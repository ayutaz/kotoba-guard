# M1〜M4追加開発のWindows検証

2026-11-27。cleanな`7db627156a76f9968e0eecf8b2f27849d7351b4a`でWindows統合10ゲートが成功した。これは追加開発の途中の証拠で、Linux・全Python coverage・全context通信監査はこのsourceでは未実施。製品精度とCPU/WASM数値一致も未達のため、MVP完成・release candidateにはしない。

| 対象                   | 結果                                                                     |
| ---------------------- | ------------------------------------------------------------------------ |
| Python / TypeScript    | 283件 / 215件成功                                                        |
| Lint / Format / 型検査 | 成功                                                                     |
| TS全体coverage         | statements86.07%、lines89.34%                                            |
| SDK coverage           | statements92.42%、lines94.56%                                            |
| Tokenizer integration  | 1テスト内の固定34ケース成功                                              |
| 限定変換回帰           | 自作40文による`evaluation.py --check-conversion`成功。一般精度評価とは別 |
| Playwright             | mock4件＋実モデル5件、全9件成功。skip/retryなし                          |
| Build / Package        | 成功。モデル・Tokenizer・WASM同梱                                        |
| ZIP                    | 53,014,754 bytes                                                         |
| ZIP SHA-256            | `5bb1422c99c1b8ec0f059ca3dae7216c63376b1215229feb24cdcf7bc181ca41`       |

`uv run --locked python scripts/harness/run_checks.py --model --e2e --package`は終了コード0。環境はWindows11、Node24.15.0、npm11.4.2、Python3.12.13、uv0.12.20、Chromium159.0.8154.6。pytest cacheの書込み権限warning1件と、PlaywrightのNO_COLOR/FORCE_COLOR warningを保持した。テスト失敗や判定の緩和はない。

証拠は`artifacts/validation/7db627156a76f9968e0eecf8b2f27849d7351b4a/`。`windows-validation.json`にclean source・10ゲート・各ファイルSHAを記録し、checks/各log/JUnit/Playwright JSON、TS coverage、ZIP、model/distribution manifest、依存ライセンス一覧を退避した。rootの従来レポートは上書き前に`artifacts/validation/pre-7db6271/`へ保存した。

M1の[採点感度](research/scoring-sensitivity.md)は別source`1e5b609`、M3の[最適化対照](research/onnx-wasm-parity.md#measured-result-at-7db6271)は診断sourceがこのcommitで配布buildは比較用に旧`67217cc`を保持した。sourceと実行経路の違いを混同しない。

この検証後の追加レビューで、IME開始前のdebounce予約、IME開始後の遅延結果、切断editorの保持、cold start中の最新入力取りこぼしを確認した。次の修正はこのcommitの検証済みとは扱わず、回帰を追加して新しいsourceで検証する。物理IME、native権限、Chrome116、実サービス、remote CIは未検証のまま。
