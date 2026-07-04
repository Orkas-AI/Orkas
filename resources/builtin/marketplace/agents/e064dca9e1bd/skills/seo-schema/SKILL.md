---
ownerAgent: e064dca9e1bd
name: seo-schema
description_zh: "校验页面 JSON-LD 结构化数据并按页面角色推荐应补的类型，也能生成可粘贴的 JSON-LD 模板（Organization/WebSite/SoftwareApplication/FAQPage/BreadcrumbList/Article/Product）；校验项含缺 @type、缺必填字段、已废弃富结果类型（FAQPage/HowTo）；适合\"检查结构化数据\"\"给我一段 Organization 的 JSON-LD\"；触发词：结构化数据、JSON-LD、schema、富结果、FAQ schema"
description_en: "Validate a page's JSON-LD structured data, recommend types to add by page role, and generate paste-ready JSON-LD templates (Organization/WebSite/SoftwareApplication/FAQPage/BreadcrumbList/Article/Product); lint covers missing @type, missing required fields, deprecated rich-result types (FAQPage/HowTo); For: 'check structured data', 'give me Organization JSON-LD'; Triggers: structured data, JSON-LD, schema, rich result, FAQ schema"
category: data
---

# seo-schema

Lint existing JSON-LD and generate templates. Pure analysis/templating — no network.

## When to use

- The diagnose flow wants structured-data findings + which schema types the page should add.
- The apply/content flow needs a paste-ready JSON-LD snippet for a type.

## When NOT to use

- Coarse "has any structured data?" — `seo-tech-audit` already flags that. This goes deeper (per-node lint, recommendations, generation).
- Writing the JSON-LD into source — the agent does that (with this skill's generated snippet).

## Preconditions

- For `validate`: a `seo-crawl` JSON (uses each page's parsed `structured_data`). Python 3.9+ stdlib only.

## How to call

Validate existing JSON-LD + recommend types:
```
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" seo-schema schema -- --op validate --input <crawl.json> [--out <schema.json>]
```

Generate a template (for apply/content mode):
```
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" seo-schema schema -- --op generate --type Organization [--json '{"name":"Orkas","url":"https://orkas.ai"}']
```

## Expected output

`validate`:
```json
{ "ok": true, "data": {
  "schema_score": 96, "present_types": ["Organization"], "recommended_types": ["WebSite"],
  "findings": [ { "id": "schema_recommend", "dimension": "schema", "severity": "low", ... } ],
  "summary": { "total": 1 }, "meta": { "url": "..." } } }
```
Findings use `dimension: "schema"` and feed `seo-report --add`.

`generate`: `{ "ok": true, "data": { "jsonld": { "@context": "https://schema.org", "@type": "Organization", ... } } }`. Emit the `jsonld` object as a `<script type="application/ld+json">` block; **the JSON-LD must match the visible page one-to-one** (esp. FAQ Q&A). Failure: `{"ok": false, "error": "..."}`, non-zero exit.

## Lint coverage

Missing `@type`; missing required fields (Organization/WebSite/SoftwareApplication/Article/FAQPage/BreadcrumbList/Product/HowTo); deprecated rich-result types (FAQPage/HowTo still valid markup but no rich result for most sites); recommended types by page role (home → Organization+WebSite; deep page → BreadcrumbList). `@graph` is expanded.
