---
ownerAgent: e064dca9e1bd
name: seo-monitor
description_zh: "SEO/GEO 漂移监控：op=snapshot 把一次抓取（含健康分/GEO 分）固化成可比对的基线快照（含内容哈希）；op=compare 把当前快照与基线对比，按规则引擎产出漂移项（schema 被删、加 noindex、canonical 改动、标题/H1 变化、健康分/GEO 回退、内容大幅缩水等），分级输出；适合\"监控这页有没有退步\"\"和上次比有什么变化\"；触发词：监控、漂移、回退、基线、对比、drift"
description_en: "SEO/GEO drift monitoring: op=snapshot distills a crawl (+ health/GEO scores) into a comparable baseline (with content hash); op=compare diffs the current snapshot against the baseline via a rule engine and emits ranked drift findings (schema removed, noindex added, canonical changed, title/H1 changes, health/GEO regression, large content loss); For: 'monitor this page for regressions', 'what changed since last time'; Triggers: monitor, drift, regression, baseline, compare"
category: data
---

# seo-monitor

Detect SEO/GEO regressions over time by snapshotting and diffing. Pure analysis — no network (the agent re-crawls; this compares).

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

## Rules (severity)

critical: status 200→error, noindex added, indexability lost, all schema removed, canonical removed. high: canonical changed, title/H1 removed, health regressed ≥20. medium: title changed, H1 changed >50%, word count −40%, health regressed 10–19, GEO regressed ≥10. low/info: meta/OG/H2/schema-type changes, content hash changed. Identical snapshots → `changed:false`, zero findings.
