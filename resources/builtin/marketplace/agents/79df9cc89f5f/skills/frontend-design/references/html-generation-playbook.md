# HTML generation playbook

Use this when mapping reference frames into `art_direction` and before writing `index.html`. This is an internal authorship pass, not a user gate and not a new required project file.

## Private pre-code art direction

Use the path selected in `frontend-design`. Keep the result in the existing manifest; this pass implements its scene plan.

### Reference-led composition

For each scene about to be planned or implemented, open its saved source frame as an image with `read_files` (`metadata_only: false`) immediately before authoring. Earlier inspection receipts and plan prose do not keep the pixels visible in a later turn. Use the visible frame and mapped source time to fill the existing fields below, then write that scene description or HTML while the frame is in context:

1. **Elements and substitutions** — identify the source elements and their roles. Replace their content with confirmed target copy and explicit user changes, retaining the visual relationships.
2. **Recurring carrier** — retain the element and connections that continue between the mapped source scenes.
3. **Type hierarchy** — derive relative title/body/label scale, placement and contrast from the source while preserving approved casing.
4. **Spatial arrangement** — put named regions, relative positions and sizes, grouping and connections in `art_direction.scenes[].composition`. Record the source frame/time with this description. For example: a main card centered above three equal child cards, joined by branching lines; replace the card copy inside that arrangement. This describes a particular frame, not a theme such as "modular cards".
5. **Observed motion** — fill opening/resolved states and motion verbs from the observed changes and holds, using the declared temporal anchors. Unseen movement remains unknown under `reference-recreation`.

Build the static HTML/CSS/SVG from those mapped regions, then apply the content substitutions before adding motion. Keep the source scene sequence and layout changes within the user's preserve/may-change scope. Implementation primitives fit these regions; a new visual metaphor is an original-design decision.

### Original composition

Without a concrete reference, decide five things before coding:

1. **Material world** — list the real artifacts, surfaces, marks, diagrams, interfaces, documents, objects, or physical behaviors that belong to the topic. Prefer those over generic circles and lines.
2. **Recurring carrier** — choose one visual object that can move through the story: signal, rule, token stream, document strip, route, waveform, product surface, cursor, scale, or data mark.
3. **Type behavior** — choose how display, supporting copy, labels, and data differ through family, width, weight, scale, color, spacing, or tracking while preserving approved casing.
4. **Spatial rhythm** — alternate where the dominant mass lives. A sequence can move left-heavy → full-field → right-heavy → centered payoff; it should not reset to the same top-left title layout each time.
5. **Motion logic** — decide what information is established, explained, and resolved. Motion must change meaning or state, not merely prove that animation exists.

For every scene, internally answer:

- What single visual object explains this beat without narration?
- Where does the largest visual mass sit, and how much of the safe canvas does it occupy?
- What are the background, midground, and foreground layers?
- What is already visible on the first frame of the scene?
- What new understanding exists in the resolved frame?
- What enters from the previous scene and what leaves for the next one?
- Which primitive or custom SVG construction will implement it?

Put compact answers in the existing design contract scene fields when they help HTML execution. Do not create a separate approval artifact.

Before coding the first scene, resolve the dedicated cover contract separately: approved headline, dominant hero, at least two concrete signals of the video's real content, and a composition that still communicates at thumbnail size. Frame 0 is the exported cover, so it cannot be a generic title treatment or an incomplete tween state.

## Original composition preferences

Without a concrete reference, compose intentional video frames:

- Use asymmetric tension, scale contrast, edge anchoring, cropping, overlap, or a strong full-field structure. Do not center every object inside generous web-page whitespace.
- Let meaningful material occupy the canvas. Empty space is useful only when it creates direction, suspense, scale, or emphasis.
- Use three semantic depth layers. Background structure should belong to the subject; midground carries the main message; foreground annotations, ticks, fragments, or masks create scale and finish.
- Build one dominant focal point and one supporting focal point. Tiny labels scattered around a small diagram do not create hierarchy.
- Prefer a few large shapes and readable annotations over many small cards. At phone size, labels must remain legible and the hero graphic must still read as a silhouette.

## Opening, explanation, resolved

For both paths, keep exact words, dates, numbers, and CTA copy as real HTML. Use SVG for geometry, relationships, paths, masks, charts, and spatial systems.

Reference-led scenes take their states from the observed source. For original work, design three states:

1. **Opening** — the premise and visual identity are already visible. The first scene must never be a blank canvas waiting for a fade.
2. **Explanation** — structure, comparison, connection, or causality becomes visible in a controlled sequence.
3. **Resolved** — the completed idea holds long enough to read and should be visibly different from the opening state.

For both paths, author the resolved state first in HTML/CSS/SVG, then implement the planned opening and explanation states. For original work, choose which parts begin muted, clipped, offset, or incomplete; avoid using only container opacity.

For the first scene:

```js
// The opening composition is visible at t=0. Animate supporting structure,
// not the whole scene from a blank frame.
tl.set('#s01', { opacity: 1 }, 0)
  .fromTo('#s01 .signal',
    { strokeDashoffset: 720 },
    { strokeDashoffset: 0, duration: 1.2, ease: 'power2.out' }, 0)
  .fromTo('#s01 .annotation',
    { opacity: 0.25, y: 18 },
    { opacity: 1, y: 0, duration: 0.65, stagger: 0.08 }, 0.25);
```

For later scenes, a hard cut, wipe, carried object, or short crossfade may reveal the next scene at its start. Do not spend the first second of every scene fading an empty layout into view.

## Original scene variation

Without a concrete reference, keep typography, palette, stroke character, corner treatment, and the recurring carrier consistent. Vary two or more of these per scene:

- dominant mass position;
- full-field versus split composition;
- visual grammar: document, path, network, comparison, scale, object, quote;
- camera/framing: macro crop, overview, detail, centered payoff;
- motion behavior: draw, reveal, accumulate, transform, converge;
- relationship between text and visual: integrated, adjacent, overprinted, annotated.

Variation is structural, not a new palette or unrelated visual style every few seconds.

## Original generation-time anti-patterns

In original work, replace these before coding:

- `top-left headline + small diagram below` repeated across the sequence;
- a pure-color background with only one thin SVG group;
- four words placed around a circle as a substitute for an explanation;
- multiple diagonal lines without scale, anchors, values, or change over time;
- universal Arial/Helvetica with no meaningful role contrast;
- all scene roots fading from opacity zero;
- a final frame that is identical to the prior scene midpoint;
- arbitrary decorative particles, blobs, cards, grids, or glows unrelated to the topic.

## Initial-generation checklist

Before saving `index.html`, verify from the source itself:

- frame 0 contains the promise and a subject-specific visual signal;
- frame 0 satisfies every `art_direction.cover.content_signals` item and reads as the actual video's cover;
- reference images and videos satisfy their reproduce/edit/guide intent, protected axes, allowed changes, and layout/temporal anchors;
- scene layering follows the source, or the planned background/midground/foreground for original work;
- each scene has a large, recognizable hero visual;
- the spatial sequence follows the mapped source, or varies within the original visual system;
- opening/resolved states follow the observed changes and holds, or reveal new information in original work;
- continuity follows the source carrier, or the chosen original motif;
- typography roles differ beyond font size;
- SVG structure encodes real content rather than generic decoration;
- no remote runtime dependency is required;
- animation is deterministic and registered on the paused GSAP timeline.
