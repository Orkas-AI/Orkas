"""geo-probe — GEO visibility probe, split into deterministic halves.

A Python skill cannot reach Orkas's in-process provider_catalog, so the AGENT
supplies the model answers (it calls its own model / web_search per query).
This skill does the two deterministic halves:

  queries  — generate representative probe queries from the page topic + brand.
  score    — parse a set of {query, model, mode, text} answers for brand
             mention vs sourced citation, and aggregate share-of-voice.

Honesty (design plan): a model answering from parametric memory ("mentioned")
is weaker evidence than an answer that cites the domain as a source ("cited").
Answers tagged mode="param" feed an Estimated SoV; mode="retrieval" with a
domain citation is the stronger signal.

stdlib only.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from urllib.parse import urlsplit

_WORD_RE = re.compile(r"\b[\w'-]+\b", re.UNICODE)
_STOP = {"the", "and", "for", "with", "your", "you", "our", "are", "that", "this",
         "from", "what", "how", "why", "can", "all", "any", "into", "out", "get",
         "a", "an", "of", "to", "in", "is", "it", "on", "by", "or", "be", "as",
         "open", "source", "free", "best", "top", "client", "app", "tool", "tools"}


def _data_page(crawl_obj: dict) -> tuple[dict, dict]:
    data = crawl_obj.get("data", crawl_obj) if isinstance(crawl_obj, dict) else {}
    pages = data.get("pages") or []
    if not pages:
        raise ValueError("crawl JSON has no pages")
    return pages[0], (data.get("site") or {})


def _sd_org_name(page: dict) -> str | None:
    for block in page.get("structured_data") or []:
        for it in (block if isinstance(block, list) else [block]):
            if isinstance(it, dict):
                nodes = it.get("@graph", [it]) if isinstance(it.get("@graph"), list) else [it]
                for n in nodes:
                    if isinstance(n, dict) and "Organization" in str(n.get("@type", "")) and n.get("name"):
                        return str(n["name"])
    return None


def derive_brand_domain(crawl_obj: dict, brand: str | None, domain: str | None) -> tuple[str, str]:
    page, _ = _data_page(crawl_obj)
    host = (urlsplit(page.get("url") or "").hostname or "").lower()
    dom = domain or host
    if not brand:
        brand = _sd_org_name(page)
    if not brand:
        # first segment of the title before a separator
        title = page.get("title") or ""
        brand = re.split(r"[\|\-—–:·]", title)[0].strip() if title else ""
    if not brand:
        brand = host.split(".")[0] if host else "the site"
    return brand, dom


def _topic_terms(page: dict, limit: int = 3) -> list[str]:
    text = " ".join([page.get("title") or ""] + (page.get("h1s") or []))
    seen, terms = set(), []
    for w in _WORD_RE.findall(text.lower()):
        if len(w) > 3 and w not in _STOP and w not in seen:
            seen.add(w); terms.append(w)
        if len(terms) >= limit:
            break
    return terms


def context_terms(crawl_obj: dict, brand: str, domain: str, limit: int = 10) -> list[str]:
    """Distinctive page-vocabulary terms used to disambiguate the brand from a
    homonym (e.g. 'Orkas' the AI product vs 'orcas' the whale): a brand-token
    hit only counts as a real product mention if the answer also carries one of
    these terms (or cites the domain)."""
    page, _ = _data_page(crawl_obj)
    text = " ".join([page.get("title") or ""] + (page.get("h1s") or [])
                    + [page.get("first_paragraph") or ""])
    stop = _STOP | set(brand.lower().split()) | set(re.split(r"[./:]", (domain or "").lower()))
    out, seen = [], set()
    for w in _WORD_RE.findall(text.lower()):
        if len(w) >= 2 and not w.isdigit() and w not in stop and w not in seen:
            seen.add(w)
            out.append(w)
        if len(out) >= limit:
            break
    return out


def gen_queries(crawl_obj: dict, brand: str, competitors: list[str]) -> list[str]:
    page, _ = _data_page(crawl_obj)
    terms = _topic_terms(page)
    topic = " ".join(terms[:2]) if terms else "this category"
    qs = [
        "What is {}?".format(brand),
        "{} review — is it any good?".format(brand),
        "Best {} tools".format(topic),
        "How does {} work?".format(brand),
    ]
    if competitors:
        qs.append("{} vs {}".format(brand, competitors[0]))
    else:
        qs.append("{} alternatives".format(brand))
    # de-dup, keep order
    out, seen = [], set()
    for q in qs:
        if q not in seen:
            seen.add(q); out.append(q)
    return out


def _mentions(text: str, needle: str) -> bool:
    if not needle:
        return False
    return re.search(r"(?<![\w-])" + re.escape(needle.lower()) + r"(?![\w-])", (text or "").lower()) is not None


def score_answers(payload: dict) -> dict:
    brand = payload.get("brand") or ""
    domain = payload.get("domain") or ""
    competitors = payload.get("competitors") or []
    answers = payload.get("answers") or []
    if not answers:
        raise ValueError("no answers to score (provide answers:[{query,text,...}])")

    # Page-vocabulary terms that tie a brand-token hit to the real product.
    # Provided by the queries op; when absent we fall back to legacy behavior
    # (any brand-token hit counts as a mention).
    context = [c.lower() for c in (payload.get("context_terms") or [])]

    rows, cited_n, mentioned_n, ambiguous_n, retrieval_n = [], 0, 0, 0, 0
    comp_hits = {c: 0 for c in competitors}
    for a in answers:
        text = a.get("text") or ""
        mode = (a.get("mode") or "param").lower()
        if mode == "retrieval":
            retrieval_n += 1
        # Word-boundary match only: a raw `domain in text` substring test counted
        # the domain as cited when it merely prefixed a longer host (orkas.ai is a
        # substring of orkas.airlines.com), inflating citation_rate. _mentions already
        # accepts orkas.ai/path, (orkas.ai) and trailing-dot forms.
        m_dom = _mentions(text, domain)
        m_brand = _mentions(text, brand)
        corroborated = any(_mentions(text, t) for t in context) if context else None
        if m_dom:
            kind = "cited"
            cited_n += 1
        elif m_brand:
            # With context terms, a brand token needs corroboration or it is a
            # likely homonym (e.g. "Orkas" -> orcas/whales) -> ambiguous, excluded.
            if (not context) or corroborated:
                kind = "mentioned"
                mentioned_n += 1
            else:
                kind = "ambiguous"
                ambiguous_n += 1
        else:
            kind = "absent"
        for c in competitors:
            if _mentions(text, c):
                comp_hits[c] += 1
        rows.append({"query": a.get("query"), "model": a.get("model"), "mode": mode,
                     "brand_token_present": bool(m_brand), "domain_cited": bool(m_dom),
                     "context_corroborated": (bool(corroborated) if context else None),
                     "result": kind})

    n = len(answers)
    brand_hits = cited_n + mentioned_n  # corroborated product mentions only
    tier = "Measured" if retrieval_n == n and n else "Estimated"
    return {
        "brand": brand, "domain": domain,
        "answers_scored": n, "retrieval_answers": retrieval_n,
        "share_of_voice": round(brand_hits / n, 3),
        "citation_rate": round(cited_n / n, 3),
        "brand_mentions": brand_hits, "domain_citations": cited_n,
        "ambiguous_mentions": ambiguous_n,
        "competitor_share": {c: round(h / n, 3) for c, h in comp_hits.items()},
        "context_terms": context,
        "per_answer": rows,
        "data_tier": tier,
        "note": ("share_of_voice counts only corroborated product mentions (domain cited, OR "
                 "brand token + a page-context term); brand-token hits with no context are "
                 "'ambiguous' (likely a homonym) and excluded. citation_rate counts sourced "
                 "domain citations. Tier is Measured only when every answer came from a "
                 "retrieval-capable model."),
    }


def _load(path):
    raw = sys.stdin.read() if not path or path == "-" else open(path, encoding="utf-8").read()
    return json.loads(raw)


def main(argv):
    ap = argparse.ArgumentParser(prog="geo-probe")
    ap.add_argument("--op", choices=["queries", "score"], required=True)
    ap.add_argument("--input", default=None, help="queries: seo-crawl JSON; score: answers payload (default stdin)")
    ap.add_argument("--brand", default=None)
    ap.add_argument("--domain", default=None)
    ap.add_argument("--competitors", default=None, help="comma-separated")
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)
    competitors = [c.strip() for c in (args.competitors or "").split(",") if c.strip()]

    if args.op == "queries":
        crawl_obj = _load(args.input)
        brand, domain = derive_brand_domain(crawl_obj, args.brand, args.domain)
        data = {"brand": brand, "domain": domain, "competitors": competitors,
                "context_terms": context_terms(crawl_obj, brand, domain),
                "queries": gen_queries(crawl_obj, brand, competitors)}
    else:
        payload = _load(args.input)
        if args.brand:
            payload["brand"] = args.brand
        if args.domain:
            payload["domain"] = args.domain
        if competitors:
            payload["competitors"] = competitors
        data = score_answers(payload)

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
