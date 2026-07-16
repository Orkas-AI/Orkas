---
ownerAgent: bcfcb4921dce
name: ui-taste
description_zh: "处理明确的反模板审美挑战、表现型改版、品牌视觉论点或专项 critique，覆盖密度、动效、领域化签名和高质量界面判断；普通设计使用紧凑执行器。"
description_en: "Handle explicit anti-template taste challenges, expressive restyles, brand visual theses, or focused critique across density, motion, domain-specific signature, and high-quality judgment; ordinary design uses the compact executor."
category: rnd
---

# ui-taste

Use this specialist when the user explicitly asks for a less generic/less AI-looking direction, an expressive restyle, brand-led visual thesis, or a taste critique. `ui-design-executor` already carries the baseline subject grounding and visual thesis for ordinary work.

## Ground The Design In The Subject

Before choosing a style, identify:

- The concrete product or subject, not only a broad category such as “AI SaaS”.
- The audience and pressure they feel: speed, trust, comparison, learning, creativity, delight, or compliance.
- The page's single job and the primary workflow that proves it.
- The subject's own visual material: tools, objects, environments, vocabulary, data shapes, imagery, or physical qualities.
- Real or representative content that makes this artifact belong to the product.

Typography, structure, imagery, copy, and motion should come from this evidence. A design that could keep the same layout and copy after swapping the product name has not gone far enough.

## Visual Thesis

Before rendering a design, define:

- `product_type`: operational tool, creative workspace, consumer product, developer tool, marketplace, education, finance, content, or brand site.
- `subject`: concrete product world and the material or behavior the UI can borrow from.
- `audience_pressure`: the user's dominant need.
- `single_job`: what this page must help the user complete or understand.
- `primary_workflow`: the action users repeat.
- `density`: compact, balanced, spacious, or editorial.
- `tone`: 2 precise words, not "modern" or "clean" alone.
- `palette_roles`: 4–6 named functional colors or existing product tokens.
- `type_roles`: deliberate display/title, body, label, and data choices as applicable.
- `layout_concept`: one sentence explaining how composition supports the job.
- `signature_device`: one subject-specific visual rule, not decoration.
- `aesthetic_risk`: one intentional choice that gives the artifact a point of view without harming usability.
- `anti_template_rejection`: what generic idea you rejected.

A design without a thesis becomes default SaaS UI.

## Two-Pass Taste Loop

1. Draft the Visual Thesis before coding.
2. Challenge each free choice: could the same palette, type, layout, card structure, copy, or motion appear unchanged in several unrelated prompts?
3. Replace the generic choices and record the reason internally.
4. Build from the revised thesis instead of improvising a different style in code.
5. Review the rendered result against the brief, source, and thesis. Fix drift before decorative polish.

For follow-up edits, the accepted artifact is part of the brief. Preserve its working signature and fixed decisions unless the user asks to change direction.

## Anti-Template Rejections

Reject these unless they are explicitly justified:

- Purple-blue neon gradients for AI products.
- Glass panels, blur-heavy surfaces, and decorative bokeh.
- Generic bento grids for tools that need workflow density.
- Floating page-section cards.
- Cards inside cards.
- Oversized hero sections for apps, dashboards, editors, or tools.
- Monochrome one-hue palettes made from tints of a single color.
- Decorative orbs, blobs, and abstract SVG backgrounds.
- Tiny badges and over-dense microcopy replacing clear hierarchy.
- Motion everywhere instead of meaningful motion.
- Trend-default combinations that have become detached from the subject, even when each ingredient is individually attractive.

These are warning signs, not universal bans. A referenced brand, suitable subject, or explicit brief may justify one of them. The design must be able to explain why it belongs.

## Domain Fit

Match the UI to the work:

- SaaS operations: quiet, dense, fast scanning, predictable controls.
- Developer tools: precise type, code/data affordances, clear states, restrained contrast.
- Finance/trading: tabular clarity, risk status, high density, strong alignment.
- Creative tools: canvas-first, toolbars, palettes, shortcuts, direct manipulation.
- Education: progression, feedback, explanations, gentle structure.
- Ecommerce: product inspection, comparison, trust, conversion, clear imagery.
- Brand/editorial: stronger typography and imagery, but only if the first viewport communicates the object or offer.

## Variation Controls

Adjust deliberately:

- Visual density: information per viewport.
- Contrast: calm, standard, high.
- Motion intensity: none, subtle, expressive.
- Shape language: sharp, practical, soft, playful.
- Surface depth: flat, bordered, raised, layered.
- Type personality: neutral, technical, editorial, humanist, display-led.

Use only 1-2 expressive axes at a time. If everything is expressive, nothing is readable.

Minimalism is not an excuse for generic output: it requires exact spacing, typography, alignment, content, and interaction detail. Maximalism is not an excuse for noise: complexity must still serve hierarchy and the page's single job.

## Good-Taste Checks

Before delivery, ask:

- Can a target user complete the main task without reading an explanation?
- Is the primary action obvious?
- Does hierarchy come from layout and type, not decoration?
- Does the page look specific to this product, not any startup?
- Are there enough real states to judge the interface?
- Does mobile still feel designed, not squeezed?
- Is there one memorable visual choice, and does it help the work?
- Does every structural device communicate real grouping, order, status, or hierarchy rather than acting as decoration?
- Did the rendered result keep the revised thesis, or did implementation drift back to defaults?

## Reporting

When describing design direction, include:

- Visual thesis.
- Signature device.
- Justified aesthetic risk.
- Rejected generic choice.
- Density and motion settings.
- One tradeoff the design makes intentionally.
