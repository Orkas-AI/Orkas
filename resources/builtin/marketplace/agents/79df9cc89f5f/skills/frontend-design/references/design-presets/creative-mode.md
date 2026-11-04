# creative-mode — neo-brutalist editorial poster

Adapted from the HyperFrames frame preset `creative-mode` (heygen-com/hyperframes,
Apache-2.0, see `LICENSE-hyperframes.txt`). Changed for Orkas VideoStudio: local
font stacks with CJK faces, px sizes with the 22px floor, approved-copy casing,
and a motion section.

Pick it when the brand wants editorial presence and geometric confidence: sparse,
graphic, punchy but restrained, like a Risograph poster or a punk-zine spread. Flat
ink-bordered blocks, one big claim, a lot of cream. Indie tools, developer products.
Failure looks like a rounded, soft-shadowed SaaS feature grid.

## Tokens

```yaml
colors:             # keep the roles; remap by role (see design-presets.md)
  cream: "#EFE9D9"      # canvas: the ground on nearly every frame
  cream-2: "#E4DCC4"    # surface: table fill, block-on-block contrast
  ink: "#0F0F0F"        # ink: every border, rule and line of type on cream
  ink-2: "#2A2A2A"      # deep variant: secondary dark fills
  green: "#1F8A4C"      # accent: cell and step fills; the closing-plate ground, once
  green-dark: "#136636" # green's deep variant
  pink: "#F06CA8"       # accent: marker block, stamp, winning column
  pink-dark: "#D14E8B"  # pink's deep variant
  orange: "#E85A1F"     # accent: fills, and the hard offset shadow
  yellow: "#F5C518"     # accent: rotated badge, decorative circle
type:                # px on 1920×1080; Archivo Black is one black cut at 400
  display-hero:  { face: "Archivo Black" > sans, size: 298, weight: 400, line: 0.84, tracking: -0.02em }
  display-xl:    { face: "Archivo Black" > sans, size: 211, weight: 400, line: 0.9, tracking: -0.01em }
  display-lg:    { face: "Archivo Black" > sans, size: 154, weight: 400, line: 0.9, tracking: -0.01em }
  step-num:      { face: "Archivo Black" > sans, size: 134, weight: 400, line: 0.85 }
  stat-num:      { face: "Archivo Black" > sans, size: 123, weight: 400, line: 0.88 }
  display-head:  { face: "Archivo Black" > sans, size: 81, weight: 400, line: 0.92, tracking: -0.01em }
  marker:        { face: "Archivo Black" > sans, size: 46, weight: 400, line: 1.0 }
  stamp-num:     { face: "Archivo Black" > sans, size: 42, weight: 400, line: 0.9 }
  step-title:    { face: "Archivo Black" > sans, size: 34, weight: 400, line: 1.0 }
  badge-label:   { face: "Archivo Black" > sans, size: 28, weight: 400 }
  table-head:    { face: "Archivo Black" > sans, size: 28, weight: 400 }
  body-lg:       { face: "Space Grotesk" > sans, size: 32, weight: 400, line: 1.4 }
  body-md:       { face: "Space Grotesk" > sans, size: 28, weight: 400, line: 1.3 }
  mono-kicker:   { face: "JetBrains Mono" > mono, size: 24, weight: 400, tracking: 0.14em }
  mono-label:    { face: "JetBrains Mono" > mono, size: 24, weight: 400, tracking: 0.06em }
  cjk:           { display: hei 600, body: hei 400 }
space: { chrome: 64, gutter: 96, gap: 28, cell: 32, border: 4, rule: 3, shadow: 24 }
```

Faces: use the named face when installed or vendored in `assets/fonts/`, otherwise the
stack after `>`; on the `sans` stack set the Archivo Black roles at 800 so the mass holds.
Copy keeps its approved casing: black weight, the 0.84–0.92 line and tight tracking carry
the poster, and CJK has no case. Hanzi display lines need a line height of 1.05 or more.

## Frame craft

- Squint: exactly one element dominates, 3–6× its nearest neighbor, a chasm rather than
  a ramp: the display-hero or display-xl claim, or a stat-num.
- Silence: cover, claim and closer stay 45–60% empty; only the stat grid and the ledger
  run dense. Never pad a sparse frame to make it look finished.
- Restraint: per frame, at most one hard offset shadow and two or three accents, never
  all four. Green as a ground appears once, on the closing plate.

## Components

- **frame-chrome**: a mono topbar 48px from the top (label left, a 999px pill with a 2px
  ink stroke right) and a footer 48px from the bottom (descriptor left, `NN • NN` counter
  right, a 10px ink dot between), inset 64px; dropped only against a full-bleed wordmark.
- **stat-cell**: a flat green, pink, orange or cream tile, 4px ink border, square, 32px
  padding, stat-num over a mono-label; cream type on accents, ink on cream. No shadow.
- **step-card**: the same 4px square card with a giant step-num, step-title and body-md;
  fills alternate cream with pink, yellow and green, and the run ends on green.
- **marker-block**: pink, ink marker type, 4px ink border, and the signature shadow
  `24px 24px 0 orange, 24px 24px 0 4px ink`. Diagram stacks may use an 18px ink offset.
- **kicker-block**: cream mono-kicker on an ink chip, padding 10px 18px, square.
- **badge-rotated**: yellow, 4px ink border, badge-label type, turned −4°.
- **pill-badge**: cream, 2px ink border, 999px radius, mono-label; the one rounded box.
- **stamp**: a pink square about 346px, 4px cream border, a cream circular inner ring
  around stamp-num, turned −6°. The closing seal.
- **comparison-table**: cream-2, 4px ink outer border, 3px ink inner rules, an ink head
  row with cream table-head labels; one pink or green column fill marks the winner.
- **decorative-circle**: a yellow disc, 4px ink border, against a green panel or off a corner.

## Frame types

1. **Wordmark cover** — cream. A two-line display-hero wordmark centered, its second line
   pink or orange; full chrome with a `01 • NN` footer; one decorative-circle may bleed
   off a corner. About 55% empty; readable at frame 0.
2. **Big claim** — a full-bleed pink or orange ground (green stays with the closer). A
   2–3 line ink claim at display-xl or display-lg, left and vertically centered, a
   kicker-block above. No second accent; about 45% open.
3. **Stat grid** — cream. A centered display-head over green, pink and orange stat-cells,
   the one place three accents sit together. About 25% open; the dense frame.
4. **Closing plate** — green, its only use as a ground. A two-line cream display-lg
   sign-off centered, cream chrome, one pink stamp in a corner. About 55% empty.
5. **Featured marker** — cream. The marker-block and its shadow off-center, an optional
   body-md line beside it. About 50% open.
6. **Comparison ledger** — cream, 96px gutter. The full-width table with one filled
   winning column; the second dense frame.

## Motion

- Verbs: blocks slam, shadows snap out, stamps thump, cells cut on, chrome ticks over.
- Blocks slam in from 40–60px off their rest in 0.25–0.35s `power4.out`; no overshoot, no fade.
- The marker-block lands flat, then its shadow snaps out to 24px in 0.2s `power3.out` on
  the next beat (one beat = 0.5s at 120 BPM); on an accent beat it may press into it.
- Stat cells and step cards cut on one per beat, left to right; figures arrive whole.
- Badge and stamp thump from scale 1.3 to 1 in 0.25s `power4.out`, already at −4°/−6°.
- Chapters and ground swaps hard-cut on the downbeat. The cover wordmark is set at
  frame 0; chrome, pill and circle arrive within 0.6s.
- Never: blur, crossfades, soft eases on a slam, elastic wobble, two shadows moving.

## Do and don't

- Do build each frame on one idea, its focal element 3–5× the neighbors.
- Do center cover, stat grid and closer; anchor claim, marker and ledger left or off-center.
- Do keep sparse frames 45–60% empty with two or three accents; green waits for the close.
- Do spend the hard shadow on one block per frame; size Archivo Black to its measure.
- Don't round any corner but the pill's; no gradient, blur or glow.
- Don't track Archivo Black wider than −0.01em; no fifth accent, no pure white.
- Don't center body copy or set labels outside mono; don't run a headline edge to edge.

## 9:16 and 1:1

- Cover: stacked taller, circle on top on 9:16; centered and tighter on 1:1.
- Claim: at the top of the full accent on 9:16, centered on 1:1. Closer: stamp below on 9:16.
- Stat grid: three stacked on 9:16; 2×2 on 1:1, a fourth cell only for a fourth figure.
- Marker: centered, the shadow falling below on 9:16. Ledger: fewer columns, two on 1:1.
- Chrome keeps its 64px inset on the short edge in every ratio.

## Self-check before snapshot

- One element dominates at 3–5×; sparse frames 45–60% empty, only grid and ledger dense.
- Two or three accents per frame, never four; a green ground only on the closer.
- No blur, one hard shadow at most, square corners but the pill, rotation only −4°/−6°.
- Copy keeps its approved casing; nothing below 22px.
- Every figure, name and logo traces to the brief; otherwise leave it out.
