# Design presets

Thirteen starting systems for COMPOSE. Each one fixes a look: color roles, type
ramp, components, frame types and motion. The brand supplies colors and fonts;
the brief supplies every word, number and image. They are the recommended
starting point when no concrete reference sets the look, or when a reference's
grammar matches one; skip them when none fits the brand and the brief. A brand
website or design system gives the tokens to remap onto, not the look itself. Pick one,
read its file, remap it, apply the video-type rules below, then design each
scene for this subject. Name it in `art_direction.visual_direction.visual_tradition`
(for example "blue-professional preset, remapped to the brand tokens").

The presets are adapted from the HyperFrames frame presets (heygen-com/hyperframes
@279d40dc, Apache License 2.0); each file states what changed, and the license
text is in [design-presets/LICENSE-hyperframes.txt](design-presets/LICENSE-hyperframes.txt).

| Preset | Look | Temperament and fit |
| --- | --- | --- |
| [biennale-yellow](design-presets/biennale-yellow.md) | parchment, one indigo ink, yellow bloom and panel, display serif, 1px hairlines | elegant, atmospheric; brand or culture launches told as an issue or exhibition |
| [blockframe](design-presets/blockframe.md) | 4px black borders, hard offset shadows, candy pastels, heavy sans | loud, playful, confident; consumer apps, social shorts |
| [blue-professional](design-presets/blue-professional.md) | warm cream, one cobalt accent, tinted cards without shadows, pill chrome | measured, executive; B2B products, reports, consulting |
| [bold-poster](design-presets/bold-poster.md) | tilted script display, serif body, red and brown-black on white, double-border grids | printed gravitas with popular energy; campaigns, events, food and retail stories |
| [broadside](design-presets/broadside.md) | ink-black and fire-orange planes, massive lowercase heavy sans | declarative; manifestos, announcements, bold product statements |
| [capsule](design-presets/capsule.md) | pill shapes with ink outlines, cream, candy colors, Bodoni with a grotesk | friendly, warm; lifestyle and consumer brands, e-commerce |
| [cartesian](design-presets/cartesian.md) | warm stone palette, taupe hairline grid, Playfair with Inter, drafted rings | quiet, literary; luxury, architecture, research |
| [cobalt-grid](design-presets/cobalt-grid.md) | cream paper, cobalt ink, permanent graph grid, serif with grotesk and mono | systematic, technical-editorial; developer tools, data, infrastructure |
| [code-editorial](design-presets/code-editorial.md) | warm cream, scarce terracotta, Garamond display, a navy code surface | considered, developer-facing; launches, changelogs and docs with code |
| [coral](design-presets/coral.md) | coral, ink and cream planes at hard edges, diagonal hatch, condensed display, giant numerals | bold magazine energy; product drops, list videos, fashion and sport |
| [creative-mode](design-presets/creative-mode.md) | cream, 4px ink borders, hard offset shadows, black heavy display, mono taxonomy | punchy but restrained; creator tools, studios, tutorials with attitude |
| [daisy-days](design-presets/daisy-days.md) | sunny pastels, charcoal outlines, rounded friendly type, hand-drawn ornaments | playful, warm; education, kids, cafés, gifts |
| [editorial-forest](design-presets/editorial-forest.md) | green, pink and cream, a serif display, mono chrome, 2px hairlines, monogram stamp | spacious, literary calm; wellness, sustainability, publishing |

Pick by the brand's temperament first, then check the fit. Use one preset per
video. When a frame needs a component the preset lacks, borrow it from another
preset and restyle it in this preset's tokens.

## Video-type rules

These sit on top of whichever preset is chosen.

- **Product demo (app, SaaS, tool)**: real screens at 45–70% of the frame width.
  Mark a region on the full screen before pushing into it (scale 1.6–2.0 over
  0.8–1.2s). A 40px cursor with a click ring; typed input at 2–4 characters per
  0.1s. Change the screen's state every 1–2s and carry the same screen across
  scenes instead of cutting to new layouts.
- **Physical product or offer**: supplied product images only; the product is
  the largest element in hero frames (50–75% of the height). At most three
  callouts with leader lines per view. One offer element per frame; only the
  closing frame pairs the price with the CTA. Never invent prices, discounts,
  ratings or sales counts.
- **Short-form 9:16**: essential text between y=220 and y=1540 and left of x=940.
  The hook and a visual of its payoff are readable at frame 0. At most 12 CJK
  characters or 6 English words a line, three lines a frame. Cut every 1–2
  beats; captions sit above y=1540.
- **Tutorial or how-to**: one action per step frame, each on the real UI. Mark
  the control with an outline, dim the rest, then push in. At most five numbered
  pins per screen. Menu names, button labels and shortcuts exactly as in the product.
- **Numbers and reports**: one number per frame carries the accent. Every chart
  frame shows its unit and source; bar axes start at zero. Count-ups take
  0.8–1.5s, except the cover, which shows the final figure at frame 0. Hold a
  finished chart 1.5s or more.
- **Brand film or teaser**: one line per frame; plates get a vignette and scale
  slowly (1.00→1.08 over the shot); cut to black for half a beat before the
  lockup.
- **A cast of people, agents or products**: one item per beat on hard cuts
  (0.5s at 120 BPM), then a summary frame listing all of them.

## Remap onto the brand

Every preset names color roles in its tokens. Map the brand onto them by role
and keep the structure:

- `canvas` → the brand's background; `ink` → its text color; `accent` → its
  primary; `deep` → its dark or ink; `surface` and `line` follow canvas and ink.
- A brand with one color keeps the preset's neutrals and puts that color on
  `accent`. Keep the preset's rule for how much of the frame `accent` may cover.
- If the brand primary fails contrast where the preset puts accent text, keep
  it for fields and marks, and set that text in `ink`.
- Fonts: use the brand's faces when they are installed or supplied, then the
  preset's named face, then its stack. Copy any font file the video depends on
  into `assets/fonts/` and load it with `@font-face`; never load a remote font.

## Fixed and free

- Fixed: the color-role rules, type roles and ramp, component shapes, frame-type
  grammar, motion vocabulary and the don'ts.
- Free: every word, number and image; which frame types appear, in what order
  and how often; which components a frame uses.

## Units and ratios

Sizes are px on a 1920×1080 frame. On 1080×1920 keep body, label and caption
sizes, and scale display sizes by 0.7–0.8 so the longest line fits about 920px.
On 1080×1080 scale display by about 0.8.

## Font stacks

Put the Latin face before the CJK face so mixed lines take each script's own
face. These stacks resolve on macOS and Windows without downloads.

- `serif-display`: "Didot", "Bodoni 72", "Bodoni MT", Georgia, then `song`
- `serif-text`: "Iowan Old Style", "Charter", Georgia, "Cambria", then `song`
- `sans`: "Avenir Next", "Helvetica Neue", "Segoe UI", Arial, then `hei`
- `condensed`: "Avenir Next Condensed", "DIN Condensed", "Bahnschrift", Impact, then `hei`
- `mono`: "SF Mono", Menlo, "Cascadia Mono", Consolas, monospace
- `song`: "Songti SC", "STSong", "Source Han Serif SC", "Noto Serif CJK SC", SimSun, serif
- `hei`: "PingFang SC", "Hiragino Sans GB", "Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif

PingFang SC stops at weight 600 and SimSun has one thin weight. When a preset
asks for heavier CJK than the machine has, raise size rather than fake bold, and
check the inspect frame.

## Rules every preset keeps

- Type floor: nothing on screen below 22px; body copy at least 28px.
- Casing: keep the approved copy's casing. Presets describe letter-spacing, never
  `text-transform: uppercase`.
- Frame 0: the cover's headline and hero are visible on the first frame; build
  the resolved frame first, then animate supporting parts into it.
- Real material first: product screens and photos come from `assets/product/`,
  supplied media or the reference. Never redraw a screen that was captured.
- Numbers: every figure, price, rating, date and count comes from the brief or a
  source. Ordinals such as 01, 02 are decoration and may be free.
- Local only: no remote fonts, scripts or images at render time.
