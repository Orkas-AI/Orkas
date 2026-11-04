# blockframe — candy neobrutalist blocks

Adapted from the HyperFrames frame preset `blockframe` (heygen-com/hyperframes,
Apache-2.0, see `LICENSE-hyperframes.txt`). Changed for Orkas VideoStudio: local
font stacks with CJK faces, px sizes with the 22px floor, approved-copy casing,
and a motion section.

Pick it when the product wants to feel confident and graphic: bold, punchy,
playful-loud. Consumer apps, creator tools, launches with a sense of humor,
anything that should feel like a sticker book or a toy box, not a deck.
Failure looks like a flat web card grid: thin or missing borders, blurred
shadows, everything politely aligned.

## Tokens

```yaml
colors:             # keep the roles; remap by role (see design-presets.md)
  black: "#000000"      # ink, line, deep: all type, every border and shadow, close ground
  white: "#FFFFFF"      # surface: card fills; border and type on the close-frame
  offwhite: "#FFFDF5"   # canvas: default ground
  pink: "#FE90E8"       # accent: pastel ground, icon square, star
  blue: "#C0F7FE"       # accent: pastel ground, icon square
  green: "#99E885"      # accent: pastel ground, icon square
  yellow: "#F7CB46"     # accent: CTA fill and the close-frame shadow
  cream: "#FFDC8B"      # canvas variant: cover ground, warm pastel
borders: { primary: 8, thin: 6 }   # px, black; source 0.4 / 0.3cqw at 1920
shadows: { default: 16, small: 8, hover: 12, close-yellow: 24, close-white: 12 }
type:                # px on 1920×1080
  heading-xl:  { face: "Inter" > sans, size: 96, weight: 900, line: 0.95, tracking: -0.03em }
  close-title: { face: "Inter" > sans, size: 81, weight: 900, line: 0.95, tracking: -0.03em }
  heading-lg:  { face: "Inter" > sans, size: 63, weight: 800, line: 1.0, tracking: -0.02em }
  stat-number: { face: "Inter" > sans, size: 63, weight: 900, line: 1.0 }
  quote-text:  { face: "Inter" > sans, size: 52, weight: 900, line: 1.15, tracking: -0.02em }
  heading-md:  { face: "Inter" > sans, size: 40, weight: 700, line: 1.1, tracking: -0.01em }
  card-title:  { face: "Inter" > sans, size: 36, weight: 700, line: 1.2 }
  body:        { face: "Inter" > sans, size: 32, weight: 500, line: 1.6 }
  label:       { face: "Space Grotesk" > sans, size: 22, weight: 600, tracking: 0.08em }
  counter:     { face: "Space Grotesk" > sans, size: 22, weight: 700, tracking: 0.1em }
  cjk:         { display: hei 900, body: hei 500 }
space: { edge: 60, gap: 33 }
```

Faces: use the named face when installed or vendored in `assets/fonts/`,
otherwise the stack after `>`; labels share the sans stack and differ by
tracking and weight. The source leans on capitals; copy keeps its approved
casing (CJK has no case), so weight 800–900, tight tracking, borders and
decorations carry the voice. PingFang stops at 600: raise CJK size, never fake bold.

## Frame craft

- Squint: one display moment dominates at 3–6× its neighbor; cards read as one system.
- Silence: cover, quote and close keep air, held by decorations rather than
  content. The feature and stat grids are the dense frames.
- Restraint: border and shadow travel in pairs (8↔16 cards, 6↔8 chrome, all
  black; white only on the closer); one pastel ground per frame, never a sixth.

## Components

- **card-elevated**: white, 8px black border, 16px hard shadow, square; the main card.
- **card-small**: white, 6px border, 8px shadow, square; stats, people, steps.
- **label-pill**: 6px border, 8px shadow, 9999px radius, pastel fill; opens every region.
- **button-primary**: yellow, black Inter 700, 6px border, 8px shadow, square.
- **star-burst**: a ten-point clip-path star, pastel, 6px border; corner attention.
- **stripe-block**: 45° stripes of black and one pastel inside a 6px border.
- **bg-dot-grid**: faint black dots, 2–3px on a 48px grid, over a corner or ground.
- **tilt-deco**: a block, badge or star turned 2–12°; stat cards alternate −2°/+2°.
- **stat-deco-dot**: a 24px pastel circle, 4px border, on stat cards; the only round shape.
- **close-frame**: black, white type, 8px white border, 24px yellow shadow; the closer.

## Frame types

1. **Cover** — cream or offwhite with a faint dot grid. A label-pill over a two-
   or three-line heading-xl on the left; tilted pastel blocks and a star break
   into the right third; a counter pill. Comfortable; readable at frame 0.
2. **Feature cards** — blue. Label-pill and heading-lg over three card-elevated
   cards, each a pastel icon square, card-title and body. Dense by design.
3. **Stat grid** — green. Three card-small stats tilted −2/+2°, each a deco dot,
   stat-number and label, under label-pill and heading-lg. Dense.
4. **Closing plate** — black. A white close-title inside the close-frame under
   an inverted label-pill; a pink star over one corner. About 50% open.
5. **Quote** — pink or offwhite. Quote-text in a card-elevated, label-pill
   above, attribution below, one decoration. Comfortable.
6. **Timeline** — offwhite. Three or four pastel card-small steps with step
   numbers, joined by black connector bars. Standard density.

## Motion

- Verbs: cards slam down, shadows snap out, pills and stars pop, tilts settle,
  grounds hard-cut.
- Cards slam in from 1.08× with a 24px shadow to rest in 0.3s `power4.out`;
  grids land one card per half-beat (0.25s at 120 BPM) in reading order.
- Pills, stars and deco dots pop from 0 in 0.35s `back.out(2)`; stat cards
  settle into their tilt in 0.4s `back.out(1.6)`.
- Press for emphasis: a card or the CTA moves 4px down-right as its shadow
  shrinks 4px (the hover token), 0.2s `power2.out`, back on the next beat.
- Chapters hard-cut on the downbeat to a new pastel with the headline set; the
  rest lands on the following beats.
- The cover's heading-xl and main decorations hold from frame 0.
- Never: crossfades, blurred or soft shadows, a shadow without its border,
  tweened border widths, rotation past 12°.

## Do and don't

- Do pair every border with its shadow: 8px with 16px, 6px with 8px.
- Do change the pastel ground every frame; the cycle is the rhythm.
- Do open each region with a label-pill and add one decoration per frame.
- Do keep shadows solid black, zero blur, bottom-right; yellow for the CTA.
- Do set display at 800–900, tracked tight; each line keeps its approved casing.
- Do fit the headline: up to 3 words heading-xl, 4–6 heading-lg, 7 or more
  heading-md, under 1500px wide. Lean most frames left.
- Don't round a corner except the deco dot, or blur any shadow.
- Don't color a border (white only on the closer) or add a sixth pastel.
- Don't set display untracked or a label as bare text.
- Don't align everything perfectly or leave a corner empty.

## 9:16 and 1:1

- Cover: title on top, decorations below; fewer decorations on 1:1.
- Feature cards: three stacked on 9:16; two plus one on 1:1.
- Stat grid: three tilted cards stacked on 9:16; 2×2 on 1:1.
- Closing and quote: centered; taller close-frame and stacked quote on 9:16.
- Timeline: vertical with connectors hidden on 9:16; 2×2 on 1:1.
- Drop decorations as the frame tightens: bordered, not cluttered.

## Self-check before snapshot

- One display moment dominates; the cards read as one system.
- Only the feature and stat grids run dense; cover, quote and close keep air.
- Every border has its shadow partner; solid black, zero blur, bottom-right.
- New pastel each frame; a label-pill and a decoration on each; square corners.
- Copy keeps its approved casing; nothing below 22px.
- Every figure, name and logo traces to the brief; otherwise leave it out.
  Counters and step numbers may be decorative.
