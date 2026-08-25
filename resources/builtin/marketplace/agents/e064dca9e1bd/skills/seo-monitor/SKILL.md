---
ownerAgent: e064dca9e1bd
name: seo-monitor
description_zh: "从抓取和评分数据建立可比较的 SEO/GEO 基线，或将新快照与基线比较并分级报告 schema、noindex、canonical、标题/H1、健康分、GEO 分和内容损失等漂移；用于页面退步监控和变化解释。"
description_en: "Create a comparable SEO/GEO baseline from crawl and score data, or compare a later snapshot to rank drift such as schema, noindex, canonical, title/H1 changes, score regression, or content loss. Use for monitoring page regressions and explaining what changed."
---

# seo-monitor

Detect SEO/GEO regressions over time by snapshotting and diffing. Pure analysis — no network (the agent re-crawls; this compares).

MONITOR completion invariant: when an existing baseline is supplied, the run is incomplete until it also reads the prior ACTION-PLAN and reports every TODO as `done`, `open`, or `new` by comparing its Leading indicator with the fresh evidence. A baseline-only drift table is not a complete monitor delivery.

## When to use

- Scheduled monitoring (e.g. an auto-task dispatches the agent in monitor mode daily/weekly).
- "Did anything regress since the baseline?" after edits or a deploy.

## When NOT to use

- The first diagnosis (no baseline yet — run a full diagnose, then `snapshot` to set the baseline).
- Fetching pages — that is `seo-crawl`.

## Preconditions

- `snapshot`: a `seo-crawl` JSON (optionally pass the run's `--health`/`--geo` scores to record them). `compare`: two snapshot files. Python 3.9+ stdlib only.

## How to call

Set/refresh a baseline (store it in the project, e.g. `baseline.json`):
```
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" seo-monitor monitor -- --op snapshot --input <crawl.json> --health <N> --geo <N> --out baseline.json
```

Compare a fresh snapshot against the baseline:
```
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" seo-monitor monitor -- --op compare --baseline baseline.json --current current.json
```

## Expected output

`snapshot`: `{ ok, data: { url, fetched_at, title, canonical, noindex, structured_data_types, word_count, content_hash, health_score, geo_score, ... } }`.

`compare`:
```json
{ "ok": true, "data": {
  "changed": true,
  "drift_findings": [ { "id": "noindex_added", "dimension": "drift", "severity": "critical",
                        "evidence": "before=False → after=True", "recommendation": "...",
                        "leading_indicator": "...", "failure_criterion": "...", "data_tier": "Measured" } ],
  "summary": { "critical": 1, "total": 1 }, "baseline_at": "...", "current_at": "...", "url": "..." } }
```

## ACTION-PLAN reconciliation

When a prior baseline exists, read the prior ACTION-PLAN alongside it. For every prior TODO, compare its Leading indicator with the fresh diagnosis and current snapshot: mark it `done` only when the indicator is met, otherwise keep it `open`. Create a `new` TODO for every newly observed regression. Report all `done` / `open` / `new` transitions before refreshing the baseline; never infer a transition by comparing the current snapshot with itself.

## Rules (severity)

critical: status 200→error, noindex added, indexability lost, all schema removed, canonical removed. high: canonical changed, title/H1 removed, health regressed ≥20. medium: title changed, H1 changed >50%, word count −40%, health regressed 10–19, GEO regressed ≥10. low/info: meta/OG/H2/schema-type changes, content hash changed. Identical snapshots → `changed:false`, zero findings.
