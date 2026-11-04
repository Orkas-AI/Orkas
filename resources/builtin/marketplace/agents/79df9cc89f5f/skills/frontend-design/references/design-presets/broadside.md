# broadside — two-register protest poster

Adapted from the HyperFrames frame preset `broadside` (heygen-com/hyperframes,
Apache-2.0, see `LICENSE-hyperframes.txt`). Changed for Orkas VideoStudio: local
font stacks with CJK faces, px sizes with the 22px floor, approved-copy casing,
and a motion section.

Pick it when the brand wants presence and authority carried by type alone: bold,
typographic, declarative. Manifestos, positioning, design-led and developer brands.
Failure looks like a multi-accent corporate deck of small blocks and no shape.

## Tokens

```yaml
colors:             # keep the roles; remap by role (see design-presets.md)
  ink-black: "#111111"                        # deep: dark-register ground; type on orange
  ink-black-alt: "#1A1A18"                    # deep variant
  fire-orange: "#E85D26"                      # accent: lone accent on dark; the orange register
  cream: "#F0ECE5"                            # ink on the dark register
  cream-muted: "#888880"                      # ink-muted on dark
  cream-hint: "#505048"                       # ink-hint on dark: resting bars
  border-dark: "#282826"                      # line on dark: hairlines
  ink-on-orange-muted: "rgba(17,17,17,0.75)"  # ink-muted on orange: lead
  ink-on-orange-hint: "rgba(17,17,17,0.55)"   # ink-hint on orange: kicker
  ink-on-orange-faint: "rgba(17,17,17,0.40)"  # faint on orange: catalogue mark
  ink-on-orange-border: "rgba(17,17,17,0.20)" # line on orange
type:                # px on 1920×1080
  display:        { face: "Barlow" > sans, size: 250, weight: 900, line: 0.88, tracking: -0.04em }
  fadelist-title: { face: "Barlow" > sans, size: 202, weight: 900, line: 0.9, tracking: -0.04em }
  quote-mark:     { face: "Barlow" > sans, size: 192, weight: 900, line: 0.6 }
  h1:             { face: "Barlow" > sans, size: 144, weight: 800, line: 0.9, tracking: -0.03em }
  fadelist-item:  { face: "Barlow" > sans, size: 144, weight: 900, line: 1.0, tracking: -0.03em }
  stat-value:     { face: "Barlow" > sans, size: 106, weight: 900, line: 1.0, tracking: -0.04em }
  h2:             { face: "Barlow" > sans, size: 86, weight: 700, line: 1.1, tracking: -0.02em }
  quote-text:     { face: "Barlow" > sans, size: 73, weight: 700, line: 1.15, tracking: -0.02em }
  h3:             { face: "Barlow" > sans, size: 54, weight: 600, line: 1.2 }
  lead:           { face: "Barlow" > sans, size: 36, weight: 400, line: 1.5 }
  body:           { face: "Barlow" > sans, size: 28, weight: 400, line: 1.6 }
  caption:        { face: "Barlow" > sans, size: 24, weight: 400, line: 1.5 }
  label:          { face: "IBM Plex Mono" > mono, size: 22, weight: 500, tracking: 0.14em }
  cjk:            { display: hei 900, body: hei 400 }
space: { edge: 106, gap-lg: 67, gap-md: 38, gap-sm: 19, rule: 1 }
```

Faces: use the named face when installed or vendored in `assets/fonts/`,
otherwise the stack after `>`. Barlow carries every text role, its range from
weight 400–900 and size; mono is chrome only. The source sets display lowercase
and chrome in capitals; copy keeps its approved casing. A lowercase brief line is
the native register; otherwise 900, size and tight tracking carry the look. CJK
has no case, so the registers carry it; PingFang stops at 600, so raise size.

## Frame craft

- Squint: one display moment dominates at 3–6×, big enough to read as shape first.
- Silence: declarative frames stay 45–55% empty; the stat grid is the dense one.
- Restraint: one register per frame; fire-orange is the only hue, accent on dark
  and environment on orange; three bullets at most.

## Components

- **registers**: two surfaces, one per frame. Dark: ink-black, cream type, orange
  accent. Orange: fire-orange, ink-black type, ink overlays for muted tones.
- **slide-chrome**: 1px bars top and bottom (border-dark, or 20% ink on orange),
  label left, number right; off on cover, chapter, statement, quote and end.
- **kicker**: the mono eyebrow, fire-orange on dark, 55% ink on orange.
- **rule**: a 36×2px stub, orange on dark, ink on orange; the only ornament.
- **broadside-num**: a faint mono catalogue numeral top-left on orange covers.
- **stat-card**: a single 1px border-dark top rule; stat-value, body and a label.
- **bullet**: a fire-orange mono `/` before each lead-size item; three at most.
- **bar-track**: vertical bars on a 1px left axis; cream-hint bars, one orange.
- **compare-panel**: two equal panels split by a 1px rule; the right may fill orange.
- **fadelist**: three fadelist-item words at opacity 1.0 / 0.5 / 0.22 facing one
  oversized fadelist-title.

## Frame types

1. **Cover** (orange) — a one- or two-word display in ink, left, over the rule
   stub and a kicker, a lead in 75% ink beneath; broadside-num top-left, meta
   top-right, no bars. About 45% open; readable at frame 0.
2. **Statement** (dark) — a two-to-four-word display or h1 in cream, left, one
   clause in fire-orange, a kicker, no bars. About 55% open.
3. **Stat grid** (dark, bars on) — a kicker over three stat-cards: orange 900
   figures, Barlow labels, mono notes. The dense frame.
4. **Fadelist** (dark) — the three-step word stack facing a fire-orange
   fadelist-title: before, during, after. Low to moderate density.
5. **Pull quote** (dark, bars off) — 700 quote-text under the oversized orange
   quote-mark, block under 1500px, a mono name and role. About 50% open.
6. **Compare** (dark into orange) — a dark panel documenting in cream beside an
   orange panel declaring in ink, a mono label and h3 on each. Standard.

## Motion

- Verbs: registers hard-cut, words slam, one clause ignites, hairlines draw.
- Register changes are hard cuts on the downbeat, never a crossfade; the cut is
  the punctuation.
- Display and h1 words land one per beat (0.5s at 120 BPM), 1.06× to rest in
  0.25s `power4.out`; the clause turns orange on its own beat, no color tween.
- Hairlines draw in 0.4s `power2.inOut`; each figure cuts in whole once its rule
  is down. Bars rise in 0.6s `power3.out`, the orange one last.
- Fadelist words arrive on successive beats already at their opacity; the title
  slams in last.
- On the cover the display word holds from frame 0; the rule stub draws, then
  kicker, lead and numeral arrive on half-beats.
- Never: shadows, blur, rotation, bounce, crossfaded registers, two display moves.

## Do and don't

- Do set Barlow display at 900, tracked tight; each line keeps its approved casing.
- Do make fire-orange the environment on declarative frames, the lone accent on dark.
- Do keep chrome in mono at 0.14em and mark bullets with the mono `/`, three at most.
- Do say one statement per frame; build hierarchy from weight, size and 1px rules.
- Do leave chrome bars off declarative frames; lean left; the type is the layout.
- Do fit the line: up to 2 words display, 3–4 h1, 5 or more h2, under 1500px.
- Don't add a second accent or a cream/paper register, or set cream type on orange.
- Don't use drop shadows, rounded surfaces or gradient grounds.
- Don't add a serif companion or set chrome in Barlow.

## 9:16 and 1:1

- Cover: word on top, lead below on 9:16; centered word on 1:1.
- Statement: stacked taller on 9:16, centered on 1:1. Fadelist: stack over title.
- Stat grid: three stacked on 9:16; two plus one on 1:1.
- Pull quote: mark on top, quote below on 9:16; centered on 1:1.
- Compare: dark over orange, stacked, on both. Mono chrome stays Latin and digits.

## Self-check before snapshot

- Exactly one display moment dominates; only the stat grid runs dense.
- Declarative frames 45–55% empty, chrome bars off.
- One register per frame; ink on orange, cream on dark; no second hue.
- No shadow, no radius, 1px hairlines; three bullets at most, each with the `/`.
- Copy keeps its approved casing; nothing below 22px.
- Every figure, name and logo traces to the brief; otherwise leave it out.
  Catalogue numerals may run in sequence.
