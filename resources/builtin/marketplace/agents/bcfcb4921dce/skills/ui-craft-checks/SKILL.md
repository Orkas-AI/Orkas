---
ownerAgent: bcfcb4921dce
name: ui-craft-checks
description_zh: "UIDesigner 的完整 HTML 质量门槛；用于正式 review、QA、上线交接、严格保真或高风险复杂 UI，检查可访问性、状态、表单、排版、响应式、反模板和运行时。普通单页使用快速验证。"
description_en: "UIDesigner's comprehensive HTML quality gate for formal review, QA, launch handoff, exact fidelity, or high-risk complex UI across accessibility, states, forms, typography, responsive behavior, anti-template quality, and runtime; ordinary single-page work uses the fast validator."
category: rnd
---

# ui-craft-checks

Use this comprehensive gate for formal review, QA, launch handoff, exact-fidelity inspection, high-risk complex UI, or when the fast gate exposes a deeper craft problem. Ordinary single-screen work uses `ui-design-executor` and its bundled validator without loading this full matrix. Pair standalone artifacts with `ui-artifact-workspace` when this specialist is triggered.

This skill does not replace `ui-html-renderer` or `ui-design-review`. It tells them what must be checked before delivery.

Run the gate internally by default. Surface the full checklist only for review, handoff, QA, or when the user asks for the detailed pass/fail matrix.

## When To Use

Use this skill when:

- The user asks for a formal review, QA matrix, hardening, launch-readiness, accessibility audit, or detailed handoff.
- Exact screenshot/design-source fidelity needs comprehensive validation.
- A complex form, live/data surface, or composite interaction is high risk or has failed the fast gate.
- The user explicitly requests a full craft or anti-template critique.

For ordinary single-page delivery and tiny text-only answers, skip this skill.

## Severity

- `P0`: Must fix before final delivery.
- `P1`: Should fix before production or stakeholder review.
- `P2`: Polish; fix when scope allows.

## P0 Gates

The artifact fails the craft pass if any P0 is present:

- **Not HTML by default**: a UI/design deliverable is only prose, PNG, SVG, Markdown, or a raw asset gallery when the user did not request that final format.
- **Explicit format ignored**: the user requested a non-HTML final format but the artifact silently substitutes HTML or another format for it.
- **Detached revision**: a normal follow-up creates a new sibling or regenerates an unrelated artifact instead of inspecting and patching the canonical artifact in place, losing accepted content or user edits.
- **Broken artifact boundary**: a standalone deliverable has no stable artifact directory or valid manifest/entry, or it depends on missing local files, machine-specific absolute paths, undeclared secrets, or an unmentioned build step that prevents sharing or packaging.
- **Source drift**: screenshot, Figma/design-source, or explicit contract structure is replaced by an unrelated dashboard, table, chart, sidebar, pricing page, or kanban board.
- **Missing critical states**: a data-fetching or data-transforming surface does not implement reachable loading, populated, empty, error, and edge/partial states. Mentioning them in rationale while shipping only populated DOM still fails.
- **Broken form validation**: required fields lack labels/helper/error wiring, or the prototype omits pristine, dirty/touched invalid, submitted-pending, recoverable server-error, or success behavior that the workflow can reach. A user-requested success/failure outcome that exists only in an untriggered branch still fails.
- **Keyboard/accessibility failure**: interactive controls are not keyboard reachable, focus-visible is absent, icon-only controls lack names, or native elements are replaced with inert divs.
- **Unsafe live data**: live-ready artifacts persist tokens, credentials, cookies, auth headers, raw provider responses, or secret-like fields.
- **Text/layout collision**: text overlaps controls, is clipped without intent, or mobile layout hides the primary action.
- **Broken HTML/runtime**: invalid or malformed HTML, unclosed critical tags, inline JavaScript syntax/runtime errors, or missing root content causes a blank or unusable first render. Inline event handlers nested inside `innerHTML` strings are a P0 because their quote/escape layers are fragile. Mutating cached element-reference maps to redirect a renderer, clearing a container before querying/moving its former descendants, or wrapping only `addEventListener("DOMContentLoaded", init)` in `try/catch` while leaving the later callback unguarded is also P0; use immutable references, detached fragments, one safe commit, a genuinely guarded initializer, and data hooks plus listeners/delegation.
- **False capability claim**: the response claims Figma import, connector refresh, external-browser validation, or accessibility checks happened when they did not.
- **Invented evidence**: sample metrics, placeholder records, inferred copy, or guessed assets are presented as observed source content or production data.
- **Raster route bypassed**: a requested original raster asset is replaced by an inline SVG/gradient or the whole UI is delegated, even though the dedicated raster capability is available. The asset brief also fails if its stated aspect ratio conflicts with its pixel dimensions, or if it names a save path without wiring that relative raster path and an honest fallback into the HTML.

## P1 Gates

Fix or explicitly note these before handoff:

- **Contrast and focus**: body text, muted text, control borders, semantic status, and focus rings need sufficient contrast.
- **State composition**: empty states need a headline, explanation, and recovery action; errors need what happened, why, and how to recover.
- **Typography hierarchy**: hierarchy should use at least two vectors such as size, weight, spacing, color, position, or grouping; avoid both flat hierarchy and noisy hierarchy.
- **Motion discipline**: motion should explain state, space, or feedback. Avoid ambient motion in work tools. Translate/scale/rotate/parallax motion should respect reduced motion.
- **Form timing**: do not show error chrome on pristine fields; validate after blur/submit, then clear errors as the user fixes input.
- **Responsive behavior**: navigation, filters, tables, side panels, fixed boards, and action bars need a defined mobile behavior.
- **RTL/bidi readiness**: for multilingual or unknown user-generated content, prefer logical properties and isolate unknown-direction text with `dir="auto"` or `<bdi>`.
- **AI-template tells**: remove unjustified purple-blue glow gradients, generic 3-card rows, stock-placeholder imagery, oversized rounded cards everywhere, decorative blobs, and empty marketing adjectives.
- **Weak component stories**: reusable components lack meaningful variants/states, making later implementation or review depend on guesswork.

## P2 Polish

Improve when time allows:

- Tighten rhythm so related items align and unrelated items separate clearly.
- Reduce redundant chips, badges, and microcopy that compete with the main task.
- Prefer borders and layout clarity over heavy shadows.
- Give the design one product-specific signature device that helps the workflow.
- Replace arbitrary icons with familiar symbols and accessible labels.

## Required Check Matrix

Before final delivery, internally verify this matrix:

```markdown
## Craft Check
- HTML default:
- Explicit format:
- Artifact continuity:
- Package boundary:
- HTML syntax/runtime:
- Source/design fidelity:
- State coverage:
- State implementation evidence:
- Accessibility:
- Form behavior:
- Typography hierarchy:
- Motion:
- Responsive:
- Live/security:
- Anti-template:
- Optional automation:
- Remaining risks:
```

Judge evidence, not vocabulary. A state passes only when it exists in the rendered artifact, DOM, component story, or executable rendering branch and there is a clear way to reach or inspect it. A validation passes only when the named check actually ran; otherwise mark it `not run`, keep the risk visible, and give the future execution action plus a concrete pass criterion instead of a bare checklist label.

For simple final answers, summarize only failures and verification performed. Do not clutter the user-facing artifact with a checklist unless it is a review page, handoff, QA report, or requested by the user.

## Optional Automated Checks

Use automated checks only when an HTML file/app screen exists and the environment already supports the tool or the user asks for stronger validation. Do not install new dependencies just to satisfy this skill.

- Accessibility: if axe-core, pa11y, Playwright accessibility helpers, or an equivalent existing checker is available, run it and fix actionable violations around labels, names, landmarks, contrast, focus order, and keyboard reachability.
- Visual regression: when a source screenshot or prior HTML screenshot exists, use screenshot comparison or viewport screenshots to catch blank render, source drift, clipped text, overlap, broken assets, and unintended layout shifts.
- Component stories: when Storybook or a local component preview exists, check the relevant states/stories rather than only the full page.
- DOM/source inspection: when browser automation is unavailable, inspect the generated HTML/CSS/JS for semantic elements, labels, state markup, media queries, and unsafe persisted data.
- HTML syntax/runtime: when possible, parse the generated HTML, check inline script syntax, inspect console/runtime errors, and confirm the rendered body is non-blank with the primary region visible.

Automated tools are evidence, not a substitute for design judgment. If a tool cannot run, state that validation was reasoned from source/HTML and list the remaining risks.

## How To Apply

1. Inspect the rendered HTML or app screen when possible.
2. Compare it to `ui-design-source` and `ui-design-contract` outputs if present.
3. Check HTML syntax/runtime and first render before visual polish; a blank artifact is a P0 even if the design direction is good.
4. Check P0 first; fix P0 rather than merely listing it. Inspect the artifact for state DOM/rendering branches instead of accepting a prose state inventory.
5. Check P1/P2 according to scope.
6. Use optional automated checks only when available and relevant.
7. If verification cannot run, say which checks were reasoned from source/HTML and which still require rendered inspection.
