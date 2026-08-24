#!/usr/bin/env python3
"""Deterministic coverage gate for a ContentWriter research ledger.

The gate checks that every required evidence family has usable collection
coverage and reports undated coverage as an advisory. It does not impose a
research recipe or arbitrary source target, and it cannot verify that a URL was
fetched, that a recorded date is real, that sources are independent, whether a
date is required for a particular claim, or that a source entails a claim.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from datetime import date
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit


MAX_INPUT_BYTES = 1024 * 1024
MAX_FAMILIES = 50
MAX_SOURCES = 100
_ISO_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")


def _normalize_family(value: Any) -> str:
    raw = unicodedata.normalize("NFKC", str(value or ""))
    family = " ".join(raw.split()).strip().casefold()
    if not family:
        raise ValueError("family labels cannot be empty")
    if any(unicodedata.category(char).startswith("C") for char in family):
        raise ValueError("family labels cannot contain control characters")
    if len(family) > 64:
        suffix = hashlib.sha256(family.encode("utf-8")).hexdigest()[:8]
        family = f"{family[:55]}-{suffix}"
    return family


def _normalize_url(value: Any) -> str:
    raw = str(value or "").strip()
    parts = urlsplit(raw)
    if parts.scheme.lower() not in {"http", "https"} or not parts.netloc:
        raise ValueError("usable sources require an absolute http(s) URL")
    host = (parts.hostname or "").lower()
    path = parts.path.rstrip("/") or "/"
    first_segment = next((item.lower() for item in path.split("/") if item), "")
    if (
        host in {"baike.baidu.com", "baike.com", "wikipedia.org"}
        or host.endswith(".wikipedia.org")
        or "encyclopedia" in host
        or path == "/"
        or first_segment in {"search", "tag", "tags", "category", "categories"}
    ):
        raise ValueError("usable sources require a specific non-encyclopedia page")
    return urlunsplit(
        (parts.scheme.lower(), parts.netloc.lower(), path, parts.query, "")
    )


def _published_date(value: Any) -> str:
    """The page's stated publication date, or "" when the row does not carry one.

    A row that reports no date is honest and still counts toward completeness;
    it just cannot be what makes a time-sensitive family dated. Rejecting the
    whole row instead would push a writer toward supplying a date it does not
    have, which is the opposite of the point.
    """
    raw = str(value or "").strip()
    match = _ISO_DATE.match(raw)
    if not match:
        return ""
    year, month, day = (int(part) for part in match.groups())
    try:
        date(year, month, day)
    except ValueError:
        return ""
    return raw


def evaluate_ledger(payload: Any, min_sources: int = 1) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("ledger root must be a JSON object")
    if not 1 <= min_sources <= 20:
        raise ValueError("min_sources must be between 1 and 20")

    raw_families = payload.get("required_families")
    if not isinstance(raw_families, list) or not raw_families:
        raise ValueError("required_families must be a non-empty array")
    if len(raw_families) > MAX_FAMILIES:
        raise ValueError(f"required_families exceeds {MAX_FAMILIES}")
    required_families = list(dict.fromkeys(_normalize_family(item) for item in raw_families))

    raw_sources = payload.get("sources", [])
    if not isinstance(raw_sources, list):
        raise ValueError("sources must be an array")
    if len(raw_sources) > MAX_SOURCES:
        raise ValueError(f"sources exceeds {MAX_SOURCES}")
    usable_by_url: dict[str, set[str]] = {}
    dated_families: set[str] = set()
    undated_source_rows = 0
    rejected_rows = 0
    disallowed_source_rows = 0
    malformed_source_rows = 0
    for row in raw_sources:
        if not isinstance(row, dict) or str(row.get("status", "")).strip().lower() != "usable":
            rejected_rows += 1
            continue
        try:
            url = _normalize_url(row.get("url"))
        except ValueError:
            disallowed_source_rows += 1
            continue
        raw_row_families = row.get("families")
        if not isinstance(raw_row_families, list) or not raw_row_families:
            malformed_source_rows += 1
            continue
        try:
            families = {_normalize_family(item) for item in raw_row_families}
        except ValueError:
            malformed_source_rows += 1
            continue
        usable_by_url.setdefault(url, set()).update(families)
        if _published_date(row.get("published")):
            dated_families.update(families)
        else:
            undated_source_rows += 1

    covered = set().union(*usable_by_url.values()) if usable_by_url else set()
    missing = [family for family in required_families if family not in covered]
    undated = [
        family for family in required_families
        if family in covered and family not in dated_families
    ]
    success_count = len(usable_by_url)
    gate_eligible = success_count >= min_sources
    ready = gate_eligible and not missing

    reasons: list[str] = []
    advisories: list[str] = []
    if not gate_eligible:
        reasons.append(
            f"need {min_sources - success_count} more distinct usable source(s) "
            "for the requested evidence standard"
        )
    if missing:
        reasons.append("missing evidence families: " + ", ".join(missing))
    if undated:
        advisories.append(
            "families whose sources state no publication date: "
            + ", ".join(undated)
            + "; assess whether each retained claim needs a dated source"
        )
    if disallowed_source_rows:
        reasons.append(
            f"ignored {disallowed_source_rows} disallowed or generic source row(s)"
        )
    if malformed_source_rows:
        reasons.append(
            f"ignored {malformed_source_rows} malformed usable source row(s)"
        )
    return {
        "ok": True,
        "ready": ready,
        "decision": "READY_TO_DRAFT" if ready else "CONTINUE_RESEARCH",
        "gate_eligible": gate_eligible,
        "minimum_distinct_sources": min_sources,
        "usable_source_count": success_count,
        "required_families": required_families,
        "covered_families": [family for family in required_families if family in covered],
        "missing_families": missing,
        "undated_families": undated,
        "undated_source_rows": undated_source_rows,
        "ignored_nonusable_rows": rejected_rows,
        "ignored_disallowed_source_rows": disallowed_source_rows,
        "ignored_malformed_source_rows": malformed_source_rows,
        "reasons": reasons,
        "advisories": advisories,
        "limits": (
            "Collection coverage only; a recorded date is taken at face value and an "
            "undated row is not automatically blocking. Separately decide whether the "
            "claim needs dated evidence and verify fetch success, source quality, quote "
            "provenance, claim entailment, independence, and freshness. Distinct URLs "
            "do not prove independent evidence."
        ),
    }


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        f"Research gate: **{report['decision']}**",
        f"- Distinct usable sources: {report['usable_source_count']} / {report['minimum_distinct_sources']}",
        "- Covered families: " + (", ".join(report["covered_families"]) or "none"),
        "- Missing families: " + (", ".join(report["missing_families"]) or "none"),
        "- Undated families: " + (", ".join(report["undated_families"]) or "none"),
    ]
    for reason in report["reasons"]:
        lines.append(f"- Required action: {reason}")
    for advisory in report["advisories"]:
        lines.append(f"- Advisory: {advisory}")
    lines.append(f"- Limit: {report['limits']}")
    return "\n".join(lines)


def _read_payload(source: str) -> Any:
    if source == "-":
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    else:
        path = Path(source)
        if not path.is_file():
            raise ValueError(f"input file not found: {source}")
        if path.stat().st_size > MAX_INPUT_BYTES:
            raise ValueError(f"input exceeds {MAX_INPUT_BYTES} bytes")
        raw = path.read_bytes()
    if len(raw) > MAX_INPUT_BYTES:
        raise ValueError(f"input exceeds {MAX_INPUT_BYTES} bytes")
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid UTF-8 JSON input: {error}") from error


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="Research ledger JSON file, or - for stdin")
    parser.add_argument(
        "--min-sources",
        type=int,
        default=1,
        help="optional minimum distinct-source floor; this does not prove independence",
    )
    parser.add_argument("--format", choices=("json", "markdown"), default="json")
    args = parser.parse_args(argv)
    try:
        report = evaluate_ledger(_read_payload(args.input), args.min_sources)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    if args.format == "markdown":
        print(render_markdown(report))
    else:
        print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
