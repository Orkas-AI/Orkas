---
ownerAgent: bcfcb4921dce
name: ui-live-artifact
description_zh: "为 UIDesigner 创建或规划可刷新、可审计、数据源驱动的 HTML 产物；适用于 live dashboard、可刷新报告、同步视图、连接器数据视图，并约束 template/data/provenance 文件、安全脱敏和静态降级。"
description_en: "Create or plan refreshable, auditable, data-backed HTML artifacts for UIDesigner; use for live dashboards, refreshable reports, synced views, and connector data views with template/data/provenance files, safe redaction, and static fallback rules."
category: rnd
---

# ui-live-artifact

Use this skill when the user asks for a live dashboard, refreshable report, synced view, recurring data artifact, connector-backed UI, auditable status page, or data-backed HTML that should remain useful after the first render.

Do not use this for ordinary one-off mockups, static redesigns, image-to-HTML conversion, or visual polish. In those cases `ui-design-executor` is enough.

## Intent Gate

Choose the mode before creating files:

- `static_html`: one-off HTML design or mockup. No refresh contract.
- `live_ready_html`: HTML plus data/provenance contract that can later be wired to refresh, but no live runtime registration happens now.
- `connected_live`: only when Orkas exposes an actual connector/runtime for the requested source in the current context.

If the request is ambiguous, ask one short question: "Should this be refreshable/live, or just a static HTML design?"

## Required Source Questions

Resolve:

- Audience and decision the view supports.
- Data source: local file, repo data, connector, manual sample, or unknown.
- Freshness expectation: manual, on open, hourly/daily, or event-driven.
- Refresh owner: user, connector, scheduled job, or future integration.
- Privacy level: public, workspace, sensitive, or regulated.

Do not ask for secrets. If a connector is not available, ask the user to connect/provide an export rather than requesting API keys.

## File Contract

For `live_ready_html`, create or describe these files when a file deliverable is requested:

- `index.html`: rendered preview that works now in the Orkas embedded artifact surface.
- `template.html`: optional source template when the user wants future refresh wiring.
- `data.json`: compact normalized preview data only.
- `artifact.json`: optional metadata for title, description, refresh mode, view type, and safe source descriptors.
- `provenance.json`: optional safe summary of source, transform, timestamp, confidence, and omitted sensitive fields.

If no file workspace is available, embed the same contract in the HTML artifact and final handoff.

## Data Rules

- Store only fields needed by the UI preview.
- Summarize or sample large lists; do not persist raw provider responses.
- Normalize display-ready values, units, timestamps, status labels, and chart series.
- Keep `data.json` small enough to inspect by eye.
- Mark sample data clearly when the real source is unavailable.

Avoid these key names anywhere in persisted JSON unless they are non-sensitive user-facing labels: `token`, `secret`, `credential`, `password`, `cookie`, `authorization`, `headers`, `raw`, `rawResponse`, `payload`, `body`.

## HTML Requirements

The preview must still be a good UIDesigner artifact:

- Show refresh status, last updated time, data freshness, and empty/error states.
- Include source/provenance cues only where they help trust; do not clutter the main workflow.
- Separate UI actions from data refresh actions.
- Implement visible, reachable stale, partial, loading, failed-refresh, empty, and last-updated states in DOM/rendering logic; a prose inventory is not sufficient.
- Use `ui-design-executor` for baseline visual quality. Add a contract, reference, system, or deep renderer skill only when its specialist trigger is present.

## Connector Boundaries

- Use available Orkas connector tools or local files when they exist.
- Do not call raw third-party APIs when a platform connector/wrapper should own auth.
- Do not store OAuth tokens, API keys, cookies, auth headers, raw HTTP envelopes, or secret-like metadata in generated files.
- If no connector exists, produce `live_ready_html` with sample/exported data and note the missing integration.

## Static Fallback

When live wiring is not possible, do not fail the design:

- Produce a static HTML preview with realistic sample data.
- Include a "Refresh contract" section in the handoff or artifact metadata.
- State which source fields need to be connected later.
- Keep the design ready for implementation without implying refresh already works.

## Output Shape

Use this handoff when helpful:

```markdown
## Live Artifact Handoff
- Mode:
- Data source:
- Freshness:
- Files:
- Data schema:
- States represented:
- Security exclusions:
- Missing integration:
- HTML acceptance gates:
```
