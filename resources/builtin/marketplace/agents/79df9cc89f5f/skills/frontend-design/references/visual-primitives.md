# Video visual primitives

These are adaptable ingredients for model-authored HTML, not fixed templates. Select only the primitives justified by the brief, then change geometry, scale, copy, density, and motion to fit the subject.

## 1. Composition chassis

Use a shared token chassis so scenes feel related while their layouts vary:

```css
:root {
  --bg: #081018;
  --ink: #f3f0e8;
  --muted: #9ca8b4;
  --accent: #ffb000;
  --support: #55d6c2;
  --danger: #ff665c;
  --safe-x: 112px;
  --safe-y: 92px;
  --hairline: 2px;
}

* { box-sizing: border-box; }
html, body { width: 1920px; height: 1080px; overflow: hidden; margin: 0; }
body {
  color: var(--ink);
  background: var(--bg);
  font-family: "Avenir Next", "Helvetica Neue", Arial, sans-serif;
}
.scene {
  position: absolute;
  inset: 0;
  overflow: hidden;
  isolation: isolate;
}
.safe { position: absolute; inset: var(--safe-y) var(--safe-x); }
.display {
  font-size: clamp(76px, 6.1vw, 118px);
  line-height: .9;
  font-weight: 760;
  letter-spacing: -.055em;
}
.supporting {
  max-width: 720px;
  font-size: 42px;
  line-height: 1.16;
  color: var(--muted);
}
.label {
  font-size: 38px;
  line-height: 1;
  font-weight: 650;
  letter-spacing: .12em;
  text-transform: uppercase;
}
```

Derive tokens from the design contract. Do not paste this palette into unrelated work.

## 2. Topic-derived background field

A background field establishes material and depth without becoming a dashboard:

```css
.field::before {
  content: "";
  position: absolute;
  inset: -8%;
  z-index: -2;
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--ink) 7%, transparent) 1px, transparent 1px),
    linear-gradient(color-mix(in srgb, var(--ink) 5%, transparent) 1px, transparent 1px);
  background-size: 96px 96px;
  mask-image: linear-gradient(90deg, transparent, #000 18%, #000 82%, transparent);
}
.field::after {
  content: "";
  position: absolute;
  width: 820px;
  height: 820px;
  right: -240px;
  top: 80px;
  border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--accent) 18%, transparent), transparent 68%);
  filter: blur(24px);
  z-index: -1;
}
```

Adapt the field to the topic: manuscript rules, map coordinates, spectral bands, film grain, product geometry, waveform lanes, token cells, or measured laboratory ticks. A generic grid is not automatically appropriate.

## 3. Asymmetric split

Use for an argument plus one substantial visual:

```css
.split {
  display: grid;
  grid-template-columns: minmax(0, .78fr) minmax(0, 1.22fr);
  gap: 88px;
  align-items: center;
  height: 100%;
}
.split[data-mass="left"] { grid-template-columns: 1.25fr .75fr; }
.split__visual { min-height: 700px; position: relative; }
```

The visual zone should contain a real diagram, object, image crop, chart, or structural typographic composition. Do not place a small icon in a large empty column.

## 4. Editorial title wall

Use an oversized, edge-anchored title plus subject evidence—not a centered hero card:

```css
.title-wall .display {
  position: absolute;
  left: var(--safe-x);
  bottom: 138px;
  width: 78%;
  font-size: 142px;
}
.title-wall .ghost {
  position: absolute;
  right: 70px;
  top: 22px;
  font-size: 330px;
  line-height: 1;
  font-weight: 800;
  color: color-mix(in srgb, var(--ink) 5%, transparent);
  letter-spacing: -.08em;
}
.title-wall .evidence {
  position: absolute;
  right: var(--safe-x);
  top: 118px;
  width: 560px;
  min-height: 260px;
  border-top: var(--hairline) solid var(--accent);
}
```

`evidence` can be a paper excerpt, product crop, map, data mark, waveform, or diagram fragment that proves the subject immediately.

## 5. SVG signal carrier

Use one path to carry continuity across scenes. Author the resolved path in SVG and animate `stroke-dashoffset`:

```html
<svg class="carrier" viewBox="0 0 1200 620" aria-hidden="true">
  <path class="carrier__guide" d="M40 480 C260 80 430 560 650 220 S980 120 1160 300" />
  <path class="carrier__signal" pathLength="1"
        d="M40 480 C260 80 430 560 650 220 S980 120 1160 300" />
  <g class="carrier__marks">
    <circle cx="40" cy="480" r="10" />
    <circle cx="650" cy="220" r="10" />
    <circle cx="1160" cy="300" r="10" />
  </g>
</svg>
```

```css
.carrier__guide { fill: none; stroke: color-mix(in srgb, var(--ink) 13%, transparent); stroke-width: 2; }
.carrier__signal { fill: none; stroke: var(--accent); stroke-width: 7; stroke-linecap: round; stroke-dasharray: 1; stroke-dashoffset: 1; }
.carrier__marks circle { fill: var(--bg); stroke: var(--ink); stroke-width: 3; }
```

Change the path into a route, reading order, waveform, parameter curve, product flow, or narrative thread. It must encode meaning.

## 6. Measured comparison field

Comparisons need scale and anchors, not unlabeled diagonal lines:

```html
<svg viewBox="0 0 1100 640" class="measure" aria-hidden="true">
  <g class="measure__grid">
    <path d="M120 60V560H1040" />
    <path d="M120 435H1040M120 310H1040M120 185H1040" />
  </g>
  <g class="measure__bars">
    <rect x="210" y="430" width="150" height="130" rx="4" />
    <rect x="470" y="300" width="150" height="260" rx="4" />
    <rect x="730" y="105" width="150" height="455" rx="4" />
  </g>
</svg>
```

Place exact values and labels as nearby HTML text. Animate bars, range fills, or paths from a common baseline, then hold the completed comparison.

## 7. Document-to-diagram transformation

For research, history, policy, or technical explanations:

- Start from a large cropped document fragment or typographic excerpt.
- Highlight one phrase, equation, heading, or date.
- Extend rules/connectors from that evidence into the explanatory diagram.
- Preserve one fragment as foreground context while the diagram resolves.

This is stronger than replacing the source with a generic network graphic.

## 8. Convergence field

For multimodal, systems, ecosystems, or synthesis:

- Give each input its own material behavior, not just a word around a circle.
- Text can arrive as token rows; audio as a measured waveform; image as crop tiles; code as aligned syntax bands.
- Let inputs bend, mask, or recompose into one shared output object.
- Resolve into a new state that visibly contains evidence of all inputs.

## 9. Deterministic motion recipes

Use a small number of semantic groups:

```js
// Establish -> explain -> resolve -> hold.
tl.set(scene, { opacity: 1 }, start)
  .fromTo(`${id} .structure`, { opacity: .35 }, { opacity: 1, duration: .55 }, start)
  .fromTo(`${id} .build`, { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 1.25 }, start + .18)
  .fromTo(`${id} .result`, { opacity: 0, y: 22 }, { opacity: 1, y: 0, duration: .65 }, start + 1.05);
```

Use explicit timeline positions. CSS animations, timers, random particles, and runtime network calls are not render-safe.

## Primitive selection guide

- Research/history: editorial title wall + document-to-diagram + signal carrier.
- Data/scale: measured comparison + full-field data mark + annotated path.
- Product/feature: product surface + asymmetric split + cursor/route carrier.
- Systems/process: map/flow + convergence field + state transformation.
- Quote/argument: oversized type + evidence fragment + rule/annotation system.
- Abstract concept: choose a concrete physical behavior first—accumulation, compression, branching, collision, alignment, or convergence—then build custom SVG around it.

Do not use all primitives in one scene. One scene grammar, one hero visual, one supporting system, and one continuity carrier are usually enough.
