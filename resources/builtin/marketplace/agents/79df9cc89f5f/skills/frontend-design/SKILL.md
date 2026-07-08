---
ownerAgent: 79df9cc89f5f
name: frontend-design
description_zh: VideoStudio 的 HTML/动态图形审美层——在 stage-compose 写 design-contract.json 与 index.html 前，用主题世界、字体、配色、布局签名、动效克制和反模板检查，把普通可渲染页面提升为有明确视觉观点的视频画面。
description_en: Aesthetic direction for VideoStudio HTML and motion-graphics compositions. Use before stage-compose writes design-contract.json and index.html to choose a subject-specific visual point of view, type, palette, layout signature, restrained motion, and anti-template checks.
category: creation
---

# frontend-design

Use this as the design-lead layer for VideoStudio COMPOSE work. It shapes HTML/SVG motion graphics before `stage-compose` turns them into `project/composition/design-contract.json` and `index.html`.

This skill does not pick the video production line, replace `video-craft`, or relax Orkas renderer constraints. If there is a conflict, renderer determinism, safe zones, legibility, audio ownership, and user-approved creative direction win.

## Design Thesis

Before writing HTML, choose a compact visual thesis:

- `subject_world`: the real materials, artifacts, interface metaphors, gestures, environment, or culture of the topic.
- `audience`: who must understand this at phone size and what they already know.
- `one_job`: what this video frame sequence must make clear.
- `tone`: one or two precise words that shape type, color, spacing, and motion.
- `signature_device`: one memorable visual move that belongs to this brief.
- `aesthetic_risk`: one justified choice that avoids generic output without hurting readability.

Keep the thesis specific. "Modern tech style" is not a thesis. "Battery-lab oscilloscope traces become the progress line" is.

## Avoid Template Gravity

Reject choices that could fit almost any brief:

- Purple/blue neon gradients, glass panels, generic bento cards, floating UI cards, decorative blobs, and stock SaaS dashboards unless the subject truly calls for them.
- Numbered markers, timelines, terminal windows, blueprint grids, or newspaper rules when the content is not actually sequential, technical, architectural, or editorial.
- A palette made from one hue family with lighter/darker variations only.
- Long labels in circles, tiny badges, dense microcopy, or walls of text doing the visual's job.
- Motion everywhere. Spend motion on the one thing the viewer must notice.

If the first design idea feels like a reusable demo template, revise the thesis before coding.

## Contract Fields

Add an `aesthetic` object to `project/composition/design-contract.json`:

```json
{
  "aesthetic": {
    "subject_world": "what the visual language borrows from",
    "audience": "who it is for",
    "one_job": "the frame sequence's job",
    "tone": ["precise", "brief"],
    "signature_device": "one remembered visual behavior",
    "aesthetic_risk": "the deliberate non-default choice",
    "anti_template_check": "what was rejected as too generic"
  }
}
```

The rest of the contract must make the thesis executable:

- `typography_tokens`: role-based, not just sizes. Include display, body, data/label, and caption roles when needed.
- `color_tokens`: named baseline values with rationale. Include neutrals, primary accent, and any purposeful supporting accents needed for brand, hierarchy, data meaning, or scene variation.
- `layout_boxes`: describe visual hierarchy, not only coordinates. Name the focal zone and supporting zones.
- `motion_budget`: state what carries meaning, what stays still, and how each transition maps to the story.
- `scene_variation`: prevent three near-identical card/title scenes in a row.

## HTML Direction

When writing `index.html`:

- Derive the main CSS variables from `design-contract.json`; keep extra chromatic colors intentional and named enough to audit. Do not flatten the design or recolor the whole video only to reduce a static palette count.
- Let one element carry personality: a custom progress line, typographic reveal, diagram grammar, texture, data mark, or transition family. Keep surrounding elements quiet.
- Use type as design material: contrast display/body roles, make title/body hierarchy unmistakable, and keep labels large enough for the video-craft floor.
- Use structural marks only when they encode meaning: steps for sequences, coordinates for maps, ticks for time, nodes for relationships, brackets for comparison.
- Prefer SVG for diagrams, paths, meters, masks, charts, and signature geometry; keep prose and captions as real HTML text.
- Default to SVG/static held states first. Use GSAP only when a timed reveal, transition, or emphasis genuinely improves comprehension; animate SVG groups or a few containers instead of many HTML cards.
- For vertical video, design for platform UI: keep essential text away from the bottom action area and make the first frame readable as a thumbnail.
- Respect `prefers-reduced-motion` in CSS where practical, but drive render-critical animation through the paused GSAP timeline.

## Build Loop

1. Draft the thesis and contract.
2. Self-critique the contract: name the most generic choice and replace it.
3. Write HTML/SVG from the contract.
4. Run the draft QA command. If `draft_disposition.blocking_error_count` or structural/video/audio QA fails, repair the contract or scene structure first; do not only nudge CSS numbers. Treat visual/readability findings as draft notes unless they make the approved message unreadable.
5. After a rendered draft, judge the first frame, one mid-frame, and the payoff frame for: clear focal point, subject-specific visual language, readable type, and motion with purpose.

## Output Standard

When reporting a COMPOSE draft or blocker, include the short design direction used: thesis, signature device, and any inspect/craft issue that forced a design change.
