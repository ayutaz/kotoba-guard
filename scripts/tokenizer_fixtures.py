"""Regenerate synthetic golden IDs and offsets with the pinned Rust tokenizer."""

import json
from pathlib import Path

from tokenizers import Tokenizer

REVISION = "8d640720bddeb64c89dc1fa7780c3ea29fa523e8"
TEXTS = [
    "",
    "日本語です。",
    "本日は晴天なので、公園に行って散歩をしよう思います。",
    "明日の予定については、来週移行にご連絡します。",
    "😀漢字",
    "絵文字👨‍👩‍👧‍👦と👍🏽",
    "がか\u3099\nＡＢＣ",
    "\r\n\t 空白  と　全角\n改行\t",
    "ＡＢＣ１２３ abc123 ﾊﾝｶｸ",
    "繰り返し。繰り返し。",
    "<s>日本語</s><mask><unk>",
    "<|user|>こんにちは<|assistant|>",
    "▁と空白 ▁",
    "<0xF0>😀<0x0A>",
    "𠮷野家と𩸽",
    "a\u0301é e\u0301\u0327",
    "\u0000 制御\u0001文字",
]


def main():
    tokenizer = Tokenizer.from_file(f"models/upstream/{REVISION}/tokenizer.json")
    cases = []
    for text in TEXTS:
        for special in (False, True):
            encoded = tokenizer.encode(text, add_special_tokens=special)
            offsets = [
                [
                    len(text[:start].encode("utf-16-le")) // 2,
                    len(text[:end].encode("utf-16-le")) // 2,
                ]
                for start, end in encoded.offsets
            ]
            cases.append(
                {
                    "text": text,
                    "special": special,
                    "ids": encoded.ids,
                    "tokens": encoded.tokens,
                    "offsets": offsets,
                }
            )
    destination = Path("tests/fixtures/tokenizer-reference.json")
    destination.write_text(
        json.dumps(
            {
                "revision": REVISION,
                "provenance": (
                    "Synthetic project-authored fixtures; MIT. Rust tokenizers offsets "
                    "converted from codepoints to UTF-16."
                ),
                "cases": cases,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
