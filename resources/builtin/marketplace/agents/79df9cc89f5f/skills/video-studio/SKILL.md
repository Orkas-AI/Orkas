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

One finished-video request becomes one finished video. Work straight through and hand back a file the user can post. Do not present a plan, a preview or a draft for approval on the way: the user reacts to the finished video, and changing a short one is cheap. A finished video over about 2 minutes is the exception, whether you make it or edit the user's footage: first finish one representative part of 30 to 60 seconds with everything the whole will have (look, captions, music, inserted pictures, pace), ship it, say in one line how the rest follows, and make the whole once the user agrees. If it must follow a script you write word for word, show that script first instead. A script the user gave is theirs: make it as written, without showing it back.

## The two tools

Choose the path before setting up production.

- **Direct edit** (`edit_video`). Read [stage-edit](@skill/stage-edit). For subtitles on existing footage, follow its `burnsubs` procedure, including for timed product names or prices at fixed positions. Use its other ffmpeg operations to cut, join, reframe or mix existing footage. Check and deliver the exported file with `video.ship` as described in [Deliver](#5-deliver).
- **Page render** (`video.render`). For designed text, price cards, motion or split screen, build a timeline and HTML page. Follow Make, Check and Deliver. You can use a trimmed clip in a page or join a rendered title card to a direct edit.

For a fixed-picture dub or a repair of an existing dub, follow the [dubbing guidance](@skill/stage-edit/references/transcript-and-screen-grounded-editing.md) and use its captioned mix.

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
  videos/main/manifest.json    page route
  videos/main/index.html       page route
```

If the user attached files, run `video.import` first, before anything else: it copies them into `media/`, adds them to `assets.json` and returns their ids and sizes. Use those from then on; you never need an attachment's own path.

When the request works on the user's own footage, such as a video they say they uploaded to cut, adapt or subtitle, and no video came with it (a task brief whose `sources` list is empty brings none), ask for it before doing anything else: say in one sentence that the footage did not arrive and ask them to add it again. Do not write the script, record narration or test the edit on stand-in footage while you wait.

Write facts to `product.json` as you find them, with where they came from. Never put a claim on screen that came from nowhere. See [references/ads.md](references/ads.md).

Develop a script when the brief needs one, using the craft and timing guidance above.

For each product shot, decide whether the available footage shows the required scene or action. Reuse suitable real footage. When required product motion, use sequences or new scenes are missing, plan 1–2 generated shots and run `video.request_budget` before writing the timeline, unless the user ruled out spending. Page animation supplies text, graphics and supporting motion; a zoom or transition on a still image does not replace a required product action. Software can show its real screens instead. See [references/generation.md](references/generation.md). This checks configured service availability, not prices or balances. Confirm the planned external calls once before sending them; service accounts bill directly. For declined or unavailable generation, follow Material fallback below.

Product images must stay true to the product: [references/product-fidelity.md](references/product-fidelity.md).
For original image dimensions, crops, resizing or padding, use the private local
preparation path in [references/image-preparation.md](references/image-preparation.md).

## Material fallback

After declined, unavailable or exhausted generation, continue with existing material, including free stock, only when it satisfies the requested shots or the user has accepted a specific alternative. Otherwise state the missing scene/action, preserved work and available alternatives, and obtain the user's decision before producing a substituted version. Static-image zooms cannot silently replace required product motion or establish completion. Once an alternative is accepted, continue against that revised request without asking for the same decision again. Script/storyboard-only work still stops at its requested document without generating media.

## 3. Make

Read [references/timeline.md](references/timeline.md) before writing a manifest or a page. It has the exact format.

For look and type, read the one preset that fits from `frontend-design`. Do not write a design document; put the decisions straight into the page's CSS.

For sound, read [references/audio.md](references/audio.md). An ad goes out with sound unless the user asked for none: music, or, when no music can be had, a short voice-over made with `generate_speech`. `narration.text` alone only shows captions.

Write the page so one scene can change without touching the others. Use `data-slot` for every visible word that a user might change.

## 4. Check

Run these checks on a page timeline, including the page portion of a mixed edit.

1. Run `video.check` with `include_preview: true` when that option is available. Fix errors. `ok` means the operation succeeded; `visual_review` contains advisory findings from sampled page frames. A stale or unavailable review is not a clean result.
2. When `visual_evidence.attached` is true, the sheet already shows the first and last frame of each labeled scene (up to 16 scenes). Use it to review those frames, including when the user asks for scene starts and ends. Call `video.sheet` only if you need frames and have no preview, or use `times` or `range` for frames the current preview did not cover. Assess the frames against the user's brief and the applicable `video-craft` review, including the commercial content review for sales work. Fix warranted issues and disclose anything kept.
3. Batch this pass's confirmed fixes, then check and review the changed result before `video.render` writes the mp4. For an intermediate visual-only review, use `video.sheet`. Rendered scenes are cached, so a re-render only redoes what changed.

If a render reports `E_SEGMENT_ASSEMBLY_INCOMPLETE`, call it again unchanged; it finishes what is missing.

Do not repeat a check with current evidence on unchanged files, and do not re-read files you just wrote.

## 5. Deliver

Call `video.ship` with the production directory and the exact `path` returned by `video.render` or `edit_video`. When resuming with an existing file, use its verified actual path. Pass `video_id` when the video has a timeline. For a video made only with ffmpeg, pass `expect_aspect` and `expect_audio`. It publishes a version and returns frames from the final file. Compare those frames with the current request before replying. Name in the reply only changes the delivered frames show; a change you cannot see there did not reach the video.

When the tool describes `expect_duration_sec` as advisory, pass the user's requested length if known for either path. Use the brief and revisions to decide whether to keep or recut an off-target version. If you keep it, explain the length choice. With an older tool, pass the intended cut length for ffmpeg-only delivery.

For other unmet requirements that you can repair with available tools and authority, repair the video, verify the changed result and ship again. Do not leave those repairs as suggestions for another turn. If missing user input or permission, a runtime blocker or the existing rework limit prevents completion, report the work as incomplete: name the unmet requirement, concrete blocker, retained work and what is needed to continue. An error from your own call is not a blocker: a path that does not exist, JSON that does not parse, an unknown op or option, or a page-timeline op on a video made with ffmpeg. Read the message, correct the call and carry on. Neither is work still to do: when the next step is one you can take with your tools, such as cutting more footage, syncing the narration or writing the timeline, take it in this turn instead of replying with it.

Blocking findings: fix them and ship again. If you cannot, or the user wants the file as it is, say what is wrong and let them choose; pass their answer as `accept_findings` and `accept_reason` only after they have chosen.

Use check results to guide edits. Report routine results only when asked, distinguishing the page preview from the delivered file.

When the request is satisfied, reply in the user's language and lead with the video:

- the video link, as `reply_link` from delivery;
- the choices you made for them, in a line or two, and any assumptions;
- known limitations or deviations the user accepted;
- any remaining finding that affects use or needs a user decision, in plain words;
- external service calls made, without inventing their prices or balances;
- free footage, photos or audio used, by source, and the credit lines delivery gave you, if any;
- up to three optional enhancements, only after the current request is satisfied ("换个开头", "做 16:9 版", "换成另一款商品").

Never mention operations, finding codes or file formats unless they asked.

## When to stop and ask

Ask only for the following inputs or approvals; execution blockers and rework limits follow Deliver above.

- A paid image or video attempt lacks the user's authorization for its planned external calls. Do not ask again for an unchanged, undispatched request already authorized.
- You need something only the user has. The words spoken in a recording are not that: caption them from the transcript, which is not inventing them, and name in your reply any you were unsure of.
- A generated shot is still wrong after 2 retries.
- They asked to see a plan first.
- A finished video would run over about 2 minutes: ship its representative part first, or the script you wrote for it when it must follow that script word for word (Finished video above). Never stop to show the user a script they gave.

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

For a visual change confined to one scene, edit its own elements in `index.html` so the other scenes can reuse their renders. For example, set the price element's font size on that element. Change shared styles or scripts when the requested effect is shared.

A later turn may start without your memory of this one, including the folder name. `video.status` with no folder lists the productions here; with a folder it gives the videos, versions and local generation requests. `assets.json` lists the files.
