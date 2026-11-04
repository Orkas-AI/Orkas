# biennale-yellow — art-catalogue editorial

Adapted from the HyperFrames frame preset `biennale-yellow` (heygen-com/hyperframes,
Apache-2.0, see `LICENSE-hyperframes.txt`). Changed for Orkas VideoStudio: local
font stacks with CJK faces, px sizes with the 22px floor, approved-copy casing,
and a motion section.

Pick it when the brand wants museum-catalogue elegance and editorial authority:
confident, atmospheric, restrained. Launches told as an issue or exhibition,
founder stories, culture and design brands.
Failure looks like a flat CMS template (paper with no bloom) or a deck of
bordered cards.

## Tokens

```yaml
colors:             # keep the roles; remap by role (see design-presets.md)
  paper: "#E9E5DB"      # canvas: warm parchment on every frame
  paper-deep: "#DCD6C4" # canvas variant
  sun: "#F1EE2E"        # accent: bloom core, panel, tile underprint
  sun-soft: "#F8F39B"   # bloom middle stop
  haze: "#F0DA7C"       # bloom outer stop
  ink: "#1B2566"        # every line of type and every rule
  ember: "#E26B4A"      # counter-bloom only, 15–22%; never a fill or text
type:                # px on 1920×1080
  numeral-jumbo: { face: "Instrument Serif" > serif-display, size: 538, weight: 400, line: 0.84, tracking: -0.04em }
  display:       { face: "Instrument Serif" > serif-display, size: 280, weight: 400, line: 0.86, tracking: -0.018em }
  numeral-md:    { face: "Instrument Serif" > serif-display, size: 144, weight: 400, line: 0.92 }
  display-it:    { face: "Instrument Serif" > serif-display, size: 134, style: italic, line: 1.04 }
  date-rail:     { face: "Instrument Serif" > serif-display, size: 96, line: 0.96 }
  headline:      { face: "Instrument Serif" > serif-display, size: 88, line: 1.06 }
  headline-sm:   { face: "Instrument Serif" > serif-display, size: 64, line: 1.0 }
  strand-title:  { face: "Instrument Serif" > serif-display, size: 36, line: 1.1 }
  body:          { face: "Archivo" > sans, size: 32, weight: 400, line: 1.5 }
  body-lede:     { face: "Archivo" > sans, size: 36, weight: 400, line: 1.5 }
  label:         { face: "Archivo" > sans, size: 22, weight: 600, tracking: 0.18em }
  data:          { face: "JetBrains Mono" > mono, size: 24, tracking: 0.04em }
  pagenum:       { face: "JetBrains Mono" > mono, size: 22, opacity: 0.75 }
  cjk:           { display: song 700, body: hei 400 }
space: { edge: 80, region: 80, gap: 48, rule: 1 }
```

Faces: use the named face when installed or vendored in `assets/fonts/`,
otherwise the stack after `>`. Serif display stays weight 400; contrast comes
from size, never bold.

## Frame craft

- Squint: one serif moment dominates at 3–6× its neighbor; the sun bloom pulls
  the eye to it.
- Silence: frames stay 55–60% empty. The ledger is the one dense frame, dense
  through quiet hairline repetition.
- Restraint: one ink for all type and rules, one sun bloom per frame plus an
  optional ember counter-bloom. Never yellow type on ink.

## Components

- **sun-bloom**: a layered radial — sun at 70–95% core → sun-soft → haze at
  18–22% → paper at 0% — 42–70% of the frame, off-center or behind the focal
  element. One per frame; flat parchment reads as broken.
- **ember-bloom**: a radial in ember at 15–22% in the corner opposite the sun
  bloom; always subordinate.
- **block-tile**: sun rectangles at 40–70% opacity on an 8×4 grid behind cover
  and closing frames; a poster underprint.
- **yellow-panel**: a full-bleed sun column or third with ink type on it, meeting
  the paper directly with no border. The strongest color statement.
- **hairline-rule**: 1px ink; a soft variant at 18–20% for dense rows. The only
  border; nothing thicker exists.
- **strand-row**: serif numeral + serif title + sans body, soft hairline under.
  Numbered editorial lists.
- **ledger-row**: four columns — mono date · serif title · sans venue · mono
  duration on the right — with soft hairlines.
- **footer-band**: a four-column metadata strip at the foot of cover and closing
  frames, 1px ink rule over each cell.
- **vertical-rail**: a label rotated up the left edge as a section marker.
- **pagenum**: bottom-right, the only persistent chrome.

## Frame types

1. **Cover** — paper, a large sun bloom left of center, an ember bloom in the
   opposite corner. A two-line display headline left under a label, a date-rail
   top-right, a footer-band at the foot. Low density; readable at frame 0.
2. **Chapter divider** — a corner sun bloom, one numeral-jumbo dominating, a
   headline-sm title under it, a vertical-rail label up the left edge.
3. **Ledger** — headline-sm with a label top bar, then ledger rows under a 1px
   header rule. The dense frame; no accent, no bloom or a faint one.
4. **Manifesto** — a centered bloom, an oversized serif quote mark, a two-line
   display-it quote centered, a label attribution. About 60% open.
5. **Poster panel** — a yellow-panel column or third with a headline in ink on
   it; the paper side stays open.
6. **Strand list** — label, headline-sm, then numbered strand rows breathing
   under a subtle bloom.

## Motion

- Verbs: blooms breathe, lines rise into masks, hairlines draw, numerals swap,
  panels wipe across.
- Blooms scale 1→1.05 and drift 2–3% across the scene, `sine.inOut`; the
  atmosphere moves, the type holds.
- Display and headline lines reveal by a baseline mask, 0.6–0.8s `power3.out`,
  one line per beat.
- Hairlines draw left to right in 0.5s; ledger and strand rows follow them in
  sequence 0.12s apart.
- Chapter dividers cut on the downbeat; the numeral swaps with a hard cut.
- A yellow-panel enters as a wipe from its own edge in 0.5s `power2.inOut`.
- Never: bounce, rotation, shadows appearing, fast zooms on type.

## Do and don't

- Do start every frame on parchment with one sun bloom.
- Do set every line in ink; serif 400 display, sans body, mono for numerals and dates.
- Do lean sparse: left or asymmetric on cover, chapter and lists; centered only
  on the manifesto.
- Don't use drop shadows, rounded corners, bordered cards or rules thicker than 1px.
- Don't add a second text color, bold serif or inverted ink grounds.
- Don't run a headline edge to edge; step down the ramp instead.

## 9:16 and 1:1

- Cover: display at the top, footer-band stacks; 1:1 puts display in the upper half.
- Chapter divider: numeral centered, the rail moves to the top.
- Ledger: drop the venue column to three columns on 9:16 and 1:1.
- Poster panel: a top or bottom band on 9:16, a third on 1:1.

## Self-check before snapshot

- One serif display moment dominates; one sun bloom present; sparse frames 55–60% open.
- Ink for all text and rules; sun only as bloom, panel or tile; ember only as a counter-bloom.
- No shadow, no rounded corner, hairlines 1px.
- Copy keeps its approved casing; nothing below 22px.
- Every numeral and date traces to the brief; ordinals may be decorative.
