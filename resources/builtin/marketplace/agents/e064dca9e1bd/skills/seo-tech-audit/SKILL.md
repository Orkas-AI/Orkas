---
ownerAgent: e064dca9e1bd
name: seo-tech-audit
description_zh: "对 seo-crawl 抽取的页面数据做技术 SEO 诊断，输出分级 findings（可索引/canonical/标题描述/标题层级/结构化数据/图片 alt/移动端/HTTPS/robots 等）与健康分，每条带证据、领先指标、失败判据；适合\"诊断这个页面的技术 SEO\"\"给我技术问题清单和健康分\"；触发词：技术诊断、SEO 审计、健康分、技术问题、可索引性"
description_en: "Diagnose technical SEO from seo-crawl page data, emitting bucketed findings (indexability/canonical/title+description/heading hierarchy/structured data/image alt/mobile/HTTPS/robots) and a health score, each with evidence, a leading indicator and a failure criterion; For: 'audit this page's technical SEO', 'give me the technical issue list and health score'; Triggers: technical audit, SEO audit, health score, indexability"
category: data
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
  "dimension_scores": { "security": 100, "indexability": 100, "content_meta": 100,
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
