---
ownerAgent: 79df9cc89f5f
name: video-studio
description_zh: 一句话做完整条视频：备素材、出片、检查、交付。广告、电商视频和剧情短片的主流程，新需求先读它。
description_en: Make a whole video from one request: gather material, produce, check, deliver. The main path for ads, e-commerce video and short films; read it first for any new request.
---

# video-studio

Resolve the requested endpoint first: a script/storyboard document or a finished video.

## Script or storyboard only

Read the supplied material and use [video-craft](@skill/video-craft) for creative guidance. For an ad, promo, launch, brand or campaign video, or versions to test, read [marketing guidance](@skill/video-craft/references/marketing.md); for product listing or sales creative, also read [ecommerce guidance](@skill/video-craft/references/ecommerce.md) before writing. For a short film, a drama episode or a story with recurring characters, read [short-film guidance](@skill/video-craft/references/short-film.md) before writing. For a person talking to camera, such as a generated presenter selling a product, read [presenter guidance](@skill/video-craft/references/presenter.md). For a montage of clips or photos cut to a music track, read [music-cut guidance](@skill/video-craft/references/music-cut.md). For short clips cut from a long recording such as a podcast, interview or livestream, read [clip guidance](@skill/stage-decide/references/clips.md). For a video that teaches, explains a topic or data, or walks through software from a screen recording, read [explainer guidance](@skill/video-craft/references/explainer.md). For a narrated recap or commentary cut from supplied film or drama episodes, read [commentary guidance](@skill/video-craft/references/commentary.md).

For timed scripts, use [script timing](@skill/video-studio/references/script-timing.md) before drafting and when revising spoken lines. It owns the estimator command and final-text comparison. Review the final script against the brief and source facts, then deliver the requested document; do not generate media, render or call `video.ship`.

Use the same craft and timing guidance when scripting a finished video, then continue with production below.

## Finished video

One finished-video request becomes one finished video. Work straight through and hand back a file the user can post. Do not present a plan, a preview or a draft for approval on the way. The user reacts to the finished video, and changing it is cheap.

## The two tools

- **ffmpeg** (`edit_video`, see `stage-edit`): cut, join, reframe, remove silence, mix, burn subtitles, overlay a logo. Seconds of work.
- **Page render** (`video.render`): a timeline plus an HTML page, captured frame by frame. Text, price cards, motion, split screen, footage under graphics. About 1.5 seconds per second of video.

For designed text, price cards or motion, use the page. For plain subtitles on existing footage, use `burnsubs` in `stage-edit`; use its other ffmpeg operations for cutting, joining and mixing. They combine freely: put a trimmed clip in a page, or render a title card and `concat` it onto a long cut. All of it ends at `video.ship`, whichever tool made the file.

## 1. Brief

Find out what can be found before asking. Open the product page with `product.capture`, inspect images with `read_files` and reference videos with `reference.inspect`. When the video should recreate a reference or borrow its look, read [design-system-importer](@skill/design-system-importer) before writing the script; it decides what to keep.

Choose these yourself and state them in your final reply: length (15–30s for an ad unless told otherwise), shape (9:16 for TikTok, Reels, Shorts), look, language (the user's, unless they say otherwise), pacing.

Ask only for what the user alone can give, such as a price you cannot find or which of two products. At most 4 questions, in one message, each with your recommended answer so that "yes" is enough. If you can proceed on a reasonable assumption, proceed and name the assumption in the final reply.

## 2. Material

Pick a short folder name for the production, for example `lamp-ad`. Everything goes in it:

```text
lamp-ad/
  assets.json              every file you use
  product.json             name, facts, images
  media/                   the user's attachments
  videos/main/manifest.json
  videos/main/index.html
```

If the user attached files, run `video.import` first, before anything else: it copies them into `media/`, adds them to `assets.json` and returns their ids and sizes. Use those from then on; you never need an attachment's own path.

Write facts to `product.json` as you find them, with where they came from. Never put a claim on screen that came from nowhere. See [references/ads.md](references/ads.md).

Develop the script with the craft and timing guidance above. A one-step edit still goes directly to [stage-edit](@skill/stage-edit).

For each product shot, decide whether the available footage shows the required scene or action. Reuse suitable real footage. When required product motion, use sequences or new scenes are missing, plan 1–2 generated shots and run `video.request_budget` before writing the timeline, unless the user ruled out spending. Page animation supplies text, graphics and supporting motion; a zoom or transition on a still image does not replace a required product action. Software can show its real screens instead. See [references/generation.md](references/generation.md). This checks configured service availability, not prices or balances. Confirm the planned external calls once before sending them; service accounts bill directly. For declined or unavailable generation, follow Material fallback below.

Product images must stay true to the product: [references/product-fidelity.md](references/product-fidelity.md).
For original image dimensions, crops, resizing or padding, use the private local
preparation path in [references/image-preparation.md](references/image-preparation.md).

## Material fallback

After declined, unavailable or exhausted generation, continue with existing material only when it satisfies the requested shots or the user has accepted a specific alternative. Otherwise state the missing scene/action, preserved work and available alternatives, and obtain the user's decision before producing a substituted version. Static-image zooms cannot silently replace required product motion or establish completion. Once an alternative is accepted, continue against that revised request without asking for the same decision again. Script/storyboard-only work still stops at its requested document without generating media.

## 3. Make

Read [references/timeline.md](references/timeline.md) before writing a manifest or a page. It has the exact format.

For look and type, read the one preset that fits from `frontend-design`. Do not write a design document; put the decisions straight into the page's CSS.

For sound, read [references/audio.md](references/audio.md). An ad goes out with sound unless the user asked for none: music, or, when no music can be had, a short voice-over made with `generate_speech`. `narration.text` alone only shows captions.

Write the page so one scene can change without touching the others. Use `data-slot` for every visible word that a user might change.

## 4. Check

1. `video.check` reports structure, missing files and layout problems from the real page. Fix errors. `ok` means the operation succeeded; `visual_review` contains advisory findings from sampled page frames. Judge them against the frames, fix warranted issues and disclose anything kept. A stale or unavailable review is not a clean result; after a change, check the affected video again.
2. `video.sheet` shows frames without rendering. Review them against the user's brief and the applicable `video-craft` review, including the commercial content review for sales work. Fix what you see, and check again only what you changed.
3. Batch this pass's confirmed fixes and verify the changed result with checks and sampled frames before `video.render` writes the mp4. Use `video.sheet` for intermediate visual review rather than rendering after each small edit. Rendered scenes are cached, so a re-render only redoes what changed.

If a render reports `E_SEGMENT_ASSEMBLY_INCOMPLETE`, call it again unchanged; it finishes what is missing.

Do not repeat a check with current evidence on unchanged files, and do not re-read files you just wrote.

## 5. Deliver

`{ "op": "video.ship", "production_dir": "lamp-ad", "video_id": "main", "path": "render/main.mp4" }`. Pass `video_id` when the video has a timeline. For a video made only with ffmpeg, pass `expect_duration_sec`, `expect_aspect` and `expect_audio` so it has something to compare against. It publishes a version and returns frames from the final file. Compare those frames with the current request before replying.

For unmet requirements that you can repair with available tools and authority, repair the video, verify the changed result and ship again. Do not leave those repairs as suggestions for another turn. If missing user input or permission, a runtime blocker or the existing rework limit prevents completion, report the work as incomplete: name the unmet requirement, concrete blocker, retained work and what is needed to continue.

Blocking findings: fix them and ship again. If you cannot, or the user wants the file as it is, say what is wrong and let them choose; pass their answer as `accept_findings` and `accept_reason` only after they have chosen.

When the request is satisfied, reply in the user's language and lead with the video:

- the video link;
- the choices you made for them, in a line or two, and any assumptions;
- known limitations or deviations the user accepted;
- what a check flagged that you kept rather than fixed, such as long still or empty stretches, and why, in plain words;
- external service calls made, without inventing their prices or balances;
- up to three optional enhancements, only after the current request is satisfied ("换个开头", "做 16:9 版", "换成另一款商品").

Never mention operations, finding codes or file formats unless they asked.

## When to stop and ask

Ask only for the following inputs or approvals; execution blockers and rework limits follow Deliver above.

- A paid image or video attempt lacks the user's authorization for its planned external calls. Do not ask again for an unchanged, undispatched request already authorized.
- You need something only the user has.
- A generated shot is still wrong after 2 retries.
- They asked to see a plan first.
- Rework would be expensive: a finished video over about 2 minutes, or one that must follow a script exactly. Then show the script first.

When you stop, say what you need, what you have kept, and what happens next. Before ending a turn on a question, include `<plan-interaction status="open" />` in the reply.

## Changing a video

Change only what was asked. Do not re-read this skill. Pick the cheapest level:

| Level | For | Cost |
| --- | --- | --- |
| Reassemble | Words, cuts, order, music, captions | Edit `manifest.json`, render. Seconds, no service call |
| Re-voice a line | Words spoken in the narration, such as a price | Generate that line again with its voice (references/audio.md), then reassemble |
| Redo one shot | The picture itself is wrong | A new external service request for that shot. Only this video changes; other versions keep theirs |
| Rethink | New concept or structure | Tell the user first, then do it |

A change stays in the same video, and each delivery keeps the last one as an earlier version. Only a version to keep alongside, such as another ratio, language or test variant, gets a copy: `videos/main` to `videos/<new id>`, changing what differs. Assets are shared.

A later turn may start without your memory of this one, including the folder name. `video.status` with no folder lists the productions here; with a folder it gives the videos, versions and local generation requests. `assets.json` lists the files.
