---
ownerAgent: e064dca9e1bd
name: seo-cwv
description_zh: "用 Google PageSpeed Insights 查核心网页指标(Core Web Vitals)：LCP/CLS/INP/FCP 与性能分，区分 CrUX 真实用户字段数据(Measured)与实验室数据(Estimated)，输出 performance 维度 findings；免费、无需 OAuth；适合\"测一下这页的加载性能\"\"看看 CWV/LCP 怎么样\"；触发词：CWV、核心网页指标、LCP、CLS、INP、PageSpeed、性能、加载速度"
description_en: "Fetch Core Web Vitals via Google PageSpeed Insights: LCP/CLS/INP/FCP and the performance score, separating CrUX real-user field data (Measured) from lab data (Estimated); emits performance-dimension findings; free, no OAuth; For: 'check this page's load performance', 'how are the Core Web Vitals / LCP'; Triggers: CWV, Core Web Vitals, LCP, CLS, INP, PageSpeed, performance, load speed"
category: data
---

# seo-cwv

Measure Core Web Vitals with the free PageSpeed Insights API. Field data (CrUX, real users) is reported as Measured; lab (Lighthouse synthetic) as Estimated.

## When to use

- The diagnose flow wants real performance / CWV signals (the other skills are HTML-only).
- Checking LCP/CLS/INP before/after a performance fix.

## When NOT to use

- On-page HTML SEO (meta/headings/schema) — those skills cover it.
- Bulk auditing many URLs fast — keyless PSI is rate-limited (set a key).

## Preconditions

- Network access to `googleapis.com` (honors HTTP(S)_PROXY automatically). Optional free API key via `--key` or `ORKAS_PAGESPEED_KEY` (keyless works but is rate-limited). Python 3.9+ stdlib only. PSI is slow (synthetic run) — default timeout 60s.

## How to call

```
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" seo-cwv cwv -- <url> [--strategy mobile|desktop] [--key <k>] [--out <cwv.json>]
```

## Expected output

```json
{ "ok": true, "data": {
  "strategy": "mobile", "performance_score": 42,
  "lab":   { "lcp_ms": 4100, "cls": 0.28, "tbt_ms": 600, "fcp_ms": 2100, "si_ms": 5000 },
  "field": { "lcp_ms": 4200, "cls": 0.30, "inp_ms": 540, "fcp_ms": 2200, "overall_category": "SLOW", "has_field_data": true },
  "findings": [ { "id": "lcp_poor", "dimension": "performance", "severity": "high",
                  "evidence": "...", "recommendation": "...", "leading_indicator": "...",
                  "failure_criterion": "...", "data_tier": "Measured" } ],
  "summary": { "total": 1 }, "meta": { "url": "...", "field_data": true } } }
```

Findings use `dimension: "performance"` and feed `seo-report --add`. Failure: `{"ok": false, "error": "..."}` (e.g. PSI quota/error) on stderr, non-zero exit.

## Thresholds (Google)

LCP good ≤2500ms / poor >4000ms · CLS good ≤0.10 / poor >0.25 · INP good ≤200ms / poor >500ms. Field (CrUX) is preferred and Measured; lab is the fallback and Estimated. INP comes from field only (lab has TBT as a proxy).
