---
ownerAgent: e064dca9e1bd
name: seo-report
description_zh: "把 seo-tech-audit、关键词机会池和 GEO 探针结果汇总成可内联渲染的 :::dashboard JSON（健康分、维度评分、问题清单、机会池、GEO SoV 快照）并生成 ACTION-PLAN.md 行动计划；适合\"出诊断报告\"\"给我一个 SEO 看板和行动清单\"；触发词：报告、看板、dashboard、行动计划、汇总"
description_en: "Aggregate seo-tech-audit, keyword opportunities and GEO probe results into an inline-renderable :::dashboard JSON (health score, dimension charts, issue table, opportunity pool, GEO SoV snapshot) plus an ACTION-PLAN.md; For: 'produce the diagnosis report', 'give me a SEO dashboard and action list'; Triggers: report, dashboard, action plan, summary"
category: data
---

# seo-report

Render an audit into the deliverable: a dashboard spec the chat can show inline, and a written action plan. Pure formatting — no network, no scoring (it trusts the audit, opportunity and probe inputs).

## When to use

- The diagnose flow has a `seo-tech-audit` result and needs the user-facing report + dashboard.
- The diagnose flow has `seo-opportunity` and/or `geo-probe --op score` output to include in the same one-run report.
- Producing a monitoring snapshot's dashboard from a fresh audit.

## When NOT to use

- Scoring or generating findings — that is `seo-tech-audit`.
- Acquiring page data — that is `seo-crawl`.

## Preconditions

- A `seo-tech-audit` JSON object. Optionally the originating `seo-crawl` JSON, `seo-opportunity` JSON, and `geo-probe --op score` JSON for extra context.
- Python 3.9+ (stdlib only).

## How to call

```
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" seo-report report -- --audit <audit.json> [--crawl <crawl.json>] [--opportunities <opportunities.json>] [--geo-probe <geo-probe.json>] [--plan <ACTION-PLAN.md>] [--out <dashboard.json>]
```

- `--audit` path to the `seo-tech-audit` JSON (omit or `-` to read stdin).
- `--crawl` optional `seo-crawl` JSON for context.
- `--opportunities` optional `seo-opportunity` JSON. Rendered as a one-run Keyword Opportunities section; no trend claims.
- `--geo-probe` optional `geo-probe --op score` JSON. Rendered as a one-run GEO Share-of-Voice Snapshot.
- `--plan` write the `ACTION-PLAN.md` markdown here.
- `--out` also write the dashboard JSON here.

## Expected output

stdout is an envelope:

```json
{ "ok": true,
  "dashboard": { "schema_version": 1, "root": { ... } },
  "action_plan_md": "# SEO/GEO Action Plan\n...",
  "health_score": 96, "summary": { "critical": 0, "high": 0, "medium": 0, "low": 2, "total": 2 } }
```

The `dashboard` object is validated against the directive schema before printing (schema_version 1; Stack/Grid/Metric/Chart/Table/Alert/Markdown), so it always renders. On failure: `{"ok": false, "error": "..."}` on stderr with a non-zero exit. `--plan` / `--out` additionally write the plan / dashboard to files.

## Rendering note for the agent

1. Emit the `dashboard` object once, inside a fenced block:

````
:::dashboard
<the dashboard object here>
:::
````

2. Write `action_plan_md` to `ACTION-PLAN.md` (use `write_file`).

Do not hand-edit the JSON — regenerate via this skill if the audit changes.
