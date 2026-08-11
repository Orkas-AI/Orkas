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

## Completion Router

Resolve these gates before asking a question or choosing the HTML fast path:

1. **Explicit final format wins immediately.** If the user explicitly requests SVG, PDF, React, Vue, PNG, Markdown, or another final format and the subject plus deliverable are clear, build that format now. For a standalone icon/SVG request, a missing product name or exact icon list is a low-risk creative detail rather than a material blocker: choose a neutral working identity and a coherent default set. Infer other low-risk visual details; do not open a preference form or ask about style, palette, icon count, or packaging merely because those choices could be customized. A standalone SVG delivery is the editable SVG entry plus `artifact.json`, with HTML intentionally absent.
2. **Inaccessible exact source offers two honest paths.** When an exact/1:1 Figma request has only an inaccessible URL and no Figma connector/export, do not use a general web fetch as substitute access. Keep exact work blocked and put both paths in the visible reply before any question or form: **Exact** waits for inspectable evidence; **Adaptive (optional)** is a provisional non-fidelity scaffold, explicitly not 1:1, and starts only if the user chooses it. Do not silently start that scaffold.
3. **Unapproved raster work stays a handoff, not a substitute.** If the brief requires an original raster asset but the current turn has no approved/direct raster invocation, retain the UI, write a ratio-consistent asset brief, and prewire the future relative raster path with an honest pending fallback. The artifact itself must retain a compact machine-checkable `<template class="asset-brief" type="application/json">` object with `capability: "raster-image-generation"`, `status: "pending"`, composition/aspect, matching integer width/height, at least two palette colors, opaque/transparent background treatment, and the exact `assets/...` `save_path`. Keep a not-yet-created asset inert, for example `data-raster-src="assets/hero.webp"` beside an actual local/data fallback; do not create a broken active `src`. Do not call a billable generation tool, claim the raster exists, or replace the requested raster with an inline SVG final.
4. **A follow-up revision is incomplete without available preview evidence.** When `html_preview` is available, validate the package first, then run the final visual review with `interactions:false` and `screenshots:true` at the actual requested target before that follow-up's one manifest increment and publication. A new artifact begins at revision 1; initial validation and preview keep it at revision 1. Capture desktop plus mobile evidence only when the user explicitly requests responsive, multi-device, or narrow-screen behavior. Do not treat the source-only validator as rendered evidence.
5. **Tools-off does not turn a new artifact into a future brief.** When a new standalone artifact has a clear brief but file-writing or preview tools are unavailable, deliver the complete entry source and strict `artifact.json` inline in the current response. Implement every relevant reachable state in that source and mark execution checks `not run`; a design brief or future executor plan alone is not the requested artifact. This inline fallback does not apply to an existing artifact that cannot be inspected safely.

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
- Treat every visible enabled button, standalone search field, and standalone filter as a behavior promise: bind it to the primary workflow or remove/disable it. When an error preview is reachable, include a bound retry, reload, refresh, or recovery control; explanatory copy alone is not recovery.
- Use `addEventListener`, delegation, or data-action hooks; do not nest inline handlers inside generated HTML strings.
- Keep cached element references immutable. Build complex state in a fragment/detached container and commit once.
- Guard the real initialization callback so a failure leaves the static shell visible and shows an actionable fallback. Use one named guarded entry point, not an outer `try/catch` around callback registration:

```js
function safeInit() {
  try {
    init();
  } catch (error) {
    runtimeStatus.hidden = false;
    runtimeStatus.textContent = "This view could not initialize. Retry or reload.";
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", safeInit, { once: true });
} else {
  safeInit();
}
```

## Fast Gate

For a standalone HTML artifact, run the bundled validator when Node and shell execution are available:

```text
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" \
  ui-design-executor validate-html-artifact -- \
  <artifact-directory>
```

Keep this default command unchanged for ordinary HTML. Append exactly one task-scoped expectation only when its trigger is active:

- `--expect live-ready` when `ui-live-artifact` classified the deliverable as live-ready or connected-live.
- `--expect raster-handoff` when an original raster is required but direct generation is not approved or available in the current turn.

As a narrow omission safeguard, the default validator also infers `raster-handoff` when `artifact.json` describes an original hero illustration, the HTML substitutes a hero SVG, and the manifest does not record an explicit user request for SVG/vector output. Ordinary icons/SVG decoration do not trigger it. Record explicit vector intent only when it came from the user; it is not an escape hatch for an omitted raster handoff.

An expectation failure is a focused same-turn repair signal, not a new approval gate. Make one narrow repair, rerun the same command once, and then stop retrying. Do not ask the user to approve validation, load a broader QA bundle, or add another workflow loop. The validator does not intercept `publish_outputs`; if the second attempt still fails, finish with an honest incomplete handoff rather than claiming the expectation passed.

It checks strict `artifact.json`, entry/file inventory, safe relative paths, critical HTML structure, meaningful static content, inline JavaScript syntax, fragile generated inline handlers, guarded initialization when an initializer exists (`runtime-guarded-init`), custom field-error linkage (`form-error-accessibility`), and local references in one call. Field-error ownership is deterministic only when a control references the exact error ID with `aria-describedby`, or when an error in the same form uses the exact conventional ID `<control-id>-error` or `<control-id>-invalid`. A deterministically mapped error requires both the exact link and `aria-invalid`. Missing or duplicate referenced error targets and semantic errors that cannot be mapped deterministically are review warnings, not guessed hard failures. It does not infer control wiring, recovery behavior, or business correctness from source patterns. Fix every reported error. Treat warnings as review prompts, not automatic failures.

For a standalone build or in-place revision, validate before finalizing; for a revision, first read the baseline and patch the existing entry. Only after the validator passes, run `html_preview` with `interactions:false` and `screenshots:true` for the final visual review. This preserves runtime, resource, layout, keyboard-focus, and screenshot evidence without clicking controls or submitting forms. Use `target:"responsive"` only when the user explicitly requests responsive, multi-device, or narrow-screen behavior. Otherwise omit target for desktop, or use `target:"mobile"` for an explicitly mobile artifact. A failed preview returns deterministic diagnostics without model-visible screenshots: repair those findings and rerun instead of requesting image analysis. A passing final preview attaches lossless screenshot evidence; inspect it for hierarchy, typography, density, color, reference fidelity, the requested visual change or state, non-blank first render, requested viewport behavior, and local asset/reference resolution. Keep a new artifact at its initial revision 1; for a follow-up, move baseline N exactly once to N+1 after this review. Then run the final package check and publish. Report these as UI rendering and visual-review evidence, not proof that authentication, persistence, network, or other business behavior works. A validator-only run is not rendered evidence.

Use embedded preview, DOM inspection, screenshots, or accessibility tooling only when already available and proportionate to the task. Do not open an external browser or install dependencies by default.

If a parser/browser/runtime check did not run, mark it `not run`; do not convert source inspection into a runtime claim.

## Delivery

Lead with the canonical directory or repo screen, entry/final format, revision for standalone artifacts, files changed, checks actually run, and remaining risks. Keep ordinary summaries compact. Surface a full design contract or craft matrix only when the user requested a review, system, handoff, or QA report.
