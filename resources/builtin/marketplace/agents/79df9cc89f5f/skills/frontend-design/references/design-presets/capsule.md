# capsule — pill-shaped playful editorial

Adapted from the HyperFrames frame preset `capsule` (heygen-com/hyperframes,
Apache-2.0, see `LICENSE-hyperframes.txt`). Changed for Orkas VideoStudio: local
font stacks with CJK faces, px sizes with the 22px floor, approved-copy casing,
and a motion section.

Pick it when the brand wants to feel friendly, soft and approachable yet still
editorial: consumer apps, creator tools, community launches, playful explainers.
Failure looks like a flat SaaS card grid: unstroked boxes, no pills, bare corners.

## Tokens

```yaml
colors:             # keep the roles; remap by role (see design-presets.md)
  cream: "#F5F5F0"    # canvas: every frame, under glows and grain
  ink: "#1A1A1A"      # ink: every headline and line of body
  outline: "#1E1E1E"  # line: the stroke around every pill
  white: "#FFFFFF"    # surface: content pills and cards
  coral: "#E85D4E"    # accent, warm: accent-line, first card-icon
  lime: "#C4D94E"     # accent, bright neutral: orbit center, highlight
  lavender: "#C5B5E0" # accent, cool: header tag-pill
  sky: "#8BB4F7"      # accent, cool: highlight, card-icon
  violet: "#A06CE8"   # accent, cool: closing italic word
  yellow: "#F2D160"   # accent, warm: title-pill
  peach: "#F5B895"    # accent, warm
  mint: "#A8E6CF"     # accent, cool
  shadow: "rgba(26,26,26,0.08)" # deep: offset shadows only, 8% ink
type:                # px on 1920×1080
  display:          { face: "Bodoni Moda" > serif-display, size: 230, weight: 800, line: 0.88, tracking: -0.03em }
  closing-display:  { face: "Bodoni Moda" > serif-display, size: 163, weight: 800, line: 0.95, tracking: -0.03em }
  headline:         { face: "Bodoni Moda" > serif-display, size: 96, weight: 700, line: 1.05, tracking: -0.02em }
  quote-display:    { face: "Bodoni Moda" > serif-display, size: 81, weight: 600, line: 1.3, tracking: -0.01em }
  section-headline: { face: "Bodoni Moda" > serif-display, size: 77, weight: 700, line: 1.05, tracking: -0.01em }
  stat-number:      { face: "Bodoni Moda" > serif-display, size: 69, weight: 800, line: 1.0, tracking: -0.03em }
  orbit-numeral:    { face: "Bodoni Moda" > serif-display, size: 50, weight: 700, line: 1.0 }
  card-headline:    { face: "Bodoni Moda" > serif-display, size: 36, weight: 700, line: 1.1 }
  subtitle:         { face: "Space Grotesk" > sans, size: 36, weight: 400, tracking: 0.18em }
  body:             { face: "Space Grotesk" > sans, size: 32, weight: 400, line: 1.6 }
  pill-text:        { face: "Space Grotesk" > sans, size: 24, weight: 600, tracking: 0.12em }
  label:            { face: "Space Grotesk" > sans, size: 22, weight: 500, tracking: 0.1em }
  cjk:              { display: song 700, body: hei 400 }
space: { edge: 96, gap: 38, card-pad: [38, 31], stroke: 4, pill-radius: 9999, card-radius: 32 }
```

Faces: use the named face when installed or vendored in `assets/fonts/`,
otherwise the stack after `>`. Bodoni runs 700–800 (600 on quotes), always ink;
where the stack stops at bold, take its bold and never fake a heavier weight.

## Frame craft

- Squint: one Bodoni headline or stat dominates at 3–6× its nearest neighbor.
- Silence: declarative frames fill with atmosphere, not content; their pills are
  wallpaper. Pillar cards and the stat grid are the dense frames and drop it.
- Restraint: every pill stroked, candy on fills and stat numerals only, shadows
  under content only. The nine candies mean nothing: mix warm, cool and lime,
  never two of a family side by side. A brand primary takes one slot; no tenth.

## Components

- **pill**: the container for every chip, button, label, tile, node and bar:
  9999px radius small, 32px on cards, 4px outline, candy or white fill, never
  unstroked. Shadows fall down-right in `shadow`, unblurred: 4px on small nodes,
  6px on stat and title pills and satellites, 8px on cards, 12px on a screen.
- **pill-card**: white, 32px radius, outline, 8px shadow, padded 38/31; a
  card-icon, a card-headline, then body.
- **stat-pill**: white, 32px, outline, 6px shadow; a candy stat-number over a
  pill-text label and a 40px candy bar. The one place color touches a numeral.
- **title-pill**: a yellow 9999px pill, outline, 6px shadow, over the headline.
- **card-icon**: a 60px outlined candy circle holding an ink Bodoni numeral.
- **floating-pill**: outlined candy pills and dots tilted −20° to +25°, flat, 5–8
  per declarative frame, off the edges; short neutral words from the brief, or none.
- **quote-highlight**: an outlined lime or sky pill wrapped around one phrase of
  a Bodoni quote; it replaces bold.
- **bar-track**: a 36px outlined cream track filled by a candy pill, value at its end.
- **accent-line**: a coral pill rule, 60×4px (80×4 on the closing frame).
- **atmosphere**: 1–3 radial candy glows at 6–15% over cream, 4% grain; every frame.

## Frame types

1. **Cover** — glows, grain and 5–8 floating pills at the edges; a yellow
   title-pill over a one- or two-line display headline in ink, centered, a key
   word in candy italic; accent-line and subtitle beneath. Readable at frame 0.
2. **Pillar cards** — no wallpaper; a lavender tag-pill and section-headline over
   three pill-cards with coral, sky and lime icons. The dense frame.
3. **Stat grid** — a centered section-headline over a row of 3–4 stat-pills.
4. **Pull quote** — a few floating pills; a quote-display quote in ink at left,
   one phrase highlighted, accent-line, label attribution. About half open.
5. **Orbit** — a 160px lime circle with an orbit-numeral ordinal, circled by 4–6
   tilted candy satellites with 6px shadows.
6. **Closing plate** — wallpaper back; a yellow title-pill over a centered
   closing-display sign-off in ink, one word in violet italic, 80px accent-line.

## Motion

- Verbs: pills pop, shadows land, wallpaper floats, highlights sweep, bars fill.
- Content pills pop from scale 0.86 in 0.45s `back.out(1.7)`, 0.1s apart, so
  three cards land in one beat; each shadow slides out 0.1s later, in 0.2s.
- Floating pills are in place from the start and drift 8–16px with a 2–4° sway,
  `sine.inOut` yoyo; the glows breathe with them.
- Bodoni lines rise 24px from a baseline mask, 0.6s `power3.out`, a line per
  beat; a highlight sweeps under its phrase on the next beat in 0.4s.
- Bars grow from the left, 0.7s `power3.out`, while numerals count up to the
  brief's value; orbit satellites settle in on `back.out(1.4)`, 0.1s apart.
- Chapters cut on the downbeat, hard or behind one candy pill wiping across, 0.5s.
- Never: elastic wobble, spinning pills, blurred shadows, a headline that bounces.

## Do and don't

- Do make every container a stroked pill: 9999px small, 32px cards, 4px outline.
- Do set Bodoni in ink, negative-tracked; color only on stat numerals, pill fills
  and one italic key word. Shadows under content pills; floating pills flat.
- Do fill declarative frames with pills, glows and grain; center cover, closing
  and orbit, anchor cards and quote left.
- Don't use a sharp text box, an unstroked pill, a blurred or recolored shadow,
  bold for emphasis, a tenth candy, or a headline running edge to edge.
- Copy keeps its approved casing; pill text, labels and subtitle get their look
  from weight 500–600 and 0.1–0.18em tracking (CJK has no case).

## 9:16 and 1:1

- Cover: display on top, pills as a band below on 9:16; centered, fewer pills on 1:1.
- Pillar cards: three stacked on 9:16, two plus one on 1:1; stats 2×2 on both.
- Quote: on top with the highlight inline on 9:16; centered on 1:1. Closing: centered.
- Orbit: three satellites on 9:16, four on 1:1; fewer floating pills as it tightens.

## Self-check before snapshot

- One Bodoni element dominates at 3–6×; only pillar cards and stats run dense.
- Every container a stroked pill; candy on fills, stat numerals, one italic word.
- Shadows unblurred and under content only; glow and grain on every frame.
- Copy keeps its approved casing; nothing below 22px.
- Every figure, name and logo traces to the brief; otherwise leave it out.
