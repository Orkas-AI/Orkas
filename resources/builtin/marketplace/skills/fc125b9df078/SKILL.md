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
4. Define the screen structure, states, interactions, requested viewport behavior, and accessibility requirements. Add responsive behavior only when the user asks for multi-device or narrow-screen support.
5. Implement using the app's existing framework and component patterns.
6. For runnable local HTML, call `html_preview` on the actual entry before completion. `screenshots` defaults to false for audit-only results; set `screenshots:true` only for the final visual review. Pass `target:"responsive"` only when the user explicitly requests responsive, multi-device, or narrow-screen behavior; otherwise omit target for desktop or use mobile for an explicitly mobile artifact. Source inspection, media-query checks, a local server, PID, or HTTP response do not replace rendered evidence.
7. Summarize what changed, what visual behavior was verified, and any remaining design questions.

For a standalone greenfield UI with a clear audience, deliverable, and required sections, the absence of an existing app is not a blocker. Choose the smallest self-contained implementation, use clearly labeled editable sample content when authorized, and produce the complete artifact. Do not replace implementation with a handoff plan merely because no repository, brand system, personal assets, or deployment target was supplied.

For that standalone artifact, finish the whole delivery contract: include every requested section and reachable action, the requested viewport behavior, visible keyboard focus, adequate contrast, accessible labels or alt text, and `prefers-reduced-motion` handling. Add mobile or multi-device reflow only when the user requests it. Requested actions must work with included or inline sample content; do not point a download, image, form, or navigation action at a missing placeholder file. End with copy-paste deployment steps for a suitable static host and an honest checklist covering browser, requested viewport, link, form, and download checks; distinguish checks actually run from checks the recipient must still run. Make the checklist executable by naming every requested viewport (desktop by default), overflow and text-fit inspection, keyboard tab order/focus, link targets, form behavior, and generated download content and filename.

If `html_preview` reports a blocker, inspect its diagnostics; failed checks never return screenshots. Make the smallest runtime/resource/layout repair and rerun the same entry until every requested target succeeds. Do not hide overflow globally, shrink the entire page, or downgrade the result to a source-only check. On the final passing call use `screenshots:true`, inspect the returned screenshot(s), and name each captured target and size. Report Tab-key focus traversal and visible-focus counts, hash/mail links, filled/submitted forms, and observed download filenames, MIME types, and byte sizes. If the built-in tool is environmentally unavailable, keep rendered behavior unverified; do not search for or install Playwright, Puppeteer, Chromium, or another browser runtime.

Rendered evidence belongs to the exact UI revision it captured. After any change that may affect layout or behavior, discard affected pre-change evidence; after the final relevant edit, rerun `html_preview` with `screenshots:true`, inspect the new screenshots and interaction evidence, and report only that post-change evidence. If this rerun is unavailable, keep the affected behavior unverified.

## UI Rules

- Prefer existing app components, tokens, icons, spacing, and interaction patterns.
- If using a brand-style reference, adapt the style; do not copy logos, trademarks, proprietary text, or protected assets.
- Do not invent existing design-system components. Mark missing components as proposed or implement local UI only where appropriate.
- Keep the UI usable at every requested viewport, accessible, and aligned with the product task.
- Use familiar controls: icon buttons for tools, toggles for binary settings, sliders/inputs for numeric values, tabs for views, menus for option sets.
- Avoid decorative-only design that makes the workflow harder to scan or use.
- For production UI changes, verify that text fits, controls do not overlap, and major states are represented.

## Output Standard

When finishing, state:

- UI direction or style reference used.
- Files or screens changed.
- Verification performed, especially browser/screenshot checks when available.
- Remaining design or product questions.
