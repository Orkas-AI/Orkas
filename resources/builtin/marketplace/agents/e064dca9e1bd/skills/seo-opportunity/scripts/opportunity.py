"""seo-opportunity — one-shot keyword/GEO opportunity pool.

Deterministic, stdlib-only. It consumes data the agent has already collected
(seo-crawl, optional GSC/Bing query/page rows, optional geo-probe score) and
returns prioritized opportunities for the current diagnose run. It does not
persist state and therefore never emits historical decay/trend claims.
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


def _load_optional(path: str | None):
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None


def _load_required(path: str | None):
    raw = sys.stdin.read() if not path or path == "-" else open(path, encoding="utf-8").read()
    return json.loads(raw)


def _data(obj):
    return obj.get("data", obj) if isinstance(obj, dict) else obj


def _data_page(crawl_obj: dict) -> tuple[dict, dict]:
    data = _data(crawl_obj) if isinstance(crawl_obj, dict) else {}
    pages = data.get("pages") or []
    if not pages:
        raise ValueError("crawl JSON has no pages")
    return pages[0], (data.get("site") or {})


def _rows(obj) -> list[dict]:
    obj = _data(obj)
    if isinstance(obj, dict):
        rows = obj.get("rows") or []
    elif isinstance(obj, list):
        rows = obj
    else:
        rows = []
    return [r for r in rows if isinstance(r, dict)]


def _key_text(row: dict) -> str:
    keys = row.get("keys")
    if isinstance(keys, list) and keys:
        return str(keys[0])
    for k in ("query", "Query", "Keyword", "keyword"):
        if row.get(k):
            return str(row[k])
    return ""


def _page_text(row: dict) -> str:
    keys = row.get("keys")
    if isinstance(keys, list):
        for v in keys:
            sv = str(v)
            if sv.startswith("http://") or sv.startswith("https://"):
                return sv
    for k in ("page", "Page", "url", "Url"):
        if row.get(k):
            return str(row[k])
    return ""


def _num(row: dict, *keys, default=0.0) -> float:
    for k in keys:
        v = row.get(k)
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            try:
                return float(v)
            except ValueError:
                pass
    return float(default)


def _ctr(row: dict, clicks: float, imps: float) -> float:
    v = row.get("ctr")
    if isinstance(v, (int, float)):
        return float(v)
    return clicks / imps if imps > 0 else 0.0


def _priority(score: int) -> str:
    return "High" if score >= 75 else "Medium" if score >= 50 else "Low"


def _intent_value(query: str) -> int:
    q = query.lower()
    if any(w in q for w in ("alternative", "vs", "compare", "pricing", "best", "tool", "software", "assistant")):
        return 90
    if any(w in q for w in ("how", "what", "guide", "tutorial", "example")):
        return 65
    return 50


def _geo_relevance(query: str) -> int:
    q = query.lower()
    if any(w in q for w in ("best", "alternative", "vs", "compare", "recommend", "tool", "software", "agent", "assistant")):
        return 90
    if any(w in q for w in ("how", "what", "why")):
        return 65
    return 40


def _traffic_potential(impressions: float) -> int:
    if impressions >= 1000:
        return 95
    if impressions >= 300:
        return 80
    if impressions >= 100:
        return 65
    if impressions >= 30:
        return 45
    return 25


def _quick_win_likelihood(position: float | None) -> int:
    if position is None or position <= 0:
        return 35
    if 8 <= position <= 20:
        return 95
    if 4 <= position < 8:
        return 65
    if 21 <= position <= 40:
        return 50
    if position <= 3:
        return 25
    return 20


def _score(query: str, impressions: float, position: float | None, confidence: int) -> int:
    score = (
        _traffic_potential(impressions) * 0.30
        + _intent_value(query) * 0.25
        + _quick_win_likelihood(position) * 0.20
        + _geo_relevance(query) * 0.15
        + confidence * 0.10
    )
    return int(round(max(0, min(100, score))))


def _signal(position: float | None, impressions: float, clicks: float, ctr: float) -> str:
    bits = []
    if position is not None and position > 0:
        bits.append("position {:.1f}".format(position))
    if impressions:
        bits.append("{} impressions".format(int(round(impressions))))
    if clicks:
        bits.append("{} clicks".format(int(round(clicks))))
    if impressions:
        bits.append("CTR {:.1f}%".format(ctr * 100))
    return ", ".join(bits) if bits else "measured query signal"


def _target_page(row: dict, fallback_url: str) -> str:
    return _page_text(row) or fallback_url


def _mk(query, typ, source, tier, page_url, signal, score, confidence, action, lead, fail):
    return {
        "query": query,
        "type": typ,
        "source": source,
        "data_tier": tier,
        "target_page_url": page_url,
        "current_signal": signal,
        "priority_score": score,
        "priority": _priority(score),
        "confidence": confidence,
        "recommended_action": action,
        "leading_indicator": lead,
        "failure_criterion": fail,
    }


def _console_opportunities(rows: list[dict], source: str, fallback_url: str) -> list[dict]:
    out = []
    by_query: dict[str, list[dict]] = {}
    for row in rows:
        q = _key_text(row).strip()
        if not q:
            continue
        by_query.setdefault(q.lower(), []).append(row)
        imps = _num(row, "impressions", "Impressions")
        clicks = _num(row, "clicks", "Clicks")
        pos = _num(row, "position", "Position", "AvgImpressionPosition", "AvgClickPosition", default=0.0)
        pos_val = pos if pos > 0 else None
        ctr = _ctr(row, clicks, imps)
        if imps < 20:
            continue
        score = _score(q, imps, pos_val, 90)
        page_url = _target_page(row, fallback_url)
        if pos_val is not None and 8 <= pos_val <= 20:
            out.append(_mk(
                q, "quick_win", source, "Measured", page_url, _signal(pos_val, imps, clicks, ctr),
                score, "High",
                "Improve the target page's title/meta, answer-first opening, internal links and schema for this query.",
                "CTR improves by 20% or average position enters the top 8 within 30 days.",
                "CTR and average position stay flat after 30 days.",
            ))
        elif imps >= 100 and ctr < 0.02 and (pos_val is None or pos_val <= 20):
            out.append(_mk(
                q, "ctr_gap", source, "Measured", page_url, _signal(pos_val, imps, clicks, ctr),
                score, "High",
                "Rewrite the SERP snippet: title, meta description and first visible answer should state the concrete value.",
                "CTR improves by 20% within 30 days while impressions remain stable.",
                "CTR remains below 2% with similar impressions.",
            ))
    for q, qrows in by_query.items():
        # Cannibalization needs ≥2 DISTINCT real pages. Use _page_text (no
        # fallback): a query-dimensioned row carries no page, so falling back to
        # the crawl URL here would phantom a "second page" and falsely flag a
        # query that simply appears in both the query and page exports.
        pages = sorted({_page_text(r) for r in qrows if _page_text(r)})
        if len(pages) >= 2:
            imps = sum(_num(r, "impressions", "Impressions") for r in qrows)
            clicks = sum(_num(r, "clicks", "Clicks") for r in qrows)
            score = _score(q, imps, None, 85)
            out.append(_mk(
                q, "cannibalization", source, "Measured", pages[0],
                "{} pages receive signal for this query: {}".format(len(pages), ", ".join(pages[:3])),
                score, "Medium",
                "Choose the canonical target page, consolidate overlapping intent, and point internal links at that page.",
                "One primary page owns most impressions/clicks for the query.",
                "Multiple pages keep splitting the same query intent.",
            ))
    return out


def _topic_terms(page: dict, limit=4) -> list[str]:
    text = " ".join([page.get("title") or ""] + (page.get("h1s") or []) + [page.get("first_paragraph") or ""])
    seen, terms = set(), []
    for w in _WORD_RE.findall(text.lower()):
        if len(w) > 3 and w not in _STOP and w not in seen:
            seen.add(w)
            terms.append(w)
        if len(terms) >= limit:
            break
    return terms


def _inferred_opportunities(page: dict, existing_queries: set[str]) -> list[dict]:
    terms = _topic_terms(page)
    if not terms:
        return []
    page_url = page.get("url") or page.get("final_url") or ""
    title = page.get("title") or page_url
    topic = " ".join(terms[:2])
    queries = [
        "{} guide".format(topic),
        "best {} tools".format(topic),
    ]
    out = []
    for q in queries:
        if q.lower() in existing_queries:
            continue
        score = _score(q, 0, None, 35)
        out.append(_mk(
            q, "content_gap", "inferred", "Estimated", page_url,
            "inferred from page title/H1/topic: {}".format(title[:120]),
            score, "Low",
            "Validate demand in Search Console/Bing or SERP research; if relevant, add a dedicated answer-first section or page.",
            "The query appears in console data or starts receiving impressions after publication.",
            "No measured impressions or citations appear after the observation window.",
        ))
    return out


def _geo_gap_opportunities(geo_obj, fallback_url: str) -> list[dict]:
    d = _data(geo_obj) if geo_obj else {}
    rows = d.get("per_answer") or []
    if not rows:
        return []
    brand = d.get("brand") or "target brand"
    comp = d.get("competitor_share") or {}
    top_comp = None
    if comp:
        top_comp = max(comp.items(), key=lambda kv: kv[1])[0]
    out = []
    for row in rows:
        result = row.get("result")
        q = row.get("query") or "GEO prompt"
        if result == "absent" or (result == "mentioned" and not row.get("domain_cited")):
            signal = "{} was {}; top competitor: {}".format(brand, result, top_comp or "n/a")
            score = _score(q, 0, None, 55 if result == "absent" else 60)
            out.append(_mk(
                q, "geo_gap", "geo-probe", d.get("data_tier", "Estimated"), fallback_url,
                signal, score, "Medium",
                "Add a concise quotable answer, comparison context, FAQ/schema and corroborating references for this prompt intent.",
                "Next GEO probe shows the brand cited for this prompt, not only mentioned.",
                "The prompt remains absent or uncited in the next probe.",
            ))
    return out


def build_opportunities(crawl_obj: dict, gsc=None, gsc_pages=None, bing=None, bing_pages=None,
                        geo_probe=None, limit: int = 12) -> dict:
    page, _site = _data_page(crawl_obj)
    fallback_url = page.get("url") or page.get("final_url") or ""
    opportunities = []
    opportunities.extend(_console_opportunities(_rows(gsc) + _rows(gsc_pages), "gsc", fallback_url))
    opportunities.extend(_console_opportunities(_rows(bing) + _rows(bing_pages), "bing", fallback_url))
    existing = {o["query"].lower() for o in opportunities}
    opportunities.extend(_geo_gap_opportunities(geo_probe, fallback_url))
    existing |= {o["query"].lower() for o in opportunities}
    opportunities.extend(_inferred_opportunities(page, existing))

    # De-dupe by query+type+source, keep the highest score.
    dedup = {}
    for o in opportunities:
        key = (o["query"].lower(), o["type"], o["source"])
        if key not in dedup or o["priority_score"] > dedup[key]["priority_score"]:
            dedup[key] = o
    ordered = sorted(dedup.values(), key=lambda o: (-o["priority_score"], o["query"]))[:limit]
    measured = sum(1 for o in ordered if o.get("data_tier") == "Measured")
    return {
        "summary": {"total": len(ordered), "measured": measured, "estimated": len(ordered) - measured},
        "opportunities": ordered,
    }


def main(argv):
    ap = argparse.ArgumentParser(prog="seo-opportunity")
    ap.add_argument("--crawl", default=None, help="seo-crawl JSON (default stdin)")
    ap.add_argument("--gsc", default=None, help="GSC query rows JSON")
    ap.add_argument("--gsc-pages", default=None, help="GSC page rows JSON")
    ap.add_argument("--bing", default=None, help="Bing query rows JSON")
    ap.add_argument("--bing-pages", default=None, help="Bing page rows JSON")
    ap.add_argument("--geo-probe", default=None, help="geo-probe score JSON")
    ap.add_argument("--limit", type=int, default=12)
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)
    data = build_opportunities(
        _load_required(args.crawl),
        gsc=_load_optional(args.gsc),
        gsc_pages=_load_optional(args.gsc_pages),
        bing=_load_optional(args.bing),
        bing_pages=_load_optional(args.bing_pages),
        geo_probe=_load_optional(args.geo_probe),
        limit=args.limit,
    )
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
