# blue-professional — cream and cobalt briefing

Adapted from the HyperFrames frame preset `blue-professional` (heygen-com/hyperframes,
Apache-2.0, see `LICENSE-hyperframes.txt`). Changed for Orkas VideoStudio: local
font stacks with CJK faces, px sizes with the 22px floor, approved-copy casing,
and a motion section.

Pick it when the brand wants investment-research rigor and refined restraint:
measured, executive-readable, premium. B2B, finance, analytics, board updates.
Failure looks like a heavy-outlined, multi-color dashboard or cobalt headlines.

## Tokens

```yaml
colors:             # keep the roles; remap by role (see design-presets.md)
  bg: "#fdfae7"                         # canvas: warm cream on every frame
  primary: "#1e2bfa"                    # accent: the only one; eyebrows, figures, CTA, bars
  text: "#111111"                       # ink: headlines and quotes, never cobalt
  text-muted: "#6b6b6b"                 # ink-muted: body
  text-light: "#9a9a9a"                 # ink-light: tertiary chrome
  accent-light: "rgba(30,43,250,0.08)"  # accent tint: tag pills, bar tracks, highlight
  accent-medium: "rgba(30,43,250,0.15)" # accent tint, stronger: atmosphere
  border: "rgba(30,43,250,0.2)"         # line: card borders
  card-bg: "rgba(30,43,250,0.04)"       # surface: card fill
  positive: "#059669"                   # signal: upward change, text only
  negative: "#dc2626"                   # signal: downward change, text only
radii: { pill: 100, card-lg: 14, card-md: 12, card-sm: 10, bar: 6, circle: 50% }
type:                # px on 1920×1080; headings and quotes in text, figures in primary
  quote-mark:   { face: "Space Grotesk" > sans, size: 154, weight: 700, line: 0.5, color: primary, opacity: 0.15 }
  h1:           { face: "Space Grotesk" > sans, size: 81, weight: 700, line: 1.08, tracking: -0.02em }
  metric-value: { face: "Space Grotesk" > sans, size: 58, weight: 700, line: 1.0, color: primary }
  h2:           { face: "Space Grotesk" > sans, size: 50, weight: 600, line: 1.1, tracking: -0.02em }
  blockquote:   { face: "Space Grotesk" > sans, size: 46, weight: 500, line: 1.35 }
  h3:           { face: "Space Grotesk" > sans, size: 40, weight: 500, line: 1.3, tracking: -0.02em }
  stat-num:     { face: "Space Grotesk" > sans, size: 36, weight: 700, line: 1.0, color: primary }
  body:         { face: "Inter" > sans, size: 32, weight: 400, line: 1.6, color: text-muted }
  h4-eyebrow:   { face: "Space Grotesk" > sans, size: 22, weight: 600, tracking: 0.08em, color: primary }
  tag:          { face: "Space Grotesk" > sans, size: 22, weight: 500, color: primary }
  counter:      { face: "Space Grotesk" > sans, size: 22, weight: 500, tracking: 0.05em, color: text-muted }
  cjk:          { display: hei 600, body: hei 400 }
space: { edge: 96, top: 96, gap: 27 }
```

Faces: use the named face when installed or vendored in `assets/fonts/`,
otherwise the stack after `>`. Both faces fall back to one sans stack, so the
pair rests on weight and color: headings 500–700 near-black, body 400 gray. The
source sets eyebrows in tracked capitals; copy keeps its approved casing (CJK
has no case), so cobalt, weight 600, 0.08em and the accent-line carry them.

## Frame craft

- Squint: one near-black headline or cobalt figure dominates at 3–6× its neighbor.
- Silence: content frames read balanced, never crowded; the dashboard is the dense one.
- Restraint: cobalt carries every accent and nothing else does; headlines stay
  near-black; cards lift by tint, never shadow; green and red are inline text only.

## Components

- **card-tinted**: card-bg fill, 1.5px `border` line, 14px radius, no shadow; never solid.
- **metric-card**: the same shell with a cobalt metric-value, a label in text, a
  muted note, and an optional ↑/↓ chip in positive or negative text, no fill.
- **tag-pill**: accent-light fill, cobalt tag type, 100px radius; slide-header right.
- **cta-button**: a solid cobalt pill, cream Space Grotesk 600; the one solid element.
- **accent-line**: a 60×4px cobalt bar, 2px radius, above titles and under eyebrows.
- **bar-track**: a 28px accent-light track, 6px radius; the fill's width is the value.
- **step-circle**: 56px cobalt, cream numeral; steps fade 1.0 → 0.85 → 0.7 → 0.55.
- **split-highlight**: accent-light, 4px cobalt left rule, 12px radius; a pull quote.
- **slide-header**: cobalt eyebrow left, tag-pill right, h2 below; tops content frames.
- **atmosphere**: a clipped diagonal tint panel, a 3×3 cobalt dot grid, concentric
  rings. Cover and closing only.
- **progress-bar**: a 3px cobalt strip on the bottom edge; width grows by chapter.

## Frame types

1. **Cover** — cream, the diagonal tint panel over the right ~36%, a 3×3 dot
   grid. A two-line near-black h1 on the left under an accent-line and meta
   eyebrow, a muted body line below. Low density; readable at frame 0.
2. **Dashboard** — slide-header and h2 over three metric-cards: cobalt figure,
   label, muted note, optional chip. The dense frame; figures are the accent.
3. **Bar ranking** — eyebrow and h2 over three to five labeled bar-tracks with
   cobalt fills and percentages. Standard density.
4. **Pull quote** — centered over faint rings: a near-black blockquote under the
   15% cobalt quote-mark, a muted cite in the eyebrow style. About 55% open.
5. **Split + highlight** — an Inter body column beside a split-highlight pull
   quote, eyebrow and h2 above, a generous gutter. Standard.
6. **Closing / CTA** — cream with rings: accent-line, a centered near-black h1, a
   body line, the single cobalt cta-button below. About 60% open.

## Motion

- Verbs: masks lift lines, the accent-line draws, bars fill, cards fade up, rings drift.
- Headlines reveal by a baseline mask, 0.6s `power3.out`, one line per beat (0.5s
  at 120 BPM), after the accent-line draws 0→60px in 0.4s `power2.out`.
- Cards fade up 16px in 0.5s `power2.out`, 0.12s apart; a metric-value counts to
  the brief's figure in 0.8s `power1.out` and holds.
- Bars fill from the left in 0.7s `power3.out`, one per half-beat in rank order.
- The diagonal panel drifts about 2% and the rings breathe 1→1.04, `sine.inOut`.
- Chapters cut on the downbeat or push left in 0.6s `power2.inOut`; the
  slide-header lands first and the progress bar extends in 0.5s. The CTA may
  take a soft cobalt glow on its last beat, the only shadow the system allows.
- Never: bounce, elastic, rotation, a second color, card shadows, fast zooms on type.

## Do and don't

- Do start every frame on cream and let cobalt carry every accent.
- Do set headlines near-black at −0.02em, eyebrows cobalt at 0.08em, figures
  cobalt 600–700, body Inter 400 muted at 1.6; each line keeps its approved casing.
- Do use tinted cards (4% fill, 20% border, 10–14px radius, no shadow) and pill
  chrome; keep atmosphere and the one solid CTA for cover and closing.
- Do fit the headline: up to 3 words h1, 4–6 h2, 7 or more h3, under 1500px.
  Lean left on cover, dashboard and split; center quote and closer.
- Don't add a second accent or set a headline in cobalt.
- Don't shadow content, outline in opaque cobalt or square a content corner.
- Don't use the green and red chips as decoration; they mark a real comparison.
- Don't thicken borders to fill space, or run a headline edge to edge.

## 9:16 and 1:1

- Cover: title on top, the diagonal panel as a band below on 9:16; title in the
  upper half, dots in a corner on 1:1.
- Dashboard: three cards stacked on 9:16; 2×2 on 1:1.
- Bar ranking: three to five tighter bars on 9:16; three on 1:1.
- Pull quote and closing: centered, taller on 9:16. Split + highlight stacks.

## Self-check before snapshot

- One near-black headline or cobalt figure dominates; only the dashboard runs dense.
- Cobalt is the only accent; headlines near-black; green and red inline only.
- Cards tinted and rounded, 20% borders, no shadow; atmosphere on cover and closing.
- Left on cover, dashboard and split; centered on quote and closer.
- Copy keeps its approved casing; nothing below 22px.
- Every figure, name and logo traces to the brief; otherwise leave it out. A
  change chip needs a real comparison from the brief.
