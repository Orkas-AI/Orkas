---
ownerAgent: e064dca9e1bd
name: seo-opportunity
description_zh: "把 GSC/Bing 查询、页面抓取和 GEO 探针结果合成带优先级、证据和下一步动作的关键词机会池，覆盖 quick win、CTR、内容、GEO 缺口和关键词蚕食；用于 SEO 增长机会发现与关键词排序。"
description_en: "Combine GSC/Bing queries, crawl facts, and GEO probe results into prioritized keyword opportunities covering quick wins, CTR, content and GEO gaps, and cannibalization, with evidence and next actions. Use for SEO growth and keyword prioritization."
---

# seo-opportunity

For product-focused strategy, prefer observed use-case, pricing,
comparison, and trust/docs pages. Name missing page types as coverage gaps and
map recommendations to owned pages, first-party proof, answer blocks, and one
cannibalization owner per overlapping query cluster.

Build a one-diagnosis keyword/GEO opportunity pool. This skill is deterministic and stdlib-only: it does not fetch data, call models, or persist anything.

Connector acquisition invariant: naming connector operations is not enough. Discover each connected console with `list_connector_tools`, then invoke its selected operations through the core `call_connector_tool`; for GSC the order is `list_sites` before `query_search_analytics`.

Ownership evidence invariant: a verified Search Console property is not evidence that its root URL owns a query. When query evidence lacks a page dimension, keep the owner page unconfirmed, request query+page rows, and defer owner-page edits until that row or crawl evidence identifies the target. Never convert a property-level query row into a homepage claim.

## When to use

- After `seo-crawl` and any available Search Console / Bing Webmaster query exports.
- After `geo-probe --op score` when the diagnose flow wants GEO gaps folded into the action plan.
- When the user wants "what should I do first?" rather than only technical findings.

## When NOT to use

- Historical decay/trend analysis. This skill has no persistence and should not claim trends.
- Fetching GSC/Bing data. The agent/connector does that before calling this skill.
- Writing content or editing files.

## Preconditions

- Python 3.9+ (stdlib only).
- At least one `seo-crawl` JSON. GSC/Bing/GEO inputs are optional.

## Connector evidence acquisition

Connector availability is closed-world: consume, reconcile, and name every
runtime-listed console, never omit a second console, and never probe one from
memory. Without returned console evidence, rankings and traffic remain
Estimated.

When `## Connectors` lists a search console, first call `list_connector_tools` once for that connector, then invoke every selected connector operation through the core `call_connector_tool`. For Google Search Console, call `list_sites`, select the verified property that owns the target URL, then call `query_search_analytics` once for the relevant query/page dimensions. Reconcile any user-declared target queries with the actual returned query rows before recommending an opportunity. Store raw connector results with `write_file`; only returned fields become Measured.

## How to call

```
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" seo-opportunity opportunity -- --crawl <crawl.json> [--gsc <gsc-query.json>] [--gsc-pages <gsc-page.json>] [--bing <bing-query.json>] [--bing-pages <bing-page.json>] [--geo-probe <geo-probe.json>] [--out <opportunities.json>]
```

All optional inputs are skipped if missing or unreadable. Results are a snapshot for this run only.

## Strategy-map contract

Translate the opportunity pool into an intent-to-page architecture, not a flat keyword list. For each material theme record the intent/stage, query or topic cluster, owning page type and URL, primary question, answer-first or quotable content block, evidence/trust block, and cannibalization owner. Cover core product, use case, comparison, pricing, and trust/docs/security pages when relevant. If measured search data is missing, label the map `Estimated` and present it as a hypothesis to validate rather than omitting the architecture.

## Expected output

```json
{
  "ok": true,
  "data": {
    "summary": { "total": 3, "measured": 2, "estimated": 1 },
    "opportunities": [
      {
        "query": "open source ai assistant",
        "type": "quick_win",
        "source": "gsc",
        "data_tier": "Measured",
        "target_page_url": "https://example.com/",
        "current_signal": "position 11.2, 830 impressions, CTR 1.4%",
        "priority_score": 88,
        "priority": "High",
        "confidence": "High",
        "recommended_action": "Rewrite title/meta and add answer-first copy.",
        "leading_indicator": "CTR improves by 20% or average position enters top 8 within 30 days.",
        "failure_criterion": "CTR and position stay flat after 30 days."
      }
    ]
  }
}
```
