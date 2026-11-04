# Reference-led reconstruction

Load after production-method selection, for `is_generation:false` reference-led
creative work. Reuse existing evidence for unchanged source bytes.

Before proposing reference-derived visuals, obtain source frames through
`video_studio` `reference.inspect` and inspect its attached color sheet. Retain
the returned source identity and sample times with observations. Binary file
text, probe metadata, and rejected extraction commands are not visual evidence.
If inspection fails, keep source-dependent design decisions unknown, recover
access through supported tools, and continue only independent product work;
report a remaining access blocker instead of inventing a reference analysis.
If the frames are omitted because the current model cannot receive images, the
reference's look is unknown: say so in the direction confirmation and recommend
switching to a vision-capable model. Only after the user agrees to continue,
work from the measured rhythm (cuts, BPM, moving shots) and the product page's
words, and do not describe the reference's look.
The first pass returns one still per detected shot, a `shot end` still for each
shot in `shots.moving`, the cut times and the soundtrack tempo (`audio.bpm`).
Use those as the edit-rhythm evidence. Request neighboring times only when a
motion or transition stays unclear.

## Signature elements

Before the direction confirmation, list what a viewer would name as the
reference's look: hero image or subject, display typeface style, recurring
layout devices (masthead, numbered roster, page furniture), palette and grounds,
edit rhythm, and the animation of each moving shot named from its first and end
stills (build-up, typing, camera pull-back, zoom wipe). Record each in `ingest.json` `reference.signature`
as `{element, treatment, how}`:

- `reuse`: the reference is the target brand's own material (its name, logo or
  product is the subject) or the user supplied it as theirs; extract stills from
  the frozen copy. Reuse needs no separate license check: name it in the
  direction confirmation so the user can object.
- `recreate`: rebuild type and layout devices in HTML/CSS with an installed font
  of the same style, vendored into `assets/`; for an image you cannot reuse,
  offer an original generated replacement with its cost, or a graphic stand-in.
- `drop`: only what the user excluded or what contradicts the request.

"Reference the style" means these elements, not only the layout grid, so a guide
reference keeps them too. Name the elements and their treatment in one line of
the direction confirmation; say why for any `drop`.

Understand the dimensions that actually constrain this job:

- **Content and persuasion:** subject/product, audience, hook, demonstration or
  proof, information order, payoff and CTA. Separate observed facts from inferred
  creative intent; a reference's offer, testimonial, demonstrated capability or UI
  is not evidence about the target product. Borrow visual organization without
  asserting those features: take target facts and screens from the target's own
  page or supplied material ([product-source.md](product-source.md)); label only
  an interface drawn without such a source as illustrative.
- **Visual design:** framing, hierarchy, composition, typography, palette,
  product placement, backgrounds and text-safe areas.
- **Movement and timing:** shot boundaries, subject/camera movement, transitions,
  beat lengths, reading time and emphasis. Sample around meaningful changes;
  inspect neighboring frames to locate boundaries instead of inventing timestamps.
- **Audio and text:** take the audio's style, not its detail: music or none, its
  genre, energy and rough tempo; voice-over or none; captions and on-screen words
  as observed. Transcribe when wording or speech timing drives the local edit. A silent
  reference has no transcript to recover.

Persist concise observations in `project/ingest.json` with input identity,
source times/frame evidence, unknowns, preserve/change decisions and intended
target scenes or segment ids. Cover applicable dimensions, marking absent ones
as absent; do not manufacture dialogue, product facts or motion from one frame.

Realize those observations in the existing canonical artifact: COMPOSE scene
copy, layout/motion and reference contracts; or EDL sources, references, temporal
anchors, segments and tracks. A separate analysis without corresponding authored
behavior is incomplete. Reference timing is evidence, not an instruction to copy
seconds blindly: when target wording/language changes, use its actual narration
timing and reading time, then align the corresponding visual beats.

Keep exact user assets and product facts where fidelity matters; generate only
the missing visual work. Reuse accessible references and completed media. A single
video-model request can contain several visual beats; reference shot boundaries
do not each require a paid generation. Preserve prior outputs on revision and
change only affected copy, tracks, scenes or inputs. Text embedded by a video
model is not an editable HTML/subtitle layer; disclose that distinction before
promising a cheap local text replacement.
