"""deep-research citations — the deterministic anti-fabrication half of the engine.

A Python skill cannot reach Orkas's in-process model or web tools, so the AGENT
gathers sources (web_search / web_fetch) and drafts claims-with-citations; this
skill does the deterministic verification the model must not be trusted to do on
itself:

  verify      — for each claim citation, check the quote actually appears in the
                CITED source, the DOI (if any) is well-formed and present, and the
                source is one that was really fetched. A verified quote must also
                share meaningful claim terms before it is eligible to support the
                claim; provenance alone never implies support. Abstain when there
                are no sources at all.
  references  — build a de-duplicated, stably-numbered reference list from the
                sources that are validly cited (the add-references step).

Design (deep-research references guardrail, stronger than GPT-Researcher):
a model answering from parametric memory can invent a plausible quote, a real-
looking DOI, or a URL it never read. All three are caught here deterministically:
quote match is formatting-insensitive but NOT paraphrase-tolerant, a DOI must
resolve to a fetched source, and a citation to an unknown source is flagged, not
silently accepted. Nothing here calls a model — same input always yields the same
verdicts, so it is fully unit-testable. The lexical alignment gate is deliberately
conservative and is only a necessary condition for support, not a semantic
entailment proof; the agent must still inspect meaning and contradictions.

stdlib only.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
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
_ALIGN_WORD_RE = re.compile(r"[0-9A-Za-z]+", re.UNICODE)
_ALIGN_CJK_RUN_RE = re.compile(
    r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+",
    re.UNICODE,
)
_ALIGN_STOP = {
    "the", "and", "for", "with", "are", "that", "this", "from", "was", "were",
    "has", "have", "had", "not", "but", "its", "their", "they", "will", "would",
    "which", "these", "those", "such", "than", "then", "there", "here", "when",
    "where", "about", "over", "more", "most", "some", "also", "may", "might",
    "been", "being", "does", "did", "study", "paper", "report", "reports",
    "reported", "source", "article", "research", "researchers", "finding",
    "findings", "a", "an", "of", "to", "in", "is", "it", "on", "by", "or",
    "be", "as", "at",
}
_ALIGN_CJK_STOP = {
    "研究", "报告", "论文", "来源", "结果", "显示", "指出", "认为", "相关",
    "这个", "那个", "一种", "一个", "以及", "对于", "进行",
}
_OBSERVED_DATE_RE = re.compile(r"\b(?:19|20)\d{2}(?:-\d{2}(?:-\d{2})?)?\b")
_EVIDENCE_ID_RE = re.compile(r"\bE\d+\b", re.IGNORECASE)
_STRUCTURED_EVIDENCE_RE = re.compile(
    r"^\s*-\s*field=([a-z_]+);\s*exact_quote=(.+?)\s*$",
    re.MULTILINE,
)
_GITHUB_SNAPSHOT_MARKER = "Source type: structured GitHub repository snapshot"
_GITHUB_README_MARKER = "Official repository README:"
_GITHUB_README_EVIDENCE_PATTERNS = (
    ("core_use_case", re.compile(
        r"\b(?:assistant|chat|document|knowledge base|rag|agent|workspace|productivity|image generation)\b",
        re.IGNORECASE,
    )),
    ("os", re.compile(
        r"\b(?:windows|macos|mac os|linux|ubuntu|cross-platform|cross platform)\b",
        re.IGNORECASE,
    )),
    ("installation", re.compile(
        r"\b(?:install|installer|download|setup|getting started|quick ?start|no environment setup)\b",
        re.IGNORECASE,
    )),
    ("local_model_path", re.compile(
        r"\b(?:local model|offline|ollama|lm studio|llama\.?cpp|on-device|on device|self-host)\b",
        re.IGNORECASE,
    )),
    ("privacy", re.compile(
        r"\b(?:privacy|private|local-first|local first|100%\s+offline|no data|telemetry)\b",
        re.IGNORECASE,
    )),
    ("license_open_source", re.compile(
        r"\b(?:licen[cs]e|open.source|agpl|apache-2|apache 2|mit|gpl)\b",
        re.IGNORECASE,
    )),
    ("hardware_constraints", re.compile(
        r"\b(?:gpu|cpu|ram|memory|hardware|system requirement|minimum requirement|vram)\b",
        re.IGNORECASE,
    )),
)

_COMPARISON_COLUMNS = (
    ("candidate", "Candidate"),
    ("best_for", "Best for"),
    ("os", "OS"),
    ("installation", "Installation"),
    ("local_model_path", "Local-model path"),
    ("privacy", "Privacy"),
    ("license_open_source", "License/open source"),
    ("project_activity", "Project activity (observed date)"),
    ("hardware_constraints", "Hardware/constraints"),
    ("ideal_user", "Ideal user"),
    ("evidence", "Evidence"),
)


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


def _stem_alignment_word(word: str) -> str:
    """Tiny deterministic normalization for common English inflections."""
    if len(word) > 5 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 4 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def _alignment_terms(value: str) -> set:
    """Return Latin content words plus CJK bigrams for a conservative gate."""
    normalized = _normalize_text(value)
    terms = {
        _stem_alignment_word(match.group(0))
        for match in _ALIGN_WORD_RE.finditer(normalized)
        if match.group(0) not in _ALIGN_STOP
    }
    for match in _ALIGN_CJK_RUN_RE.finditer(normalized):
        run = match.group(0)
        if len(run) == 1:
            terms.add(run)
            continue
        terms.update(
            token for token in (run[i:i + 2] for i in range(len(run) - 1))
            if token not in _ALIGN_CJK_STOP
        )
    return terms


def _claim_quote_alignment(claim_text: str, quote: str) -> tuple[str, float]:
    """Return (aligned|unproven, claim-term coverage).

    Exact quote presence proves attribution, not relevance. Requiring at least
    two shared content terms (or the only term for a one-term claim) rejects the
    most dangerous shape: a real but unrelated quote attached to a claim.
    """
    claim_terms = _alignment_terms(claim_text)
    quote_terms = _alignment_terms(quote)
    if not claim_terms or not quote_terms:
        return "unproven", 0.0
    overlap = claim_terms & quote_terms
    coverage = len(overlap) / len(claim_terms)
    required = 1 if len(claim_terms) == 1 else 2
    aligned = len(overlap) >= required and coverage >= 0.25
    return ("aligned" if aligned else "unproven"), round(coverage, 4)


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

    lines = []
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
                '  - [{evidence_id}] {claim} — "{quote}" — verified —'.format(
                    evidence_id=row["evidence_id"],
                    claim=claim,
                    quote=quote,
                )
            )
    return "\n".join(lines)


def _bounded_repository_line(line: str):
    quote = line.strip()
    if (
        len(quote) < 20
        or len(quote) > 600
        or re.match(r"^#{1,6}\s", quote)
        or quote.startswith("![")
        or re.search(r"<img\b|img\.shields\.io", quote, re.IGNORECASE)
    ):
        return None
    return quote


def _github_metadata_value(text: str, label: str):
    match = re.search(
        r"^\s*-\s*{}:\s*(.+?)\s*$".format(re.escape(label)),
        text,
        re.MULTILINE,
    )
    if not match:
        return None
    value = match.group(1).strip()
    return None if not value or value == "Not provided" else value


def _github_repository_evidence(text: str) -> list:
    """Derive research fields from a neutral structured GitHub snapshot."""
    if _GITHUB_SNAPSHOT_MARKER not in text:
        return []

    rows = []
    description = _github_metadata_value(text, "Description")
    license_id = _github_metadata_value(text, "License SPDX ID")
    pushed_at = _github_metadata_value(text, "Pushed at")
    if description:
        rows.append({"field": "core_use_case", "quote": description})
    if license_id:
        rows.append({
            "field": "license_open_source",
            "quote": "License SPDX ID: {}".format(license_id),
        })
    if pushed_at:
        rows.append({
            "field": "project_activity",
            "quote": "Pushed at: {}".format(pushed_at),
        })

    readme = text.partition(_GITHUB_README_MARKER)[2]
    for field, pattern in _GITHUB_README_EVIDENCE_PATTERNS:
        for raw_line in readme.splitlines():
            quote = _bounded_repository_line(raw_line)
            if quote and pattern.search(quote):
                rows.append({"field": field, "quote": quote})
                break
    return rows


def _structured_source_evidence(source: dict) -> list:
    """Build deterministic evidence atoms in the research layer.

    Explicit source-adapter atoms remain supported for compatibility. Neutral
    GitHub repository snapshots are classified here so the general web_fetch
    tool does not contain DeepResearch-specific field taxonomy.
    """
    text = str(source.get("text") or "")
    candidates = []
    for match in _STRUCTURED_EVIDENCE_RE.finditer(text):
        field = match.group(1)
        raw_quote = match.group(2)
        try:
            quote = json.loads(raw_quote)
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        if not isinstance(quote, str):
            continue
        quote = quote.strip()
        candidates.append({"field": field, "quote": quote})
    candidates.extend(_github_repository_evidence(text))

    rows = []
    seen = set()
    for candidate in candidates:
        field = candidate["field"]
        quote = candidate["quote"]
        key = (field, _normalize_text(quote))
        if not quote or key in seen:
            continue
        seen.add(key)
        rows.append({"field": field, "quote": quote})
    return rows


def _comparison_cell(value) -> str:
    """Render a safe one-line Markdown table cell."""
    return _inline_markdown(value).replace("|", "\\|")


def _source_ids(value) -> list:
    if isinstance(value, list):
        return [str(item) for item in value if item is not None and str(item).strip()]
    if value is None:
        return []
    return [part.strip() for part in str(value).split(",") if part.strip()]


def _render_comparison(payload_rows, evidence_rows: list) -> tuple[list, str, list]:
    """Normalize a model-supplied comparison into one complete, stable table.

    The model still decides the candidates and field values. This formatter only
    guarantees the delivery contract: every retained candidate gets every
    column, missing facts are explicit, activity has an observed date, and the
    Evidence cell can reference only citation rows that actually verified.
    """
    rows = payload_rows if isinstance(payload_rows, list) else []
    evidence_by_source: dict = {}
    valid_evidence_ids = set()
    for evidence in evidence_rows:
        evidence_id = str(evidence.get("evidence_id") or "").upper()
        if not evidence_id:
            continue
        valid_evidence_ids.add(evidence_id)
        source_id = evidence.get("source_id")
        if source_id is not None:
            evidence_by_source.setdefault(str(source_id), []).append(evidence_id)

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

        activity = normalized["project_activity"]
        if not activity.startswith("Not verified:") and not _OBSERVED_DATE_RE.search(activity):
            observed_at = _inline_markdown(candidate.get("activity_observed_at"))
            if observed_at and _OBSERVED_DATE_RE.search(observed_at):
                activity = "{} (observed {})".format(activity, observed_at)
            else:
                activity = "{}; Not verified: observed date".format(activity)
                warnings.append({
                    "row": index,
                    "candidate": name,
                    "field": "project_activity",
                    "issue": "comparison_activity_date_missing",
                })
            normalized["project_activity"] = activity

        evidence_ids = []
        for source_id in _source_ids(candidate.get("evidence_sources")):
            evidence_ids.extend(evidence_by_source.get(source_id, []))
        for evidence_id in _EVIDENCE_ID_RE.findall(
            _inline_markdown(candidate.get("evidence"))
        ):
            normalized_id = evidence_id.upper()
            if normalized_id in valid_evidence_ids:
                evidence_ids.append(normalized_id)
        evidence_ids = list(dict.fromkeys(evidence_ids))
        if evidence_ids:
            normalized["evidence"] = ", ".join(evidence_ids)
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
    claim_text: str,
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
            alignment_status="invalid",
            alignment_score=0.0,
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
        verdict = "weak"             # real source, but no quote to prove the claim
    out["verdict"] = verdict
    if verdict == "verified":
        alignment, score = _claim_quote_alignment(claim_text, cit.get("quote") or "")
        out["alignment_status"] = alignment
        out["alignment_score"] = score
    elif verdict == "weak":
        out["alignment_status"] = "unproven"
        out["alignment_score"] = 0.0
    else:
        out["alignment_status"] = "invalid"
        out["alignment_score"] = 0.0
    return out


def verify(payload: dict) -> dict:
    sources = payload.get("sources") or []
    claims = payload.get("claims") or []
    if not sources:
        comparison_rows, comparison_markdown, comparison_warnings = _render_comparison(
            payload.get("comparison"), [])
        return {
            "abstain": True,
            "abstain_reason": "no_sources",
            "summary": {"claims": len(claims), "supported": 0, "unsupported": len(claims),
                        "citations": 0, "verified": 0, "weak": 0, "flagged": 0,
                        "aligned": 0, "support_unproven": 0},
            "claims": [], "references": [], "evidence_rows": [],
            "evidence_markdown": "", "comparison_rows": comparison_rows,
            "comparison_markdown": comparison_markdown,
            "comparison_warnings": comparison_warnings,
            "flags": [], "warnings": [],
        }

    by_id, by_url = _index_sources(sources)
    source_text_cache: dict = {}
    ref_order: list = []          # normalized-url keys in first-cited order
    ref_meta: dict = {}
    n_verified = n_weak = n_flagged = n_cit = n_aligned = n_unproven = 0
    n_supported = 0
    out_claims: list = []
    evidence_rows: list = []
    flags: list = []
    warnings: list = []

    for ci, claim in enumerate(claims):
        if not isinstance(claim, dict):
            continue
        cits = claim.get("citations") or []
        classified = []
        for cj, cit in enumerate(cits):
            if not isinstance(cit, dict):
                continue
            n_cit += 1
            info = _classify_citation(
                cit, str(claim.get("text") or ""), by_id, by_url, source_text_cache)
            if info["verdict"] == "verified":
                n_verified += 1
            elif info["verdict"] == "weak":
                n_weak += 1
            else:
                n_flagged += 1
                flags.append({"claim": ci, "citation": cj,
                              "issue": _flag_issue(info), "detail": _flag_detail(info, cit)})
            if info["alignment_status"] == "aligned":
                n_aligned += 1
            elif info["verdict"] != "flagged":
                n_unproven += 1
                warnings.append({
                    "claim": ci,
                    "citation": cj,
                    "issue": "claim_evidence_alignment_unproven",
                    "detail": (
                        "source attribution is valid, but the quote does not share enough "
                        "specific claim terms to establish support"
                        if info["verdict"] == "verified"
                        else "source is known, but a verifiable quote is required for support"
                    ),
                })

            # Assign a stable reference number to any source that backs the claim
            # (verified or weak). Flagged/phantom citations get no reference.
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
                if info["verdict"] == "verified" and info["alignment_status"] == "aligned":
                    evidence_rows.append({
                        "evidence_id": "E{}".format(len(evidence_rows) + 1),
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
                        "verification": "verified",
                    })
            classified.append(info)

        supported = any(
            c["verdict"] == "verified" and c["alignment_status"] == "aligned"
            for c in classified
        )
        if supported:
            n_supported += 1
        has_usable_attribution = any(c["verdict"] != "flagged" for c in classified)
        out_claims.append({
            "text": claim.get("text"),
            "supported": supported,
            "support_status": (
                "supported" if supported
                else "unproven" if has_usable_attribution
                else "invalid"
            ),
            "citations": classified,
        })

    # Source adapters can emit exact, field-indexed evidence candidates. Add
    # them deterministically so evidence granularity does not depend on whether
    # the model happened to split a compound repository snapshot into many
    # separate claims.
    existing_atoms = {
        (
            str(row.get("source_id") or ""),
            _normalize_text(str(row.get("quote") or "")),
        )
        for row in evidence_rows
    }
    structured_count = 0
    for source in sources:
        if not isinstance(source, dict):
            continue
        atoms = _structured_source_evidence(source)
        if not atoms:
            continue
        key = _normalize_url(source.get("url") or "") or "src:{}".format(source.get("id"))
        if key not in ref_meta:
            ref_order.append(key)
            ref_meta[key] = {
                "title": source.get("title"),
                "url": source.get("url"),
                "date": source.get("date"),
                "authors": source.get("authors") or [],
                "publisher": source.get("publisher") or source.get("venue"),
                "doi": source.get("doi"),
                "pmid": source.get("pmid"),
                "source_type": source.get("source_type") or source.get("source"),
            }
        ref = ref_order.index(key) + 1
        for atom in atoms:
            atom_key = (
                str(source.get("id") or ""),
                _normalize_text(atom["quote"]),
            )
            if atom_key in existing_atoms:
                continue
            existing_atoms.add(atom_key)
            evidence_rows.append({
                "evidence_id": "E{}".format(len(evidence_rows) + 1),
                "ref": ref,
                "source_id": source.get("id"),
                "title": source.get("title"),
                "field": atom["field"],
                "claim": "{}: {}".format(atom["field"], atom["quote"]),
                "quote": atom["quote"],
                "url": source.get("url"),
                "source_date": source.get("date") or source.get("published_at"),
                "accessed_at": source.get("accessed_at") or source.get("access_date"),
                "limitation": (
                    source.get("limitation")
                    or source.get("limitations")
                    or "Structured official-source excerpt; not an independent usability test."
                ),
                "verification": "verified",
                "verification_basis": "structured_source_adapter",
            })
            structured_count += 1

    references = [{"ref": i + 1, **ref_meta[k]} for i, k in enumerate(ref_order)]
    comparison_rows, comparison_markdown, comparison_warnings = _render_comparison(
        payload.get("comparison"), evidence_rows)
    return {
        "abstain": False,
        "abstain_reason": None,
        "summary": {"claims": len(out_claims), "supported": n_supported,
                    "unsupported": len(out_claims) - n_supported, "citations": n_cit,
                    "verified": n_verified, "weak": n_weak, "flagged": n_flagged,
                    "aligned": n_aligned, "support_unproven": n_unproven,
                    "structured_evidence_candidates": structured_count},
        "claims": out_claims,
        "references": references,
        "evidence_rows": evidence_rows,
        "evidence_markdown": _render_evidence_markdown(evidence_rows),
        "comparison_rows": comparison_rows,
        "comparison_markdown": comparison_markdown,
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


def _enrich_sources_from_evidence_ledger(payload: dict, input_path) -> dict:
    """Recover source dates/limits from the durable sibling ledger.

    Agents often build a minimal citations payload containing only id/url/text.
    The research workflow already persists richer metadata in
    evidence_ledger.jsonl, so the CLI merges it deterministically instead of
    asking the model to copy the same fields twice.
    """
    if not input_path or input_path == "-":
        return {"matched_sources": 0, "ledger": None}
    ledger_path = os.path.join(
        os.path.dirname(os.path.abspath(input_path)),
        "evidence_ledger.jsonl",
    )
    if not os.path.isfile(ledger_path):
        return {"matched_sources": 0, "ledger": None}

    by_id = {}
    by_url = {}
    try:
        with open(ledger_path, encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(row, dict):
                    continue
                source_id = row.get("source_id") or row.get("id")
                if source_id is not None and str(source_id) not in by_id:
                    by_id[str(source_id)] = row
                url_key = _normalize_url(row.get("canonical_url") or row.get("url") or "")
                if url_key and url_key not in by_url:
                    by_url[url_key] = row
    except OSError:
        return {"matched_sources": 0, "ledger": None}

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
    raw = sys.stdin.read() if not path or path == "-" else open(path, encoding="utf-8").read()
    return json.loads(raw)


def main(argv):
    ap = argparse.ArgumentParser(prog="deep-research/citations")
    ap.add_argument("--op", choices=["verify", "references"], default="verify")
    ap.add_argument("--input", default=None, help="claims+sources payload JSON (default stdin)")
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)

    payload = _load(args.input)
    if not isinstance(payload, dict):
        raise ValueError("input must be a JSON object with 'sources' and 'claims'")
    enrichment = _enrich_sources_from_evidence_ledger(payload, args.input)
    data = references(payload) if args.op == "references" else verify(payload)
    data["metadata_enrichment"] = enrichment

    result = {"ok": True, "data": data}
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False)
    return result


if __name__ == "__main__":
    try:
        out = main(sys.argv[1:])
    except (ValueError, OSError, json.JSONDecodeError) as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)
    # Keep stdout ASCII-safe so Windows shells cannot mojibake JSON when a
    # caller captures it. Delivery files use --out and remain normal UTF-8.
    print(json.dumps(out, ensure_ascii=True))
