# ADR-0001: npmとuv、Viteを直接利用する

状態: 採用 (2026-11-25)

Python3.12はモデル変換をCPUで再現するために採用。依存はuv、Node24 LTS側はnpm lockfileで固定する。UIはDOM APIで十分な規模でありReactを追加しない。

WXTはMV3エントリと開発時reloadを抽象化できる。一方で今回の主要なリスクはモデル/WASMの同梱、offscreen worker、通信監視である。Viteの個別ビルドによりcontentをIIFE、拡張ページとworkerをESMとして出力し、CSPやアセットの構成を直接監査する。代償はmanifest更新とビルド管理を自前でテストすること。

SDKはChrome APIに依存させず、モデル設定に基づく分類とUTF-16位置を返す。Offscreenの共有モデルによりタブごとの重複ロードを避ける。権限はデフォルトhost accessなしで明示的サイト許可を採用する。
