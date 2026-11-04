# coral — hard-edged magazine poster

Adapted from the HyperFrames frame preset `coral` (heygen-com/hyperframes,
Apache-2.0, see `LICENSE-hyperframes.txt`). Changed for Orkas VideoStudio: local
font stacks with CJK faces, px sizes with the 22px floor, approved-copy casing,
and a motion section.

Pick it when the brand wants graphic, structural confidence: solid planes of color
meeting at hard edges and tall condensed type as architecture, like a sports-magazine
cover or a Saul Bass travel poster. Bold launches, campaign and event films.
Failure looks like a deck of soft cards with drop shadows and rounded corners.

## Tokens

```yaml
colors:             # keep the roles; remap by role (see design-presets.md)
  coral: "#E85D5D"      # accent and environment: full regions, borders, icon squares, nodes
  coral-dark: "#D44A4A" # accent deep: start of the one 135° feature gradient
  cream: "#F5F0E8"      # canvas: the warm field
  cream-dark: "#E8E0D4" # surface: info-bar band
  black: "#1A1A1A"      # ink and deep: headlines, the ink panel, the timeline line
  gray: "#6B6B6B"       # muted ink: body and meta only, never a headline
  light-gray: "#B0B0B0" # line: faint meta and inactive marks
  white: "#FFFFFF"      # surface: card and sidebar-item fill; never type on coral
type:                # px on 1920×1080
  giant-mark:         { face: "Bebas Neue" > condensed, size: 269, weight: 400, color: "rgba(0,0,0,0.35)" }
  background-numeral: { face: "Bebas Neue" > condensed, size: 192, weight: 400, color: "rgba(0,0,0,0.12)" }
  jumbo-feature:      { face: "Bebas Neue" > condensed, size: 173, weight: 400, line: 1.0, tracking: 12px }
  hero-title:         { face: "Bebas Neue" > condensed, size: 125, weight: 400, line: 0.9, tracking: 4px }
  stat-numeral:       { face: "Bebas Neue" > condensed, size: 96, weight: 400, line: 1.0 }
  section-headline:   { face: "Bebas Neue" > condensed, size: 81, weight: 400, line: 1.0, tracking: 2px }
  column-title:       { face: "Bebas Neue" > condensed, size: 71, weight: 400, line: 1.0, tracking: 2px }
  card-stat:          { face: "Bebas Neue" > condensed, size: 48, weight: 400, line: 1.0 }
  bar-title:          { face: "Bebas Neue" > condensed, size: 44, weight: 400, line: 1.0, tracking: 2px }
  sidebar-value:      { face: "Bebas Neue" > condensed, size: 44, weight: 400, line: 1.0 }
  card-title:         { face: "Bebas Neue" > condensed, size: 36, weight: 400, line: 1.1, tracking: 1px }
  body-light:         { face: "Inter" > sans, size: 36, weight: 300, line: 1.5 }   # pull quote, support line
  body:               { face: "Inter" > sans, size: 28, weight: 400, line: 1.7 }
  section-label:      { face: "Inter" > sans, size: 22, weight: 700, tracking: 4px }
  item-label:         { face: "Inter" > sans, size: 22, weight: 700, tracking: 3px }
  quote-attribution:  { face: "Inter" > sans, size: 22, weight: 600, tracking: 3px }
  quote-role:         { face: "Inter" > sans, size: 22, weight: 400, tracking: 1px }
  cjk:                { display: hei 600, body: hei 400 }
space: { pad-x: 96, pad-y: 80, col: 56, gap: 32, card: 40 }
```

Faces: use the named face when installed or vendored in `assets/fonts/`, otherwise the
stack after `>`. Bebas Neue stays 400. Display roles never take the sans, body never the
condensed face. Copy keeps its approved casing; height, condensed width and the 1–12px
tracking carry the poster, and CJK has no case.

## Frame craft

- Squint: one element dominates at 3–6× its neighbor: a hero-title, a jumbo-feature or a
  wallpaper numeral behind a region's title. Never two rival headlines.
- Silence: regions stay 40–55% empty; the catalog is the one dense frame. A thin coral
  region gets a wallpaper numeral, not more copy.
- Restraint: coral is an accent or one full region per frame, never both at full
  strength. One giant mark per quote. Type on coral is ink, never white.

## Components

- **region-split**: two or three solid surfaces at a hard edge, in rows 38/62 or columns
  40/60 or 50/50, 0 radius. The join is the layout; no gradient, no rounded seam.
- **diagonal-hatch**: `repeating-linear-gradient(45deg, transparent 0 20px, rgba(0,0,0,.06)
  20px 40px)` on every coral region; variants −45° at 30/60px, vertical at 60/62px in 10%.
- **background-numeral**: 192px in 12% ink behind a coral region's title. **giant-mark**:
  a 269px quote mark or glyph in 35% ink inside a coral region. Wallpaper, not content.
- **card**: white, a 5px coral top border as its only chrome, 0 radius, no shadow;
  holds a **card-icon** (48px coral square, one white glyph), card-title, body, card-stat.
- **sidebar-item**: white with a 4px coral left border; sidebar-value over a label.
- **accent-line**: a 77×5px coral rule under a headline; 60×4px on closing frames.
- **timeline**: a 4px ink line with a dashed tail; 20px coral nodes on cream halos.
- **info-bar**: a cream-dark band under a feature region, bar-title left, meta right.

## Frame types

1. **Region-split cover** — 38/62 rows: a hatched coral band with a wallpaper numeral,
   brand left and meta right, over cream. A two-line ink hero-title left in the cream
   field, its second line coral; the field about 45% empty. Readable at frame 0.
2. **Feature stat** — full hatched coral. An ink stat-numeral, jumbo-feature or two-line
   headline on the left, a wallpaper numeral behind, an ink label above, an optional
   body-light line within 845px. About 40% open.
3. **Quote layout** — 40/60: a hatched coral panel with a giant-mark beside a black panel
   holding a 2–3 line body-light quote in cream; a 60×4 accent-line over the attribution.
4. **Closing plate** — cream over a hatched coral foot band. A two-line ink sign-off,
   centered between an eyebrow and an accent-line. About 55% empty.
5. **Three-column catalog** — cream or black, 96px sides. A centered section-headline
   over three cards. The dense frame; coral tops and icons are its only accent.
6. **Timeline** — cream. A section-headline over the timeline, 4–5 nodes with condensed
   labels. Standard density.

## Motion

- Verbs: regions slam in, lines punch up, rules extend, numerals drift, nodes stamp on.
- A coral region wipes in from its own edge in 0.3–0.4s `expo.out`; the edge stays sharp.
- Condensed lines punch up through a baseline mask, 0.3s `power4.out`, one per beat
  (0.5s at 120 BPM). Stat numerals cut on whole, on the beat.
- Wallpaper numerals drift 2–3% over the scene, `sine.inOut`; the hatch slides one 40px
  period, `none`.
- Rules and card tops extend from the left in 0.25s `power3.out`, cards 0.12s apart. The
  timeline draws in 0.8s `power2.inOut`, nodes stamping on (scale 0→1, 0.2s) as it passes.
- Chapters hard-cut on the downbeat; a split may trade sides across the cut. The cover's
  split, band and hero-title stand at frame 0; only meta and texture move.
- Never: crossfades, feathered wipes, shadows, rotation, bounce.

## Do and don't

- Do compose with two or three of coral, ink and cream meeting at hard edges.
- Do let tracking carry the display (2px standard, 4px hero, 12px jumbo), not casing.
- Do set eyebrows coral on cream or ink, ink on coral; headlines ink on cream or coral,
  cream on ink.
- Do hatch every coral region; fill a thin one with a wallpaper numeral or giant mark.
- Do center sign-offs and catalog heads; set features and quotes left or in a split.
- Don't add a fourth surface, shadows or rounded rectangles; circles are timeline nodes.
- Don't set white headlines on coral or gray headlines anywhere; gray is body and meta.
- Don't soften an edge with a gradient (one 135° coral-dark → coral feature region is
  the exception); don't run a headline edge to edge.

## 9:16 and 1:1

- Cover: a taller band with the title below on 9:16; 40/60, title lower, on 1:1.
- Feature stat: figure on top, numeral behind on 9:16; centered on 1:1.
- Quote stacks on both, mark panel over quote. Closer: taller band on 9:16, centered on 1:1.
- Catalog: three stacked on 9:16, 2+1 on 1:1. Timeline: vertical on 9:16, compact on 1:1.
- Condensed display sets about 20% wider in CJK; re-break lines for each ratio.

## Self-check before snapshot

- One focal per region at 3–5×; sparse frames 40–55% empty, only the catalog dense.
- Two or three surfaces at hard edges, hatch on every coral region, ink on coral.
- No shadow, no rounded rectangle; anchors vary, never three alike in a row.
- Copy keeps its approved casing; nothing below 22px.
- Every figure, name and logo traces to the brief; otherwise leave it out.
