---
ownerAgent: bcfcb4921dce
name: ui-design-executor
description_zh: "UIDesigner 的紧凑默认执行器；用于普通单页、组件、截图改版和仓库内 UI 实现，以最少技能和工具循环完成设计、HTML/显式格式产物、相关状态、快速验证与交付。"
description_en: "UIDesigner's compact default executor for ordinary single-page, component, screenshot-redesign, and in-repo UI work; complete the design, HTML or explicit-format artifact, relevant states, fast validation, and delivery with minimal skill loading and tool loops."
category: rnd
---

# ui-design-executor

Use this as UIDesigner's default execution skill. It contains the baseline design, accessibility, HTML, runtime-safety, responsive, taste, and verification rules needed by ordinary UI work. Do not load the separate system, control, taste, color, renderer, or craft skills merely to repeat these baseline rules.

Pair it with:

- `ui-artifact-workspace` for a new standalone artifact or an in-place artifact revision.
- `ui-design-source` when an inspectable screenshot, Figma export, PDF, design JSON, existing HTML, or other fidelity source exists.
- One specialist skill only when its trigger below materially changes the work.

## Minimal Routing

Use the fast path for a clear single screen, component, local redesign, or small repo UI change:

1. Load this skill.
2. Add `ui-artifact-workspace` only for standalone output or artifact revision.
3. Add `ui-design-source` only for inspectable source evidence.
4. Build, run the fast gate, publish, and stop.

Do not load `ui-design-contract`, `ui-design-system`, `ui-controls-accessibility`, `ui-taste`, `ui-color`, `ui-html-renderer`, and `ui-craft-checks` together. Load a specialist only for its narrow trigger:

- `ui-design-contract`: durable multi-screen/brand direction, conflicting references, or a genuinely vague visual system.
- `ui-reference-packs`: explicit named style/reference need and insufficient source/repo direction.
- `ui-design-system`: reusable token/component system work.
- `ui-controls-accessibility`: accessibility audit, complex form, or non-trivial composite widget.
- `ui-taste`: explicit anti-generic critique, expressive restyle, or brand/visual-thesis challenge.
- `ui-color`: palette, dark mode, chart color, or contrast-focused work.
- `ui-html-renderer`: unusually complex stateful HTML, runtime-risk repair, or detailed source-to-HTML handoff.
- `ui-craft-checks`: formal review, QA, launch handoff, exact-fidelity inspection, or high-risk complex UI.
- `ui-live-artifact`: refreshable, connector-backed, recurring, or auditable data UI.
- `ui-design-review`: review/critique/polish where findings are the primary result.

If a specialist is loaded, keep this executor as the coordinator instead of recursively loading every skill named by that specialist.

## Execution Budget

For a fast-path task, normally stay within six model/tool loops and eight tool calls after the needed skills are loaded. This is a coordination target, not permission to skip required evidence.

- Skip a formal execution plan for one clear screen/component or a bounded local edit. Use an internal compact brief instead.
- Inspect the source/target once. Batch independent reads when several small files are required.
- Write the main entry once. Do not repeatedly re-read a newly written full HTML file unless a write was truncated, a validator points to a location, or a later edit requires a narrow range.
- Run one grouped deterministic validation command instead of many exploratory shell checks.
- Create `DESIGN.md` only for multi-screen work, reusable systems, brand/identity work, formal handoff, or an explicit user request. A simple standalone screen normally needs only its entry and `artifact.json`.
- Do not create optional state galleries, documentation, assets, or dependencies that the brief does not need.
- If the budget must be exceeded, continue only for a concrete blocker, failed validation, source ambiguity, or requested complexity; consolidate the remaining work rather than repeating broad inspection.

## Compact Design Brief

Before editing, resolve these facts internally:

- Subject/product and target user.
- Page's single job and primary workflow.
- Source of truth and confidence: user brief, screenshot/export, current artifact, or repo UI.
- Output format and canonical target.
- Keep/change boundaries and responsive constraint.
- Visual thesis: hierarchy/layout, density, two precise tone words, role-based palette/type, one subject-specific signature, and one generic choice rejected.

For a screenshot or existing screen, preserve its information architecture and visible content unless the user requests a structural redesign. Do not invent dashboards, tables, charts, metrics, sidebars, or operational data that the source and brief do not support.

## Build Rules

- Design deliverables default to HTML; honor an explicit SVG, PDF, React, Vue, PNG, Markdown, or other final format.
- For a standalone HTML artifact, prefer self-contained semantic HTML/CSS with minimal JavaScript and no remote runtime dependency.
- For repo implementation, reuse the existing framework, components, tokens, icons, routes, and conventions. The repo screen is canonical; do not create a parallel preview unless requested.
- Use role tokens for background, surface, text, muted text, border, accent, focus, and semantic states. Ground density, radius, shadow, type, imagery, and motion in the subject rather than a fixed house style.
- Open on the actual product workflow, not a marketing hero. Remove unjustified glow gradients, bento/card stacks, decorative blobs, oversized rounded panels, and empty promotional copy.
- Keep controls semantic and keyboard reachable; provide visible focus and accessible names. Implement the expected keyboard model for composite controls such as tabs.
- Define responsive behavior for navigation, primary action, dense data, long localized text, and narrow targets. If 320px or no horizontal scroll is explicit, recompose rather than relying on horizontal scrolling.

Implement only states the workflow can reach, but implement those states in real DOM/component branches:

- Data fetching/transformation: populated, loading, empty, error, and partial/stale when the surface actually fetches or transforms data.
- Forms: pristine, dirty/touched invalid, submitted-pending, recoverable error, and success when the task includes a real form workflow.
- Explicit success/failure requests: distinct named triggers, rendered feedback, and recovery; an unreachable conditional or prose list does not count.
- Static navigation or presentation screens do not need artificial data-fetch states merely to satisfy a checklist.

For interactive standalone HTML:

- Keep meaningful primary content in static HTML before scripts run.
- Use `addEventListener`, delegation, or data-action hooks; do not nest inline handlers inside generated HTML strings.
- Keep cached element references immutable. Build complex state in a fragment/detached container and commit once.
- Guard the real initialization callback so a failure leaves the static shell visible and shows an actionable fallback.

## Fast Gate

For a standalone HTML artifact, run the bundled validator when Node and shell execution are available:

```text
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" \
  ui-design-executor validate-html-artifact -- \
  <artifact-directory>
```

It checks strict `artifact.json`, entry/file inventory, safe relative paths, critical HTML structure, meaningful static content, inline JavaScript syntax, fragile generated inline handlers, and local references in one call. Fix every reported error. Treat warnings as review prompts, not automatic failures.

For an in-place revision, validate the changed entry before incrementing the manifest when practical, then run the final package check after the single revision increment. Also smoke-check the requested change, non-blank first render, primary workflow, responsive behavior, and local asset/reference resolution.

Use embedded preview, DOM inspection, screenshots, interaction playback, or accessibility tooling only when already available and proportionate to the task. Do not open an external browser or install dependencies by default.

If a parser/browser/runtime check did not run, mark it `not run`; do not convert source inspection into a runtime claim.

## Delivery

Lead with the canonical directory or repo screen, entry/final format, revision for standalone artifacts, files changed, checks actually run, and remaining risks. Keep ordinary summaries compact. Surface a full design contract or craft matrix only when the user requested a review, system, handoff, or QA report.
