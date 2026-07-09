---
ownerAgent: 79df9cc89f5f
name: stage-plan
min_app_version: "1.5.1"
description_zh: 端到端视频编排的"摄入+计划"知识——先据实摄入用户素材，再把意图拆成一份跨模态 EDL（plan.json：剪辑/生成/合成/已提供 四类片段 + 旁白/音乐/字幕轨 + 交付承诺），用 stage-plan 的 video_plan 脚本校验后交 B 门审批；AUTO 端到端产线的核心。
description_en: The "ingest + plan" knowledge for end-to-end video orchestration — ingest the user's material from evidence, then decompose intent into ONE cross-modal EDL (plan.json: edit / generate / compose / provided segments + narration/music/caption tracks + a delivery promise), validate it with the stage-plan video_plan script, and take it to gate B. Core of the AUTO end-to-end line.
category: creation
---

# stage-plan

How to turn "here is my material + here's the video I want" into a single, inspectable plan that spans more than one production line. The output is `project/plan.json` — a cross-modal Edit Decision List (EDL) — which the assembler then walks deterministically. Host-neutral: ingest evidence comes from `stage-edit` skill scripts (probe / silence / ocr / scenes / quality / extract_frame via `bin/run-skill.cjs`) plus the built-in `video_studio` transcription op, this skill provides the plan validator script, and the producers handle compose / generate / edit.

## How to call ingest scripts

Use `stage-edit` scripts for factual ingest before writing the plan, except transcription, which runs through the required built-in `video_studio` tool.

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-edit edit_video -- --op probe --input raw/clip.mp4
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-edit analyze_media -- --op ocr --input raw/screen-recording.mp4
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-edit edit_video -- --op extract_frame --input raw/clip.mp4 --start 3 --output project/frames/clip-3s.png
```

Call transcription directly as:

```json
{"op":"speech.transcribe","input_path":"raw/clip.mp4","transcript_path":"project/transcripts/clip.json","timestamps":"word"}
```

These script/tool calls return JSON. Their output is the evidence for `project/ingest.json`.

## How to call the plan validator

Use the skill script, not a deprecated direct `video_plan` tool:

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-plan video_plan -- --op validate --plan project/plan.json
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-plan video_plan -- --op promise_check --plan project/plan.json
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-plan video_plan -- --op summarize --plan project/plan.json
```

For repeated takes:

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-plan video_plan -- --op rank_takes --takes project/takes.json
```

The script returns JSON with a `text` field for the user-facing summary. `validate` exits non-zero when the plan is invalid; `promise_check` exits non-zero when the delivery promise fails.

Use this line when the deliverable is NOT cleanly one axis — e.g. "trim my clip, add a title card and captions, and a voiceover", or "my footage for the middle, generate an opener, compose the stats". For a pure single-axis job, route to that single line instead (see `video-router`).

## Step 1 — Ingest from evidence, never from assumption

You cannot plan against material you have not looked at. For EVERY supplied clip, before writing any segment:

1. **Probe** it (`stage-edit edit_video --op probe`) for real duration / resolution / fps / audio presence. A plan that cuts past the real duration breaks.
2. **Read its content** the cheapest way that fits:
   - spoken audio → call `video_studio` `op: "speech.transcribe"` with `timestamps: "word"` → you now have timecoded words to cut on.
   - silent / screen-recording / slideshow → `stage-edit analyze_media --op ocr` → per-timecode on-screen text. The audio being empty does NOT mean the screen is.
   - need to judge what a moment LOOKS like (is the hero shot usable? is the product right-side up?) → read frames: `stage-edit edit_video --op extract_frame` then look at them. If you are multimodal you read them directly; if you cannot see images, say so and plan on probe/transcript/OCR evidence alone — mark those judgments unverified, do not invent them.
3. Record what each input is good for in `project/ingest.json`: `{input_id, duration, has_audio, content_summary, quality_risks:[...], usable_for:[...], planning_implications:[...]}`. This is the factual basis the plan cites — segments reference `input_id`s from here. Rules:
   - **`content_summary` is specific and from observation:** "45 s of interview, no b-roll, mono audio" — never "user provided footage". An entry is only "reviewed" if a real probe/transcript/OCR actually ran; never claim you looked at a clip you did not.
   - **Usability heuristics:** video > 10 s → hero footage; > 3 s → b-roll; has speech → dialogue source; audio-only → narration/music source, production must supply the visuals; image-only → motion must come from animation or generation.
   - **Quality risks to flag:** width < 720 / height < 480 (will look soft), clip < 3 s (limited use), mono audio, a still where the brief wants motion. A flagged risk the plan ignores is a planning bug — resolve it at gate A.

## Step 2 — Choose the delivery promise

Pick ONE `delivery_promise.type` and make the whole plan keep it:

- **source_led** — the user's footage is the hero (repurpose / highlight / localize). `source_required: true`.
- **motion_led** — real motion (footage or generated video) dominates; composed cards are accents.
- **compose_led** — designed HTML is the spine (explainer / data); footage/generation are accents.
- **hybrid** — a deliberate mix (e.g. source hero + composed framing + generated opener).

Set `motion_min_ratio` to the minimum share of runtime that must be real motion rather than static cards — this is the anti-slideshow guard. If you cannot hit it from the available material, say so at gate A instead of quietly shipping a slideshow. If `source_required` is true, at least one PRIMARY segment must be real footage (`source: edit | provided`) — the supplied footage must play in the rendered timeline, not merely appear as a still reference frame.

## Step 3 — Decompose into a cross-modal EDL

Write `project/plan.json`. Every segment declares HOW it is produced (`source`) and WHERE it sits (`layer`):

- `source`: **edit** (trim a real clip — needs `input_id` + `in_sec`/`out_sec`), **generate** (AI footage — needs a `prompt`; billable; for a recurring subject also set `characters` (ids), `refs` (the locked portrait / the prior shot's last frame), and `variation_type` small|medium|large — small = reuse a prior frame, cheapest + most consistent; large = a fresh shot), **compose** (designed HTML — needs a `kind`), **provided** (use a supplied asset as-is — needs `asset_id`; set `kind: image` for a still so the motion gate does not count it as real motion).
- `layer`: **primary** (the main timeline), **overlay** (sits over a primary via `over: <segment id>` — captions, lower-thirds, title cards), **bg** (behind).
- `role`: MUST be exactly one of hook / body / proof / cta / transition — the schema rejects any other value (E_SEG_ROLE) and the plan fails validation. Narrative BEAT names from the arc ("payoff", "establishing", "climax", …) are NOT roles: map a payoff / closing / CTA beat to `cta`, an establishing / evidence beat to `proof`. Front-load the hook.

Tracks are separate from the visual timeline: `tracks.narration` (a `voice` from the voice table + timed lines `{text, start_sec, target_sec}`; each line gets a `produced_path` once synthesized, so one line can be re-voiced alone), `tracks.music` (path + duck under narration), `tracks.captions` (`{ from?, style?, lines:[{text, start_sec, target_sec}] }` — captions live as DATA here, NOT burned into the picture, so a typo is a one-line edit re-burned at assemble). Put the billable-generation count in `cost_estimate` — gate C reads it.

Fit narration in the plan before any TTS call: use natural cadence (about 2.2-2.7 English words/sec or 4-5 Chinese chars/sec), shorten over-budget lines here, and do not rely on repeated synthesis to discover timing.

**Author plan.json in EXACTLY this shape (copy the field names — the `stage-plan video_plan --op validate` script rejects any other shape):**

```json
{
  "aspect": "9:16",
  "total_target_sec": 30,
  "language": "zh",
  "delivery_promise": { "type": "hybrid", "source_required": true, "motion_min_ratio": 0.6 },
  "segments": [
    { "id": "s1_hook", "order": 1, "role": "hook", "layer": "primary", "source": "edit",
      "target_sec": 6, "spec": { "input_id": "clipA", "in_sec": 12, "out_sec": 18 } },
    { "id": "s2_body", "order": 2, "role": "body", "layer": "primary", "source": "compose",
      "target_sec": 8, "spec": { "kind": "stat-card" } },
    { "id": "s2_cap", "order": 3, "role": "body", "layer": "overlay", "over": "s2_body",
      "source": "compose", "target_sec": 3, "spec": { "kind": "lower-third" } }
  ],
  "tracks": {
    "narration": { "voice": "zh_female_vv_uranus_bigtts",
      "segments": [ { "text": "一句旁白", "start_sec": 0, "target_sec": 6 } ] },
    "music": { "path": "assets/bed.mp3", "duck": true },
    "captions": { "style": "bold-bottom", "lines": [ { "text": "一句字幕", "start_sec": 0, "target_sec": 3 } ] }
  },
  "cost_estimate": { "billable_generations": 0 }
}
```

Field gotchas the validator enforces (these are the common breakers):
- `source` is the **production-method enum** `edit | generate | compose | provided` — NOT a file path. The actual clip/asset goes in `spec.input_id` (edit) or `spec.asset_id` (provided).
- Every segment needs `order` + `layer` + `spec`; use `target_sec` (not `target_duration_sec`/`duration`). At least one segment must be `layer:"primary"`.
- `tracks` is an **object** `{narration, music, captions}` — NOT an array of track objects.
- `delivery_promise` must MATCH this deliverable (Step 2) — do NOT copy the example's `hybrid`/`source_required:true`/`0.6`. A designed-HTML explainer is `type:"compose_led"`, `source_required:false`, `motion_min_ratio` ≤ 0.2; set `source_required:true` ONLY when the user's real footage must star; `motion_min_ratio` is the real-motion floor you are actually committing to.

Plan to the craft bar (`video-craft`): a hook in the first seconds, one idea per beat, readable type in safe zones, ducked audio, the right aspect.

## Step 4 — Validate, then gate B

1. Run `stage-plan video_plan --op validate` on `project/plan.json`. Fix EVERY error before going further — errors mean the plan cannot be executed or it breaks its own promise (e.g. `source_required` but no source segment). Reconsider warnings.
2. Run `stage-plan video_plan --op promise_check` on the PLAN, before producing anything. It computes the planned motion ratio vs. the promise — a fail means the plan is already a slideshow / breaks its promise. Fixing the plan now is free; re-assembling later is not. Rebalance durations or convert a static beat to footage until it passes (gate D re-checks against the real cut).
3. Run `stage-plan video_plan --op summarize` → present the returned `text` timeline to the user at **gate B** (re-state it in their language). Gate B is the highest-leverage checkpoint: it is far cheaper to fix the plan here than after assembly. Let the user edit segments / promise / voice before anything is produced.

## Director judgment (end-to-end planning)

The craft of weaving ONE good video across sources, on top of the shared craft (`video-craft`). This is where a multi-source plan becomes a video instead of a tour of clips:

- **Decide the spine before the sources.** Write the beat arc (hook → gap → core → proof → payoff/CTA, `video-craft` §2 — these are BEAT names, not segment `role` values; a payoff/CTA beat's `role` is `cta`) source-agnostic FIRST, then assign each beat its cheapest sufficient source. Letting the material on hand dictate the structure is how end-to-end videos turn into a disjointed reel.
- **Assign each beat to the source that earns it.** Real footage (edit / provided) carries proof / authenticity / the actual product or result — make it the hero of a `source_led` piece, not a cameo. `generate` is a last resort for a beat you can neither film nor compose (an impossible / expensive establishing shot, missing b-roll) — it is billable and reads synthetic if overused. `compose` is the connective tissue — titles, stats, definitions, transitions, the CTA card — cheapest and crispest for anything textual.
- **Treat the promise as an editorial commitment, not a ratio to satisfy.** `source_led` means the user's material genuinely stars (the hero beats + real screen time), not 6 s buried under composed cards. Set `motion_min_ratio` to the feel you are promising.
- **Pace the plan in `target_sec`** to `video-craft` §3: front-load the first payoff, one idea per beat, don't plan three equal-length beats in a row.
- **Cost-aware craft.** Reach ~90% of the result with zero billable generation — reuse the user's footage, compose instead of generate, pull b-roll from existing frames. Generation is the exception you justify, not the default.
- **Plan the moment, not the whole clip.** Set each edit segment's `in_sec`/`out_sec` to the one ~3 s window that earns its slot (the cut craft itself is in `stage-edit`). Every beat must earn a purpose (establish / proof / reaction); a beat you can't justify shouldn't be in the plan.
- **Write each visual beat as a concrete photograph, not an emotion** — subject, action, environment, lighting (the rule + examples are in `video-craft` §11). If you can't picture a specific frame from the spec, neither can the generator.

## Rules

- The plan is the single source of truth and the resumable state. Segments carry `status` + `produced_path` as they complete; do not re-produce a segment already marked done.
- Reference real `input_id`s from `ingest.json`; never cite a clip you have not probed.
- Keep the billable count honest in `cost_estimate` — gate C depends on it.

## Boundary / non-goals

This skill ingests and PLANS. It does not produce or assemble — that is `stage-assemble`, which walks the validated plan and delegates each segment to the compose / generate / edit lines.
