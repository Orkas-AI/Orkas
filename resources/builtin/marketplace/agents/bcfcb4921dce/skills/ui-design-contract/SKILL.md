---
ownerAgent: bcfcb4921dce
name: ui-design-contract
description_zh: "把截图、参考图、品牌材料、PRD 或“做成这种感觉”的诉求转成 UIDesigner 可复用的设计契约，覆盖 DESIGN.md 九段、source screen contract、keep/change/do-not-copy 边界和 HTML 实现交接。"
description_en: "Turn screenshots, references, brand material, PRDs, or 'make it feel like this' briefs into a reusable UIDesigner contract across a nine-section DESIGN.md shape, source screen contract, keep/change/do-not-copy boundaries, and HTML implementation handoff."
category: rnd
---

# ui-design-contract

Use this skill before rendering when the user provides screenshots, visual references, brand material, existing UI, Figma notes, PRDs, or vague taste direction. It adapts OpenDesign-style `DESIGN.md` and reference-contract discipline into UIDesigner's HTML-first workflow.

The contract is not extra ceremony. It prevents generic templates, protects the user's reference intent, and gives the HTML artifact a stable design source of truth.

When the source is a Figma link/export, design JSON, PDF, or design-tool screenshot, use `ui-design-source` first so the contract is grounded in inspectable frames, components, variables, and fidelity boundaries.

When a visual benchmark or page pattern is needed, pair this skill with `ui-reference-packs` after the contract is drafted. Skip reference packs when the screenshot, repo tokens, or existing design system already provide enough direction. The contract decides what must be preserved; reference packs only help choose style DNA and pattern boundaries.

## When To Create A Contract

Create a compact contract before HTML when any of these are true:

- The user provides a screenshot or image and asks for redesign, restoration, polishing, or page generation.
- The user says "make it feel like this", "参考这个", "做同款但不照抄", or gives brand/style references.
- The request spans more than one screen, component family, or visual system.
- The user asks for a design system, brand board, logo/identity board, or implementation handoff.
- Existing app tokens/components are unclear and the agent must infer a direction.

If the user only asks for a tiny local UI tweak with a clear existing system, a full contract can be a short inline "contract snapshot".

## Evidence Ledger

Every contract separates facts from guesses:

- `observed`: visible in the screenshot, HTML, repo, Figma notes, or rendered UI.
- `provided`: explicitly stated by the user.
- `inferred`: a reasonable choice made from context.
- `unknown`: missing information that could change the design.

Do not let inferred items override observed screenshot structure or provided user constraints.
Do not let an inaccessible Figma URL count as observed evidence. Treat it as provided context until a connector, export, screenshot, or notes are actually inspected.

## Source Screen Contract

For screenshot or image-based work, extract this before choosing a new layout:

```markdown
## Source Screen Contract
- Page type:
- Primary user job:
- Visible text:
- Major regions:
- Controls and component inventory:
- Repeated items:
- Visual hierarchy:
- Color roles:
- Typography roles:
- Density and spacing:
- Must preserve:
- May change:
- Unknown or low-confidence areas:
```

The screenshot is the contract for information architecture. Do not replace an input page, landing view, editor, chat surface, form, or simple settings screen with a dashboard, table, chart, sidebar, or operational cockpit unless those elements are visible or explicitly requested.

## DESIGN.md Shape

When a reusable visual system is needed, create or summarize a `DESIGN.md` using these nine headings:

1. `## 1. Visual Theme & Atmosphere`
2. `## 2. Color`
3. `## 3. Typography`
4. `## 4. Spacing & Grid`
5. `## 5. Layout & Composition`
6. `## 6. Components`
7. `## 7. Motion & Interaction`
8. `## 8. Voice & Brand`
9. `## 9. Anti-patterns`

Keep each section operational. Prefer constraints the next HTML pass can obey:

- Good: "single warm amber accent for primary actions; no purple-blue glow".
- Weak: "premium, modern, elegant".

## Reference Boundaries

For each reference, state:

- `Keep`: transferable qualities such as density, composition rhythm, material feel, type contrast, color temperature, interaction attitude, or component behavior.
- `Change`: product content, navigation, copy, data model, brand fit, density, or layout changes needed for the user's actual job.
- `Do not copy`: logos, protected assets, exact layouts, claims, pricing, proprietary UI, unique illustrations, or any source content the user does not own.

When references conflict, choose one recommended direction and name the tradeoff. Do not generate five unrelated moodboards unless the user asks for options.

## HTML Implementation Handoff

Before `ui-html-renderer` writes the artifact, hand off:

- Contract name or direction.
- Source of truth: screenshot, repo tokens, user brief, brand reference, or inferred system.
- Layout model.
- Token decisions: color, type, spacing, radius, border, elevation, motion.
- Component families and required states.
- Source-to-redesign mapping for every major screenshot region.
- Responsive requirements.
- Asset rules and do-not-copy constraints.
- Acceptance gates the HTML must prove.

For standalone drafts, the contract can be embedded as a visible "Design System" or "Handoff" section only when useful. For app screens, keep the artifact focused on the product experience and mention the contract in the final handoff.

## Quality Gates

Before rendering or final delivery, check:

- The main artifact type is explicit: app screen, component system, brand board, review page, deck, or other.
- Observed screenshot structure is preserved or explicitly changed.
- Inferred content is labeled and does not masquerade as source content.
- No generic template category overrides the provided reference.
- Any selected reference pack is named, justified, and rejected patterns are recorded when they could mislead the output.
- The contract names anti-patterns to avoid.
- The next HTML pass has enough concrete token and component guidance to execute without guessing.

## Output Shape

Use this compact shape in the final handoff when a separate file is not created:

```markdown
## Design Contract Snapshot
- Evidence:
- Design source:
- Direction:
- Keep:
- Change:
- Do not copy:
- Tokens:
- Components:
- Reference pack, if used:
- Rejected patterns:
- Responsive:
- Anti-patterns:
- HTML acceptance gates:
```

If the user asks for actual files or a long-running design system, write `DESIGN.md` beside the HTML artifact or inside the target project according to local conventions.
