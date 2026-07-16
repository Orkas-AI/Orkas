---
ownerAgent: bcfcb4921dce
name: ui-reference-packs
description_zh: "为 UIDesigner 按需选择中性的设计系统参考原型和页面模式边界；用于参考图/品牌/弱视觉系统场景中选风格基因，并避免误套 dashboard/kanban/pricing 等模板。"
description_en: "Select conditional neutral design-system reference archetypes and page-pattern boundaries for UIDesigner; use when references, brand material, or weak visual systems need style DNA while preventing accidental dashboard/kanban/pricing template use."
category: rnd
---

# ui-reference-packs

Use this skill after `ui-design-contract` only when UIDesigner needs a visual-system reference, product pattern, or style benchmark. It adapts OpenDesign's design-system and template catalogue into a small routed reference layer for HTML-first UI work.

This skill does not copy OpenDesign templates or brand systems. It helps choose a direction, then `ui-design-executor` turns that direction into original UI; load a design-system or deep renderer specialist only when separately triggered.

If `ui-design-source` has produced a frame/component handoff, use that handoff as stronger evidence than any reference pack. If an existing app already has clear tokens and components, skip this skill unless the user asks for a new style direction. If `ui-live-artifact` has not classified the task as live-ready or connected-live, do not select the live-artifact pattern.

## Resource Map

Read only the relevant reference:

- `references/design-system-packs.md` — curated visual system packs inspired by OpenDesign `design-systems/`.
- `references/pattern-library.md` — page and artifact pattern boundaries inspired by OpenDesign `design-templates/`.

## Selection Workflow

1. Decide whether a pack is needed.
   - Use a pack when the user supplied references/brand material, asked for a style benchmark, the product has no clear visual system, or a broad pattern label must be accepted/rejected explicitly.
   - Skip packs when the screenshot or repo system already gives enough visual direction.
2. Start from the design contract.
   - Screenshot/page structure, user-provided constraints, and repo tokens outrank reference packs.
   - If no contract exists for a reference-heavy task, create one with `ui-design-contract` first.
3. Choose at most one primary design-system pack.
   - Optionally add one secondary influence for typography, density, or motion.
   - Do not blend many archetypes; blended taste turns generic quickly.
   - Use neutral archetype IDs in handoff notes instead of brand names.
4. Choose a page pattern only when the contract or user explicitly supports it.
   - Dashboard, kanban, pricing, mobile-frame, wireframe, and live-artifact patterns have narrow triggers.
   - A pattern is a structural permission, not a mandate.
5. Convert the chosen pack into UIDesigner tokens.
   - Color roles, type roles, spacing, radius, border, elevation, motion, and component behavior must be expressed in the local HTML/app system.
   - Do not copy logos, exact layouts, product claims, screenshots, or proprietary components.
6. Record the selection in the handoff.
   - Name the selected pack.
   - Explain why it fits.
   - State what was rejected and why.
   - Include any trigger guardrails, especially when not using a dashboard/kanban/pricing template.

## Hard Guardrails

- Do not use a reference pack to override visible screenshot information architecture.
- Do not infer "dashboard" from "business", "admin", "analytics-looking", or a form category unless metrics/charts/tables/monitoring are visible or requested.
- Do not use named brands as imitation. Borrow controllable qualities such as density, typography rhythm, interaction attitude, and role structure.
- Treat any brand/source provenance as internal inspiration. In user-facing summaries, use the neutral archetype ID and concrete token decisions.
- Do not mention OpenDesign in the user-facing artifact unless provenance or implementation notes matter.
- Do not fetch or load every reference pack. Pick the smallest relevant reference file and continue.

## Output Shape

When using this skill, include this compact note in the internal handoff or final summary when helpful:

```markdown
## Reference Pack Choice
- Primary pack:
- Secondary influence:
- Pattern used:
- Why it fits:
- Rejected patterns:
- Token translation:
- Copy/brand safety:
```
