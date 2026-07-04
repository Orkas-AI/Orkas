"""geo-score — platform-agnostic GEO (Generative Engine Optimization) score.

stdlib only. Pure-function core (`score_geo`) over the seo-crawl page. Produces
a 5-dimension weighted GEO score, an entity-resolution status, and ranked
recommendations — kept SEPARATE from the SEO health score (the design plan
treats GEO as its own facet). No network.

Dimensions (weights): Citability 25 · Structure 20 · Multimodal 15 ·
Authority&Brand 20 · Technical-access 20. Signals are crawl facts (answer-first,
heading hierarchy, alt coverage, JSON-LD Organization+sameAs, indexability,
HTTPS, raw-HTML content, AI-crawler reachability via robots.txt).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from urllib.parse import urlsplit

_WEIGHTS = {"citability": 0.25, "structure": 0.20, "multimodal": 0.15,
            "authority": 0.20, "technical": 0.20}
_AI_BOTS = ("GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot",
            "Claude-User", "PerplexityBot", "Perplexity-User", "Google-Extended", "CCBot")


def _data_page(crawl_obj: dict) -> tuple[dict, dict]:
    data = crawl_obj.get("data", crawl_obj) if isinstance(crawl_obj, dict) else {}
    pages = data.get("pages") or []
    if not pages:
        raise ValueError("crawl JSON has no pages")
    return pages[0], (data.get("site") or {})


def _sd_nodes(structured_data):
    out = []
    for block in structured_data or []:
        items = block if isinstance(block, list) else [block]
        for it in items:
            if isinstance(it, dict):
                if isinstance(it.get("@graph"), list):
                    out.extend(n for n in it["@graph"] if isinstance(n, dict))
                else:
                    out.append(it)
    return out


def _robots_blocks_ai(robots_text: str) -> list[str]:
    """Return the AI/crawler user-agents that robots.txt disallows at root.
    Light parser: track the current User-agent group and any 'Disallow: /'."""
    blocked = []
    if not robots_text:
        return blocked
    cur = []
    prev_was_ua = False
    for raw in robots_text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        k, _, v = line.partition(":")
        k = k.strip().lower(); v = v.strip()
        if k == "user-agent":
            # Consecutive User-agent lines share one group; a User-agent that
            # follows a rule line starts a new group. Resetting on every line
            # dropped all but the last agent of a stacked group.
            if not prev_was_ua:
                cur = []
            cur.append(v)
            prev_was_ua = True
            continue
        prev_was_ua = False
        if k == "disallow" and v == "/":
            for ua in cur:
                if ua == "*" or ua in _AI_BOTS:
                    blocked.append(ua)
    return sorted(set(blocked))


def score_geo(crawl_obj: dict) -> dict:
    page, site = _data_page(crawl_obj)
    dims = {k: 100 for k in _WEIGHTS}
    recs: list[dict] = []

    def deduct(dim, amount, title, evidence, rec, lead, fail, tier="Measured"):
        dims[dim] = max(0, dims[dim] - amount)
        recs.append({"dimension": "geo:" + dim, "title": title, "evidence": evidence,
                     "recommendation": rec, "leading_indicator": lead,
                     "failure_criterion": fail, "data_tier": tier})

    first = (page.get("first_paragraph") or "").strip()
    wc = page.get("word_count", 0)
    # ── Citability ──
    if len(first) < 60:
        deduct("citability", 40, "No extractable answer up top",
               "opening paragraph {} chars".format(len(first)),
               "Open with a 1–2 sentence direct answer in the first 30% (answer-first).",
               "opening carries a quotable direct answer", "answer still buried", tier="Estimated")
    if wc and wc < 300:
        deduct("citability", 20, "Thin body weakens citability",
               "{} words".format(wc), "Add substantive, original, quotable content.",
               "word count grows with quotable facts", "still thin")

    # ── Structure ──
    if page.get("h1_count", 0) != 1:
        deduct("structure", 30, "Heading structure unclear",
               "{} H1 elements".format(page.get("h1_count", 0)),
               "Use exactly one H1 and a logical H2/H3 outline so engines can segment answers.",
               "single H1 + clean outline on recrawl", "structure still unclear")
    order = page.get("heading_order") or []
    prev = 0
    for lvl in order:
        if prev and lvl - prev > 1:
            deduct("structure", 20, "Heading levels skip", "order {}".format(order),
                   "Don't jump heading levels; keep a parseable hierarchy.",
                   "no level jumps on recrawl", "still skipping")
            break
        prev = lvl
    if not any(l == 2 for l in order):
        deduct("structure", 20, "No H2 sub-sections",
               "no H2 headings", "Break the page into H2 sub-sections that map to sub-questions.",
               "H2 sections present", "still a flat page")

    # ── Multimodal ──
    if page.get("images_total", 0) == 0:
        deduct("multimodal", 30, "No images/diagrams",
               "0 images", "Add relevant diagrams/screenshots with descriptive alt (multimodal citation).",
               "captioned visuals present", "still text-only", tier="Estimated")
    if page.get("images_missing_alt", 0) > 0:
        deduct("multimodal", 30, "Images missing alt text",
               "{} images lack alt".format(page.get("images_missing_alt")),
               "Add descriptive alt so engines can read the visuals.",
               "alt coverage 100%", "alt still missing")

    # ── Authority & brand (entity resolution) ──
    nodes = _sd_nodes(page.get("structured_data"))
    types = page.get("structured_data_types") or []
    has_org = "Organization" in types
    has_sameas = any(n.get("sameAs") for n in nodes)
    if not has_org:
        deduct("authority", 30, "No Organization entity",
               "no Organization JSON-LD", "Add Organization JSON-LD so the brand is a resolvable entity.",
               "Organization present + recognized", "brand still unresolved")
    if not has_sameas:
        deduct("authority", 20, "No sameAs brand links",
               "no sameAs in JSON-LD",
               "Add sameAs links (Wikidata/Wikipedia/Crunchbase/GitHub/social) to resolve the entity.",
               "sameAs present; entity recognized in Knowledge Graph", "entity still ambiguous", tier="Estimated")
    if page.get("external_link_count", 0) == 0:
        deduct("authority", 20, "No outbound citations",
               "0 external links", "Cite authoritative sources; corroboration raises citability.",
               "outbound citations present", "still no citations")
    entity_status = "recognized" if (has_org and has_sameas) else "partial" if has_org else "unrecognized"

    # ── Technical access ──
    if not page.get("is_indexable", True):
        deduct("technical", 50, "Page not indexable",
               "is_indexable=false", "Make the page indexable (200 + no noindex); unindexable pages aren't cited.",
               "page indexable on recrawl", "still blocked")
    if not page.get("https"):
        deduct("technical", 20, "Not HTTPS", "scheme http", "Serve over HTTPS.",
               "https on recrawl", "still http")
    if wc == 0:
        deduct("technical", 30, "No content in raw HTML",
               "0 words in static fetch",
               "Server-render the citation-critical content; AI crawlers read raw HTML, not JS.",
               "content present in raw HTML", "still JS-only", tier="Estimated")
    blocked = _robots_blocks_ai(site.get("robots", {}).get("text", ""))
    if blocked:
        deduct("technical", 20, "robots.txt blocks AI crawlers",
               "Disallow / for {}".format(", ".join(blocked)),
               "Allow AI-search crawlers (or specific bots) in robots.txt if you want citations.",
               "AI bots allowed on recrawl", "still disallowed")

    geo_score = round(sum(dims[k] * w for k, w in _WEIGHTS.items()))
    return {
        "geo_score": geo_score,
        "geo_dimensions": dims,
        "entity_status": entity_status,
        "geo_recommendations": recs,
        "meta": {"url": page.get("url"), "entity_status": entity_status},
    }


def _load(path):
    raw = sys.stdin.read() if not path or path == "-" else open(path, encoding="utf-8").read()
    return json.loads(raw)


def main(argv):
    ap = argparse.ArgumentParser(prog="geo-score")
    ap.add_argument("--input", default=None, help="seo-crawl JSON (default stdin)")
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)
    result = {"ok": True, "data": score_geo(_load(args.input))}
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
