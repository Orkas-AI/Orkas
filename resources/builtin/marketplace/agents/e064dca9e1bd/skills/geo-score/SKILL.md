---
ownerAgent: e064dca9e1bd
name: geo-score
description_zh: "从 seo-crawl 数据计算 GEO 就绪度，覆盖可引用性、结构、多模态、权威与品牌、技术可达五个维度，并给出实体解析状态和分级建议；用于判断页面是否便于 AI 引用，结果与 SEO 健康分分开呈现。"
description_en: "Compute a five-dimension GEO readiness score from seo-crawl data covering citability, structure, multimodal, authority and brand, technical access, entity resolution, and ranked recommendations. Use to assess whether a page is ready for AI citation; report separately from SEO health."
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
