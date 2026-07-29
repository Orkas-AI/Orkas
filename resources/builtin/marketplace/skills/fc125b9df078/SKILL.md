---
name: product-ui
description: Use to design and implement product UI from PRD, product goals, user flows, or existing app context. Use when the user asks to build or improve a UI, frontend screen, landing page, dashboard, component set, design-system-based interface, Figma-style brief plus implementation, brand-inspired UI, responsive layout, accessibility pass, or visual polish.
---

# Product UI

Use this skill when UI design and UI implementation should happen together. It turns product context into usable frontend screens, components, layout decisions, design-system choices, accessibility rules, and visual polish.

This skill combines:

- Product design brief and handoff ideas: goal, audience, flows, component mapping, accessibility, JSON/Markdown summaries when helpful.
- UI style references: curated DESIGN.md files from known websites for color, typography, components, layout, and visual tone.
- Frontend implementation guidance: inspect existing patterns, implement in the app's framework, and verify the rendered UI.

Do not use this skill to write a PRD, create product test scenarios, split backend/infra work, write low-level engineering plans, or run broad engineering quality gates. Keep the center of gravity on UI.

## Route The Work

| Situation | Read |
|---|---|
| Need to build or improve UI in an app | `references/ui-implementation.md` |
| User asks for a known brand/style, DESIGN.md, or "make it look like X" | `references/design-style-index.md`, then one matching file under `references/design-styles/` |
| Need a design brief before coding, or the user asks for JSON/Markdown handoff | `references/ui-brief-template.md` |

Read only the relevant style reference. Do not load all design style files at once.

## Default Workflow

1. Identify the product goal, user flow, target users, platform, and existing app framework.
2. Inspect the current UI, design system, components, tokens, routes, and styling conventions.
3. Choose a UI direction: existing product style first; external style reference only when requested or useful.
4. Define the screen structure, states, interactions, responsive behavior, and accessibility requirements.
5. Implement using the app's existing framework and component patterns.
6. For runnable local HTML, call `html_preview` on the actual entry before completion. It always renders desktop and mobile viewports and returns inline screenshots plus runtime, resource, image, focusable-control, and horizontal-overflow evidence. Source inspection, media-query checks, a local server, PID, or HTTP response do not replace this rendered evidence.
7. Summarize what changed, what visual behavior was verified, and any remaining design questions.

For a standalone greenfield UI with a clear audience, deliverable, and required sections, the absence of an existing app is not a blocker. Choose the smallest self-contained implementation, use clearly labeled editable sample content when authorized, and produce the complete artifact. Do not replace implementation with a handoff plan merely because no repository, brand system, personal assets, or deployment target was supplied.

For that standalone artifact, finish the whole delivery contract: include every requested section and reachable action, mobile reflow, visible keyboard focus, adequate contrast, accessible labels or alt text, and `prefers-reduced-motion` handling. Requested actions must work with included or inline sample content; do not point a download, image, form, or navigation action at a missing placeholder file. End with copy-paste deployment steps for a suitable static host and an honest checklist covering browser, responsive, link, form, and download checks; distinguish checks actually run from checks the recipient must still run. Make the checklist executable by naming at least one desktop and one mobile viewport, overflow and text-fit inspection, keyboard tab order/focus, link targets, form behavior, and generated download content and filename.

If `html_preview` reports a blocker, inspect both screenshots and the bounded diagnostics, make the smallest responsive/runtime/resource repair, and rerun the same entry until both viewports succeed. Do not hide overflow globally, shrink the entire page, or downgrade the result to a source-only check. In the final handoff, explicitly say both screenshot sizes were captured and inspected, then report Tab-key focus traversal and visible-focus counts, hash/mail links, filled/submitted forms, and observed download filenames, MIME types, and byte sizes. Add focused app-specific checks when the generic audit cannot prove a requested behavior. If the built-in tool is absent or fails for an environmental reason, report the exact blocker and keep rendered behavior unverified; do not search for or install Playwright, Puppeteer, Chromium, or another browser runtime.

## UI Rules

- Prefer existing app components, tokens, icons, spacing, and interaction patterns.
- If using a brand-style reference, adapt the style; do not copy logos, trademarks, proprietary text, or protected assets.
- Do not invent existing design-system components. Mark missing components as proposed or implement local UI only where appropriate.
- Keep the UI usable, responsive, accessible, and aligned with the product task.
- Use familiar controls: icon buttons for tools, toggles for binary settings, sliders/inputs for numeric values, tabs for views, menus for option sets.
- Avoid decorative-only design that makes the workflow harder to scan or use.
- For production UI changes, verify that text fits, controls do not overlap, and major states are represented.

## Output Standard

When finishing, state:

- UI direction or style reference used.
- Files or screens changed.
- Verification performed, especially browser/screenshot checks when available.
- Remaining design or product questions.
