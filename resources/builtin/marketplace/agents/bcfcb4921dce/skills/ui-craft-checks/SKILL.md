---
ownerAgent: bcfcb4921dce
name: ui-craft-checks
description_zh: "UIDesigner 的 HTML 设计质量门槛；在交付前或 review/polish 时检查可访问性、状态覆盖、表单验证、动效克制、排版层级、响应式/RTL、反 AI 模板味、截图/设计源保真，并按条件使用可选自动检查。"
description_en: "UIDesigner's HTML craft quality gate; use before delivery or during review/polish to check accessibility, state coverage, form validation, motion discipline, typography hierarchy, responsive/RTL behavior, anti-AI-template tells, screenshot/design-source fidelity, and optional automated checks when available."
category: rnd
---

# ui-craft-checks

Use this skill as UIDesigner's final quality gate for HTML artifacts, implemented app screens, live-ready views, design-source handoffs, and UI reviews. It adapts OpenDesign craft rules into practical checks that prevent attractive but fragile UI.

This skill does not replace `ui-html-renderer` or `ui-design-review`. It tells them what must be checked before delivery.

Run the gate internally by default. Surface the full checklist only for review, handoff, QA, or when the user asks for the detailed pass/fail matrix.

## When To Use

Use this skill when:

- UIDesigner has produced or modified HTML.
- The user asks for review, polish, harden, launch-readiness, quality, accessibility, or "反 AI 味".
- A screenshot/design-source redesign needs fidelity validation.
- A form, data view, dashboard, live artifact, or interactive control is present.
- The artifact will be shared, implemented, or used as a design handoff.

For tiny text-only answers, skip this skill.

## Severity

- `P0`: Must fix before final delivery.
- `P1`: Should fix before production or stakeholder review.
- `P2`: Polish; fix when scope allows.

## P0 Gates

The artifact fails the craft pass if any P0 is present:

- **Not HTML by default**: a UI/design deliverable is only prose, PNG, SVG, Markdown, or a raw asset gallery when the user did not request that final format.
- **Source drift**: screenshot, Figma/design-source, or explicit contract structure is replaced by an unrelated dashboard, table, chart, sidebar, pricing page, or kanban board.
- **Missing critical states**: a data-fetching or data-transforming surface lacks loading, populated, empty, error, and edge/partial states.
- **Broken form validation**: required fields lack labels, helper/error text, submitted-pending behavior, or recovery from invalid input.
- **Keyboard/accessibility failure**: interactive controls are not keyboard reachable, focus-visible is absent, icon-only controls lack names, or native elements are replaced with inert divs.
- **Unsafe live data**: live-ready artifacts persist tokens, credentials, cookies, auth headers, raw provider responses, or secret-like fields.
- **Text/layout collision**: text overlaps controls, is clipped without intent, or mobile layout hides the primary action.
- **Broken HTML/runtime**: invalid or malformed HTML, unclosed critical tags, inline JavaScript syntax/runtime errors, or missing root content causes a blank or unusable first render.
- **False capability claim**: the response claims Figma import, connector refresh, external-browser validation, or accessibility checks happened when they did not.
- **Invented evidence**: sample metrics, placeholder records, inferred copy, or guessed assets are presented as observed source content or production data.

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
- HTML syntax/runtime:
- Source/design fidelity:
- State coverage:
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
4. Check P0 first; fix P0 rather than merely listing it.
5. Check P1/P2 according to scope.
6. Use optional automated checks only when available and relevant.
7. If verification cannot run, say which checks were reasoned from source/HTML and which still require rendered inspection.
