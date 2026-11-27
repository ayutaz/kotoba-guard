# ADR-0004: Offscreenと専用Worker

採用。Service Workerの寿命に長時間推論を依存させず、`WORKERS`理由のOffscreen Documentが専用Workerを所有する。Content ScriptはDOM・IME・表示、背景は権限・有界キュー、SDKはChrome非依存の推論を担う。複数タブでモデルを複製しない。

Chrome116以降の `runtime.getContexts` を使う。WASMは1スレッドで動作させ、cross-origin isolationを導入しない。処理停止・Worker障害にタイムアウトと再生成を設ける。メッセージ経路と世代チェックをテストする。メモリのアイドル解放は未実装。
