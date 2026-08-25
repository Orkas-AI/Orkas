---
ownerAgent: e064dca9e1bd
name: seo-tech-audit
description_zh: "根据 seo-crawl 证据诊断技术 SEO，输出健康分以及可索引性、canonical、元数据、标题层级、结构化数据、图片 alt、移动端、HTTPS 和 robots 问题；用于技术 SEO 审计和问题清单，每项包含证据、领先指标和失败判据。"
description_en: "Diagnose technical SEO from seo-crawl evidence and return a health score plus findings for indexability, canonicals, metadata, headings, schema, image alt, mobile, HTTPS, and robots. Use for technical SEO audits and issue lists; each finding includes evidence and success/failure criteria."
---

# seo-tech-audit

Judge the technical SEO facts produced by `seo-crawl` and return falsifiable findings + a health score. This is pure analysis — it does no network I/O and only reasons over the crawl JSON.

## When to use

- The diagnose flow has a `seo-crawl` result and needs technical findings + a health score before writing the report.
- Re-running after an `apply` edit to confirm a finding cleared (the leading_indicator/failure_criterion drive the recheck).

## When NOT to use

- Acquiring page data — that is `seo-crawl` (this skill consumes its output).
- Content quality / E-E-A-T / GEO citability scoring — separate skills.
- Rendering the dashboard or writing the action plan — that is the report skill.

## Preconditions

- A `seo-crawl` JSON object (its `{ "data": { site, pages } }` shape, or the bare `data`).
- Python 3.9+ (stdlib only).

## How to call

```
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" seo-tech-audit audit -- --input <crawl.json> [--out <audit.json>]
```

- `--input` path to the `seo-crawl` JSON (omit or `-` to read stdin).
- `--out` optional path to also write the audit JSON.

## Expected output

JSON on stdout:

```json
{ "ok": true, "data": {
  "health_score": 0,
  "assessed_dimensions": [ "content_meta", "structure" ],
  "not_assessed": [ { "dimension": "security", "check": "https",
                      "reason": "no request was made (local file crawl)" } ],
  "dimension_scores": { "security": null, "indexability": 100, "content_meta": 100,
                        "structure": 100, "schema": 100, "i18n": 100, "media": 100,
                        "mobile": 100, "crawlability": 100 },
  "summary": { "critical": 0, "high": 0, "medium": 0, "low": 0, "total": 0 },
  "findings": [ {
    "id": "title_missing", "dimension": "content_meta", "severity": "critical",
    "title": "...", "evidence": "<fact from crawl>", "recommendation": "...",
    "leading_indicator": "<metric that should move if fixed>",
    "failure_criterion": "<how we know it did NOT work>", "data_tier": "Measured"
  } ]
} }
```

Findings are sorted critical→low. Failure: `{"ok": false, "error": "..."}` (e.g. crawl JSON had no pages).

## Scoring

`health_score = clamp(100 − Σ severity weights, 0, 100)` with weights critical=25, high=12, medium=6, low=2; the same weights drive per-dimension subscores. Scoring is deterministic so two runs over the same crawl are identical (drift-comparable).

A check whose input the crawl never measured does not run: its dimension scores `null` and is listed in `not_assessed`, and `health_score` covers only the checks that did run. This is why a local-file crawl cannot report a clean security or indexability result — scoring deducts for findings, so a check that silently does not fire would otherwise read as a pass.
