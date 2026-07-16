---
ownerAgent: bcfcb4921dce
name: ui-design-contract
description_zh: "为多屏、品牌、长期复用或参考冲突的 UIDesigner 任务建立持久设计契约，覆盖 DESIGN.md、source screen contract、tokens、keep/change/do-not-copy 边界和实现交接；普通单屏截图任务使用紧凑执行器即可。"
description_en: "Create durable UIDesigner design contracts for multi-screen, brand, long-lived, or conflicting-reference work across DESIGN.md, source-screen rules, tokens, keep/change/do-not-copy boundaries, and implementation handoff; ordinary single-screen screenshot work stays on the compact executor."
category: rnd
---

# ui-design-contract

Use this skill before rendering when the direction must persist across multiple screens/components, brand or system work, conflicting references, formal handoff, or a genuinely vague visual system. Ordinary single-screen screenshots and clear briefs use `ui-design-executor`'s compact source/visual thesis instead of loading a full durable contract.

The contract is not extra ceremony. It prevents generic templates, protects the user's reference intent, and gives the HTML artifact a stable design source of truth.

For standalone work, keep any long-lived `DESIGN.md` inside the canonical directory chosen by `ui-artifact-workspace`. On later revisions, read and update that contract in place only when the accepted design direction actually changes.

When the source is a Figma link/export, design JSON, PDF, or design-tool screenshot, use `ui-design-source` first so the contract is grounded in inspectable frames, components, variables, and fidelity boundaries.

When a visual benchmark or page pattern is needed, pair this skill with `ui-reference-packs` after the contract is drafted. Skip reference packs when the screenshot, repo tokens, or existing design system already provide enough direction. The contract decides what must be preserved; reference packs only help choose style DNA and pattern boundaries.

## When To Create A Contract

Create a compact durable contract before HTML when any of these are true:

- The screenshot/reference spans multiple screens, must establish a reusable direction, or contains conflicting evidence that a compact executor snapshot cannot resolve.
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

## DESIGN.md Compatibility

When a reusable visual system is needed, create or summarize a `DESIGN.md`-compatible contract. The goal is not to copy a public brand document; it is to give coding agents a durable, versionable design source of truth for this product.

Include compact metadata when useful: name, version, source, fidelity mode, and token format. Then use these nine headings:

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

If token detail matters, express it in role-based or DTCG-like terms that `ui-design-system` can turn into CSS variables: color roles (`bg`, `surface`, `text`, `accent`), typography roles (`title`, `body`, `label`), spacing scale (`xs` to `lg`), and radius roles (`control`, `panel`).

Do not import public `DESIGN.md` files or brand analyses wholesale. Use them only to understand structure, vocabulary, and quality bar; the actual contract must be grounded in the user's source, repo, and ownership boundaries.

## Reference Boundaries

For each reference, state:

- `Keep`: transferable qualities such as density, composition rhythm, material feel, type contrast, color temperature, interaction attitude, or component behavior.
- `Change`: product content, navigation, copy, data model, brand fit, density, or layout changes needed for the user's actual job.
- `Do not copy`: logos, protected assets, exact layouts, claims, pricing, proprietary UI, unique illustrations, or any source content the user does not own.

When references conflict, choose one recommended direction and name the tradeoff. Do not generate five unrelated moodboards unless the user asks for options.

## HTML Implementation Handoff

Before `ui-design-executor` writes the artifact, hand off:

- Contract name or direction.
- Source of truth: screenshot, repo tokens, user brief, brand reference, or inferred system.
- Layout model.
- Token decisions: color, type, spacing, radius, border, elevation, motion.
- Component families and required states.
- Source-to-redesign mapping for every major screenshot region.
- Responsive requirements.
- Asset rules and do-not-copy constraints.
- Acceptance gates the HTML must prove.
- State/story coverage for components that need reusable variants.
- Fixed decisions that ordinary follow-up edits must preserve, plus any deliberately open axes.

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
- Tokens and component rules are specific enough to produce HTML/CSS, not only mood adjectives.
- Public reference systems are treated as structure and quality inspiration, not as copied brand identity.

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
- State/story coverage:
- Reference pack, if used:
- Rejected patterns:
- Responsive:
- Anti-patterns:
- HTML acceptance gates:
```

If the user asks for actual files or a long-running design system, write `DESIGN.md` beside the entry file in the canonical artifact directory or inside the target project according to local conventions.
