# cartesian — stone-and-hairline museum catalogue

Adapted from the HyperFrames frame preset `cartesian` (heygen-com/hyperframes,
Apache-2.0, see `LICENSE-hyperframes.txt`). Changed for Orkas VideoStudio: local
font stacks with CJK faces, px sizes with the 22px floor, approved-copy casing,
and a motion section.

Pick it when the brand wants quiet authority and editorial rigor: sparse,
literary, restrained. Architecture, design and research studios, considered
professional launches, an essay told one idea per frame.
Failure looks like a shadowed, rounded SaaS card deck, or a frame crowded past
its stone margins.

## Tokens

```yaml
colors:             # keep the roles; remap by role (see design-presets.md)
  bg-primary: "#EDE8E0"     # canvas: warm stone on every frame
  bg-secondary: "#E2DBD1"   # surface: image plates and portrait discs only
  text-primary: "#1A1A1A"   # ink: headlines and the one ink rule
  text-secondary: "#5A5A5A" # ink-muted: body copy
  accent: "#8A8178"         # accent: taupe labels, numerals, small type only
  line: "#B8B0A4"           # line: every hairline and every ring
  white-overlay: "rgba(255,255,255,0.3)" # card fill; the stone shows through
type:                # px on 1920×1080
  display:           { face: "Playfair Display" > serif-display, size: 154, weight: 400, line: 1.04 }
  quote-mark:        { face: "Playfair Display" > serif-display, size: 173, weight: 400, line: 0.5, color: line }
  h1:                { face: "Playfair Display" > serif-display, size: 119, weight: 400, line: 1.06 }
  h2:                { face: "Playfair Display" > serif-display, size: 77, weight: 400, line: 1.1 }
  stat-figure:       { face: "Playfair Display" > serif-display, size: 58, weight: 400, line: 1.0 }
  card-headline:     { face: "Playfair Display" > serif-display, size: 38, weight: 400, line: 1.15 }
  timeline-headline: { face: "Playfair Display" > serif-display, size: 36, weight: 400, line: 1.1 }
  h3:                { face: "Playfair Display" > serif-display, size: 35, weight: 400, line: 1.1 }
  subtitle:          { face: "Inter" > sans, size: 36, weight: 400, line: 1.5 }
  body:              { face: "Inter" > sans, size: 32, weight: 400, line: 1.6, color: text-secondary }
  attribution:       { face: "Inter" > sans, size: 24, weight: 400, tracking: 0.13em, color: accent }
  label:             { face: "Inter" > sans, size: 22, weight: 500, tracking: 0.21em, color: accent }
  micro:             { face: "Inter" > sans, size: 22, weight: 400, tracking: 0.17em, color: accent }
  cjk:               { display: song 700, body: hei 400 }
space: { edge-x: 134, edge-y: 96, gap-xl: 115, gap-lg: 96, rule: 1 }
```

Faces: use the named face when installed or vendored in `assets/fonts/`,
otherwise the stack after `>`. Playfair stays weight 400 in ink, never bold or
taupe; contrast comes from size and the serif–sans switch. Italic on a key word.

## Frame craft

- Squint: one Playfair moment dominates at 3–6× its neighbor; serif against sans
  and size carry the hierarchy, never weight.
- Silence: declarative frames stay 55–60% empty. No frame is dense; even the
  agenda breathes, because crowding is what breaks this system.
- Restraint: two geo rings per frame at most, the one ink rule used sparingly, no
  attention color: five stones and ink. A brand accent stays at label scale.

## Components

- **hairline**: 1px solid `line`. Every separator, card edge, timeline rule and
  photo ring is this line; nothing thicker exists.
- **card**: white-overlay fill in a 1px line border, square, no shadow; the faint
  fill is what sets it apart from bare stone.
- **card-icon**: a 40px circle ringed in 1px line, a taupe Playfair numeral inside.
- **agenda-row**: taupe Playfair numeral left, ink Playfair label right, both h3,
  on a 1px line.
- **timeline**: one 1px line across the top of all phases; year, timeline-headline
  and body under it. No nodes, no dots.
- **stats-cluster**: modest stat-figures under a 1px top rule with taupe labels;
  never a hero numeral.
- **geo-ring**: a 1px line circle 192–960px across at 20–50% opacity, a dashed
  inner ring at 70–80% of its diameter; compass work behind content, 1–2 a frame.
- **horizontal-accent**: 346×1px in text-primary, the only ink line; cover and closing.
- **vertical-line**: optional 1px line at 30–40%, full height, ~96px in from an edge.
- **image-placeholder**: a bg-secondary plate in a 1px line border holding a
  supplied photo or screen; with none, a crossed X of 1px taupe diagonals at ±30°
  and a micro caption — a drafting mark, never a fake picture.
- **team-photo**: a bg-secondary circle ringed in 1px line with a supplied
  portrait or a taupe Playfair initial.

## Frame types

1. **Cover** — a 650px geo ring right of center, an optional vertical-line left; a
   taupe label over a two- or three-line display or h1 in ink at left, italic key
   word, then subtitle, optional meta row and ink rule. ~55% empty; readable at frame 0.
2. **Agenda / index** — a label and an h2 over 4–6 generously spaced agenda
   rows; taupe numerals are the only emphasis.
3. **Pull quote** — centered on a dashed 500px ring: the quote-mark at half
   opacity, a two-line quote at h2 in ink, a taupe attribution. About 60% open.
4. **Closing plate** — centered in the largest ring (~770px): a label, an h1 or
   display sign-off with an italic word, a horizontal-accent. About 60% open.
5. **Two-column editorial** — columns 115px apart: label, h2 and body on one side,
   an image-placeholder or card on the other. No accent.
6. **Stats / timeline** — a label and an h3 over a stats-cluster or a timeline,
   each under its 1px top rule. No accent, no nodes.

## Motion

- Verbs: rings draw, hairlines draw, lines rise into masks, labels fade, rings drift.
- A ring draws its circumference in 0.9s `power2.inOut`, the dashed inner ring
  0.25s behind, then turns 2–4° across the scene on `sine.inOut`.
- Headlines reveal by a baseline mask, 0.7s `power3.out`, a line per beat; the
  italic word arrives with its line. The cover headline is set from frame 0.
- Hairlines draw left to right in 0.6s `power2.out`; rows and phases follow 0.15s
  apart, fading up 12px. Labels fade in over 0.4s `sine.out` half a beat later.
- The horizontal-accent draws last, 0.5s `power2.inOut`, on a downbeat.
- Chapters change on the downbeat with a 0.4s crossfade; no wipes, no slides.
- Never: bounce, overshoot, scale pops, rotating type, shadows, fast zooms.

## Do and don't

- Do make every separator one 1px line; set Playfair at 400 in ink, body in
  text-secondary, labels in taupe with wide tracking.
- Do layer one or two geo rings behind content; fill plates with bg-secondary.
- Do let frames breathe, never crowded; center quote and closing, the rest left.
- Don't add an attention color, bold Playfair, set a headline in taupe, or draw a
  border of 2px or more.
- Don't add shadows, elevated cards or rounded rectangles; circles are the only
  curve. Don't run a headline edge to edge.
- Copy keeps its approved casing; labels get their look from taupe, size and
  0.13–0.21em tracking (CJK has no case).

## 9:16 and 1:1

- Cover: headline on top, ring below on 9:16; upper half, ring behind on 1:1.
- Quote and closing: centered, the ring scaled to the short side; agenda rows tighten.
- Two-column editorial: stacks, text over the plate, on both ratios.
- Stats / timeline: a vertical list without the top rule on 9:16; compact on 1:1.

## Self-check before snapshot

- One Playfair moment dominates; declarative frames 55–60% empty, none crowded.
- Five stones and ink; headlines ink, body gray, labels taupe; two rings at most.
- Every separator 1px; horizontal-accent the only ink rule; no shadow or rounded box.
- Copy keeps its approved casing; nothing below 22px.
- Every figure, name and logo traces to the brief; otherwise leave it out.
