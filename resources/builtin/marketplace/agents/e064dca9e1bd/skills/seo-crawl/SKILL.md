---
ownerAgent: e064dca9e1bd
name: seo-crawl
description_zh: "抓取一个 URL 并抽取 on-page SEO/GEO 字段为结构化 JSON（标题/描述/canonical/标题层级/结构化数据/hreflang/图片 alt/内外链/robots 等），带 SSRF 防护与系统代理支持；适合\"抓一下这个页面的 SEO 字段\"\"取回这个站的 on-page 数据做诊断\"；触发词：抓取、采集、on-page、抓页面、crawl、页面字段"
description_en: "Fetch a URL and extract on-page SEO/GEO fields as structured JSON (title/description/canonical/heading hierarchy/structured data/hreflang/image alt/internal+external links/robots), SSRF-guarded and system-proxy aware; For: 'grab this page's SEO fields', 'pull on-page data for diagnosis'; Triggers: crawl, fetch page, on-page, scrape page, extract fields"
category: data
---

# seo-crawl

Fetch one URL and return the raw on-page signals the SEO/GEO audits consume. This is the data-acquisition step: it does NOT score or judge — it extracts facts.

## When to use

- The diagnose flow needs the on-page facts for a target URL before any audit runs.
- You need the site's `robots.txt` + declared sitemaps alongside the page.
- Re-crawling a localhost / preview URL to re-test after an edit (the "apply → re-test" loop).

## When NOT to use

- Scoring, bucketing, or producing findings — that is the technical/content/GEO audit step (this skill only extracts).
- Multi-page site crawling at scale — this fetches the single given URL (+ its origin `robots.txt`). Breadth-first crawl is a separate concern.
- Rendering JavaScript-built DOM — this reads the raw HTML as AI-citation crawlers do; client-rendered content is intentionally out of scope.

## Preconditions

- Network access to the target. Honors `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`; in fake-ip proxy environments (Clash/Surge) a configured proxy is required because direct DNS returns reserved 198.18.0.0/15 addresses.
- Python 3.9+ (stdlib only — no third-party packages).
- Safety: scheme is restricted to http/https; the host is checked against private/loopback/link-local/cloud-metadata ranges and obfuscated-IP forms; on the direct path the connection is pinned to a validated public IP and every redirect hop is re-validated.

## How to call

```
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" seo-crawl crawl -- <url> [--timeout 20] [--user-agent "<ua>"] [--no-robots]
```

- `<url>` (required): absolute http(s) URL.
- `--timeout` seconds per request (default 20).
- `--user-agent` override the crawler UA.
- `--no-robots` skip the site-level `robots.txt` fetch.

## Expected output

JSON on stdout. Success:

```json
{ "ok": true, "data": {
  "site": { "origin": "https://example.com", "fetched_at": "...Z",
            "robots": { "exists": true, "status": 200, "sitemaps": ["https://example.com/sitemap.xml"], "text": "…" } },
  "pages": [ {
    "url": "...", "final_url": "...", "status_code": 200, "redirect_chain": [],
    "response_time_ms": 0, "https": true, "lang": "en", "charset": "utf-8",
    "title": "...", "title_length": 0, "meta_description": "...", "meta_robots": null, "canonical": "...",
    "og_title": "...", "og_description": "...", "og_image": "...", "twitter_card": "...", "viewport": "...",
    "h1s": ["..."], "h1_count": 1, "h2_count": 0, "heading_order": [1,2,2,3],
    "word_count": 0, "images_total": 0, "images_missing_alt": 0, "images": [{"src":"...","alt":null}],
    "internal_link_count": 0, "external_link_count": 0, "internal_links": ["..."], "external_links": ["..."],
    "has_structured_data": true, "structured_data_types": ["Organization"], "structured_data": [ {} ],
    "hreflang_tags": [ {"hreflang":"zh","href":"..."} ],
    "is_indexable": true, "noindex": false, "first_paragraph": "..."
  } ]
} }
```

Failure: `{"ok": false, "error": "<reason>"}` on stderr with a non-zero exit (blocked scheme, non-public host / SSRF guard, DNS failure, too many redirects, network timeout).

## Notes

- `is_indexable` is derived (HTTP 200 AND no `noindex` in meta robots). Canonical-mismatch and header-level `X-Robots-Tag` indexability are judged by the technical audit, not here.
- `structured_data` is the parsed JSON-LD objects (capped); invalid JSON-LD blocks are skipped, not error.
- Link lists are origin-split, de-duplicated, and capped; `#fragment` / `mailto:` / `tel:` / `javascript:` are excluded.
