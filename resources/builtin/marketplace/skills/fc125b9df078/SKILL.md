---
name: product-ui
description_zh: "依据产品需求、用户流程或设计来源设计并实现页面、组件、落地页、仪表盘或设计系统，覆盖响应式、可访问性、UI 打磨与渲染验证。"
description_en: "Design and implement screens, components, landing pages, dashboards or design systems from product needs, flows or design sources, with responsive behavior, accessibility, UI polish and rendered checks."
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
| Build or improve UI, including standalone artifacts | [UI implementation](references/ui-implementation.md) |
| User asks for a known brand/style, DESIGN.md, or "make it look like X" | [Design style index](references/design-style-index.md), then one matching file under `references/design-styles/` |
| Need a design brief before coding, or the user asks for JSON/Markdown handoff | [UI brief template](references/ui-brief-template.md) |

Read only the relevant style reference. Do not load all design style files at once.

## Default Workflow

1. Identify the product goal, user flow, target users, platform, and existing app framework.
2. Inspect the current UI, design system, components, tokens, routes, and styling conventions.
3. Choose a UI direction: existing product style first; external style reference only when requested or useful.
4. Define the screen structure, states, interactions, requested viewport behavior, and accessibility requirements. Add responsive behavior only when the user asks for multi-device or narrow-screen support.
5. Implement using the app's existing framework and component patterns.
6. Follow the implementation reference's verification and handoff procedure before delivery; it owns screen coverage, rendered checks, interaction checks, recovery, and evidence freshness.

For a standalone greenfield UI with a clear audience, deliverable, and required sections, the absence of an existing app is not a blocker. Choose the smallest self-contained implementation, use clearly labeled editable sample content when authorized, and produce the complete artifact. Do not replace implementation with a handoff plan merely because no repository, brand system, personal assets, or deployment target was supplied.

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
