---
ownerAgent: bcfcb4921dce
name: ui-html-renderer
description_zh: "作为 UIDesigner 的默认交付格式守门员，用 HTML 呈现设计稿、改版稿、组件样例、设计系统、logo/字标、品牌视觉和 review，除非用户明确要求其他格式。"
description_en: "Guard UIDesigner's default delivery format by rendering drafts, redesigns, component samples, design systems, logos/wordmarks, visual identity, and reviews as HTML unless the user explicitly requests another format."
category: rnd
---

# ui-html-renderer

Use this skill for every UIDesigner design deliverable unless the user explicitly requests another final format. The output must be visible in HTML by default. Markdown is acceptable for rationale, but not as the final artifact unless the user asks for text only.

Skip this skill for meta work about the agent itself: analysis, options, debugging prior runs, prompt/skill review, or planning can be answered in prose unless the user asks for an HTML artifact.

Before final delivery, pair with `ui-craft-checks` for any non-trivial HTML artifact, implemented screen, design-source handoff, live-ready view, form, dashboard, or interactive surface. Fix P0 craft failures before final response.

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

The HTML draft should be self-contained unless the repo already has an asset pipeline:

- Inline CSS for standalone drafts.
- No remote runtime dependencies.
- Realistic content and realistic data.
- Representative empty, loading, error, selected, and disabled states where relevant.
- Desktop and mobile responsive behavior.
- Stable dimensions for repeated items, toolbars, grids, cards, counters, boards, and fixed-format widgets.
- Accessible labels for controls and icons.
- Visible focus states.
- Text that wraps, truncates, or scales deliberately without overlap.

Use semantic HTML where practical. Add lightweight JavaScript only for preview interactions such as tabs, filters, menus, theme toggles, or sample state changes.

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

- Realistic metrics, tables, filters, charts, trends, alerts, and drilldown affordances.
- Charts can use SVG or CSS. Make them inspectable and labeled.

For component systems:

- Token swatches.
- Type scale.
- Buttons and controls with states.
- Form fields with validation.
- Table/list rows.
- Feedback states.
- Dialog/drawer/popover examples when needed.

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

- Do not use generic hero pages for apps, tools, or dashboards.
- Do not create a split marketing hero unless the request is a landing page.
- Do not put cards inside cards.
- Do not use decorative orbs, blobs, or background bokeh.
- Do not scale font size with viewport width.
- Do not use negative letter spacing.
- Keep card radius 8px or less unless the existing system requires otherwise.
- Use icons for familiar actions rather than text-filled rounded rectangles.

## Verification

When possible:

- Inspect the Orkas embedded artifact preview, generated HTML/CSS/JS, DOM structure, screenshots, or equivalent non-external viewport checks.
- Do not open the system browser by default. Use an external browser only when the user explicitly asks for it or the target app workflow already requires an external browser.
- Check desktop and mobile widths.
- Inspect screenshots for blank areas, overlap, clipped text, broken assets, and unreadable contrast.
- Interact with tabs, menus, toggles, filters, and primary actions if present.
- Run the `ui-craft-checks` matrix for HTML default, source/design fidelity, state coverage, accessibility, forms, typography, motion, responsive behavior, live/security, and anti-template tells.

If verification cannot run, state that clearly and list the checks the artifact was designed to satisfy.

## Delivery

Finish with:

- HTML file or app screen path.
- Viewports represented.
- States represented.
- Interactions included.
- Verification performed.
- Known risks.

For ordinary final responses, summarize only verification performed, blocking craft failures, and known risks. Include the full craft matrix only for review, handoff, QA, or when the user asks for it.
