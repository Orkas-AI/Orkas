---
ownerAgent: e064dca9e1bd
name: seo-opportunity
description_zh: "把 GSC/Bing 查询数据、页面抓取和 GEO 探针结果合成一次诊断内的关键词机会池（quick win、CTR gap、内容缺口、GEO gap、关键词蚕食），输出优先级、证据和下一步动作；适合\"找 SEO 增长机会\"\"给关键词机会排序\"；触发词：关键词机会、增长机会、quick win、CTR、机会池、优先级"
description_en: "Turn GSC/Bing query data, crawl facts and GEO probe results into a one-shot keyword opportunity pool (quick wins, CTR gaps, content gaps, GEO gaps, cannibalization), with priority, evidence and next action; For: 'find SEO growth opportunities', 'rank keyword opportunities'; Triggers: keyword opportunities, growth opportunities, quick win, CTR, opportunity pool, priority"
category: data
---

# seo-opportunity

Build a one-diagnosis keyword/GEO opportunity pool. This skill is deterministic and stdlib-only: it does not fetch data, call models, or persist anything.

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

## How to call

```
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" seo-opportunity opportunity -- --crawl <crawl.json> [--gsc <gsc-query.json>] [--gsc-pages <gsc-page.json>] [--bing <bing-query.json>] [--bing-pages <bing-page.json>] [--geo-probe <geo-probe.json>] [--out <opportunities.json>]
```

All optional inputs are skipped if missing or unreadable. Results are a snapshot for this run only.

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
