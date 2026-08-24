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


# Acronyms whose bare form means different things in different industries, so an
# answer engine may answer for the wrong one. Only these get expanded; spelling
# out a universally-read acronym ("Artificial Intelligence voice tools") is a
# phrasing no real user searches.
AMBIGUOUS_ACRONYMS = (
    ("AEO", "Answer Engine Optimization"),
    ("GEO", "Generative Engine Optimization"),
    ("CRO", "Conversion Rate Optimization"),
    ("CDP", "Customer Data Platform"),
    ("CRM", "Customer Relationship Management"),
    ("ERP", "Enterprise Resource Planning"),
)

_COMPARISON_RE = re.compile(r"\b(vs\.?|versus|alternatives?|compared to|better than|instead of)\b", re.I)
_AI_CHANNEL_RE = re.compile(
    r"\b(chatgpt|gemini|claude|perplexity|copilot|llama|grok|mistral|bard|openai|gpt-?[34-9])\b", re.I)
# Segment words that make a vendor-listing query specific enough to track. Read
# from the page so we never invent an industry the site has no product for.
_SEGMENT_RE = re.compile(
    r"\b(teams?|developers?|designers?|startups?|agencies|enterprises?|marketers?|"
    r"founders?|students?|researchers?|writers?|creators?|analysts?|small business(?:es)?)\b", re.I)

QUERY_KINDS = ("unbranded", "branded")


def _segment_terms(page: dict, limit: int = 2) -> list[str]:
    text = " ".join([page.get("title") or ""] + (page.get("h1s") or [])
                    + (page.get("h2s") or []) + [page.get("first_paragraph") or ""])
    out, seen = [], set()
    for m in _SEGMENT_RE.finditer(text):
        w = m.group(0).lower()
        if w not in seen:
            seen.add(w)
            out.append(w)
        if len(out) >= limit:
            break
    return out


def _topic_terms_excluding_brand(page: dict, brand: str, domain: str, limit: int = 3) -> list[str]:
    """Topic words with the brand and domain core removed.

    `_topic_terms` reads the title and H1, which is exactly where a brand name
    lives — so the naive topic for "Orkas — multi-agent desktop app" is
    "orkas multi-agent", and every "unbranded" query built from it silently
    carries the brand. Caught by smoke-testing the generator before its tests.
    """
    drop = set(_WORD_RE.findall((brand or "").lower()))
    core = re.sub(r"\.[a-z]{2,}$", "", (domain or "").lower())
    drop |= set(_WORD_RE.findall(core))
    text = " ".join([page.get("title") or ""] + (page.get("h1s") or []))
    seen, terms = set(), []
    for w in _WORD_RE.findall(text.lower()):
        if len(w) > 3 and w not in _STOP and w not in drop and w not in seen:
            seen.add(w)
            terms.append(w)
        if len(terms) >= limit:
            break
    return terms


def _current_year_hint() -> str:
    """Recency marker, as a literal year string. Probe queries are a snapshot and
    carry no other time state."""
    import datetime
    return str(datetime.date.today().year)


def filter_candidates(candidates, brand: str, domain: str) -> dict:
    """Validate probe queries, naming a reason for every drop.

    The generator below is deterministic and narrow on purpose. When the agent
    produces richer candidates from a model, they clear the same bar — and a
    silently dropped candidate is how a probe set quietly becomes branded again.
    """
    kept, rejected, seen = [], [], set()
    brand_l = (brand or "").lower().strip()
    core = re.sub(r"\.[a-z]{2,}$", "", (domain or "").lower().strip())

    for cand in candidates or []:
        text = (cand.get("query") if isinstance(cand, dict) else cand) or ""
        text = str(text).strip()
        if not text:
            rejected.append({"query": text, "reason": "empty"})
            continue
        low = text.lower()

        if brand_l and brand_l in low:
            rejected.append({"query": text, "reason": 'contains brand "{}"'.format(brand)})
            continue
        if core and len(core) >= 4 and core in low:
            rejected.append({"query": text, "reason": 'contains domain core "{}"'.format(core)})
            continue
        if low in seen:
            rejected.append({"query": text, "reason": "duplicate"})
            continue
        seen.add(low)

        wc = len(text.split())
        if wc < 3:
            rejected.append({"query": text, "reason": "too short ({} words)".format(wc)})
            continue
        if wc > 12:
            rejected.append({"query": text, "reason": "too long ({} words)".format(wc)})
            continue

        bare = None
        for abbr, expansion in AMBIGUOUS_ACRONYMS:
            if re.search(r"\b{}\b".format(abbr), text, re.I) and expansion.lower() not in low:
                bare = (abbr, expansion)
                break
        if bare:
            rejected.append({"query": text, "reason": 'bare "{}" without "{}"'.format(*bare)})
            continue

        if _COMPARISON_RE.search(text) and _AI_CHANNEL_RE.search(text):
            rejected.append({"query": text, "reason": "compares AI answer engines, not vendors"})
            continue

        kept.append({"query": text, "kind": "unbranded", "intent": "commercial"})

    return {"kept": kept, "rejected": rejected}


def gen_queries(crawl_obj: dict, brand: str, competitors: list[str], domain: str = "") -> list[dict]:
    """Build the probe set, unbranded first.

    A branded query cannot measure GEO visibility: asked "What is <brand>?", a
    model names the brand by construction, so every such row scores a hit and
    inflates share of voice. The question worth answering is whether the brand
    is named at all in the unbranded vendor-listing queries a buyer types.
    Branded rows stay as a labelled CONTROL — if they miss too, the problem is
    entity recognition, not competitive position.

    Returns `{query, kind, intent}` rows; `kind` drives the split in
    `score_answers`.
    """
    page, _ = _data_page(crawl_obj)
    domain = domain or (urlsplit(page.get("url") or "").hostname or "")
    terms = _topic_terms_excluding_brand(page, brand, domain)
    topic = " ".join(terms[:2]) if terms else "this category"
    segments = _segment_terms(page)

    unbranded = [
        "best {} tools".format(topic),
        "top {} software {}".format(topic, _current_year_hint()),
    ]
    for seg in segments:
        unbranded.append("best {} tools for {}".format(topic, seg))
    if competitors:
        # Vendor-vs-vendor, not brand-vs-vendor: a query a buyer runs before
        # they know our brand exists. "best" prefix clears the 3-word floor —
        # bare "<competitor> alternatives" is a real query but the filter reads
        # two words as an under-specified head term.
        unbranded.append("best {} alternatives".format(competitors[0]))

    # Generated rows clear the same bar as agent-supplied ones. Labelling a row
    # `unbranded` is not the same as it being unbranded, and that difference is
    # exactly the bias this change removes.
    kept = filter_candidates(unbranded, brand, domain)["kept"]

    branded = ["What is {}?".format(brand), "{} review — is it any good?".format(brand)]
    if competitors:
        branded.append("{} vs {}".format(brand, competitors[0]))

    rows, seen = [], set()
    for row in kept:
        k = row["query"].lower()
        if k not in seen:
            seen.add(k)
            rows.append(row)
    for q in branded:
        k = q.lower()
        if k not in seen:
            seen.add(k)
            rows.append({"query": q, "kind": "branded", "intent": "control"})
    return rows


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
                     "kind": _answer_kind(a, brand),
                     "brand_token_present": bool(m_brand), "domain_cited": bool(m_dom),
                     "context_corroborated": (bool(corroborated) if context else None),
                     "result": kind})

    n = len(answers)
    brand_hits = cited_n + mentioned_n  # corroborated product mentions only
    tier = "Measured" if retrieval_n == n and n else "Estimated"
    unbranded = _subset_metrics(rows, "unbranded")
    branded = _subset_metrics(rows, "branded")
    return {
        "brand": brand, "domain": domain,
        "answers_scored": n, "retrieval_answers": retrieval_n,
        # Headline metric: unbranded only. A branded query names the brand by
        # construction, so averaging it in reports competitive position the probe
        # never tested. Falls back to the whole set only when the probe carried no
        # unbranded row at all, and says so in `share_of_voice_basis`.
        "share_of_voice": (unbranded["share_of_voice"] if unbranded["answers"]
                           else round(brand_hits / n, 3)),
        "share_of_voice_basis": ("unbranded" if unbranded["answers"]
                                 else "all_answers_no_unbranded_probe"),
        "unbranded": unbranded,
        "branded_control": branded,
        "share_of_voice_all_answers": round(brand_hits / n, 3),
        "citation_rate": round(cited_n / n, 3),
        "brand_mentions": brand_hits, "domain_citations": cited_n,
        "ambiguous_mentions": ambiguous_n,
        "competitor_share": {c: round(h / n, 3) for c, h in comp_hits.items()},
        "context_terms": context,
        "per_answer": rows,
        "data_tier": tier,
        "note": ("share_of_voice is measured over UNBRANDED probe rows only — a branded query "
                 "names the brand by construction and cannot show competitive position; branded "
                 "rows are reported separately as a control (if they miss too, the gap is entity "
                 "recognition, not competition). A hit counts only as a corroborated product "
                 "mention (domain cited, OR brand token + a page-context term); brand-token hits "
                 "with no context are 'ambiguous' (likely a homonym) and excluded. citation_rate "
                 "counts sourced domain citations. Tier is Measured only when every answer came "
                 "from a retrieval-capable model."),
    }


def _answer_kind(answer: dict, brand: str) -> str:
    """Classify a scored answer's query. `kind` from the probe set wins; a payload
    predating it (or hand-assembled) is classified by whether the query names the
    brand, so an old answers file still gets an honest split."""
    kind = str(answer.get("kind") or "").lower()
    if kind in QUERY_KINDS:
        return kind
    q = str(answer.get("query") or "")
    return "branded" if (brand and _mentions(q, brand)) else "unbranded"


def _subset_metrics(rows: list[dict], kind: str) -> dict:
    subset = [r for r in rows if r.get("kind") == kind]
    n = len(subset)
    if not n:
        return {"answers": 0, "share_of_voice": 0.0, "citation_rate": 0.0}
    hits = sum(1 for r in subset if r["result"] in ("cited", "mentioned"))
    cited = sum(1 for r in subset if r["result"] == "cited")
    return {"answers": n, "share_of_voice": round(hits / n, 3),
            "citation_rate": round(cited / n, 3)}


def _load(path):
    raw = sys.stdin.read() if not path or path == "-" else open(path, encoding="utf-8").read()
    return json.loads(raw)


def main(argv):
    ap = argparse.ArgumentParser(prog="geo-probe")
    ap.add_argument("--op", choices=["queries", "filter", "score"], required=True)
    ap.add_argument("--input", default=None,
                    help="queries: seo-crawl JSON; filter: {brand,domain,candidates[]}; "
                         "score: answers payload (default stdin)")
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
                "queries": gen_queries(crawl_obj, brand, competitors, domain)}
    elif args.op == "filter":
        payload = _load(args.input)
        brand = args.brand or payload.get("brand") or ""
        domain = args.domain or payload.get("domain") or ""
        res = filter_candidates(payload.get("candidates") or payload.get("queries"), brand, domain)
        data = {"brand": brand, "domain": domain, **res,
                "note": ("Every drop names its reason. A candidate set that silently loses its "
                         "unbranded rows is how a probe set becomes branded again.")}
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
