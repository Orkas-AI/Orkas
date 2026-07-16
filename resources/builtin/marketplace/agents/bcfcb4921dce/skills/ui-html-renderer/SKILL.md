---
ownerAgent: bcfcb4921dce
name: ui-html-renderer
description_zh: "处理复杂状态型 HTML、运行时安全修复、严格 source-to-HTML 保真或详细交接；普通单页 HTML 由紧凑执行器直接完成。"
description_en: "Handle complex stateful HTML, runtime-safety repair, strict source-to-HTML fidelity, or detailed implementation handoff; ordinary single-page HTML is completed directly by the compact executor."
category: rnd
---

# ui-html-renderer

Use this specialist for unusually complex stateful HTML, blank/runtime-risk repair, strict source-to-HTML fidelity, reusable component galleries, brand boards, or detailed implementation handoff. Ordinary single-page HTML uses `ui-design-executor`, which already preserves HTML-default delivery and baseline runtime/accessibility rules.

Pair standalone output with `ui-artifact-workspace`. It owns the stable directory, `artifact.json`, revision continuity, relative assets, and packaging boundary. This skill owns what the HTML renders and whether it works.

Skip this skill for meta work about the agent itself: analysis, options, debugging prior runs, prompt/skill review, or planning can be answered in prose unless the user asks for an HTML artifact.

Pair with `ui-craft-checks` only for formal review, QA, launch handoff, exact-fidelity inspection, or high-risk complex UI. Otherwise return to the executor's fast gate.

## Contract Input

When `ui-design-contract` has been used, treat its contract snapshot or `DESIGN.md` as the source of truth for the HTML pass:

- Apply any `ui-design-source` handoff as fidelity input: preserve frame map, visible copy, component mapping, tokens, and the chosen fidelity mode.
- Follow the named visual direction, token roles, component families, anti-patterns, and acceptance gates.
- Apply any `ui-reference-packs` selection as style guidance only: translate its density, type rhythm, color roles, and component behavior into original HTML.
- Preserve observed screenshot structure before applying inferred style changes.
- Carry forward keep/change/do-not-copy boundaries; do not embed protected logos, copied layouts, or proprietary assets unless the user owns and supplied them.
- If the contract has unknowns, either label them in the artifact or ask one focused question before rendering when the missing answer would change the page structure.
- If the contract conflicts with a generic artifact type such as dashboard, kanban, or pricing page, the contract wins unless the user explicitly overrides it.
- If a selected reference pack conflicts with the contract, existing app tokens, or visible screenshot structure, the pack loses.

## Rendering Rule

Default final output is HTML for design artifacts. If the user asks for any of these and does not explicitly request another final format, produce HTML:

- Design brief.
- UI design.
- Redesign.
- Mockup.
- Page design.
- Dashboard design.
- Component set.
- Design-system sample.
- Logo design.
- App icon.
- Wordmark.
- Brand mark.
- Visual identity.
- Figma or screenshot to UI handoff.
- Screenshot or image-based redesign.
- UI review or visual audit.
- Visual polish proposal.

Valid HTML outputs:

- A self-contained HTML artifact/file when no target repo implementation is requested.
- A rendered target app screen when the user asks to implement inside an existing app.
- An HTML review page or annotated HTML artifact for reviews.

Other final formats such as standalone images, SVG files, PDFs, Markdown-only strategy, or code-only patches are valid only when the user explicitly asks for them. Do not deliver only prose, standalone images, or a raw asset gallery by default.

Do not force HTML for non-deliverable discussion, such as "why did the agent do that", "list possible integrations", "analyze this workflow", or "first give me a plan".

## HTML Artifact Requirements

The HTML draft should be self-contained unless the repo already has an asset pipeline or splitting files materially improves later edits:

- Inline CSS for standalone drafts.
- No remote runtime dependencies.
- Realistic domain content. Label sample or inferred data; never make invented metrics look observed or production-backed.
- Reachable empty, loading, error, selected, and disabled implementations where relevant; prose state inventories do not count.
- Desktop and mobile responsive behavior.
- Stable dimensions for repeated items, toolbars, grids, cards, counters, boards, and fixed-format widgets.
- Accessible labels for controls and icons.
- Visible focus states.
- Text that wraps, truncates, or scales deliberately without overlap.
- Parseable HTML structure and inline JavaScript that does not block first render.

Use semantic HTML where practical. Add lightweight JavaScript only for preview interactions such as tabs, filters, menus, theme toggles, or sample state changes.

## State Proof Protocol

For non-trivial data surfaces, implement the relevant states in the artifact rather than describing them outside it:

- Data workflows normally need populated, loading, empty, error, and partial/stale variants.
- Forms normally need pristine, dirty/touched invalid, submitted-pending, recoverable server error, and success variants. Each explicitly requested outcome must be reachable; a helper whose failure branch is never invoked is not state proof. After validation or server/import failure, focus the first invalid field or an error summary when practical, and always announce the error through an appropriate live/alert role.
- Tabs and other composite controls need semantic selected state plus their expected keyboard model; tabs include arrow-key navigation, not only click handlers.
- Disabled, permission-gated, offline, and mobile-collapsed states are required when the brief can reach them.

Keep these states inspectable without turning the product UI into a demo panel. Use the real workflow when practical; otherwise add a compact preview-only state switcher, a `data-ui-state` rendering branch, or a clearly separated state gallery. Every state must have actual DOM/component/rendering evidence and recovery behavior. A bullet list of intended states is not implementation.

## Runtime-Safe Event Wiring

- Prefer semantic static markup with `addEventListener`, event delegation, or `data-action` hooks.
- Never put inline `onclick`/`onchange` handlers inside HTML strings assigned through `innerHTML`; nested quote/backslash layers are a common syntax and injection failure.
- When markup must be generated, use template literals for markup only and attach behavior after insertion, or create elements/handlers through DOM APIs.
- Keep cached DOM references immutable. Never temporarily assign a wrapper into a `refs`, `content`, `panels`, or similar element map to redirect a renderer.
- Never clear a container and then query, append, or move a descendant that the clear just removed. Build the complete state in a local `DocumentFragment` or detached container, then commit it once with `replaceChildren(...)` or an equivalent safe operation.
- Keep meaningful primary content in static HTML before the script runs. For an interactive standalone artifact, initialize through one guarded entry point so an initialization exception leaves the static shell visible and replaces a dedicated status/fallback region with an actionable error instead of blanking the page. When waiting for DOM readiness, register the guarded function itself: `function safeInit() { try { init(); } catch (error) { showFallback(error); } }` then use `addEventListener("DOMContentLoaded", safeInit, { once: true })`. A `try/catch` around `addEventListener(..., init)` does not catch errors thrown later by `init` and must be rejected.
- Before delivery, inspect every `innerHTML` assignment for balanced delimiters, every selector for a matching element, every cached reference for later mutation, and every state renderer for clear-then-query hazards before claiming source-level runtime safety.

## Raster Asset Handoff

When a UI asks for an original raster illustration, photo, texture, or edited image and a dedicated raster image-generation capability is available:

- Route only that asset by capability or role; never depend on a mutable display name.
- Keep UIDesigner ownership of information architecture, layout, copy, tokens, responsive behavior, accessible fallback, integration slot, and final HTML.
- Provide a concrete brief with subject/composition, aspect ratio, pixel dimensions that mathematically match that ratio, palette, background/alpha, exclusions, alt intent, relative save path, and crop-safe area.
- Wire the future relative asset path in the HTML itself (normally `<img src="assets/...">` or `<picture>`) and include an honest placeholder/fallback until the raster exists. Put the ratio-consistent asset brief before long source listings so it remains actionable and auditable.
- Do not silently replace the requested raster asset with an inline SVG. SVG is acceptable only as a labeled temporary fallback or when the user asked for vector output.

Reject the handoff before delivery if, for example, the brief says `16:10` but asks for `1800x1200`.

## Stack And Dependency Boundaries

Choose the rendering stack from the task and repo, not from public examples:

- Standalone UIDesigner drafts default to plain HTML, CSS, and minimal JavaScript.
- If the target repo already uses Tailwind, Bootstrap, shadcn/ui, Radix, Headless UI, Ant Design, MUI, Carbon, React Spectrum, Vue libraries, or another system, follow that local system.
- Do not introduce Tailwind, daisyUI, Bootstrap, shadcn/ui, Storybook, or any component package just because a reference project is popular.
- Treat public libraries as behavior and state references unless the user explicitly asks to adopt them.

## Source-To-HTML Rendering Workflow

For screenshot/design-to-HTML tasks:

1. Start from the `ui-design-source` map and `ui-design-contract`, not from a generic template.
2. Build the major regions first: app shell, navigation, content groups, controls, repeated items, and primary action.
3. Add tokenized styling after the structure is faithful: colors, type roles, spacing, radius, borders, elevation, and motion.
4. Add representative states/stories in-place or as a compact state gallery when the component is reusable.
5. Compare the rendered result against the source/contract and fix mismatches before adding decorative polish.

## What To Render

For product screens:

- App shell, navigation, primary content, secondary panels, and primary action.
- Main workflow, not a marketing wrapper.
- Data or content density that matches the product type.
- Key states in-place or in a state gallery section.
- Pattern structures such as dashboard, kanban, pricing, mobile-frame, wireframe, or live-artifact must be triggered by the user or source contract before use.

For design-source or Figma handoff:

- Do not claim Figma import, frame inspection, variable extraction, or component mapping unless `ui-design-source` actually inspected that evidence.
- Respect the fidelity mode: exact, adaptive, systemize, or redesign.
- Include a compact source-to-HTML mapping when exact or adaptive fidelity matters.
- Label sample or inferred content if the source only supplied partial frames.

For live-ready artifacts:

- Use `ui-live-artifact` when refresh, sync, recurring updates, connector data, or auditable data provenance is requested.
- A live-ready HTML preview must still render now; do not depend on a missing daemon/runtime to show the first artifact.
- Include loading, stale, failed-refresh, empty, and last-updated states where relevant.
- Do not persist secrets, raw provider responses, auth headers, cookies, or token-like fields in generated HTML or JSON.

For dashboards:

- Domain-appropriate metrics, tables, filters, charts, trends, alerts, and drilldown affordances only when the request or source actually calls for a dashboard.
- Label invented preview data as sample data and keep it visibly distinct from inspected or connected data.
- Charts can use SVG or CSS. Make them inspectable and labeled.

For component systems:

- Token swatches.
- Type scale.
- Buttons and controls with states.
- Form fields with validation.
- Table/list rows.
- Feedback states.
- Dialog/drawer/popover examples when needed.
- Component stories or state gallery for reusable pieces.
- DTCG/CSS variable mapping when the system is intended to last beyond one mockup.

For logo or identity drafts:

- Mark variants and wordmark lockups.
- Light, dark, monochrome, and small-size treatments.
- App icon or favicon preview when relevant.
- Color tokens, spacing/sizing rules, and usage examples.
- A compact rationale for the visual direction.
- Raster images may be embedded as preview assets, but the final deliverable must be the HTML brand board or design draft, not an image-only gallery.

For redesigns:

- Show the redesigned screen, not only a before/after text list.
- If useful, include a compact issue-to-fix annotation layer.

For screenshot or image-based redesigns:

- Treat the image as the source of truth for page type, layout regions, visible copy, component inventory, and hierarchy.
- Before writing HTML, extract a source screen contract: visible text, major regions, controls, repeated items, density, color roles, and unknown areas.
- Preserve the source screen's information architecture unless the user explicitly asks to change the product, page type, or workflow.
- If a later form answer conflicts with the screenshot, preserve the screenshot or ask one clarification before rendering.
- Do not invent dashboards, tables, charts, metrics, operational records, sidebars, or fake domain data unless they are visible in the image or explicitly requested.
- When text or controls are hard to read, use available OCR/image inspection tools. If confidence is still low, label unknown content or ask for context instead of filling gaps with a generic SaaS template.
- Include a source-to-redesign mapping in the HTML or final handoff when the redesign changes structure.

For reference-driven or brand-driven drafts:

- Render the design contract into visible UI decisions, not a moodboard of adjectives.
- Use the contract's token roles and anti-patterns before choosing decorative effects.
- Include brand or design-system sections only when the task is a brand board, identity board, design system, or handoff. For product screens, keep the first viewport focused on the usable interface.

For reviews:

- Render findings in an HTML review page when no existing app screen is being modified.
- Prioritize concrete issues and show affected areas, severity, fix direction, and expected outcome.
- Include screenshots or image assets only as evidence inside the HTML review, not as the whole deliverable.

## Visual Constraints

Treat these as contextual quality tests, not a house style that makes every artifact look the same:

- Apps, tools, editors, and dashboards should open on the primary workflow, not a generic marketing hero.
- Split heroes, bento grids, floating cards, nested cards, decorative blobs, blur, and bokeh need a brief-specific reason. Remove them when they only signal “designed by AI.”
- Radius, shadow, letter spacing, font scaling, and surface depth must follow the chosen visual thesis and remain readable. Avoid applying one arbitrary value to every product category.
- Familiar actions should use conventional controls and recognizable icons with accessible names; novelty must not hide function.
- One justified aesthetic risk is welcome when it strengthens the subject or interaction. It cannot compromise hierarchy, accessibility, responsive behavior, or source fidelity.

## Verification

When possible:

- Before preview, run a cheap HTML sanity pass: confirm the artifact has a doctype or intentional fragment boundary, one meaningful root/page container, balanced critical tags, and no obvious unclosed `<script>`, `<style>`, `<main>`, `<section>`, `<div>`, or form controls.
- Validate inline JavaScript syntax with an available parser/checker or by loading the artifact in the embedded preview and inspecting console/runtime errors. Fix any syntax error or uncaught initialization error that prevents first paint.
- Inspect the Orkas embedded artifact preview, generated HTML/CSS/JS, DOM structure, screenshots, or equivalent non-external viewport checks.
- Do not open the system browser by default. Use an external browser only when the user explicitly asks for it or the target app workflow already requires an external browser.
- Confirm the rendered body is non-blank and contains the primary page region, primary action, and expected visible text.
- Check desktop and mobile widths.
- Inspect screenshots for blank areas, overlap, clipped text, broken assets, and unreadable contrast.
- Interact with tabs, menus, toggles, filters, and primary actions if present.
- Exercise every critical state branch. For forms, check pristine, dirty/touched invalid, pending, server-error recovery, and success; for data surfaces, check populated, loading, empty, error, and partial/stale.
- Run the `ui-craft-checks` matrix for HTML default, source/design fidelity, state coverage, accessibility, forms, typography, motion, responsive behavior, live/security, and anti-template tells.
- For standalone output, validate `artifact.json`, confirm its entry exists, check relative local references, and make sure the current file list is package-safe.
- Run optional axe-core/pa11y, screenshot comparison, Storybook, or DOM/source checks only when already available or explicitly requested; do not install dependencies for verification by default.

If verification cannot run, state that clearly and separate `implemented from source inspection` from `not executed`. Never turn a planned check into a claimed result.

When parser/browser tools are unavailable, source inspection is still a real, separately reportable check. Perform it before delivery and report its result without calling it browser validation:

- Confirm the doctype/root/body, meaningful static first-render content, and balanced critical closing tags by inspecting the completed source.
- Trace the single initialization entry point, all referenced selectors, delegated action names, tab targets, and requested success/failure transitions. Confirm that DOM-ready callbacks invoke a guarded initializer rather than merely registering an unguarded callback inside an outer `try/catch`.
- Reject mutable cached-element maps, clear-then-query/move sequences, nested inline handlers inside generated markup, and state branches that overwrite their own recovery controls.
- Mark HTML parser execution, JavaScript parser execution, console inspection, interaction playback, and viewport rendering `not run` when they did not run; give a concrete future command/action and pass criterion for each.

## Delivery

Finish with:

- Canonical artifact directory and manifest revision, or the real app screen path for target-repo implementation.
- HTML entry file.
- Files changed when revising an existing artifact.
- Viewports represented.
- States represented.
- State evidence and how each critical state is reached.
- Interactions included.
- Verification performed.
- Known risks.

For ordinary final responses, summarize only verification performed, blocking craft failures, and known risks. Include the full craft matrix only for review, handoff, QA, or when the user asks for it.
