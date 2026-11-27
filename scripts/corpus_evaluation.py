"""Auditable corpus alignment and held-out accuracy evaluation.

Offsets are Python Unicode codepoints. No corpus text is logged or committed.
"""

from __future__ import annotations

import hashlib
import math
import unicodedata
from collections import defaultdict
from typing import Any

from scripts.evaluation import ErrorSpan, scores


class DatasetError(ValueError):
    """A record cannot be scored without guessing its annotation."""


def parse_pair(
    record: dict, labels: tuple[str, ...], identity: str, *, allow_ambiguous: bool = False
) -> dict[str, Any]:
    """Locate annotated edits by reconstructing the *entire* corrected text.

    Exact repeated substrings are resolved using the paired correction. Multiple
    valid alignments are rejected by default. With allow_ambiguous every valid
    joint alignment is retained; scoring must not mix edits across alternatives.
    """
    pre, post, diffs = record.get("pre_text"), record.get("post_text"), record.get("diffs")
    if not isinstance(pre, str) or not isinstance(post, str) or not isinstance(diffs, list):
        raise DatasetError("invalid pair schema")
    if not diffs or pre == post:
        raise DatasetError("record has no annotated correction")
    edits = []
    for diff in diffs:
        if not isinstance(diff, dict):
            raise DatasetError("invalid diff schema")
        before, after, label = diff.get("pre_str"), diff.get("post_str"), diff.get("category")
        if label not in labels or label == "OK":
            raise DatasetError("unknown or clean diff label")
        if not isinstance(before, str) or not isinstance(after, str) or before == after:
            raise DatasetError("invalid edit strings")
        edits.append((before, after, label))
    solutions: list[list[dict]] = []
    visits = 0

    def visit(index: int, cursor: int, prefix: str, spans: list[dict]) -> None:
        nonlocal visits
        visits += 1
        if visits > 10_000:
            raise DatasetError("ambiguous alignment search limit")
        if not allow_ambiguous and len(solutions) > 1:
            return
        if index == len(edits):
            if prefix + pre[cursor:] == post:
                solutions.append(spans)
            return
        before, after, label = edits[index]
        positions = (
            range(cursor, len(pre) + 1)
            if before == ""
            else (offset for offset in range(cursor, len(pre)) if pre.startswith(before, offset))
        )
        for start in positions:
            proposed = prefix + pre[cursor:start] + after
            if not post.startswith(proposed):
                continue
            end = start + len(before)
            visit(index + 1, end, proposed, [*spans, {"start": start, "end": end, "label": label}])

    visit(0, 0, "", [])
    if not solutions:
        raise DatasetError("edits do not reconstruct post_text")
    if len(solutions) != 1 and not allow_ambiguous:
        raise DatasetError("ambiguous edit alignment")
    return {
        "id": identity,
        "page": str(record.get("page", identity)),
        "text": pre,
        "corrected_text": post,
        "errors": solutions[0],
        **({"error_alternatives": solutions} if allow_ambiguous else {}),
    }


def partition_pairs(records: list[dict]) -> dict[str, list[dict]]:
    """20% development / 80% held-out, with page and duplicate-pair grouping."""
    parent = list(range(len(records)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    seen: dict[str, int] = {}
    for index, item in enumerate(records):
        keys = ["page:" + item["page"]]
        for text in (item["text"], item["corrected_text"]):
            normalized = " ".join(unicodedata.normalize("NFC", text).split())
            keys.append("text:" + hashlib.sha256(normalized.encode()).hexdigest())
        for key in keys:
            if key in seen:
                parent[find(index)] = find(seen[key])
            else:
                seen[key] = index
    groups: dict[int, list[dict]] = defaultdict(list)
    for index, item in enumerate(records):
        groups[find(index)].append(item)
    result: dict[str, list[dict]] = {"development": [], "held_out": []}
    for items in groups.values():
        group_identity = "|".join(sorted({item["page"] for item in items}))
        digest = hashlib.sha256(("kotoba-guard-corpus-v1:" + group_identity).encode()).digest()
        split = "development" if int.from_bytes(digest[:8]) % 5 == 0 else "held_out"
        result[split].extend(items)
    for items in result.values():
        items.sort(key=lambda item: item["id"])
    return result


def project_gold(gold: list[ErrorSpan], offsets: list[tuple[int, int]]) -> list[ErrorSpan]:
    """Project character annotations to subwords, refusing conflicting labels.

    A zero-width deletion maps to its containing token; at document end it maps
    to the final ordinary token. These product rules are not upstream code.
    """
    assigned: dict[tuple[int, int], str] = {}
    ordinary = [(int(start), int(end)) for start, end in offsets if end > start]
    for span in gold:
        matched = [
            (start, end)
            for start, end in ordinary
            if (start < span.end and end > span.start)
            or (span.start == span.end and start <= span.start < end)
        ]
        if not matched and span.start == span.end and ordinary and span.start == ordinary[-1][1]:
            matched = [ordinary[-1]]
        if not matched:
            raise DatasetError("uncovered gold annotation")
        for position in matched:
            previous = assigned.get(position)
            if previous is not None and previous != span.label:
                raise DatasetError("conflicting labels in one subword")
            assigned[position] = span.label
    merged: list[ErrorSpan] = []
    for (start, end), label in sorted(assigned.items()):
        if merged and merged[-1].end == start and merged[-1].label == label:
            merged[-1] = ErrorSpan(merged[-1].start, end, label)
        else:
            merged.append(ErrorSpan(start, end, label))
    return merged


def wilson_interval(successes: int, total: int) -> tuple[float | None, float | None]:
    if not 0 <= successes <= total:
        raise ValueError("invalid binomial counts")
    if total == 0:
        return None, None
    z = 1.959963984540054
    proportion = successes / total
    denominator = 1 + z * z / total
    center = (proportion + z * z / (2 * total)) / denominator
    radius = (
        z * math.sqrt(proportion * (1 - proportion) / total + z * z / (4 * total**2)) / denominator
    )
    return max(0.0, center - radius), min(1.0, center + radius)


def accuracy_gate(reference: dict, candidate: dict, clean_fp: int, clean_total: int) -> dict:
    """Frozen targets, including minimum clean support; never pass missing data."""
    failures = []
    for name, metric in (("reference", reference), ("candidate", candidate)):
        for field, target in (("precision", 0.95), ("recall", 0.80), ("f1", 0.0)):
            value = metric.get(field)
            if (
                not isinstance(value, (int, float))
                or not math.isfinite(value)
                or not 0 <= value <= 1
            ):
                failures.append(f"{name} {field} missing or nonfinite")
            elif value < target:
                failures.append(f"{name} {field} {value:.6f} below {target:.2f}")
    ref_f1, candidate_f1 = reference.get("f1"), candidate.get("f1")
    if isinstance(ref_f1, (int, float)) and isinstance(candidate_f1, (int, float)):
        if (
            math.isfinite(ref_f1)
            and math.isfinite(candidate_f1)
            and ref_f1 - candidate_f1 > 0.01 + 1e-12
        ):
            failures.append("quantized F1 drop exceeds 0.01")
    if clean_total < 1000:
        failures.append("clean support below 1000")
    if not 0 <= clean_fp <= clean_total or clean_total == 0:
        failures.append("invalid clean counts")
    elif clean_fp / clean_total > 0.02:
        failures.append("clean false-positive rate exceeds 0.02")
    return {"passed": not failures, "failures": failures}


def containment_scores(
    gold: list[ErrorSpan], predicted: list[ErrorSpan], *, labeled: bool = True
) -> dict:
    """Maximum one-to-one matching, preserving independent source diff events."""
    matched: dict[int, int] = {}

    def assign(gold_index: int, visited: set[int]) -> bool:
        expected = gold[gold_index]
        for index, actual in enumerate(predicted):
            if index in visited or (labeled and expected.label != actual.label):
                continue
            if actual.start > expected.start or actual.end < expected.end:
                continue
            visited.add(index)
            previous = matched.get(index)
            if previous is None or assign(previous, visited):
                matched[index] = gold_index
                return True
        return False

    for index in range(len(gold)):
        assign(index, set())
    return scores(
        {"tp": len(matched), "fp": len(predicted) - len(matched), "fn": len(gold) - len(matched)}
    )


def select_threshold(rows: dict[str, dict]) -> dict:
    """Choose on development data only; failed selection keeps diagnostic 0.5."""
    admissible = []
    for key, row in rows.items():
        threshold = float(key)
        precision, recall = row["event"]["precision"], row["event"]["recall"]
        clean_rate = row["clean_rate"]
        if not all(math.isfinite(value) for value in (threshold, precision, recall, clean_rate)):
            raise ValueError("nonfinite threshold selection metrics")
        if precision >= 0.95 and recall >= 0.80 and clean_rate <= 0.02:
            admissible.append((recall, precision, -threshold))
    if not admissible:
        return {"threshold": 0.5, "admissible": False}
    return {"threshold": -max(admissible)[2], "admissible": True}
