"""Check fetched sources, exact quotations, DOI attribution, and citation bindings.

The Agent owns claim meaning and recommendations. This deterministic formatter
never infers semantic support from wording or recommendation quality from field
coverage. Compact reports preserve the Agent's analysis alongside citation tables.

stdlib only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import unicodedata
from typing import Any
from urllib.parse import urlsplit, urlunsplit

# A quote shorter than this (after normalization) trivially substring-matches
# almost any source and gives false confidence, so it is reported as
# "too_short" rather than "verified" — it is not evidence of fabrication, but it
# is not proof of support either.
MIN_QUOTE_CHARS = 12

# DOI syntax per the DOI handbook: "10." then a registrant code, "/", then a
# suffix. Kept deliberately strict so a mangled/invented DOI is caught as
# malformed instead of being waved through.
_DOI_RE = re.compile(r"10\.\d{4,9}/[-._;()/:a-z0-9]+", re.IGNORECASE)

_SMART_MAP = {
    "‘": "'", "’": "'", "‚": "'", "‛": "'",
    "“": '"', "”": '"', "„": '"', "‟": '"',
    "–": "-", "—": "-", "―": "-", "−": "-",
    " ": " ", "…": "...",
}
_WS_RE = re.compile(r"\s+")
_COMPARISON_COLUMNS = (
    ("candidate", "Candidate"),
    ("best_for", "Best for"),
    ("os", "OS"),
    ("setup_ease", "Setup/ease"),
    ("model_capabilities", "Model capabilities"),
    ("local_offline", "Local/offline"),
    ("privacy_data_handling", "Privacy/data handling"),
    ("pricing_cost", "Pricing/cost"),
    ("key_limitations", "Key limitations"),
    ("ideal_user", "Ideal user"),
    ("evidence", "Evidence"),
)

_COMPARISON_INFERENCE_FIELDS = {"best_for", "ideal_user"}
_COMPARISON_FACTUAL_FIELDS = tuple(
    key for key, _ in _COMPARISON_COLUMNS
    if key not in {"candidate", "evidence", *_COMPARISON_INFERENCE_FIELDS}
)
_TRUSTED_SNAPSHOT_ENV = "ORKAS_DEEP_RESEARCH_EVIDENCE_FILE"
_MAX_TRUSTED_SNAPSHOT_BYTES = 4 * 1024 * 1024
def _normalize_text(s: str) -> str:
    """Collapse away the differences that are NOT fabrication: unicode form,
    smart quotes/dashes, case, and whitespace runs. Preserves word content, so a
    paraphrase (different words) still fails to match — that is the point."""
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", s)
    s = "".join(_SMART_MAP.get(ch, ch) for ch in s)
    s = _WS_RE.sub(" ", s).strip()
    return s.casefold()


def _normalize_url(u: str) -> str:
    """Canonical key for de-dup / citation-by-url resolution. Lowercases scheme
    and host, drops the fragment and a trailing slash, but keeps the path case
    (paths can be case-sensitive)."""
    if not u:
        return ""
    try:
        parts = urlsplit(u.strip())
    except ValueError:
        return u.strip().casefold()
    scheme = (parts.scheme or "").lower()
    host = (parts.hostname or "").lower()
    if parts.port:
        host = "{}:{}".format(host, parts.port)
    path = parts.path or ""
    if len(path) > 1 and path.endswith("/"):
        path = path[:-1]
    return urlunsplit((scheme, host, path, parts.query, ""))


def _index_sources(sources: list) -> tuple[dict, dict]:
    """Return (by_id, by_url) lookup maps. Later duplicates do not clobber the
    first — first fetch wins, which keeps reference numbering stable."""
    by_id: dict = {}
    by_url: dict = {}
    for src in sources:
        if not isinstance(src, dict):
            continue
        sid = src.get("id")
        if sid is not None and str(sid) not in by_id:
            by_id[str(sid)] = src
        key = _normalize_url(src.get("url") or "")
        if key and key not in by_url:
            by_url[key] = src
    return by_id, by_url


def _resolve_source(cit: dict, by_id: dict, by_url: dict):
    """Map a citation to the fetched source it points at, by id first then by
    normalized url. Returns (source_or_None, how) where how is 'id' | 'url' |
    'unknown'."""
    sid = cit.get("source")
    if sid is not None and str(sid) in by_id:
        return by_id[str(sid)], "id"
    key = _normalize_url(cit.get("url") or "")
    if key and key in by_url:
        return by_url[key], "url"
    return None, "unknown"


def _source_text_norm(source: dict, cache: dict) -> str:
    """Normalize fetched source text once per source object per verification run."""
    key = id(source)
    if key not in cache:
        cache[key] = _normalize_text(source.get("text") or "")
    return cache[key]


def _check_quote(quote: str, source: dict, source_text_cache: dict) -> str:
    """verified | too_short | not_found | missing. Formatting-insensitive
    substring test; a paraphrase or invented quote is reported not_found."""
    if not quote:
        return "missing"
    nq = _normalize_text(quote)
    if len(nq) < MIN_QUOTE_CHARS:
        return "too_short"
    return "verified" if nq and nq in _source_text_norm(source, source_text_cache) else "not_found"


def _check_doi(doi: str, source: dict, source_text_cache: dict) -> str:
    """verified | malformed | unverified | absent. A well-formed DOI must resolve
    to the cited source (its declared doi field OR appear in its fetched text),
    otherwise it is unverified (a likely invention)."""
    if not doi:
        return "absent"
    m = _DOI_RE.fullmatch(doi.strip())
    if not m:
        return "malformed"
    norm = doi.strip().casefold()
    src_doi = str(source.get("doi") or "").strip().casefold()
    if src_doi:
        src_m = _DOI_RE.search(src_doi)
        if src_m and src_m.group(0).casefold() == norm:
            return "verified"
    if norm in _source_text_norm(source, source_text_cache):
        return "verified"
    return "unverified"


def _inline_markdown(value) -> str:
    """Keep delivery rows single-line without changing quoted wording."""
    return _WS_RE.sub(" ", str(value or "")).strip()


def _render_evidence_markdown(rows: list) -> str:
    """Render claim-level evidence while emitting source metadata only once.

    Landscape reports commonly preserve several claims from the same official
    page. Repeating its title, URL, dates, and limitation for every Evidence ID
    made the delivery block large enough that agents sometimes omitted the
    quotes entirely. Grouping changes presentation only: every claim, exact
    quote, verification label, and Evidence ID remains present.
    """
    grouped: dict = {}
    order = []
    for row in rows:
        key = (
            str(row.get("source_id") or ""),
            _normalize_url(str(row.get("url") or "")),
        )
        if key not in grouped:
            grouped[key] = []
            order.append(key)
        grouped[key].append(row)

    lines = ["## Evidence used"] if rows else []
    for key in order:
        source_rows = grouped[key]
        first = source_rows[0]
        title = _inline_markdown(first.get("title")) or _inline_markdown(first.get("source_id")) or "Official source"
        url = str(first.get("url") or "").strip()
        source_date = _inline_markdown(first.get("source_date")) or "not provided"
        accessed_at = _inline_markdown(first.get("accessed_at")) or "not provided"
        limitation = _inline_markdown(first.get("limitation")) or "none stated"
        source_link = "[{}]({})".format(title.replace("[", "\\[").replace("]", "\\]"), url)
        lines.append(
            "- {source_link} — source/release date: {source_date}"
            " — access date: {accessed_at} — limitation: {limitation}".format(
                source_link=source_link,
                source_date=source_date,
                accessed_at=accessed_at,
                limitation=limitation,
            )
        )
        for row in source_rows:
            claim = _inline_markdown(row.get("claim"))
            quote = _inline_markdown(row.get("quote"))
            lines.append(
                '  - [{evidence_id}] {claim} — "{quote}" — quote matched —'.format(
                    evidence_id=row["evidence_id"],
                    claim=claim,
                    quote=quote,
                )
            )
    return "\n".join(lines)


def _comparison_cell(value) -> str:
    """Render a safe one-line Markdown table cell."""
    return _inline_markdown(value).replace("|", "\\|")


def _source_ids(value) -> list:
    if isinstance(value, list):
        return [str(item) for item in value if item is not None and str(item).strip()]
    if value is None:
        return []
    return [part.strip() for part in str(value).split(",") if part.strip()]


def _is_not_verified(value: str) -> bool:
    return bool(re.match(r"^not verified(?:\s*:|$)", value, re.IGNORECASE))


def _comparison_coverage(normalized_rows: list) -> list:
    """Report citation coverage only; field presence does not establish meaning."""
    coverage = []
    for row in normalized_rows:
        cited = [
            field for field in _COMPARISON_FACTUAL_FIELDS
            if _inline_markdown(row.get(field))
            and not _is_not_verified(_inline_markdown(row.get(field)))
        ]
        coverage.append({
            "candidate": row.get("candidate"),
            "fields_with_citations": cited,
            "missing_citation_fields": [
                field for field in _COMPARISON_FACTUAL_FIELDS if field not in cited
            ],
        })
    return coverage


def _render_comparison(payload_rows, evidence_rows: list) -> tuple[list, str, list]:
    """Normalize a model-supplied comparison into one complete, stable table.

    The model still decides the candidates and field values. This formatter only
    guarantees the delivery contract: every retained candidate gets every
    column, missing facts are explicit, and each factual cell can survive only
    when its declared claim ID has a matched quote from that candidate's source.
    Row-level attribution does not establish individual cell bindings.
    """
    rows = payload_rows if isinstance(payload_rows, list) else []
    evidence_by_claim: dict = {}
    valid_evidence_ids = set()
    for evidence in evidence_rows:
        evidence_id = str(evidence.get("evidence_id") or "")
        if not evidence_id:
            continue
        valid_evidence_ids.add(evidence_id)
        claim_id = evidence.get("claim_id")
        if claim_id is not None and str(claim_id).strip():
            evidence_by_claim.setdefault(str(claim_id), []).append(evidence)

    normalized_rows = []
    warnings = []
    markdown_rows = []
    for index, candidate in enumerate(rows):
        if not isinstance(candidate, dict):
            warnings.append({
                "row": index,
                "issue": "comparison_row_invalid",
                "detail": "comparison rows must be JSON objects",
            })
            continue

        normalized = {}
        name = _inline_markdown(candidate.get("candidate"))
        if not name:
            name = "Unnamed candidate {}".format(index + 1)
            warnings.append({
                "row": index,
                "issue": "comparison_candidate_missing",
                "detail": "candidate name was missing",
            })
        normalized["candidate"] = name

        candidate_source_ids = set(_source_ids(candidate.get("evidence_sources")))
        field_claims = candidate.get("field_claims")
        field_claims = field_claims if isinstance(field_claims, dict) else {}
        row_evidence_ids = []
        for key, label in _COMPARISON_COLUMNS[1:-1]:
            value = _inline_markdown(candidate.get(key))
            if not value:
                value = "Not verified: {}".format(label)
                warnings.append({
                    "row": index,
                    "candidate": name,
                    "field": key,
                    "issue": "comparison_field_missing",
                })
                normalized[key] = value
                continue
            if key in _COMPARISON_INFERENCE_FIELDS or _is_not_verified(value):
                normalized[key] = value
                continue

            field_evidence = []
            for claim_id in _source_ids(field_claims.get(key)):
                for evidence in evidence_by_claim.get(claim_id, []):
                    if str(evidence.get("source_id") or "") in candidate_source_ids:
                        field_evidence.append(evidence)
            field_evidence_ids = list(dict.fromkeys(
                str(evidence.get("evidence_id") or "")
                for evidence in field_evidence
                if str(evidence.get("evidence_id") or "") in valid_evidence_ids
            ))
            if not field_evidence_ids:
                normalized[key] = "Not verified: {}".format(label)
                warnings.append({
                    "row": index,
                    "candidate": name,
                    "field": key,
                    "issue": "comparison_field_evidence_missing",
                    "detail": (
                        "a factual comparison value requires a quote-matched "
                        "field_claims entry from one of the candidate's "
                        "evidence_sources"
                    ),
                })
                continue
            normalized[key] = "{} [{}]".format(
                value, ", ".join(field_evidence_ids)
            )
            row_evidence_ids.extend(field_evidence_ids)

        row_evidence_ids = list(dict.fromkeys(row_evidence_ids))
        if row_evidence_ids:
            normalized["evidence"] = ", ".join(row_evidence_ids)
        else:
            normalized["evidence"] = "Not verified: no verified Evidence ID"
            warnings.append({
                "row": index,
                "candidate": name,
                "field": "evidence",
                "issue": "comparison_evidence_missing",
            })

        normalized_rows.append(normalized)
        markdown_rows.append(
            "| {} |".format(" | ".join(
                _comparison_cell(normalized[key]) for key, _ in _COMPARISON_COLUMNS
            ))
        )

    if not markdown_rows:
        return normalized_rows, "", warnings
    header = "| {} |".format(" | ".join(label for _, label in _COMPARISON_COLUMNS))
    separator = "|{}|".format("|".join("---" for _ in _COMPARISON_COLUMNS))
    return normalized_rows, "\n".join([header, separator, *markdown_rows]), warnings


def _classify_citation(
    cit: dict,
    by_id: dict,
    by_url: dict,
    source_text_cache: dict,
) -> dict:
    source, how = _resolve_source(cit, by_id, by_url)
    out = {
        "source": cit.get("source"),
        "url": cit.get("url"),
        "resolved_by": how,
        "url_status": "known" if source is not None else "unknown",
    }
    if source is None:
        # A citation to a source that was never fetched is the clearest
        # fabrication signal — no text exists to verify against.
        out.update(
            quote_status="unverifiable",
            doi_status="unverifiable",
            verdict="flagged",
        )
        return out

    q = _check_quote(cit.get("quote") or "", source, source_text_cache)
    d = _check_doi(cit.get("doi") or "", source, source_text_cache)
    out["quote_status"] = q
    out["doi_status"] = d

    if q == "not_found" or d in ("malformed", "unverified"):
        verdict = "flagged"          # positively contradicted → likely fabricated
    elif q == "verified":
        verdict = "verified"         # quote proven present in the cited source
    else:
        verdict = "weak"             # known source, but no adequate matched quote
    out["verdict"] = verdict
    return out


def verify(payload: dict) -> dict:
    sources = payload.get("sources") or []
    claims = payload.get("claims") or []
    if not sources:
        comparison_rows, comparison_markdown, comparison_warnings = _render_comparison(
            payload.get("comparison"), [])
        comparison_coverage = _comparison_coverage(comparison_rows)
        return {
            "abstain": True,
            "abstain_reason": "no_sources",
            "summary": {"claims": len(claims), "citations": 0,
                        "verified": 0, "weak": 0, "flagged": 0},
            "claims": [], "references": [], "evidence_rows": [],
            "evidence_markdown": "", "comparison_rows": comparison_rows,
            "comparison_markdown": comparison_markdown,
            "comparison_coverage": comparison_coverage,
            "comparison_warnings": comparison_warnings,
            "flags": [], "warnings": [],
        }

    by_id, by_url = _index_sources(sources)
    source_text_cache: dict = {}
    ref_order: list = []          # normalized-url keys in first-cited order
    ref_meta: dict = {}
    n_verified = n_weak = n_flagged = n_cit = 0
    out_claims: list = []
    evidence_rows: list = []
    flags: list = []
    warnings: list = []

    for ci, claim in enumerate(claims):
        if not isinstance(claim, dict):
            continue
        cits = claim.get("citations") or []
        claim_id = _inline_markdown(claim.get("id")) or "claim_{}".format(ci + 1)
        classified = []
        for cj, cit in enumerate(cits):
            if not isinstance(cit, dict):
                continue
            n_cit += 1
            info = _classify_citation(
                cit, by_id, by_url, source_text_cache)
            if info["verdict"] == "verified":
                n_verified += 1
            elif info["verdict"] == "weak":
                n_weak += 1
            else:
                n_flagged += 1
                flags.append({"claim": ci, "citation": cj,
                              "issue": _flag_issue(info), "detail": _flag_detail(info, cit)})
            # Number known sources with verified or weak citations.
            # Flagged/phantom citations get no reference.
            if info["verdict"] in ("verified", "weak"):
                src, _ = _resolve_source(cit, by_id, by_url)
                key = _normalize_url(src.get("url") or "") or "src:{}".format(src.get("id"))
                if key not in ref_meta:
                    ref_order.append(key)
                    ref_meta[key] = {
                        "title": src.get("title"),
                        "url": src.get("url"),
                        "date": src.get("date"),
                        "authors": src.get("authors") or [],
                        "publisher": src.get("publisher") or src.get("venue"),
                        "doi": src.get("doi"),
                        "pmid": src.get("pmid"),
                        "source_type": src.get("source_type") or src.get("source"),
                    }
                info["ref"] = ref_order.index(key) + 1
                if info["verdict"] == "verified":
                    evidence_rows.append({
                        # Compact prose cites stable ledger IDs. Filtering or removing
                        # another row must never redirect those references.
                        "evidence_id": (
                            claim_id if isinstance(payload.get("compact_landscape"), dict)
                            else "E{}".format(n_cit)
                        ),
                        "claim_id": claim_id,
                        "ref": info["ref"],
                        "source_id": src.get("id"),
                        "title": src.get("title"),
                        "claim": claim.get("text"),
                        "quote": cit.get("quote"),
                        "url": src.get("url"),
                        "source_date": src.get("date") or src.get("published_at"),
                        "accessed_at": src.get("accessed_at") or src.get("access_date"),
                        "limitation": (
                            cit.get("limitation")
                            or claim.get("limitation")
                            or src.get("limitation")
                            or src.get("limitations")
                        ),
                        "quote_status": "verified",
                    })
            classified.append(info)

        out_claims.append({
            "id": claim_id,
            "text": claim.get("text"),
            "citations": classified,
        })

    references = [{"ref": i + 1, **ref_meta[k]} for i, k in enumerate(ref_order)]
    comparison_rows, comparison_markdown, comparison_warnings = _render_comparison(
        payload.get("comparison"), evidence_rows)
    comparison_coverage = _comparison_coverage(comparison_rows)
    return {
        "abstain": False,
        "abstain_reason": None,
        "summary": {"claims": len(out_claims), "citations": n_cit,
                    "verified": n_verified, "weak": n_weak, "flagged": n_flagged,
                    "comparison_rows": len(comparison_coverage)},
        "claims": out_claims,
        "references": references,
        "evidence_rows": evidence_rows,
        "evidence_markdown": _render_evidence_markdown(evidence_rows),
        "comparison_rows": comparison_rows,
        "comparison_markdown": comparison_markdown,
        "comparison_coverage": comparison_coverage,
        "comparison_warnings": comparison_warnings,
        "flags": flags,
        "warnings": warnings,
    }


def _flag_issue(info: dict) -> str:
    if info["url_status"] == "unknown":
        return "citation_source_not_found"
    if info.get("quote_status") == "not_found":
        return "quote_not_found_in_source"
    if info.get("doi_status") == "malformed":
        return "doi_malformed"
    if info.get("doi_status") == "unverified":
        return "doi_not_found_in_source"
    return "flagged"


def _flag_detail(info: dict, cit: dict) -> str:
    issue = _flag_issue(info)
    if issue == "citation_source_not_found":
        return "cites {} which was not among the fetched sources".format(
            cit.get("source") or cit.get("url") or "<none>")
    if issue == "quote_not_found_in_source":
        return "quote does not appear in the cited source (paraphrase or fabricated)"
    if issue == "doi_malformed":
        return "DOI is not well-formed: {!r}".format(cit.get("doi"))
    if issue == "doi_not_found_in_source":
        return "DOI {!r} does not resolve to the cited source".format(cit.get("doi"))
    return "citation could not be verified"


def references(payload: dict) -> dict:
    """Emit only the numbered reference list for validly-cited sources. Thin
    wrapper over verify so numbering matches exactly."""
    v = verify(payload)
    return {"abstain": v["abstain"], "abstain_reason": v["abstain_reason"],
            "references": v["references"]}


def _evidence_ledger_rows(input_path) -> tuple[str | None, list[dict]]:
    if not input_path or input_path == "-":
        return None, []
    ledger_path = os.path.join(
        os.path.dirname(os.path.abspath(input_path)),
        "evidence_ledger.jsonl",
    )
    if not os.path.isfile(ledger_path):
        return None, []

    rows = []
    try:
        with open(ledger_path, encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(row, dict):
                    rows.append(row)
    except OSError:
        return None, []
    return ledger_path, rows


def _ledger_fields(row: dict) -> list[str]:
    raw = row.get("fields")
    if not isinstance(raw, list):
        raw = [row.get("field")]
    return list(dict.fromkeys(
        str(item).strip()
        for item in raw
        if item is not None and str(item).strip() in _COMPARISON_FACTUAL_FIELDS
    ))


def _trusted_source_snapshots() -> tuple[dict[str, list[str]], dict]:
    """Load host-captured web_fetch text and reject corrupt snapshot rows."""
    snapshot_path = str(os.environ.get(_TRUSTED_SNAPSHOT_ENV) or "").strip()
    diagnostics = {
        "available": False,
        "valid_rows": 0,
        "invalid_rows": 0,
        "source_urls": 0,
    }
    if not snapshot_path or not os.path.isfile(snapshot_path):
        return {}, diagnostics
    try:
        if os.path.getsize(snapshot_path) > _MAX_TRUSTED_SNAPSHOT_BYTES:
            diagnostics["invalid_rows"] = 1
            return {}, diagnostics
    except OSError:
        return {}, diagnostics

    by_url: dict[str, list[str]] = {}
    try:
        with open(snapshot_path, encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except (json.JSONDecodeError, TypeError):
                    diagnostics["invalid_rows"] += 1
                    continue
                if not isinstance(row, dict) or row.get("schema_version") != 1:
                    diagnostics["invalid_rows"] += 1
                    continue
                source_url = _normalize_url(row.get("canonical_url") or "")
                text = row.get("text")
                expected_hash = str(row.get("content_sha256") or "").strip().lower()
                source_parts = urlsplit(source_url)
                actual_hash = (
                    hashlib.sha256(text.encode("utf-8")).hexdigest()
                    if isinstance(text, str)
                    else ""
                )
                if (
                    source_parts.scheme not in {"http", "https"}
                    or not source_parts.netloc
                    or not text
                    or len(expected_hash) != 64
                    or actual_hash != expected_hash
                ):
                    diagnostics["invalid_rows"] += 1
                    continue
                values = by_url.setdefault(source_url, [])
                if text not in values:
                    values.append(text)
                diagnostics["valid_rows"] += 1
    except OSError:
        return {}, diagnostics
    diagnostics["available"] = bool(by_url)
    diagnostics["source_urls"] = len(by_url)
    return by_url, diagnostics


def _compact_evidence_row_verifies(
    row: dict,
    snapshots_by_url: dict[str, list[str]],
) -> bool:
    """Whether a compact ledger row passes the existing citation checks."""
    source_id = _inline_markdown(row.get("source_id"))
    claim_id = _inline_markdown(row.get("id"))
    claim = _inline_markdown(row.get("claim"))
    quote = _inline_markdown(row.get("quote"))
    source_url = _normalize_url(row.get("canonical_url") or row.get("url") or "")
    source_parts = urlsplit(source_url)
    texts = snapshots_by_url.get(source_url) or []
    if (
        not source_id
        or not claim_id
        or not claim
        or not quote
        or source_parts.scheme not in {"http", "https"}
        or not source_parts.netloc
        or not texts
    ):
        return False
    source = {
        "id": source_id,
        "url": source_url,
        "text": "\n".join(texts),
    }
    info = _classify_citation(
        {"source": source_id, "quote": quote},
        {source_id: source},
        {source_url: source},
        {},
    )
    return info.get("verdict") == "verified"


def _expand_compact_landscape_payload(payload: dict, input_path) -> dict:
    """Build the verifier payload directly from compact durable evidence.

    The compact path owns one canonical model-authored intermediate: evidence
    rows tagged with candidate and comparison fields. The verifier derives
    sources, claims, claim bindings, and factual comparison cells instead of
    asking the model to copy the same material into a second large JSON file.
    """
    spec = payload.get("compact_landscape")
    if not isinstance(spec, dict):
        return {"enabled": False, "ledger": None, "selected_evidence_rows": 0}
    if any(payload.get(key) for key in ("sources", "claims", "comparison")):
        raise ValueError(
            "compact_landscape must not be mixed with sources, claims, or comparison"
        )

    ledger_path, ledger_rows = _evidence_ledger_rows(input_path)
    if not ledger_path:
        raise ValueError("compact_landscape requires sibling evidence_ledger.jsonl")

    profiles = spec.get("candidates")
    if not isinstance(profiles, list) or not profiles:
        raise ValueError("compact_landscape.candidates must be a non-empty array")

    rows_by_candidate_field: dict[tuple[str, str], list[dict]] = {}
    for row in ledger_rows:
        candidate = _inline_markdown(row.get("candidate"))
        if not candidate:
            continue
        for field in _ledger_fields(row):
            rows_by_candidate_field.setdefault((candidate.casefold(), field), []).append(row)

    snapshots_by_url, snapshot_diagnostics = _trusted_source_snapshots()
    selected_rows: list[dict] = []
    comparison = []
    for index, profile in enumerate(profiles):
        if not isinstance(profile, dict):
            raise ValueError("compact_landscape candidate profiles must be objects")
        candidate = _inline_markdown(profile.get("candidate"))
        if not candidate:
            raise ValueError(
                "compact_landscape candidate {} has no candidate name".format(index)
            )
        best_for = _inline_markdown(profile.get("best_for"))
        ideal_user = _inline_markdown(profile.get("ideal_user"))
        if not best_for or not ideal_user:
            raise ValueError(
                "compact_landscape candidate {!r} requires best_for and ideal_user".format(
                    candidate
                )
            )

        comparison_row = {
            "candidate": candidate,
            "best_for": best_for,
            "ideal_user": ideal_user,
            "evidence_sources": [],
            "field_claims": {},
        }
        candidate_sources = []
        for field in _COMPARISON_FACTUAL_FIELDS:
            matches = rows_by_candidate_field.get((candidate.casefold(), field), [])
            row = next(
                (
                    candidate_row for candidate_row in matches
                    if _compact_evidence_row_verifies(candidate_row, snapshots_by_url)
                ),
                matches[0] if matches else None,
            )
            claim = _inline_markdown((row or {}).get("claim"))
            quote = _inline_markdown((row or {}).get("quote"))
            source_id = _inline_markdown((row or {}).get("source_id"))
            claim_id = _inline_markdown((row or {}).get("id"))
            if not row or not claim or not quote or not source_id or not claim_id:
                label = dict(_COMPARISON_COLUMNS)[field]
                comparison_row[field] = "Not verified: {}".format(label)
                continue
            comparison_row[field] = claim
            comparison_row["field_claims"][field] = [claim_id]
            candidate_sources.append(source_id)
            selected_rows.append(row)
        comparison_row["evidence_sources"] = list(dict.fromkeys(candidate_sources))
        comparison.append(comparison_row)

    unique_rows = []
    seen_claim_ids = set()
    for row in selected_rows:
        claim_id = _inline_markdown(row.get("id"))
        if not claim_id or claim_id in seen_claim_ids:
            continue
        seen_claim_ids.add(claim_id)
        unique_rows.append(row)

    sources_by_id: dict[str, dict] = {}
    source_urls_by_id: dict[str, str] = {}
    claims = []
    for row in unique_rows:
        source_id = _inline_markdown(row.get("source_id"))
        quote = _inline_markdown(row.get("quote"))
        source_url = _normalize_url(
            row.get("canonical_url") or row.get("url") or ""
        )
        source_parts = urlsplit(source_url)
        if source_parts.scheme not in {"http", "https"} or not source_parts.netloc:
            raise ValueError(
                "compact landscape source {!r} requires an HTTP(S) canonical URL".format(
                    source_id
                )
            )
        previous_url = source_urls_by_id.get(source_id)
        if previous_url is not None and previous_url != source_url:
            raise ValueError(
                "compact landscape source {!r} maps to multiple canonical URLs".format(
                    source_id
                )
            )
        source_urls_by_id[source_id] = source_url
        source = sources_by_id.get(source_id)
        if source is None:
            source = {
                "id": source_id,
                "url": source_url,
                "title": row.get("title"),
                "date": row.get("published_at") or row.get("source_date") or row.get("date"),
                "accessed_at": row.get("accessed_at") or row.get("access_date"),
                "publisher": row.get("publisher"),
                "source_type": row.get("source_type"),
                "limitations": row.get("limitations") or row.get("limitation"),
                "text": "\n".join(snapshots_by_url.get(source_url) or []),
            }
            sources_by_id[source_id] = source
        claims.append({
            "id": _inline_markdown(row.get("id")),
            "text": _inline_markdown(row.get("claim")),
            "citations": [{"source": source_id, "quote": quote}],
        })

    payload["sources"] = list(sources_by_id.values())
    payload["claims"] = claims
    payload["comparison"] = comparison
    return {
        "enabled": True,
        "ledger": os.path.basename(ledger_path),
        "ledger_rows": len(ledger_rows),
        "selected_evidence_rows": len(unique_rows),
        "candidate_rows": len(comparison),
        "trusted_source_snapshots": snapshot_diagnostics,
        "missing_snapshot_sources": sum(
            1 for source in sources_by_id.values() if not source.get("text")
        ),
    }


def _enrich_sources_from_evidence_ledger(payload: dict, input_path) -> dict:
    """Recover source dates/limits from the durable sibling ledger.

    Agents often build a minimal citations payload containing only id/url/text.
    The research workflow already persists richer metadata in
    evidence_ledger.jsonl, so the CLI merges it deterministically instead of
    asking the model to copy the same fields twice.
    """
    ledger_path, ledger_rows = _evidence_ledger_rows(input_path)
    if not ledger_path:
        return {"matched_sources": 0, "ledger": None}

    by_id = {}
    by_url = {}
    for row in ledger_rows:
        source_id = row.get("source_id") or row.get("id")
        if source_id is not None and str(source_id) not in by_id:
            by_id[str(source_id)] = row
        url_key = _normalize_url(row.get("canonical_url") or row.get("url") or "")
        if url_key and url_key not in by_url:
            by_url[url_key] = row

    matched = 0
    for source in payload.get("sources") or []:
        if not isinstance(source, dict):
            continue
        source_id = source.get("id")
        url_key = _normalize_url(source.get("url") or "")
        row = (
            by_id.get(str(source_id)) if source_id is not None else None
        ) or by_url.get(url_key)
        if not row:
            continue
        matched += 1
        if not source.get("url"):
            source["url"] = row.get("canonical_url") or row.get("url")
        if not source.get("title"):
            source["title"] = row.get("title")
        if not source.get("date"):
            source["date"] = (
                row.get("published_at")
                or row.get("source_date")
                or row.get("date")
            )
        if not source.get("accessed_at"):
            source["accessed_at"] = row.get("accessed_at") or row.get("access_date")
        if not source.get("publisher"):
            source["publisher"] = row.get("publisher")
        if not source.get("source_type"):
            source["source_type"] = row.get("source_type")
        if not source.get("limitations"):
            source["limitations"] = row.get("limitations") or row.get("limitation")

    return {
        "matched_sources": matched,
        "ledger": os.path.basename(ledger_path),
    }


def _load(path):
    if not path or path == "-":
        raw = sys.stdin.read()
    else:
        with open(path, encoding="utf-8") as fh:
            raw = fh.read()
    return json.loads(raw)


def _write_new_report(report_path: str, report_markdown: str) -> None:
    """Create one report atomically; never replace an earlier deliverable."""
    try:
        with open(report_path, "x", encoding="utf-8") as fh:
            fh.write(report_markdown)
    except FileExistsError:
        raise ValueError(
            "--report-out target already exists: {}. Pass a topic-specific "
            "RESEARCH-<topic>.md name that does not exist yet; a previous "
            "report is never overwritten.".format(report_path)
        ) from None


def main(argv):
    ap = argparse.ArgumentParser(prog="deep-research/citations")
    ap.add_argument("--op", choices=["verify", "references"], default="verify")
    ap.add_argument("--input", default=None, help="claims+sources payload JSON (default stdin)")
    ap.add_argument("--out", default=None)
    ap.add_argument("--report-out", default=None)
    args = ap.parse_args(argv)

    payload = _load(args.input)
    if not isinstance(payload, dict):
        raise ValueError("input must be a JSON object with 'sources' and 'claims'")
    compact_expansion = _expand_compact_landscape_payload(payload, args.input)
    enrichment = _enrich_sources_from_evidence_ledger(payload, args.input)
    data = references(payload) if args.op == "references" else verify(payload)
    data["metadata_enrichment"] = enrichment
    data["compact_landscape_expansion"] = compact_expansion

    if args.report_out:
        spec = payload.get("compact_landscape")
        if not isinstance(spec, dict):
            raise ValueError("--report-out requires compact_landscape input")
        title = _inline_markdown(spec.get("title")) or "Research report"
        boundary = str(spec.get("boundary") or "").strip()
        analysis = spec.get("analysis_markdown")
        if not isinstance(analysis, str) or not analysis.strip():
            raise ValueError("--report-out requires non-empty compact_landscape.analysis_markdown")
        parts = ["# {}".format(title)]
        if boundary:
            parts.append(boundary)
        parts.append(analysis)
        for key in ("comparison_markdown", "evidence_markdown"):
            value = str(data.get(key) or "").strip()
            if value:
                parts.append(value)
        report_markdown = "\n\n".join(parts) + "\n"
        # A later research run in the same workspace is a new report, not a
        # revision of the earlier one. Exclusive creation makes that guarantee
        # atomic even when two same-topic runs finish concurrently.
        _write_new_report(args.report_out, report_markdown)
        data["report"] = {
            "path": args.report_out,
            "characters": len(report_markdown),
        }

    result = {"ok": True, "data": data}
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False)
    return result


def _cli_stdout(result: dict, argv: list[str]) -> dict:
    """Keep persisted verifier output out of the model's tool-result context."""
    if "--out" not in argv:
        return result
    out_index = argv.index("--out") + 1
    output_path = argv[out_index] if out_index < len(argv) else None
    data = result.get("data") if isinstance(result, dict) else None
    data = data if isinstance(data, dict) else {}
    summary = data.get("summary")

    def compact_details(items: Any) -> list[dict]:
        keys = ("claim", "citation", "row", "candidate", "field", "issue")
        return [
            {key: item[key] for key in keys if key in item}
            for item in (items or [])[:12]
            if isinstance(item, dict)
        ]

    coverage = []
    for item in (data.get("comparison_coverage") or [])[:12]:
        if not isinstance(item, dict):
            continue
        coverage.append({
            "candidate": item.get("candidate"),
            "fields_with_citations": item.get("fields_with_citations") or [],
            "missing_citation_fields": item.get("missing_citation_fields") or [],
        })

    compact = {
        "ok": bool(result.get("ok")),
        "output": output_path,
        "abstain": bool(data.get("abstain")),
        "summary": summary if isinstance(summary, dict) else {},
        "flags": len(data.get("flags") or []),
        "warnings": len(data.get("warnings") or []),
        "flag_details": compact_details(data.get("flags")),
        "warning_details": compact_details(data.get("warnings")),
        "comparison_warnings": len(data.get("comparison_warnings") or []),
        "comparison_warning_details": compact_details(data.get("comparison_warnings")),
        "comparison_coverage_details": coverage,
        "comparison_rows": len(data.get("comparison_rows") or []),
        "evidence_rows": len(data.get("evidence_rows") or []),
        "compact_landscape_expansion": data.get("compact_landscape_expansion") or {},
        "report": data.get("report") or {},
    }
    if "--report-out" not in argv:
        compact.update({
            "comparison_markdown": data.get("comparison_markdown") or "",
            "evidence_markdown": data.get("evidence_markdown") or "",
        })
    return compact


if __name__ == "__main__":
    try:
        out = main(sys.argv[1:])
    except (ValueError, OSError, json.JSONDecodeError) as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)
    # Keep stdout ASCII-safe so Windows shells cannot mojibake JSON when a
    # caller captures it. Delivery files use --out and remain normal UTF-8.
    print(json.dumps(_cli_stdout(out, sys.argv[1:]), ensure_ascii=True))
