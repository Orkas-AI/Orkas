#!/usr/bin/env python3
"""Deterministic readiness gate for a ContentWriter research ledger.

The gate checks collection completeness only. It does not verify that a URL was
fetched, that quoted text is authentic, or that a source entails a claim.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit


MAX_INPUT_BYTES = 1024 * 1024
MAX_FAMILIES = 50
MAX_SOURCES = 100
MAX_FETCH_ATTEMPTS = 6


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


def evaluate_ledger(payload: Any, min_sources: int = 3) -> dict[str, Any]:
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
    raw_fetch_attempts = payload.get("fetch_attempts", len(raw_sources))
    if isinstance(raw_fetch_attempts, bool) or not isinstance(raw_fetch_attempts, int):
        raise ValueError("fetch_attempts must be an integer")
    if not 0 <= raw_fetch_attempts <= MAX_FETCH_ATTEMPTS:
        raise ValueError(f"fetch_attempts must be between 0 and {MAX_FETCH_ATTEMPTS}")

    usable_by_url: dict[str, set[str]] = {}
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

    covered = set().union(*usable_by_url.values()) if usable_by_url else set()
    missing = [family for family in required_families if family not in covered]
    success_count = len(usable_by_url)
    if raw_fetch_attempts < success_count:
        raise ValueError("fetch_attempts cannot be lower than usable independent sources")
    remaining_fetch_attempts = MAX_FETCH_ATTEMPTS - raw_fetch_attempts
    ready = success_count >= min_sources and not missing

    reasons: list[str] = []
    gate_eligible = raw_fetch_attempts >= min_sources
    if not gate_eligible:
        reasons.append(
            f"first gate is premature; make at least {min_sources - raw_fetch_attempts} "
            "more exact search-result fetch attempt(s)"
        )
    if success_count < min_sources:
        reasons.append(f"need {min_sources - success_count} more independent usable source(s)")
    if missing:
        reasons.append("missing evidence families: " + ", ".join(missing))
    if disallowed_source_rows:
        reasons.append(
            f"ignored {disallowed_source_rows} disallowed or generic source row(s)"
        )
    if malformed_source_rows:
        reasons.append(
            f"ignored {malformed_source_rows} malformed usable source row(s)"
        )
    if not ready and remaining_fetch_attempts == 0:
        reasons.append("fetch budget exhausted; deliver explicit gaps")

    return {
        "ok": True,
        "ready": ready,
        "decision": "READY_TO_DRAFT" if ready else "CONTINUE_RESEARCH",
        "gate_eligible": gate_eligible,
        "minimum_sources": min_sources,
        "successful_independent_sources": success_count,
        "fetch_attempts": raw_fetch_attempts,
        "maximum_fetch_attempts": MAX_FETCH_ATTEMPTS,
        "remaining_fetch_attempts": remaining_fetch_attempts,
        "required_families": required_families,
        "covered_families": [family for family in required_families if family in covered],
        "missing_families": missing,
        "ignored_nonusable_rows": rejected_rows,
        "ignored_disallowed_source_rows": disallowed_source_rows,
        "ignored_malformed_source_rows": malformed_source_rows,
        "reasons": reasons,
        "limits": (
            "Collection gate only; separately verify fetch success, source quality, "
            "quote provenance, claim entailment, independence, and freshness."
        ),
    }


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        f"Research gate: **{report['decision']}**",
        f"- Independent usable sources: {report['successful_independent_sources']} / {report['minimum_sources']}",
        f"- Fetch attempts remaining: {report['remaining_fetch_attempts']} / {report['maximum_fetch_attempts']}",
        "- Covered families: " + (", ".join(report["covered_families"]) or "none"),
        "- Missing families: " + (", ".join(report["missing_families"]) or "none"),
    ]
    for reason in report["reasons"]:
        lines.append(f"- Required action: {reason}")
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
    parser.add_argument("--min-sources", type=int, default=3)
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
