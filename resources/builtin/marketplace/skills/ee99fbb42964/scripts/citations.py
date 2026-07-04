"""deep-research citations — the deterministic anti-fabrication half of the engine.

A Python skill cannot reach Orkas's in-process model or web tools, so the AGENT
gathers sources (web_search / web_fetch) and drafts claims-with-citations; this
skill does the deterministic verification the model must not be trusted to do on
itself:

  verify      — for each claim citation, check the quote actually appears in the
                CITED source, the DOI (if any) is well-formed and present, and the
                source is one that was really fetched; mark each claim supported or
                unsupported; abstain when there are no sources at all.
  references  — build a de-duplicated, stably-numbered reference list from the
                sources that are validly cited (the add-references step).

Design (deep-research references guardrail, stronger than GPT-Researcher):
a model answering from parametric memory can invent a plausible quote, a real-
looking DOI, or a URL it never read. All three are caught here deterministically:
quote match is formatting-insensitive but NOT paraphrase-tolerant, a DOI must
resolve to a fetched source, and a citation to an unknown source is flagged, not
silently accepted. Nothing here calls a model — same input always yields the same
verdicts, so it is fully unit-testable.

stdlib only.
"""

from __future__ import annotations

import argparse
import json
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


def _classify_citation(cit: dict, by_id: dict, by_url: dict, source_text_cache: dict) -> dict:
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
        out.update(quote_status="unverifiable", doi_status="unverifiable", verdict="flagged")
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
    return out


def verify(payload: dict) -> dict:
    sources = payload.get("sources") or []
    claims = payload.get("claims") or []
    if not sources:
        return {
            "abstain": True,
            "abstain_reason": "no_sources",
            "summary": {"claims": len(claims), "supported": 0, "unsupported": len(claims),
                        "citations": 0, "verified": 0, "weak": 0, "flagged": 0},
            "claims": [], "references": [], "flags": [],
        }

    by_id, by_url = _index_sources(sources)
    source_text_cache: dict = {}
    ref_order: list = []          # normalized-url keys in first-cited order
    ref_meta: dict = {}
    n_verified = n_weak = n_flagged = n_cit = 0
    n_supported = 0
    out_claims: list = []
    flags: list = []

    for ci, claim in enumerate(claims):
        if not isinstance(claim, dict):
            continue
        cits = claim.get("citations") or []
        classified = []
        for cj, cit in enumerate(cits):
            if not isinstance(cit, dict):
                continue
            n_cit += 1
            info = _classify_citation(cit, by_id, by_url, source_text_cache)
            if info["verdict"] == "verified":
                n_verified += 1
            elif info["verdict"] == "weak":
                n_weak += 1
            else:
                n_flagged += 1
                flags.append({"claim": ci, "citation": cj,
                              "issue": _flag_issue(info), "detail": _flag_detail(info, cit)})

            # Assign a stable reference number to any source that backs the claim
            # (verified or weak). Flagged/phantom citations get no reference.
            if info["verdict"] in ("verified", "weak"):
                src, _ = _resolve_source(cit, by_id, by_url)
                key = _normalize_url(src.get("url") or "") or "src:{}".format(src.get("id"))
                if key not in ref_meta:
                    ref_order.append(key)
                    ref_meta[key] = {"title": src.get("title"), "url": src.get("url"),
                                     "date": src.get("date")}
                info["ref"] = ref_order.index(key) + 1
            classified.append(info)

        supported = any(c["verdict"] in ("verified", "weak") for c in classified)
        if supported:
            n_supported += 1
        out_claims.append({"text": claim.get("text"), "supported": supported,
                           "citations": classified})

    references = [{"ref": i + 1, **ref_meta[k]} for i, k in enumerate(ref_order)]
    return {
        "abstain": False,
        "abstain_reason": None,
        "summary": {"claims": len(out_claims), "supported": n_supported,
                    "unsupported": len(out_claims) - n_supported, "citations": n_cit,
                    "verified": n_verified, "weak": n_weak, "flagged": n_flagged},
        "claims": out_claims,
        "references": references,
        "flags": flags,
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
    data = references(payload) if args.op == "references" else verify(payload)

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
    print(json.dumps(out, ensure_ascii=False))
