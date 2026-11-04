# editorial-forest — quiet literary editorial

Adapted from the HyperFrames frame preset `editorial-forest` (heygen-com/hyperframes,
Apache-2.0, see `LICENSE-hyperframes.txt`). Changed for Orkas VideoStudio: local
font stacks with CJK faces, px sizes with the 22px floor, approved-copy casing,
and a motion section.

Pick it when the brand wants quiet confidence and a literary tone: spacious, restrained,
serif-led, like a Penguin classic, a calm annual report or an art-book spread. Reports,
research and publishing brands, considered launches, essays and founder letters.
Failure looks like a multicolor web dashboard with drop shadows.

## Tokens

```yaml
colors:             # keep the roles; remap by role (see design-presets.md)
  green: "#2e4a2a"      # deep: cover, stat and chart ground; headline ink on cream
  green-deep: "#243a21" # deep variant: type and rules on pink
  green-lite: "#3a5a36" # surface: tile fill
  pink: "#e89cb1"       # accent: display on green, rules and monogram on green
  pink-deep: "#d27e96"  # accent deep variant
  cream: "#efe7d4"      # canvas: the content ground
  cream-2: "#e6dcc4"    # surface: bordered tile fill
  ink: "#1a1a17"        # ink: body on cream
type:                # px on 1920×1080
  display-hero:     { face: "Source Serif 4" > serif-text, size: 221, weight: 500, line: 0.92, tracking: -0.02em }
  stat-figure:      { face: "Source Serif 4" > serif-text, size: 221, weight: 500, line: 0.92, tracking: -0.03em }
  display:          { face: "Source Serif 4" > serif-text, size: 140, weight: 500, line: 1.02, tracking: -0.02em }
  stat-figure-unit: { face: "Source Serif 4" > serif-text, size: 109, weight: 500, line: 0.92 }
  headline-xl:      { face: "Source Serif 4" > serif-text, size: 96, weight: 500, line: 0.96, tracking: -0.02em }
  headline:         { face: "Source Serif 4" > serif-text, size: 84, weight: 500, line: 1.0, tracking: -0.02em }
  title-card:       { face: "Source Serif 4" > serif-text, size: 67, weight: 500, line: 0.96, tracking: -0.01em }
  title-card-sm:    { face: "Source Serif 4" > serif-text, size: 56, weight: 500, line: 0.98, tracking: -0.01em }
  name:             { face: "Source Serif 4" > serif-text, size: 44, weight: 600, line: 1.0 }
  lede:             { face: "Source Serif 4" > serif-text, size: 36, weight: 400, line: 1.38 }
  body:             { face: "Source Serif 4" > serif-text, size: 30, weight: 400, line: 1.38 }
  body-card:        { face: "Source Serif 4" > serif-text, size: 28, weight: 400, line: 1.34 }
  label:            { face: "JetBrains Mono" > mono, size: 26, weight: 500, tracking: 0.18em }
  caption-mono:     { face: "JetBrains Mono" > mono, size: 24, weight: 500, tracking: 0.14em }
  cjk:              { display: song 500, body: song 400, chrome: hei 500 }
space: { edge: 96, rule: 2, rule-card: 2.5, radius-card: 6, radius-step: 8 }
```

Faces: use the named face when installed or vendored in `assets/fonts/`, otherwise the
stack after `>`. Vendor Source Serif 4 with its optical-size axis (`font-optical-sizing:
auto`) or display and body flatten into one cut. Display 500, body 400, name 600; on
`serif-text` 500 falls to regular, never to bold. Mono chrome keeps the copy's approved
casing; weight 500 and the 0.14–0.18em tracking carry the labels, and CJK has no case.

## Frame craft

- Squint: one serif moment dominates at 3–6× its neighbor; the surface block draws the eye.
- Silence: one subject per frame in deep negative space; only the topic-tile and step
  grids run dense.
- Restraint: two surface tones per frame at most, three reads loud. Serif 500 for
  display, 400 for body; the green ground is kept for moments of weight.

## Components

- **topbar**: a mono label left, a monogram-circle or ordinal counter right, along the top
  inside the 96px edge. On every frame; without it a frame looks untreated.
- **footline**: two caption-mono strings at opposite ends of the bottom edge; on cover,
  data and summary frames.
- **monogram-circle**: 130px, 2px pink border, a mono monogram inside. The identity
  stamp, cover and summary only, and the only full round.
- **topic-tile**: 6px radius, no shadow; caption-mono ordinal, title-card-sm title, mono
  foot. Fills rotate green with pink type, pink with green-deep, green-lite with pink,
  cream-2 with a 2px green border and green type; no fill repeats in a grid.
- **step-tile**: 8px radius, 2.5px border; cream with a green border, green, or pink; a
  mono ordinal, title-card title, body-card copy, a mono marker over a top rule.
- **kpi-block**: caption-mono tag, stat-figure with its unit, a body line, under a 2px rule.
- **meta-dl**: a three-column term-and-value grid under a 2px green rule; mono terms.
- **bar**: 56px wide in pink, cream or green, 3px 3px 0 0 corners, a mono value above.
- **rule-thin**: 2px in the region's accent (green on cream, pink on green, green-deep on
  pink). The only separator; never 1px, never 3px or more.

## Frame types

1. **Cover** — green. A two-line pink display-hero, left, one word in cream; a lede, the
   topbar with label and monogram-circle, a footline. About 50% open; readable at frame 0.
2. **Topic tiles** — cream. A headline-xl over three or four topic tiles in three of the
   four fills, none repeated. The dense frame.
3. **KPI stat** — green. A kpi-block with a 221px pink stat-figure and unit over a 2px
   pink rule; topbar and footline. About 55% open.
4. **Statement** — cream, generous edge. A two-line green display, left, the 600 name and
   a caption-mono role beneath. No accent; the serif carries it. About 55% open.
5. **Step framework** — cream or green. A headline over three or four step-tiles with
   67px titles, fills rotating through the three variants. Standard density.
6. **Chart** — green. A headline over 56px pink, cream and green bars on 2px axis rules
   with mono ticks, an optional meta-dl below. Standard density.

## Motion

- Verbs: lines rise through masks, rules draw, tiles settle, bars grow, the ring draws.
- Display and headline lines reveal by a baseline mask, 0.7–0.9s `power3.out`, one line
  per beat (0.5s at 120 BPM).
- Rules draw from their start edge in 0.6s `power2.inOut`; tiles follow 0.15s apart,
  rising 16px as they fade in over 0.5s `power2.out`.
- Bars grow from the axis in 0.8s `power2.out`, 0.1s apart, values fading in as each
  lands; the stat-figure reveals whole by mask, never counting.
- The ground holds still; a display may drift 1% over the scene, `sine.inOut`.
- Chapters cut on the downbeat with a ground swap or a 0.6s `power2.inOut` mask wipe.
- The cover's display-hero and topbar are set at frame 0; lede and footline rise in over
  0.8s, and the monogram ring draws in 0.9s.
- Never: bounce, scale pops, shadows, glow, rotation, fast zooms on type.

## Do and don't

- Do run display in Source Serif 4 at 500, tight and negatively tracked; body at 400.
- Do set labels, captions, ticks and footlines in mono 500 at 0.08–0.18em.
- Do give every frame a topbar, and cover and data frames a footline.
- Do keep one dominant surface, two tones at most, and rotate tile fills without repeats.
- Do set headlines green on cream, cream or pink on green, green-deep on pink (body ink,
  cream, green-deep likewise); pink and green on each other only from 84px.
- Don't add shadow, gradient or glow; depth is color block, hairline, border against fill.
- Don't add a third face, italic, underline, serif body at 500 or mono at headline scale.
- Don't add a fourth color family, rgba surfaces, rules outside 2/2.5px, two competing
  blocks or an edge-to-edge headline.

## 9:16 and 1:1

- Cover: display on top, monogram below on 9:16; monogram to a corner on 1:1.
- Tiles and steps: stacked on 9:16; 2×2 on 1:1.
- KPI stat and statement: centered (the figure taller, the quote stacked) on 9:16 and 1:1.
- Chart: taller bars, meta stacked on 9:16; a square chart on 1:1.
- The topbar spans the top on every ratio; the 96px edge holds on the short side.

## Self-check before snapshot

- One serif moment dominates; one subject per frame, only tile and step grids dense.
- Two surface tones at most, per-surface type colors; display 500, body 400, no italic.
- No shadow or gradient; 2px rules; 6/8px radii; topbar on every frame.
- Copy keeps its approved casing; nothing below 22px.
- Every figure, name and logo traces to the brief; otherwise leave it out.
