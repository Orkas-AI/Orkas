# daisy-days — sticker-sheet picture book

Adapted from the HyperFrames frame preset `daisy-days` (heygen-com/hyperframes,
Apache-2.0, see `LICENSE-hyperframes.txt`). Changed for Orkas VideoStudio: local
font stacks with CJK faces, px sizes with the 22px floor, approved-copy casing,
and a motion section.

Pick it when the brand wants warmth and whimsy: playful, childlike, sticker-sheet
kawaii, like a children's picture book. Kids' and family products, learning apps,
playful consumer brands, seasonal campaigns.
Failure looks like a flat corporate slide: square corners, blurred shadows, bare corners.

## Tokens

```yaml
colors:             # keep the roles; remap by role (see design-presets.md)
  cream: "#F5F0E6"      # canvas: the default ground
  turquoise: "#7ECDC0"  # surface: saturated ground (cover), marker fill
  soft-pink: "#F7C8D4"  # surface: quote ground, quote-mark fill
  butter: "#FDE68A"     # surface: badge-pill, bullet dots
  mint: "#A8E6CF"       # surface: marker fill, ground
  lavender: "#D4A5E8"   # surface: closing ground, marker fill
  peach: "#FFCBA4"      # surface: process ground
  sky: "#A8D8F0"        # surface: marker fill, ground
  coral: "#F8635F"      # accent: small markers only, never a ground
  text-dark: "#2D2D2D"  # ink: every outline and shadow, headlines on cream
  text-muted: "#6B6B6B" # muted ink: meta on cream or white only
  white: "#FFFFFF"      # surface: card fill; headline type on saturated grounds
type:                # px on 1920×1080
  display:       { face: "Fredoka One" > sans, size: 125, line: 1.1, tracking: 0.02em }
  headline:      { face: "Fredoka One" > sans, size: 86, line: 1.1, tracking: 0.02em }
  title:         { face: "Fredoka One" > sans, size: 58, line: 1.15, tracking: 0.02em }
  quote:         { face: "Fredoka One" > sans, size: 50, line: 1.35 }
  subtitle:      { face: "Fredoka One" > sans, size: 35, line: 1.2, tracking: 0.02em }
  label-display: { face: "Fredoka One" > sans, size: 25, line: 1.3, tracking: 0.02em }
  badge:         { face: "Fredoka One" > sans, size: 22, tracking: 0.02em }
  body:          { face: "Quicksand" > sans, size: 32, weight: 500, line: 1.6 }
  body-strong:   { face: "Quicksand" > sans, size: 32, weight: 600, line: 1.5 }
  meta:          { face: "Quicksand" > sans, size: 24, weight: 600, line: 1.45 }
  cjk:           { display: hei 600, body: hei 500 }
line: { primary: 3px text-dark, thin: 2px text-dark, ornament: 2.1px text-dark }
shadow: { default: "6px 6px 0 text-dark", small: "4px 4px 0 text-dark",
          headline: "3px 3px 0 text-dark", headline-soft: "3px 3px 0 rgba(0,0,0,0.2)" }
space: { edge: 56, radius: 20, radius-lg: 28, radius-pill: 50, radius-round: 50% }
```

Faces: use the named face when installed or vendored in `assets/fonts/`, otherwise the
stack after `>`. Fredoka One has one weight; Fredoka at 600 is its twin, so vendor that
when it is missing. On the bare `sans` stack set display at 700 and check the inspect
frame. Fredoka is never italic or underlined; Quicksand stays 500–700; roles never swap.

## Frame craft

- Squint: one Fredoka headline or one content card dominates at 3–6× its neighbor.
- Silence: one content container per frame, ringed by an ornament wreath; bare corners
  read as broken. The info-card grid is the one dense frame.
- Restraint: cream or one pastel ground per frame; coral only on small markers; charcoal
  for every border and shadow; no ninth color.

## Components

- **card**: white, 3px charcoal border, 20px radius (28px featured), 6px charcoal offset.
  The universal container, white on any ground.
- **framed-header**: a pastel cap flush on a white body inside one continuous 3px border,
  28px radius, one 6px shadow for the whole unit.
- **badge-pill**: butter, 3px border, 50px radius, badge type, 4px shadow, on one line.
- **circle-marker**: an outlined disc (3px, 50%) in any pastel with a Fredoka numeral,
  white on most fills, charcoal on butter; bullet 20, icon 44, dot 48, step 90px, and
  steps take the 4px shadow.
- **bullet-dot**: a 20px butter disc, 2px charcoal outline, 4px below the line's top.
  Lists never use glyph bullets.
- **ornament**: hand-drawn SVG daisies, stars, suns, clouds and rainbows, 2.1px charcoal
  stroke, 3–7 per frame at corners and edges, cropped by the frame, behind content.
- **quote-mark**: an oversized Fredoka quote glyph, soft-pink with a charcoal stroke.
- **text-headline-shadow**: a 3px charcoal offset under white headlines on saturated
  grounds (20% soft variant on soft-pink and mint); on cream, headlines sit flat.

## Frame types

1. **Cover** — a saturated pastel such as turquoise. A 1–2 line white display with the
   text shadow, centered under a butter badge-pill, a body line below, a counter pill;
   daisies and stars crop off the corners. Full, never crowded; readable at frame 0.
2. **Info cards** — cream. A flat charcoal headline over three white cards, each a
   circle-marker icon (turquoise, coral, lavender), title and body. The dense frame;
   only a couple of ornaments.
3. **Process steps** — peach or another pastel. A white shadowed headline over 3–4 90px
   step circles filled coral → mint → sky → lavender, joined by Fredoka arrows.
4. **Quote** — soft-pink. A white 28px card with a charcoal Fredoka quote under a big
   quote-mark, a Quicksand 700 attribution; a star or two at the corners.
5. **Framed section** — cream. One framed-header: a pastel cap with a Fredoka title over
   a white body with a butter-dot list, ornaments at the edges. Standard density.
6. **Closing** — a saturated pastel such as lavender. A badge-pill and a white shadowed
   display sign-off, centered inside a full ornament wreath.

## Motion

- Verbs: stickers pop, cards drop onto their shadows, ornaments twirl, dots stamp, steps hop.
- Cards, badges and markers pop from scale 0.6 to 1 in 0.35–0.45s `back.out(1.7)`; the
  shadow travels with its shape.
- Ornaments pop 0.08s apart with `back.out(2)`, then daisies turn 6–10° over the scene and
  stars pulse 1→1.08 on beats, `sine.inOut` (one beat = 0.5s at 120 BPM).
- List lines rise 24px over 0.4s `power2.out`, one per beat, each bullet-dot stamping in.
- Step circles hop in one per beat, 0.4s `back.out(2)`; each arrow draws in 0.3s between.
- Chapters cut on the downbeat with a ground swap, or a 0.5s `power2.inOut` pastel wipe.
- Cover and closing headlines and badges are on screen at frame 0; only ornaments move.
- Never: blur, whole-frame fades, linear slides, softening shadows, spinning type.

## Do and don't

- Do set every headline in Fredoka and every body line in Quicksand.
- Do outline every shape in 3px charcoal with a hard 6px or 4px offset; cards stay white.
- Do give headlines on saturated grounds white type and the text shadow; flat on cream.
- Do use butter-disc bullets and a 3–7 ornament wreath cropping at the corners.
- Do keep one container per frame; rotate markers coral → mint → sky → lavender → butter.
- Do center most frames; cream for dense ones, saturated for cover, quote and closer.
- Don't use square corners, blurred or rgba shadows (bar the soft text shadow), colored
  borders, a coral ground, a ninth color or a third font.
- Don't use glyph bullets, bare corners, two competing panels or edge-to-edge headlines.

## 9:16 and 1:1

- Cover, quote and closing: centered on both; taller on 9:16 with 5–7 ornaments.
- Info cards: stacked on 9:16, 2+1 on 1:1. Steps: vertical, arrows down on 9:16; 2×2 on 1:1.
- Framed section: cap and body, the body growing taller on 9:16.
- Keep the 56px edge on the short side; tight ratios lean to 5–7 ornaments.

## Self-check before snapshot

- One headline or card dominates; one container in its wreath; only info cards dense.
- Cream or one pastel ground; coral markers only; text-muted only on cream or white.
- 3px outline and hard offset on every raised shape, no blur; 3–7 ornaments; disc bullets.
- Copy keeps its approved casing; nothing below 22px.
- Every figure, name and logo traces to the brief; otherwise leave it out.
