# code-editorial — warm brand book with a code surface

Adapted from the HyperFrames frame preset `code-editorial` (heygen-com/hyperframes,
Apache-2.0, see `LICENSE-hyperframes.txt`). Changed for Orkas VideoStudio: local
font stacks with CJK faces, px sizes with the 22px floor, approved-copy casing,
and a motion section.

Pick it when the subject is considered, literary and developer-facing: a code
change, release or developer doc that wants editorial calm and a first-class
code surface. Changelogs, pull-request walkthroughs, SDK and API launches.
Failure looks like an IDE screenshot on pure white, or coral turning up thrice.

## Tokens

```yaml
colors:             # keep the roles; remap by role (see design-presets.md)
  ink: "#141413"         # ink: headlines and body on cream and tile
  cream: "#FAF9F5"       # canvas: the default ground; also type on navy
  tile: "#EFE9DE"        # surface: content half a step darker
  tile-strong: "#ECE3D4" # surface: the stronger step
  coral: "#CC785C"       # accent: one moment per frame, and the ✱ mark
  navy: "#181715"        # deep: code surface body, gravity grounds
  navy-soft: "#1F1E1B"   # deep: dark cards
  navy-elev: "#252320"   # deep, raised: code title bar and status strip
syntax: { string: "#5DB8A6", number: "#E8A55A", success: "#5DB872", warn: "#C64545" } # fixed; keywords coral; never remapped
lines:  { hairline: "ink at 12%", hairline-strong: "ink at 20%", dark: "cream at 14%, on navy" }
shadow: { card: "0 1px 3px ink at 8%, 0 4px 16px ink at 4%" } # the only shadow, used rarely
type:                # px on 1920×1080
  display-cover:  { face: "EB Garamond" > serif-text, size: 190, weight: 400, line: 0.98, tracking: -0.028em }
  number-hero:    { face: "EB Garamond" > serif-text, size: 180, weight: 400, line: 0.95, tracking: -0.025em }
  display:        { face: "EB Garamond" > serif-text, size: 140, weight: 400, line: 1.02, tracking: -0.022em }
  display-italic: { face: "EB Garamond" > serif-text, size: 129, weight: 400, style: italic, line: 1.05, tracking: -0.012em }
  quote-pull:     { face: "EB Garamond" > serif-text, size: 96, weight: 400, style: italic, line: 1.12, tracking: -0.012em }
  headline:       { face: "EB Garamond" > serif-text, size: 88, weight: 400, line: 1.06, tracking: -0.018em }
  card-title:     { face: "Inter" > sans, size: 44, weight: 500, line: 1.25, tracking: -0.005em }
  lead:           { face: "Inter" > sans, size: 40, weight: 400, line: 1.5 }
  body:           { face: "Inter" > sans, size: 29, weight: 400, line: 1.5 }
  button:         { face: "Inter" > sans, size: 28, weight: 500, line: 1.0 }
  tag:            { face: "Inter" > sans, size: 26, weight: 500, tracking: 0.18em }
  number-unit:    { face: "JetBrains Mono" > mono, size: 40, weight: 500, line: 1.0 }
  code:           { face: "JetBrains Mono" > mono, size: 32, weight: 400, line: 1.6 }
  kicker:         { face: "JetBrains Mono" > mono, size: 28, weight: 500, tracking: 0.16em }
  mono-label:     { face: "JetBrains Mono" > mono, size: 26, weight: 500, tracking: 0.02em }
  cjk:            { display: song 400, body: hei 400 }
space: { edge: 80, gap: 33, rule: 1, radius: [6, 8, 12], pill: 9999 }
```

Faces: use the named face when installed or vendored in `assets/fonts/`, otherwise
the stack after `>`. EB Garamond is warm old-style: serif-text, never Didot or sans;
display stays 400, italic voices a stance; CJK in mono kickers falls back to hei.

## Frame craft

- Squint: one EB Garamond display moment dominates at 3–6× its neighbor.
- Trinity: cream or tile ground, ink voice, coral exactly once per frame; warm
  navy only as the code surface or a gravity ground. No cool gray, pure white,
  pure black or fourth hue.
- Restraint: lift is a 1px hairline plus, rarely, the one card shadow; a tile on
  cream reads raised by its warm half-step. Density is free, as content wants.

## Components

- **card-hairline**: cream or tile, 12px radius, 1px hairline and the card shadow;
  card-title over body. Never a heavy drop, glow or gradient.
- **kicker-spike**: a coral ✱ then 2–5 indexical words in the mono kicker; never a
  sentence, never without the ✱.
- **coral-callout**: the one coral moment, 8px radius: a coral field with cream
  button or headline type, or cream with a coral edge; CTA, inline link or band.
- **number-lockup**: a number-hero figure with a mono number-unit beside it (200K,
  +1,204, −318, 17 files); serif figure, unit always mono.
- **pull-quote**: quote-pull italic (a commit message, a reviewer's line, the
  thesis) with a tag cite under it.
- **section-rule**: a 1px hairline, dark variant on navy; the only separator. A
  coral 1px rule may draw on to open a section. Never 2px or more.
- **code-surface**: a navy panel, 8px radius, dark 1px border, a navy-elev title bar
  (filename in mono-label) and status strip; cream `code` with coral keywords, teal
  strings, amber numbers. Real code from the diff or brief; this is its frame.
- **spike-mark**: the ✱ glyph (U+2731), always coral; the brand mark.

## Frame types

1. **Cover** — cream, 80px edge; a kicker-spike over a two- or three-line
   display-cover in ink, a lead, a mono-label index strip (repo · branch, or
   product · version) along an edge. The ✱ is the one coral. Readable at frame 0.
2. **Statement** — cream, or navy for gravity; a kicker and one two-line display
   sentence, display-italic for a stance. No accent, or one coral word.
3. **Code surface** — cream framing the code-surface (diff, before-and-after or typed
   snippet); outside it one coral cue such as a +/− gutter mark. The dense frame.
4. **Number / impact** — a kicker, a number-lockup over a 1px rule, a lead or
   caption; the figure in ink, at most the unit in coral.
5. **Pull-quote** — a kicker, a quote-pull, a tag cite (name · role) beneath.
6. **Closing / CTA** — cream or navy; a short display sign-off, the coral-callout,
   and for a shipped-by close a row of hairline-ringed avatars with mono names.

## Motion

- Verbs: lines dissolve in, code types on, numbers count up, a coral rule draws.
- Serif display fades up 16px in 0.6s `power2.out`, a line per beat; on the cover
  it is set from frame 0 and only the kicker and lead arrive.
- Code types on two lines per beat, each wiping in over 0.2s `none`, diff lines
  taking their gutter mark as they land; the panel is already in place.
- A number-lockup counts up to the brief's value in 0.8s `power2.out`; the unit holds.
- The coral section-rule is the only draw-on, 0.5s `power1.inOut`; the ✱ fades in
  and scales 0.92→1 in 0.4s `power2.out` on one emphasis beat per scene.
- Chapters cross-dissolve in 0.3s on the downbeat, cream to navy included.
- Never: overshoot, bounce, elastic or `back` eases, a spinning ✱, glow, tilt.

## Do and don't

- Do stand frames on cream, gather content on a tile half-step, lead with one focal.
- Do set EB Garamond 400 display, Inter 400 body, mono kickers (opened by ✱) and code.
- Do ration coral to one moment a frame; lift with a hairline and one soft shadow at
  most; keep navy for code and gravity grounds; pair figures with a mono unit.
- Don't use pure white, cool gray, pure black or a fourth hue; keep syntax colors in
  the panel; no heavy shadow, glow, gradient, tilt or square corner.
- Don't set a sans headline, a serif label or unit, or coral headline or body text.
- Copy keeps its approved casing, display included; kickers and tags get their look
  from mono or Inter 500 and 0.16–0.18em tracking (CJK has no case).

## 9:16 and 1:1

- Cover: display on top, index below on 9:16; index in a corner on 1:1.
- Statement, quote and number: stacked, taller on 9:16; centered on 1:1.
- Code surface: taller with fewer lines on 9:16, square and centered on 1:1; the
  hairline and mono chrome stay. Closing: avatars wrap below, never shrink.

## Self-check before snapshot

- One EB Garamond moment dominates; coral exactly once; navy only for code or gravity.
- 1px hairlines, one soft shadow at most, 6/8/12px radii; every figure has a mono unit.
- Copy keeps its approved casing; nothing below 22px.
- Every figure, name and logo traces to the brief; otherwise leave it out. Diffs,
  file counts and branches come from the real change; avatars only from supplied images.
