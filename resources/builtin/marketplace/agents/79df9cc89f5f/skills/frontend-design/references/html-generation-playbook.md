# HTML generation playbook

Use this during the initial COMPOSE generation, after the brief/storyboard is approved and before writing `index.html`. This is an internal authorship pass, not a user gate and not a new required project file.

## Private pre-code art direction

For the whole piece, decide five things before coding:

1. **Material world** — list the real artifacts, surfaces, marks, diagrams, interfaces, documents, objects, or physical behaviors that belong to the topic. Prefer those over generic circles and lines.
2. **Recurring carrier** — choose one visual object that can move through the story: signal, rule, token stream, document strip, route, waveform, product surface, cursor, scale, or data mark.
3. **Type behavior** — choose how display, supporting copy, labels, and data differ through family/width/weight/case/tracking, not size alone.
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

## Compose a frame, not a page

A good video frame remains intentional when paused:

- Use asymmetric tension, scale contrast, edge anchoring, cropping, overlap, or a strong full-field structure. Do not center every object inside generous web-page whitespace.
- Let meaningful material occupy the canvas. Empty space is useful only when it creates direction, suspense, scale, or emphasis.
- Use three semantic depth layers. Background structure should belong to the subject; midground carries the main message; foreground annotations, ticks, fragments, or masks create scale and finish.
- Build one dominant focal point and one supporting focal point. Tiny labels scattered around a small diagram do not create hierarchy.
- Prefer a few large shapes and readable annotations over many small cards. At phone size, labels must remain legible and the hero graphic must still read as a silhouette.
- Treat exact words, dates, numbers, and CTA copy as real HTML. Use SVG for geometry, relationships, paths, masks, charts, and spatial systems.

## Opening, explanation, resolved

Every scene needs three authored states:

1. **Opening** — the premise and visual identity are already visible. The first scene must never be a blank canvas waiting for a fade.
2. **Explanation** — structure, comparison, connection, or causality becomes visible in a controlled sequence.
3. **Resolved** — the completed idea holds long enough to read and should be visibly different from the opening state.

Author the resolved state first in HTML/CSS/SVG, then decide which parts begin muted, clipped, offset, or incomplete. Avoid building a scene whose only change is container opacity.

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

## Scene variation without random style changes

Keep typography, palette, stroke character, corner treatment, and the recurring carrier consistent. Vary two or more of these per scene:

- dominant mass position;
- full-field versus split composition;
- visual grammar: document, path, network, comparison, scale, object, quote;
- camera/framing: macro crop, overview, detail, centered payoff;
- motion behavior: draw, reveal, accumulate, transform, converge;
- relationship between text and visual: integrated, adjacent, overprinted, annotated.

Variation is structural, not a new palette or unrelated visual style every few seconds.

## Generation-time anti-patterns

Replace these before coding:

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
- every scene has background, midground, and foreground intent;
- each scene has a large, recognizable hero visual;
- the spatial sequence varies without losing the shared visual system;
- opening and resolved states differ meaningfully;
- one carrier or motif creates continuity across the piece;
- typography roles differ beyond font size;
- SVG structure encodes real content rather than generic decoration;
- no remote runtime dependency is required;
- animation is deterministic and registered on the paused GSAP timeline.
