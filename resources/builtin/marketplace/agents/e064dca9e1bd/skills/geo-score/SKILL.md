---
ownerAgent: e064dca9e1bd
name: geo-score
description_zh: "从 seo-crawl 数据算 GEO（生成式引擎优化）得分：Citability/结构可读/多模态/权威&品牌/技术可达 5 维加权，给实体解析状态（recognized/partial/unrecognized）与分级建议；与 SEO 健康分分开呈现；适合\"算一下这页的 GEO 分\"\"AI 引擎能不能引用这页\"；触发词：GEO、AI 引用、可引用性、实体解析、生成式引擎、AI 可见性"
description_en: "Compute a GEO (Generative Engine Optimization) score from seo-crawl data: a 5-dimension weighted score (Citability/Structure/Multimodal/Authority&Brand/Technical-access), an entity-resolution status (recognized/partial/unrecognized), and ranked recommendations; reported separately from SEO health; For: 'score this page's GEO', 'can AI engines cite this page'; Triggers: GEO, AI citation, citability, entity resolution, generative engine, AI visibility"
category: data
---

# geo-score

Score how citable/ready a page is for AI answer engines, from crawl facts. Pure analysis — no network, no model calls. Deterministic so it is drift-comparable.

## When to use

- The diagnose flow wants a GEO score + GEO recommendations alongside the SEO audit.
- A geo-only pass focused on AI-citation readiness.

## When NOT to use

- Measuring whether models *actually* cite the site (real visibility) — that needs probing models, not on-page scoring (see the probe step the agent runs).
- Technical SEO health — that is `seo-tech-audit`.

## Preconditions

- A `seo-crawl` JSON (uses first_paragraph, headings, images/alt, structured_data + sameAs, indexability, https, word_count, and site robots.txt). Python 3.9+ stdlib only.

## How to call

```
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" geo-score geo_score -- --input <crawl.json> [--out <geo.json>]
```

## Expected output

```json
{ "ok": true, "data": {
  "geo_score": 92,
  "geo_dimensions": { "citability": 100, "structure": 100, "multimodal": 100, "authority": 100, "technical": 100 },
  "entity_status": "recognized",
  "geo_recommendations": [ { "dimension": "geo:authority", "title": "...", "evidence": "...",
                             "recommendation": "...", "leading_indicator": "...",
                             "failure_criterion": "...", "data_tier": "Estimated" } ],
  "meta": { "url": "...", "entity_status": "recognized" } } }
```

Pass to `seo-report --geo <geo.json>` — it shows the GEO score + dimension chart and a GEO section in the action plan, kept separate from the SEO health score. Failure: `{"ok": false, "error": "..."}`, non-zero exit.

## Scoring

Weighted: Citability 25% · Structure 20% · Multimodal 15% · Authority&Brand 20% · Technical-access 20%. Signals: answer-first opening, heading hierarchy, image alt coverage, Organization JSON-LD + `sameAs` (entity resolution), outbound citations, indexability, HTTPS, raw-HTML content, AI-crawler reachability in robots.txt.
