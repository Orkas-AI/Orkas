---
ownerAgent: e064dca9e1bd
name: seo-report
description_zh: "把技术审计、关键词机会和 GEO 探针结果汇总成可内联渲染的 SEO/GEO 看板及 ACTION-PLAN.md；用于完整诊断交付，包含健康分、维度图、问题清单、机会池、GEO SoV 快照和优先行动。"
description_en: "Combine technical audit, keyword opportunities, and GEO probe results into an inline SEO/GEO dashboard plus ACTION-PLAN.md. Use for complete diagnosis delivery with health and dimension charts, an issue table, opportunity pool, GEO SoV snapshot, and prioritized actions."
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

On a continuation, supplied current-run evidence remains usable context. Finish
the pending artifact from it, keeping unsupported findings Estimated, instead
of restarting collection merely because the work spans turns.

- A `seo-tech-audit` JSON object. Optionally the originating `seo-crawl` JSON, `seo-opportunity` JSON, and `geo-probe --op score` JSON for extra context.
- Python 3.9+ (stdlib only).

## How to call

For a bounded end-to-end diagnosis, first run `seo-crawl --out` so its compact
summary supplies representative links, then call this orchestrator once:

```
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" seo-report diagnose -- --crawl .orkas-seo-audit/crawl.json --out-dir .orkas-seo-audit [--sample-url <url> ...] [--include-cwv]
```

It runs root tech/content/schema/GEO/opportunity analysis, audits at most five
explicit sample URLs once each, writes `multi-summary.json` and `report.json`,
and returns the dashboard, `action_plan_md`, page matrix, and optional CWV
failure in one envelope. A failed sample is recorded and not retried. The
workspace-relative output directory rejects absolute and parent-traversal
paths. Use `write_file` for the returned `action_plan_md`.

For report-only assembly from existing inputs:

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

2. Write `action_plan_md` to `ACTION-PLAN.md` (use `write_file`). Preserve every P0/P1 item's Evidence, concrete action, Leading indicator, and Failure criterion exactly enough to remain testable; do not replace the generated plan with a generic checklist. If tools are unavailable, present these four fields as the required executor contract instead of inventing findings.

3. Make a strategy answer usable without opening the artifact. After the
dashboard, inline:
   - a compact intent-to-page table for the sampled core pages, with owner URL,
     primary question, answer-ready passage/block, evidence or trust block, and
     recommended matching schema;
   - entity-clarity, authoritative-citation, author/reviewer, and visible
     updated-date requirements; and
   - every P0/P1 item's Evidence, action, Leading indicator, and Failure
     criterion.
Do not replace these details with only an `ACTION-PLAN.md` link.

Before strategy cards, print `### Execution sequence` with steps numbered
1..N; each step names its owner role, effort band, and validation window. P0
means dependency order, not technical severity. When no Critical/High technical
finding exists, lead with intent ownership and first-party proof, and keep
polish in P2 and last.

Do not hand-edit the JSON — regenerate via this skill if the audit changes.

For a strategy request, a safety-blocked crawl is an evidence limitation rather
than a reason to stop. Do not retry, search, or open an execution plan. Write
the evidence-honest Estimated plan to `ACTION-PLAN.md`, persist the bounded
`strategy-baseline.json`, and deliver the provisional strategy with the missing
verification named.
