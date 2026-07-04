"""seo-tech-audit — technical SEO findings + health score from seo-crawl JSON.

stdlib only. Pure-function core (`audit`) for unit testing; the CLI reads the
crawl JSON from --input (or stdin) and emits the audit JSON.

Every finding carries evidence (Measured from the crawl), a recommendation, a
leading_indicator (the metric that should move if the fix works) and a
failure_criterion (how we know it did NOT) — the falsifiable framework from the
design plan. No external calls; this layer only judges crawl facts.
"""

from __future__ import annotations

import argparse
import json
import sys
from urllib.parse import urlsplit

# severity → health-score weight (deducted from 100)
_WEIGHT = {"critical": 25, "high": 12, "medium": 6, "low": 2}

# which dimension each check belongs to (for per-dimension subscores)
_DIMENSIONS = ("security", "indexability", "content_meta", "structure",
               "schema", "i18n", "media", "mobile", "crawlability")


def _norm_url(u: str) -> str:
    if not u:
        return ""
    s = urlsplit(u.strip())
    host = (s.hostname or "").lower()
    path = (s.path or "/").rstrip("/") or "/"
    port = "" if (not s.port or s.port in (80, 443)) else ":%d" % s.port
    return "{}://{}{}{}".format(s.scheme.lower(), host, port, path)


def _page_of(crawl_obj: dict) -> tuple[dict, dict]:
    data = crawl_obj.get("data", crawl_obj) if isinstance(crawl_obj, dict) else {}
    pages = data.get("pages") or []
    if not pages:
        raise ValueError("crawl JSON has no pages")
    return pages[0], (data.get("site") or {})


def audit(crawl_obj: dict) -> dict:
    page, site = _page_of(crawl_obj)
    findings: list[dict] = []

    def add(fid, dim, sev, title, evidence, rec, lead, fail):
        findings.append({
            "id": fid, "dimension": dim, "severity": sev, "title": title,
            "evidence": evidence, "recommendation": rec,
            "leading_indicator": lead, "failure_criterion": fail,
            "data_tier": "Measured",
        })

    status = page.get("status_code")
    title = (page.get("title") or "").strip()
    tlen = page.get("title_length", len(title))
    desc = page.get("meta_description")
    h1c = page.get("h1_count", 0)
    order = page.get("heading_order") or []

    # ── security ──
    if not page.get("https"):
        add("not_https", "security", "critical", "Page is not served over HTTPS",
            "scheme is http for {}".format(page.get("url")),
            "Serve the page over HTTPS and redirect http→https.",
            "page loads over https on recrawl; mixed-content warnings gone",
            "recrawl still reports https=false")

    # ── indexability ──
    if isinstance(status, int) and status >= 500:
        add("server_error", "indexability", "critical", "Server error response",
            "HTTP {}".format(status), "Fix the server error so crawlers receive 200.",
            "recrawl returns 200", "recrawl still returns 5xx")
    elif isinstance(status, int) and status >= 400:
        add("client_error", "indexability", "critical", "Page returns a client error",
            "HTTP {}".format(status), "Restore the page or fix the broken route; return 200 for live URLs.",
            "recrawl returns 200", "recrawl still returns 4xx")
    if page.get("noindex"):
        add("noindex", "indexability", "critical", "Page is marked noindex",
            "meta robots = {!r}".format(page.get("meta_robots")),
            "Remove the noindex directive if this page should rank.",
            "meta robots no longer contains noindex; page eligible for indexing",
            "recrawl still shows noindex")
    canon = page.get("canonical")
    if not canon:
        add("canonical_missing", "indexability", "low", "No canonical URL declared",
            "no <link rel=canonical>",
            "Add a self-referential canonical to consolidate signals.",
            "self-canonical present on recrawl", "recrawl still has no canonical")
    elif _norm_url(canon) != _norm_url(page.get("final_url") or page.get("url") or ""):
        add("canonical_elsewhere", "indexability", "high", "Canonical points to a different URL",
            "canonical={} but page={}".format(canon, page.get("final_url") or page.get("url")),
            "Confirm this is intentional; an unintended cross-URL canonical deindexes this page.",
            "canonical resolves to this URL (or the intended target is confirmed)",
            "canonical still points away and this page loses impressions")

    # ── content_meta ──
    if not title:
        add("title_missing", "content_meta", "critical", "Missing <title>",
            "title is empty", "Write a descriptive <title> naming the page's primary topic.",
            "non-empty <title> on recrawl; impressions for the primary query start within 2–4 weeks",
            "recrawl still empty, or impressions flat after 4 weeks")
    else:
        if tlen > 60:
            add("title_long", "content_meta", "low", "Title may truncate in results",
                "title length {} chars".format(tlen), "Tighten to ~50–60 characters.",
                "title ≤60 chars on recrawl", "title still >60 chars")
        elif tlen < 15:
            add("title_short", "content_meta", "low", "Title is very short",
                "title length {} chars".format(tlen), "Expand to describe the page topic.",
                "title length 15–60 on recrawl", "title still <15 chars")
    if not desc:
        add("meta_desc_missing", "content_meta", "high", "Missing meta description",
            "no meta description", "Add a 50–160 char description that reads well as a snippet.",
            "meta description present; SERP CTR for the page improves",
            "recrawl still missing, or CTR unchanged after 4 weeks")
    else:
        dlen = len(desc)
        if dlen > 165:
            add("meta_desc_long", "content_meta", "low", "Meta description may truncate",
                "description length {} chars".format(dlen), "Trim to ~150–160 characters.",
                "description ≤160 on recrawl", "description still >165")
        elif dlen < 50:
            add("meta_desc_short", "content_meta", "low", "Meta description is very short",
                "description length {} chars".format(dlen), "Expand to ~120–160 characters.",
                "description 50–160 on recrawl", "description still <50")
    if page.get("word_count", 0) < 200:
        add("thin_content", "content_meta", "medium", "Thin page content",
            "{} words of visible text".format(page.get("word_count", 0)),
            "Add substantive, original content; thin pages are rarely cited or ranked.",
            "word count grows and the page earns impressions/citations",
            "word count still <200 or no ranking movement after content added")

    # ── structure ──
    if h1c == 0:
        add("h1_missing", "structure", "high", "No H1 heading",
            "0 h1 elements", "Add a single descriptive H1 stating the page topic.",
            "exactly one H1 on recrawl", "recrawl still has no H1")
    elif h1c > 1:
        add("h1_multiple", "structure", "medium", "Multiple H1 headings",
            "{} h1 elements".format(h1c), "Use one H1; demote the rest to H2/H3.",
            "exactly one H1 on recrawl", "recrawl still has >1 H1")
    prev = 0
    for lvl in order:
        if prev and lvl - prev > 1:
            add("heading_skip", "structure", "medium", "Heading levels skip a level",
                "heading order {}".format(order),
                "Don't jump heading levels (e.g. H1→H3); keep a logical outline for parsers.",
                "heading order has no >1 jumps on recrawl", "recrawl still skips levels")
            break
        prev = lvl

    # ── schema ──
    if not page.get("has_structured_data"):
        add("no_structured_data", "schema", "medium", "No structured data (JSON-LD)",
            "0 JSON-LD blocks",
            "Add JSON-LD matching the visible page (Organization/WebSite/FAQPage/etc.); improves eligibility for rich results and AI citation.",
            "valid JSON-LD present; rich-result/AI-citation eligibility appears",
            "recrawl still has no structured data")

    # ── media ──
    miss = page.get("images_missing_alt", 0)
    if miss:
        add("img_alt_missing", "media", "medium", "Images missing alt text",
            "{} of {} images lack alt".format(miss, page.get("images_total", 0)),
            "Add descriptive alt text to content images (accessibility + image search).",
            "alt coverage reaches 100% on recrawl", "images still missing alt")

    # ── mobile ──
    if not page.get("viewport"):
        add("viewport_missing", "mobile", "high", "No mobile viewport meta",
            "no viewport meta tag", "Add <meta name=viewport content='width=device-width, initial-scale=1'>.",
            "viewport present on recrawl; mobile usability passes",
            "recrawl still missing viewport")

    # ── i18n ──
    if not page.get("lang"):
        add("lang_missing", "i18n", "low", "No html lang attribute",
            "<html> has no lang", "Declare the page language on <html lang=...>.",
            "lang attribute present on recrawl", "recrawl still missing lang")

    # ── crawlability (site level) ──
    robots = site.get("robots") or {}
    if robots.get("exists") is False:
        add("robots_missing", "crawlability", "low", "No robots.txt",
            "robots.txt not found at origin",
            "Add a robots.txt that allows crawling and declares the sitemap.",
            "robots.txt returns 200 on recrawl", "recrawl still 404 for robots.txt")
    elif robots.get("exists") and not robots.get("sitemaps"):
        add("sitemap_undeclared", "crawlability", "low", "Sitemap not declared in robots.txt",
            "robots.txt has no Sitemap: line",
            "Declare the sitemap URL in robots.txt so crawlers discover all pages.",
            "robots.txt lists a Sitemap on recrawl", "recrawl still has no Sitemap line")

    return _score(findings, page, site)


def _score(findings: list[dict], page: dict, site: dict) -> dict:
    dim_penalty = {d: 0 for d in _DIMENSIONS}
    counts = {"critical": 0, "high": 0, "medium": 0, "low": 0}
    total_penalty = 0
    for f in findings:
        w = _WEIGHT[f["severity"]]
        total_penalty += w
        dim_penalty[f.get("dimension", "indexability")] = dim_penalty.get(f.get("dimension"), 0) + w
        counts[f["severity"]] += 1
    health = max(0, min(100, 100 - total_penalty))
    dim_scores = {d: max(0, 100 - p) for d, p in dim_penalty.items()}
    severity_rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    findings_sorted = sorted(findings, key=lambda f: severity_rank[f["severity"]])
    return {
        "health_score": health,
        "dimension_scores": dim_scores,
        "summary": {**counts, "total": len(findings)},
        "findings": findings_sorted,
        "meta": {
            "url": page.get("url"),
            "final_url": page.get("final_url"),
            "fetched_at": site.get("fetched_at") or page.get("fetched_at"),
            "origin": site.get("origin"),
        },
    }


def _load(path: str | None) -> dict:
    raw = sys.stdin.read() if not path or path == "-" else open(path, encoding="utf-8").read()
    return json.loads(raw)


def main(argv):
    ap = argparse.ArgumentParser(prog="seo-tech-audit")
    ap.add_argument("--input", default=None, help="seo-crawl JSON file (default: stdin)")
    ap.add_argument("--out", default=None, help="also write the audit JSON here")
    args = ap.parse_args(argv)
    result = {"ok": True, "data": audit(_load(args.input))}
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
