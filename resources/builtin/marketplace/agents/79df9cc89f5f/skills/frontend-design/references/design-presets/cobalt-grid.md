# cobalt-grid — two-color risograph on graph paper

Adapted from the HyperFrames frame preset `cobalt-grid` (heygen-com/hyperframes,
Apache-2.0, see `LICENSE-hyperframes.txt`). Changed for Orkas VideoStudio: local
font stacks with CJK faces, px sizes with the 22px floor, approved-copy casing,
and a motion section.

Pick it when the brand wants clarity and measured authority: restrained,
systemic, editorial. Trend reports, research and data stories, developer and
infrastructure brands, annual reviews.
Failure looks like a colorful dashboard with a second hue, or the grid switched off.

## Tokens

```yaml
colors:             # keep the roles; remap by role (see design-presets.md)
  paper: "#F0EBDE"                  # canvas: cream on every frame
  paper-2: "#E6E0CE"                # canvas variant; never a card
  ink: "#1F2BE0"                    # ink and accent: the only ink there is
  ink-soft: "#5560E5"               # ink-muted: italic callouts only
  grid: "rgba(31,43,224,0.10)"      # line: graph grid, chart off-cells
  ink-faint: "rgba(31,43,224,0.18)" # line, soft: ledger row dividers
type:                # px on 1920×1080
  vbig-numeral:    { face: "Newsreader" > serif-text, size: 240, weight: 400, line: 0.9, tracking: -0.015em }
  display-hero:    { face: "Newsreader" > serif-text, size: 200, weight: 400, line: 0.9, tracking: -0.008em }
  display-closing: { face: "Newsreader" > serif-text, size: 180, weight: 400, line: 0.96, tracking: -0.005em }
  display-chapter: { face: "Newsreader" > serif-text, size: 131, weight: 400, line: 1.0, tracking: -0.005em }
  display-quote:   { face: "Newsreader" > serif-text, size: 109, weight: 400, line: 1.05, tracking: -0.005em }
  headline-index:  { face: "Newsreader" > serif-text, size: 96, weight: 400, line: 0.95 }
  headline:        { face: "Newsreader" > serif-text, size: 88, weight: 400, line: 0.95 }
  ed-callout:      { face: "Newsreader" > serif-text, size: 50, weight: 400, style: italic, line: 1.1 }
  row-headline:    { face: "Newsreader" > serif-text, size: 40, weight: 400, line: 1.05 }
  table-name:      { face: "Newsreader" > serif-text, size: 36, weight: 400, line: 1.15 }
  body-lede:       { face: "Hanken Grotesk" > sans, size: 36, weight: 400, line: 1.5 }
  body:            { face: "Hanken Grotesk" > sans, size: 32, weight: 400, line: 1.5 }
  micro-strong:    { face: "Hanken Grotesk" > sans, size: 26, weight: 600, tracking: 0.18em }
  micro:           { face: "Hanken Grotesk" > sans, size: 22, weight: 600, tracking: 0.16em }
  mono-tag:        { face: "DM Mono" > mono, size: 24, weight: 400, tracking: 0.05em }
  mono-chrome:     { face: "DM Mono" > mono, size: 22, weight: 400, tracking: 0.06em }
  cjk:             { display: song 700, body: hei 400 }
space: { edge: 80, top: 134, bottom: 115, gap: 38, cell: 38, rule: 2, rule-soft: 1 }
```

Faces: use the named face when installed or vendored in `assets/fonts/`,
otherwise the stack after `>`. Newsreader is a news text serif, so it takes
serif-text, not the Didot stack; it stays 400 in cobalt and size alone ranks.

## Frame craft

- Squint: one Newsreader moment, usually display-hero or vbig-numeral, dominates
  at 3–6× its neighbor; size ranks, weight never does.
- Silence: cover, chapter, quote and colophon stay 45–60% empty with the grid
  showing; the index ledger and data frame are dense by quiet repetition.
- Restraint: cream and cobalt, never a second hue; one glitch column and at most
  one qr-block per declarative frame. Emphasis is size, the serif, a delta or opacity.

## Components

- **graph-grid**: 1px lines in `grid` on 38px cells behind every frame; never off.
- **hairlines**: two 2px ink rules ~58px in from top and bottom, inset 80px at the
  sides, framing every composition.
- **page-chrome**: mono-chrome in ink above the bottom hairline: page number at
  right, a nav or meta hint at left. The only persistent chrome.
- **pixel-glitch**: a stair-stepped column 270–576px wide, full height, of
  vertical scanlines (2px ink, 6px gap) on paper; above the grid, under the
  headline. Right on cover and data, left on chapter and colophon.
- **qr-block**: an 8×8 mosaic 58–173px square, ink cells on, grid tint off, on
  paper with a 2px paper outline for legibility, not a shadow. Corner punctuation.
- **topbar-rule**: a headline-index title and a mono-tag over a 2px ink rule; the
  header of index, data and table frames.
- **ledger-row**: mono number · Newsreader table-name · Hanken body · mono delta
  (↑ ↓ —), 1px ink-faint dividers under a 2px ink header rule.
- **pixel-stack-bar**: grid-unit cells stacked on a 2px ink baseline, ink on,
  grid tint off, mono-chrome ticks below; it echoes the glitch.
- **vstack-label**: mono-chrome set vertically along a frame edge.

## Frame types

1. **Hero cover** — a ~500px glitch column at right, a qr-block top right; a one-
   or two-line display-hero in cobalt at left, an italic ed-callout in ink-soft
   under it, a micro kicker and mono meta above. ~45% open; readable at frame 0.
2. **Index ledger** — taller top and bottom pads; a topbar-rule over 4–6 ledger
   rows. Delta arrows are the only emphasis. The dense frame; no glitch.
3. **Chapter opener** — a ~270px glitch at left in low opacity, a mono chapter
   index over a display-chapter title, an optional lede ≤806px wide. ~60% open.
4. **Data frame** — a topbar-rule with a mono figure tag over 6–8 pixel-stack-bars
   on the baseline with mono ticks. Cobalt cells are the only accent.
5. **Manifesto / quote** — centered: a micro kicker, a two- or three-line
   display-quote, a 1px ink attribution rule and a mono byline. ~55% open.
6. **Colophon** — the glitch at left, mirroring the cover; a right-aligned
   display-closing under a micro kicker; 3–4 columns of mono credits at the foot.

## Motion

- Verbs: rules draw, the glitch steps in, QR cells switch on, cells stack, lines unmask.
- Grid, hairlines and page chrome are on frame 0 and never move; chapters cut hard
  on the downbeat, changing only what sits on the paper.
- Newsreader lines reveal by a baseline mask, 0.6–0.7s `power3.out`, a line per
  beat; the ed-callout fades in over 0.4s half a beat later.
- The glitch builds by its stair steps in 0.5s on `steps(6)`; QR cells switch on
  in a fixed shuffled order over 0.4s on `steps(8)`.
- Topbar and attribution rules draw in 0.5s `power2.inOut`; ledger rows follow
  0.1s apart, rising 8px; delta arrows land last, on the beat.
- The baseline draws in 0.4s, then each bar fills cell by cell on `steps(n)`
  (n = its cells) over 0.6–0.8s, 0.1s apart.
- Never: a second hue or color shift, blur, bounce, rotation, a moving grid.

## Do and don't

- Do keep the graph-grid, both hairlines and page chrome on every frame.
- Do set Newsreader at 400 in cobalt, negative-tracked on display; size ranks.
- Do render data as pixel-stack cells; give declarative frames a glitch and a QR.
- Do keep declarative frames sparse, index and data dense; cover, index and
  chapter left, quote centered, colophon right-aligned.
- Don't add a second ink, bold the serif, round a corner, draw a circle, cast a
  shadow (the QR outline is not one) or run a headline edge to edge.
- Copy keeps its approved casing; labels get their look from Hanken 600 and
  0.16–0.18em tracking (CJK has no case).

## 9:16 and 1:1

- Cover: headline on top, glitch as a full-width band on 9:16; glitch lower on 1:1.
- Ledger: fewer rows on 9:16, two columns drop to one on 1:1. Chapter: title on top.
- Data: 4–5 taller bars on 9:16, a square chart on 1:1; quote centered and taller.
- Colophon: stacked, glitch on top on 9:16; centered on 1:1. Grid and rules hold.

## Self-check before snapshot

- One Newsreader moment dominates; declarative frames 45–60% open.
- Cream and cobalt only; grid on, both hairlines on, page chrome above the rule.
- No shadow (QR outline aside), no rounded corner, no circle.
- Copy keeps its approved casing; nothing below 22px.
- Every figure, name and logo traces to the brief; otherwise leave it out. Bar
  heights and deltas too; catalogue ordinals (001, 002) may be decorative.
