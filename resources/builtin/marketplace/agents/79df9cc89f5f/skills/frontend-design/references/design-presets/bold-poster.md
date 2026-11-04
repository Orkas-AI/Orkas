# bold-poster — tilted red editorial poster

Adapted from the HyperFrames frame preset `bold-poster` (heygen-com/hyperframes,
Apache-2.0, see `LICENSE-hyperframes.txt`). Changed for Orkas VideoStudio: local
font stacks with CJK faces, px sizes with the 22px floor, approved-copy casing,
and a motion section.

Pick it when the brand wants editorial authority and vintage gravitas: powerful,
printed, restrained. Results told loud, sports, food and culture brands, campaigns.
Failure looks like a rounded, soft-shadowed, multi-accent slide, or a straight hero.

## Tokens

```yaml
colors:             # keep the roles; remap by role (see design-presets.md)
  bg: "#FFFFFF"     # canvas: the white sheet; type on red and dark panels
  dark: "#1C1410"   # ink, line, deep: body, headers, grid rules, dark panel
  red: "#D8000F"    # accent: figures, rules, labels, leftbars, bullets, progress, red panel
  light: "#F5F2EF"  # surface: off-white alternating stripes and panels
type:                # px on 1920×1080; the tilt is part of the role
  stat-big:          { face: "Shrikhand" > serif-display, size: 422, weight: 400, line: 0.82, color: red, rotate: -6deg }
  hero-title-red:    { face: "Shrikhand" > serif-display, size: 259, weight: 400, line: 0.85, color: red, rotate: -4deg }
  close-big:         { face: "Shrikhand" > serif-display, size: 259, weight: 400, line: 0.88, color: red, rotate: -5deg }
  hero-title:        { face: "Shrikhand" > serif-display, size: 221, weight: 400, line: 0.88 }
  hero-title-bottom: { face: "Shrikhand" > serif-display, size: 200, weight: 400, line: 0.9, rotate: 2deg }
  red-quote:         { face: "Shrikhand" > serif-display, size: 90, weight: 400, line: 1.15, color: bg, shadow: stacked }
  section-header:    { face: "Shrikhand" > serif-display, size: 63, weight: 400, line: 1.0 }
  cell-number:       { face: "Shrikhand" > serif-display, size: 52, weight: 400, line: 1.0, color: red }
  card-title:        { face: "Shrikhand" > serif-display, size: 36, weight: 400, line: 1.1 }
  body:              { face: "Libre Baskerville" > serif-text, size: 32, weight: 400, line: 1.75 }
  body-cell:         { face: "Libre Baskerville" > serif-text, size: 32, weight: 400, line: 1.55 }
  bullet-body:       { face: "Space Grotesk" > mono, size: 32, weight: 400, line: 1.45 }
  label:             { face: "Space Grotesk" > mono, size: 22, weight: 600, tracking: 0.2em, color: red }
  cjk:               { display: song 900, body: song 400, label: hei 600 }
space: { edge-y: 58, edge-x: 69, gap-y: 29, gap-x: 38 }
```

Faces: use the named face when installed or vendored in `assets/fonts/`,
otherwise the stack after `>`. Shrikhand has no local look-alike: vendor it (OFL);
if the stack takes over, set display at 700 so a Bodoni or Didot bold keeps the
weight. Space Grotesk is chrome on the mono stack; bold in body switches to it at
600. The source sets labels in tracked capitals; copy keeps its approved casing (CJK
has no case), so red, 600 and 0.2em carry them, and tilt and red carry CJK display.

## Frame craft

- Squint: one display moment (hero stack, stat-big or close-big) dominates at 3–6×.
- Silence: statement frames hold 50–60% empty; the financial grid is the dense one.
- Restraint: four colors, red the only accent; one display moment per frame; the
  stacked text-shadow on red display is the only shadow; three bullets at most.

## Components

- **hero-title-stack**: three Shrikhand lines (hero-title, -red, -bottom), at least
  one red and one tilted, −4° or +2°; the signature opener.
- **stat-big**: the poster numeral at −6°, red on white or white on red with the shadow.
- **fin-grid**: 3px dark outer border, 1.5px dark inner rules meeting at every
  crossing, square; cells hold a red cell-number, a label and body-cell text.
- **red-leftbar-card**: no outline, no shadow, square; a 4px red left rule, 19px of
  padding, then card-title, body and bullets.
- **red-panel** / **dark-panel**: full-bleed red or dark with white type; red accents
  on dark, the stacked shadow on display set on red.
- **stacked-text-shadow**: `2px 2px 0 rgba(28,20,16,.25), 4px 4px 0 rgba(28,20,16,.2),
  6px 6px 0 rgba(28,20,16,.15)`; a text-shadow, on the red panel only.
- **bullet**: a red em-dash or round glyph hung at the left edge; no disc; three max.
- **progress-bar**: a 10px red strip on the bottom edge, width growing by chapter.

## Frame types

1. **Hero stack** — white. The hero-title-stack on the left, a mono label above,
   a Baskerville tagline below, progress bar and counter at the foot; the right
   half open. Readable at frame 0.
2. **Hero stat** — full red. A white stat-big at −6° with the stacked shadow,
   centered, a label above, a Baskerville line below. About 60% open.
3. **Financial grid** — white, tight padding. Label and section-header over the
   fin-grid: red numerals, mono labels, serif body. The dense frame.
4. **Pull quote** — full red. A two-line white red-quote with the stacked shadow,
   left, a Baskerville cite beneath. About 50% open.
5. **Editorial cards** — white or off-white stripes. Two or three
   red-leftbar-cards under label and section-header. Standard density.
6. **Closing statement** — white or dark. A red close-big at −5°, a label and a
   Baskerville contact line, progress bar at the foot. About 60% open.

## Motion

- Verbs: panels hard-cut, display slams in at its tilt, rules draw, cells snap in.
- Statement display slams from 1.15× to rest in 0.3s `power4.out` on the downbeat;
  its tilt is set from the first frame and never spins in.
- The hero stack is resolved at frame 0; label, tagline and progress bar arrive
  around it, one per half-beat (0.25s at 120 BPM).
- Red and dark panels arrive as hard cuts on the downbeat; the stacked shadow is
  on from the panel's first frame and never animates.
- Fin-grid: the outer border draws in 0.5s `power2.inOut`, inner rules 0.2s
  behind; cells fill row by row on half-beats, numerals cut in whole.
- Leftbar rules grow downward in 0.4s `power3.out` before their text; bullets
  tick in 0.25s apart. The progress bar steps at each cut in 0.2s `power2.out`.
- Never: crossfaded panels, blur, bouncing type, a tilt rotating into place, two
  display moves in one frame.

## Do and don't

- Do stack the hero in three Shrikhand lines, at least one tilted and one red.
- Do set every figure in red Shrikhand; tilt statement display −5° to −6°.
- Do set labels in mono 600 at 0.2em in red and body in Baskerville at 1.75;
  each line keeps its approved casing.
- Do rule data with the 3px + 1.5px double border, use leftbar cards elsewhere,
  and cap red em-dash bullets at three.
- Do fit the line: up to 2 words stat-big or hero-title-red, 3–4 hero-title, 5 or
  more section-header, under 1500px; one display moment per frame.
- Don't add a second accent, round a corner, or use any other shadow.
- Don't put Shrikhand in body, serif in labels or the label face in headlines.
- Don't use disc bullets, leave a red statement untilted, or crowd a statement frame.

## 9:16 and 1:1

- Hero stack: centered and taller on 9:16; stack over tagline on 1:1.
- Hero stat and closing: centered; close-big stacks on 9:16.
- Financial grid: two across or stacked on 9:16; 2×2 on 1:1.
- Pull quote: stacked on 9:16, centered on 1:1; editorial cards stack on both.
- Tilts hold on every ratio without clipping; the progress bar spans the bottom.

## Self-check before snapshot

- One display moment dominates; statement frames 50–60% open; only the fin-grid is dense.
- Four colors; red the lone accent and never body text.
- Statements tilted, figures red, no tilted line clipped; Baskerville body at 1.75.
- Flat: the stacked text-shadow on red display is the only shadow; square
  corners; three bullets at most.
- Copy keeps its approved casing; nothing below 22px.
- Every figure, name and logo traces to the brief; otherwise leave it out.
  Counters and progress are decorative.
