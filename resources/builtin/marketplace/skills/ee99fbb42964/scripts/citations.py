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

# Explicit comparison shapes in an Agent-authored claim. Such a claim must name
# its baseline: a "25x" gain over a model two generations old reads as a
# generational jump unless the comparator is stated (2026-10-02 Astra review).
# Ordinary counts ("more than 100k GPUs") and frequencies ("3 times a day")
# are not comparisons and do not match.
_COMPARATIVE_CLAIM_RE = re.compile(
    r"\d+(?:[.,]\d+)?\s*(?:[x×](?!\w)|倍|-?fold\b|percentage points?\b|pp\b|个百分点)"
    r"|\d+(?:[.,]\d+)?\s*times\s+(?:higher|lower|more|less|fewer|faster|slower|better|worse"
    r"|larger|smaller|greater|bigger|as)\b"
    r"|\b(?:vs\.?|versus|compared (?:with|to)|outperform(?:s|ed|ing)?)(?!\w)"
    r"|\b(?:better|worse|higher|lower|faster|slower|stronger|weaker) than\b"
    r"|\bfrom\s+\d+(?:[.,]\d+)?\s*%?\s+to\s+\d+(?:[.,]\d+)?\s*%?"
    r"|从\s*\d+(?:\.\d+)?\s*%?\s*(?:升|增|提|提高|提升|降|下降|跌)(?:至|到)"
    r"|相比|相较|对比|较之|高于|低于|优于|劣于|强于|弱于|领先于",
    re.IGNORECASE,
)

# Coverage leads: works a fetched source names (author-year citations, arXiv
# identifiers, DOIs) that no fetched or cited source matches. A companion
# report named in a paper's introduction was never fetched in the run that
# motivated this list; the script names leads, the Agent judges relevance.
_LEAD_AUTHOR = r"[A-Z][\w'’\-]*(?:\s+(?:et\s+al\.?|(?:and|&)\s+[A-Z][\w'’\-]*))?(?:\s+Team)?"
_PAREN_GROUP_RE = re.compile(r"\(([^()]{3,400})\)")
_PAREN_CITE_RE = re.compile(
    r"^\s*(?:see\s+|e\.g\.,?\s+|cf\.\s+|i\.e\.,?\s+)?(?P<author>" + _LEAD_AUTHOR
    + r"),?\s+(?P<year>(?:19|20)\d{2})[a-z]?\s*$"
)
_NARRATIVE_CITE_RE = re.compile(
    r"(?P<author>[A-Z][\w'’\-]*\s+(?:et\s+al\.?|(?:and|&)\s+[A-Z][\w'’\-]*))"
    r"\s*\(\s*(?P<year>(?:19|20)\d{2})[a-z]?\s*\)"
)
# A reference-list entry continues with its author list ("Jia et al. (2026)
# Mengzhao Jia, Yang Lin, ..." or "Ann Liu and Bo Wu."); prose continues with
# a lowercase verb ("Jia et al. (2026) showed ...").
_REFERENCE_ENTRY_START_RE = re.compile(
    r"\s+[A-Z][\w.'’\-]*(?:\s+[A-Z][\w.'’\-]*){0,3}(?:,|\s+(?:and|&)\s+[A-Z])")
_ARXIV_ID_RE = re.compile(
    r"(?:arxiv:\s*|arxiv\.org/(?:abs|pdf|html)/)(\d{4}\.\d{4,5})(?:v\d+)?", re.IGNORECASE)
_LEAD_URL_RE = re.compile(r"https?://[^\s<>\"'()\[\]]+")
_LEAD_STOPWORDS = frozenset({
    "january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december", "jan", "feb", "mar", "apr",
    "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "spring", "summer",
    "fall", "autumn", "winter", "updated", "accessed", "published", "released",
    "version", "copyright", "figure", "table", "section", "appendix", "since",
    "see", "in", "on", "by", "as", "of", "the", "and", "or", "q1", "q2", "q3", "q4",
})
_MAX_LEAD_TEXT_CHARS = 500_000
_MAX_LEAD_TOTAL_CHARS = 3_000_000
_MAX_LEAD_ENTRY_CHARS = 600
_MAX_COVERAGE_LEADS = 10
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
            baseline = _inline_markdown(row.get("baseline"))
            if baseline:
                claim = "{} (baseline: {})".format(claim, baseline)
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


def _url_key(url: str) -> str:
    """Scheme-, www- and trailing-slash-insensitive URL key for lead matching."""
    key = _normalize_url(url or "").lower()
    return re.sub(r"^https?://(?:www\.)?", "", key).rstrip("/")


def _lead_tokens(value: str) -> set:
    return {token for token in re.findall(r"[0-9a-z]+", (value or "").casefold()) if len(token) >= 3}


def _entry_identifiers(entry: str) -> list:
    found = ["arXiv:" + match.group(1) for match in _ARXIV_ID_RE.finditer(entry)]
    found.extend("doi:" + match.group(0).rstrip(".,;:)").lower() for match in _DOI_RE.finditer(entry))
    found.extend(match.group(0).rstrip(".,;:") for match in _LEAD_URL_RE.finditer(entry))
    return list(dict.fromkeys(found))


def _coverage_leads(sources: list, snapshots_by_url: dict, fetched_urls=None) -> tuple[list, int]:
    """Works that fetched text cites but no fetched or cited source matches.

    Scans source texts and host-captured snapshots for author-year citations,
    arXiv identifiers and DOIs. A lead is covered when one of its identifiers
    matches a fetched/cited URL or its first author/organization name appears
    in such a URL or a source title. Returns the top uncovered leads (most
    recent, then most mentioned) and the total uncovered count. Names only:
    whether a lead can change a conclusion is the Agent's judgment.
    """
    covered_urls = []
    covered_dois: set = set()
    covered_tokens: set = set()
    label_by_url: dict = {}
    texts = []
    for source in sources:
        if not isinstance(source, dict):
            continue
        if source.get("doi"):
            covered_dois.add(str(source["doi"]).strip().lower())
        for value in (source.get("url"), source.get("canonical_url")):
            if value:
                covered_urls.append(_url_key(str(value)))
                label_by_url.setdefault(_url_key(str(value)), str(source.get("id") or ""))
        for value in (source.get("title"), source.get("publisher")):
            covered_tokens |= _lead_tokens(str(value or ""))
        if isinstance(source.get("text"), str):
            texts.append((str(source.get("id") or source.get("url") or "source"), source["text"]))
    for url, chunks in snapshots_by_url.items():
        covered_urls.append(_url_key(url))
        label = label_by_url.get(_url_key(url)) or urlsplit(url).netloc
        texts.extend((label, chunk) for chunk in chunks)
    covered_urls.extend(_url_key(str(url)) for url in fetched_urls or [])
    covered_urls = [url for url in covered_urls if url]
    for url in covered_urls:
        covered_tokens |= _lead_tokens(url)

    leads: dict = {}
    attached: set = set()

    def lead_for(key, display: str, token, year: int, standalone: bool) -> dict:
        if key not in leads:
            leads[key] = {"lead": display, "token": token, "year": year, "standalone": standalone,
                          "mentions": 0, "sources": [], "identifiers": [], "context": "",
                          "order": len(leads)}
        return leads[key]

    def author_lead(author: str, year: str):
        author = _WS_RE.sub(" ", author).strip()
        token = re.split(r"[\s'’\-]", author, maxsplit=1)[0].casefold()
        if not token or token in _LEAD_STOPWORDS:
            return None
        return lead_for((token, year), "{}, {}".format(author, year), token, int(year), False)

    def record(lead: dict, label: str, text: str, position: int) -> None:
        lead["mentions"] += 1
        if label not in lead["sources"]:
            lead["sources"].append(label)
        if not lead["context"]:
            start, end = max(0, position - 160), min(len(text), position + 120)
            lead["context"] = ("…" if start else "") + _WS_RE.sub(" ", text[start:end]).strip() \
                + ("…" if end < len(text) else "")

    budget = _MAX_LEAD_TOTAL_CHARS
    seen = set()
    for label, raw_text in texts:
        if budget <= 0:
            break
        text = raw_text.replace("\u00a0", " ")[:min(_MAX_LEAD_TEXT_CHARS, budget)]
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        budget -= len(text)
        for group in _PAREN_GROUP_RE.finditer(text):
            for part in group.group(1).split(";"):
                match = _PAREN_CITE_RE.match(part)
                lead = author_lead(match.group("author"), match.group("year")) if match else None
                if lead is not None:
                    record(lead, label, text, group.start())
        for match in _NARRATIVE_CITE_RE.finditer(text):
            lead = author_lead(match.group("author"), match.group("year"))
            if lead is None:
                continue
            record(lead, label, text, match.start())
            if not _REFERENCE_ENTRY_START_RE.match(text, match.end()):
                continue
            entry = text[match.end():match.end() + _MAX_LEAD_ENTRY_CHARS]
            following = _NARRATIVE_CITE_RE.search(entry)
            for ident in _entry_identifiers(entry[:following.start()] if following else entry):
                attached.add(ident.casefold())
                if ident not in lead["identifiers"]:
                    lead["identifiers"].append(ident)
        standalone = [
            ("arXiv:" + match.group(1), 2000 + int(match.group(1)[:2]), match.start())
            for match in _ARXIV_ID_RE.finditer(text)
        ] + [
            ("doi:" + match.group(0).rstrip(".,;:)").lower(), 0, match.start())
            for match in _DOI_RE.finditer(text)
        ]
        for ident, year, position in standalone:
            if ident.casefold() in attached:
                continue
            lead = lead_for(("id", ident.casefold()), ident, None, year, True)
            if ident not in lead["identifiers"]:
                lead["identifiers"].append(ident)
            record(lead, label, text, position)

    def is_covered(lead: dict) -> bool:
        for ident in lead["identifiers"]:
            low = ident.casefold()
            if low.startswith(("arxiv:", "doi:")):
                needle = low.split(":", 1)[1]
                if needle in covered_dois or any(needle in url for url in covered_urls):
                    return True
                continue
            key = _url_key(ident)
            if any(url == key or url.startswith(key + "/") or key.startswith(url + "/")
                   for url in covered_urls):
                return True
        return lead["token"] is not None and lead["token"] in covered_tokens

    uncovered = [lead for lead in leads.values() if not is_covered(lead)]
    # Contemporaneous work first: a companion report published with the studied
    # release outranks the foundational papers a reference list also cites.
    uncovered.sort(key=lambda lead: (-lead["year"], lead["standalone"], -lead["mentions"], lead["order"]))
    return [
        {
            "lead": lead["lead"],
            "mentions": lead["mentions"],
            "sources": lead["sources"][:5],
            "identifiers": lead["identifiers"][:3],
            "context": lead["context"],
        }
        for lead in uncovered[:_MAX_COVERAGE_LEADS]
    ], len(uncovered)


def verify(payload: dict, fetched_urls=None) -> dict:
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
                        "verified": 0, "weak": 0, "flagged": 0, "coverage_leads": 0},
            "claims": [], "references": [], "evidence_rows": [],
            "evidence_markdown": "", "comparison_rows": comparison_rows,
            "comparison_markdown": comparison_markdown,
            "comparison_coverage": comparison_coverage,
            "comparison_warnings": comparison_warnings,
            "flags": [], "warnings": [], "coverage_leads": [],
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
        baseline = _inline_markdown(claim.get("baseline")) or None
        if baseline is None and _COMPARATIVE_CLAIM_RE.search(_inline_markdown(claim.get("text"))):
            warnings.append({
                "claim": ci,
                "issue": "comparison_baseline_missing",
                "detail": "claim {} compares magnitudes without claims[].baseline; name the "
                          "comparator and version, and whether it is the direct predecessor "
                          "or the source's official comparator".format(claim_id),
            })
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
                        "baseline": baseline,
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
            "baseline": baseline,
            "citations": classified,
        })

    references = [{"ref": i + 1, **ref_meta[k]} for i, k in enumerate(ref_order)]
    comparison_rows, comparison_markdown, comparison_warnings = _render_comparison(
        payload.get("comparison"), evidence_rows)
    comparison_coverage = _comparison_coverage(comparison_rows)
    snapshots_by_url, _ = _trusted_source_snapshots()
    coverage_leads, uncovered_leads = _coverage_leads(sources, snapshots_by_url, fetched_urls)
    return {
        "abstain": False,
        "abstain_reason": None,
        "summary": {"claims": len(out_claims), "citations": n_cit,
                    "verified": n_verified, "weak": n_weak, "flagged": n_flagged,
                    "comparison_rows": len(comparison_coverage),
                    "coverage_leads": uncovered_leads},
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
        "coverage_leads": coverage_leads,
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


def _record_ledger_issue(diagnostics: dict, line: int, reason: str, **details):
    counts = diagnostics["reason_counts"]
    counts[reason] = counts.get(reason, 0) + 1
    if len(diagnostics["samples"]) < 12:
        diagnostics["samples"].append({"line": line, "reason": reason, **details})
    else:
        diagnostics["omitted_samples"] += 1


def _compact_ledger_diagnostics(
    row: dict, line: int, candidates: set[str], diagnostics: dict,
):
    """Explain input shape/scope without changing evidence selection or support."""
    candidate = _inline_markdown(row.get("candidate"))
    if not candidate:
        _record_ledger_issue(diagnostics, line, "missing_candidate")
        return
    if candidate.casefold() not in candidates:
        # Other candidates may be valid evidence for a different selection.
        _record_ledger_issue(diagnostics, line, "candidate_outside_selection")
        return
    raw_fields = row.get("fields")
    if not isinstance(raw_fields, list):
        raw_fields = [row.get("field")]
    fields = {
        str(value).strip() for value in raw_fields
        if value is not None and str(value).strip()
    }
    if not fields:
        _record_ledger_issue(diagnostics, line, "missing_fields")
    elif fields.difference(_COMPARISON_FACTUAL_FIELDS):
        _record_ledger_issue(diagnostics, line, "unrecognized_fields")
    if fields.intersection(_COMPARISON_FACTUAL_FIELDS):
        missing = [
            key for key in ("id", "claim", "quote", "source_id")
            if not _inline_markdown(row.get(key))
        ]
        if missing:
            _record_ledger_issue(diagnostics, line, "incomplete_evidence", missing_fields=missing)


def _evidence_ledger_rows(
    input_path, *, diagnostics: dict | None = None, candidates: set[str] | None = None,
) -> tuple[str | None, list[dict]]:
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
            for line_number, line in enumerate(fh, 1):
                if not line.strip():
                    continue
                if diagnostics is not None:
                    diagnostics["nonempty_lines"] += 1
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    if diagnostics is not None:
                        _record_ledger_issue(diagnostics, line_number, "invalid_json")
                    continue
                if isinstance(row, dict):
                    rows.append(row)
                    if diagnostics is not None and candidates is not None:
                        _compact_ledger_diagnostics(row, line_number, candidates, diagnostics)
                elif diagnostics is not None:
                    _record_ledger_issue(diagnostics, line_number, "non_object")
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

    ledger_diagnostics = {
        "nonempty_lines": 0, "reason_counts": {}, "samples": [], "omitted_samples": 0,
    }
    profiles = spec.get("candidates")
    candidate_names = {
        _inline_markdown(profile.get("candidate")).casefold()
        for profile in (profiles if isinstance(profiles, list) else [])
        if isinstance(profile, dict)
    }
    ledger_path, ledger_rows = _evidence_ledger_rows(
        input_path, diagnostics=ledger_diagnostics, candidates=candidate_names,
    )
    if not ledger_path:
        raise ValueError("compact_landscape requires sibling evidence_ledger.jsonl")

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
            "baseline": row.get("baseline"),
            "citations": [{"source": source_id, "quote": quote}],
        })

    payload["sources"] = list(sources_by_id.values())
    payload["claims"] = claims
    payload["comparison"] = comparison
    return {
        "enabled": True,
        "ledger": os.path.basename(ledger_path),
        "ledger_rows": len(ledger_rows),
        "ledger_diagnostics": ledger_diagnostics,
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


def _sibling_fetch_ledger_urls(input_path) -> list:
    """URLs attempted in the sibling fetch_ledger.jsonl; they count as followed leads."""
    if not input_path or input_path == "-":
        return []
    ledger_path = os.path.join(os.path.dirname(os.path.abspath(input_path)), "fetch_ledger.jsonl")
    urls = []
    try:
        with open(ledger_path, encoding="utf-8") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except (json.JSONDecodeError, TypeError):
                    continue
                if not isinstance(row, dict):
                    continue
                for key in ("url", "canonical_url"):
                    value = row.get(key)
                    if isinstance(value, str) and value.startswith(("http://", "https://")):
                        urls.append(value)
    except OSError:
        return []
    return urls


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
    data = (
        references(payload) if args.op == "references"
        else verify(payload, fetched_urls=_sibling_fetch_ledger_urls(args.input))
    )
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

    leads = [
        {
            "lead": item.get("lead"),
            "mentions": item.get("mentions"),
            "sources": (item.get("sources") or [])[:3],
            "identifiers": (item.get("identifiers") or [])[:2],
            "context": str(item.get("context") or "")[:220],
        }
        for item in (data.get("coverage_leads") or [])[:8]
        if isinstance(item, dict)
    ]

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
        "coverage_leads": leads,
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
