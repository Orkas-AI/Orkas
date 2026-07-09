---
ownerAgent: bcfcb4921dce
name: ui-design-system
description_zh: "把产品目标或现有界面转成可实现的 UI 系统，覆盖 DESIGN.md/DTCG 风格 token、组件状态、组件库行为映射、设计系统审查和 HTML/实现交付。"
description_en: "Turn product goals or existing screens into implementable UI systems across DESIGN.md/DTCG-style tokens, component states, component-library behavior mapping, design-system review, and HTML/implementation handoff."
category: rnd
---

# ui-design-system

Use this skill when creating, extending, or auditing a product UI system. It adapts Better Design-style design-system discipline without requiring an external runtime package.

Pair this skill with `ui-design-contract` when the user provides references, screenshots, brand material, or asks for a reusable direction. The contract defines what the system must preserve; this skill turns it into tokens and components.

When `ui-reference-packs` selects a design-system pack, treat it as advisory style DNA. Translate it into the local token model and component map; do not copy named-brand assets, exact layouts, or proprietary product chrome.

Use public UI libraries and design systems as behavior references, not default dependencies. shadcn/ui, Radix, Headless UI, React Spectrum, Ant Design, MUI, Carbon, and similar systems can inform component states, keyboard behavior, density, and token discipline; only implement with one of them when the target app already uses it or the user explicitly asks.

## Design System Job

A UI system is not a moodboard. It must define reusable decisions that help the product ship:

- Who the product serves and what workflow the UI optimizes.
- What layout model organizes repeated work.
- Which component families exist, with variants and states.
- Which tokens drive typography, color, spacing, radius, borders, elevation, motion, and density.
- Which rules prevent one-off styling and component drift.
- How the design becomes HTML or target-app implementation.

For reusable systems, express the result in a `DESIGN.md`-compatible shape when useful:

- Visual theme and atmosphere.
- Color.
- Typography.
- Spacing and grid.
- Layout and composition.
- Components.
- Motion and interaction.
- Voice and brand.
- Anti-patterns.

## Context To Extract

Before designing, inspect or infer:

- Product domain: operational tool, creative app, developer tool, finance, education, commerce, content, or consumer.
- Main workflow: create, review, compare, monitor, configure, analyze, search, or collaborate.
- Existing UI framework and components.
- Selected reference pack, if any, plus rejected patterns from `ui-reference-packs`.
- For screenshots or image references: visible copy, page type, major regions, controls, repeated items, and what content is unknown.
- Current token source: CSS variables, Tailwind config, design-token files, component library, or ad hoc CSS.
- Navigation model: sidebar, top nav, split pane, command palette, tabs, wizard, canvas, or feed.
- Data density: sparse editorial, balanced product UI, or dense operational cockpit.
- Constraints: mobile, desktop, accessibility, brand, localization, dark mode, and real data variability.

For screenshot-based redesigns, the source screen is the contract. Preserve its workflow, content groups, and component families unless the user explicitly asks to change them. Do not replace a landing/input page with a dashboard, table, chart, sidebar, or operational cockpit simply because the user selected a broad page category.

## Token Model

Define tokens by role, not by vague color or size names.

For reusable systems, keep tokens close to the Design Tokens Community Group (DTCG) and Style Dictionary mental model: a token has a name, value, type, purpose, and optional mode. For example: `color.bg` (`color`, page background), `color.accent` (`color`, primary action/selected state), and `space.md` (`dimension`, default component gap). Do not require external build tooling unless the repo already uses it.

When writing CSS, export the same intent as custom properties such as `--color-bg`, `--color-accent`, `--space-md`, and `--radius-control`. This preserves portability without forcing Style Dictionary into every project.

Typography:

- `display`: only for true page or hero titles.
- `title`: screen or panel headings.
- `body`: readable paragraph or field content.
- `label`: form labels, metadata, table headers.
- `data`: numbers, metrics, monospace identifiers, code-like content.
- `caption`: secondary notes and timestamps.

Color:

- `bg`: page background.
- `surface`: panels, controls, rows, inputs.
- `surface-raised`: menus, popovers, dialogs.
- `text`: primary content.
- `text-muted`: metadata, placeholders, helper text.
- `border`: dividers and component outlines.
- `accent`: primary action or selection.
- `danger`, `warning`, `success`, `info`: semantic statuses only.

Spacing and density:

- Use a compact scale for operational products, usually 4/8/12/16/24/32.
- Reserve large whitespace for reading or marketing, not dashboards or repeated workflows.
- Keep table rows, forms, filters, and sidebars dense but scannable.

Shape and elevation:

- Default radius should be 8px or less unless the existing system says otherwise.
- Use borders and contrast before large shadows.
- Do not stack cards inside cards. Use full-width sections, panes, rows, or repeated item cards.

Motion:

- Use motion to explain state changes, reveal hierarchy, or maintain spatial continuity.
- Avoid ambient motion in work tools unless it is part of the domain.

## Component Map

Map UI to components before styling:

- Navigation: sidebar, top bar, breadcrumbs, tabs, command menu.
- Action controls: primary button, secondary button, icon button, split button, menu item.
- Data controls: table, grid, list, filters, sort, search, pagination, batch actions.
- Forms: input, textarea, select, combobox, checkbox, radio, toggle, slider, stepper.
- Feedback: toast, inline alert, empty state, loading skeleton, error state, validation message.
- Surfaces: panel, drawer, modal, popover, tooltip, detail pane.
- Content: cards only for repeated items or framed tools, not as a page-section default.

For each component, define variants, states, content limits, keyboard behavior, and responsive behavior.

## Component State And Story Model

Borrow Storybook's useful discipline without requiring Storybook to be installed:

- Define each reusable component in isolation before composing full pages.
- Cover realistic stories/states: default, hover, focus, disabled, loading, empty, error, selected, destructive, compact, long text, and mobile.
- Record inputs/props/content limits so a future implementation can reproduce the design.
- For forms, include pristine, touched, invalid, submitted-pending, success, and recovery states.
- For data components, include populated, empty, loading, partial, error, stale, and overflow states.

If the target repo already has Storybook, component docs, or a registry, align names and states with that source instead of inventing a parallel system.

## Handoff Shape

For design-system work, return or implement:

```markdown
## System Direction
- Product type:
- Design priority:
- Layout model:
- Density:
- Tone:

## Tokens
- Typography:
- Color:
- Spacing:
- Radius/border/elevation:
- Motion:
- DTCG/CSS variable mapping:

## Components
- Navigation:
- Data display:
- Forms:
- Feedback:
- Overlays:
- States/stories:

## HTML Design Draft
- File or artifact:
- Viewports represented:
- States represented:
```

If the user asked for a design draft, pair this with `ui-html-renderer`. The system is incomplete until it is visible in HTML.
