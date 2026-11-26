# VideoStudio regression

Use isolated projects and prepared target-native FFmpeg/FFprobe runtimes. The
old plan-and-gate production flow is retired. One request gathers material,
writes/checks/renders a timeline and ships a playable video. Ordinary local
editing, preview, reorder and rendering do not ask for plan approval. User-owned
paid generation still needs its applicable spending authority; the open edition
has no official credit card, account gate or managed fallback.

Use the bounded `video.check` preview for sampled scene starts and ends before rendering. Request `video.sheet` for missing times or when no preview attached. For static-promotion blocks, verify which still-only scenes were identified, preserve a user's accepted override, and keep the original checks for non-promotional footage. The local trim, seek, render, delivery and reply-link cases exercise the real backend without external generation.

## Deterministic and manual scenario portfolio

The rows identify outcomes and existing public owners, not current pass results.
An owner list does not prove the entire row: actual selections, native execution,
source versions and residual findings remain separate. Where private evaluators
are absent, preserve the manual outcome instead of claiming an equivalent score.

| Risk | Independent oracle | Owner |
| --- | --- | --- |
| A render or a normalized file stays short of the delivery loudness, so delivery asks for a normalization the Agent applies outside the timeline and the next render after a change loses it | A quiet music bed under a short voice, normalized from the render's own measurement, delivers with no off-target warning and within 2 LU of -14 LUFS, where one unmeasured pass stays off target (as the 2026-11-17 ad did, -18.4 then -16.6); normalize_loudness measures first and lands within 2 LU by an independent ebur128 reading; second-pass options come only from a complete, finite measurement | `video_audio_e2e_delivery.test.ts`, `video_edit_loudness.test.ts` |
| Narration says what the picture does not show: a saved file over the export spinner, a click cut away, a next-episode preview told as story | A narrated delivery's frames are taken where each heard clause ends (its words' own times split at clause punctuation or a pause, up to sixteen, so a narration voiced in one take still gets a frame per step; times taken loosely, ended at the file's end and skipping words the recognizer gave no room, where `speech.transcribe` itself still refuses them), then its last frame, with the words listed and each line asked to be checked against its frame; a music cut is not listened to (a recognizer reads words into music) and keeps twelve evenly spaced frames; a delivery is marked voiced from its narration, its mix or voices made for it, and the next version keeps the mark. A transcribed video attaches the picture in the middle of each phrase, up to 16 and labelled with the start the phrase view prints, red and blue cells under the phrases spoken over them; audio alone, or frames that cannot be made, attach nothing and leave the transcript as it was. Failed before the change; the blank-frame case also failed with the image check removed | `video_timeline_ship.test.ts`, `video-timeline-tool.test.ts`, `video-studio-transcribe_tool.test.ts`, `video_phrases.test.ts`, `video_studio_transcript_timing.test.ts` |
| Narration lines are written faster than the voices read, so `generate_speech` refuses them as too long one after another | `speech.capabilities` for a named language gives the pace from the rates the length check uses: 4.5 Chinese characters or 2.5 English words a second plus pauses, so a 5 s scene holds about 20 characters or 11 words; the 20 characters it names fit 5 s by the same estimate and 22 do not; no language names no pace. Failed without the field | `video-studio-speech-pace.test.ts` |
| A video cut with ffmpeg is sent to `video.check`, or a plan that costs nothing to `video.request_budget`, and the answer reads as a failure | The VideoStudio workflow and the Check section say the page checks are for a page timeline and an ffmpeg video goes to `video.ship`; an empty plan, or one of zero counts, is answered `ok` with no price, no card and no confirmation recorded, while a plan that is not a list or names an unknown kind is still refused. Failed with the old refusal | `video-timeline-tool.test.ts` |
| An op that is another tool's name, this tool's name or an op without its prefix gets only the list of ops, and the Agent cannot see which mistake it made | The refusal names the other tool to call, says op is the operation and not the tool, or names the full op (`request_budget` is `video.request_budget`, `transcribe` is `speech.transcribe`); an op that is none of these keeps the list; nothing runs. Failed with the old message | `video-timeline-tool.test.ts` |
| A call reads as a broken tool because the answer does not say what went wrong: a path with spaces split by the shell, a selection id copied short, a sound that ends before the picture, a changed line sent to a path already voiced | `edit_video` names the option whose path was split and shows it quoted, when the words make an existing file, and lists the options otherwise; `cut_selection` gives the listing's id and cuts nothing; `video.ship` says which end lacks sound or picture and what to cut or add, both ways round; the repeated-speech refusal says to give a changed line a new output_path. Failed with each old message | `video_media_skill_scripts.test.ts`, `video_picture_selection.test.ts`, `video_timeline_ship.test.ts`, `generate-speech-tool.test.ts` |
| The reference examples disagree about asset/clip ids, preparation depends on cwd, or prior measurements are treated as current verification | The timeline/ledger/page snippets pass actual validators together, with missing-asset and wrong-clip negative controls. Installed-runner cases execute documented image requests from three cwd locations and after relocation, retaining source and output bytes. Audio guidance owns current-file reuse and unknown/fresh-result boundaries; real audio delivery cases retain explicit warnings for failed or incomplete measurements. These checks do not establish fewer Agent calls or subjective fade quality | `test/main/features/video_agent_package.test.ts`, `test/main/features/video_private_preflight.test.ts`, `test/main/features/video_audio_e2e_delivery.test.ts` |
| Image preparation reports an unrelated repair, hides the failed input, leaks private diagnostics, or overwrites a concurrent output | Installed Skill Runner cases distinguish project, request JSON, input decode, output directory and publication failures using cause-only messages. Source bytes and existing output survive; injected permission and publication-race failures leave no temporary images. Original crop/orientation and scope protections stay covered | `test/main/features/video_private_preflight.test.ts` |
| Activity analysis rejects a previously valid small window, silently widens it, or spends unbounded work summarizing it | Explicit 50ms/1ms boundaries and empty windows between real 10Hz samples; actual skill CLI on two speakers preserves its reframe plan; invalid/excessive counts return recovery without changing input. A 100,000-window allocation/work budget replaces the erroneous 0.1s minimum; ordinary defaults and rounded half-open boundaries stay compatible | `test/main/features/video_decide.test.ts`, `test/main/features/video_analyze.test.ts`, `test/main/features/video_media_skill_scripts.test.ts` |
| A short or silent soundtrack is reported absent, or rhythm decode failure is mistaken for no track | Real 2/3.9/4-second media, track metadata, source-byte equality and an isolated PCM failure; explicit still sampling starts no rhythm decode | `test/main/model/core-agent/video-reference_e2e_tool.test.ts` |
| Invalid transcription timing overwrites a usable result or drops recognized wording | Actual decoded WAV duration, ordered positive segment/merged-word intervals, long-video/short-audio and malformed tokens; times extending beyond the decoded recording end are bounded by that end; previous JSON and source unchanged, unique TXT with audio-text declaration, failed-write cleanup and explicit recovery without automatic recognition replay | `test/main/features/video_studio_transcript_timing.test.ts`, `test/main/features/video_studio_native_qa.test.ts`, `test/main/model/core-agent/video-studio-transcribe_tool.test.ts` |
| A word the recognizer gave a point instead of a span (common in Chinese) makes the whole transcript lose its timing, or is stretched over its neighbours | Hand-computed spans for the shapes the bundled whisper produces (a point at the next word's start, inside the gap, two in a row, first in a segment); a point with no room or outside its neighbours still fails; real JFK and Chinese recordings | `test/main/features/video_studio_transcript_timing.test.ts` |
| An unavailable speech-overlap check is reported as no conflict or becomes a new delivery block | Invalid timing returns the existing unverifiable-narration warning through a successful delivery; no overlap verdict is invented | `test/main/features/video_delivery_repairs.test.ts`, `test/main/features/video_timeline_ship.test.ts` |
| The right picture on the right frame, in any scene order | Frame numbers decoded from the delivered mp4, with a one-frame-off negative control | `test/gui/video-timeline-canary.ts`, `npm run test:video-timeline-canary` |
| A reorder or a word change re-renders more than it must | Rendered and reused scene counts in a real window | `npm run test:video-timeline-canary` |
| An interrupted render starts over | Captures counted across two calls | `test/main/features/video_timeline_render.test.ts`, `npm run test:video-timeline-canary` |
| Page, footage and ffmpeg output disagree in length or rate | Joined file's measured length and canvas | `test/main/features/video_timeline_ship.test.ts`, `npm run test:video-timeline-canary` |
| A scene's first frame shows the page as it was, or half set up | The shade of each scene's picture read from every delivered frame, with white behind it; fails on the code before the fix | `test/main/features/video_timeline_render.test.ts`, `npm run test:video-timeline-canary` |
| An upgraded page plays at the wrong moment, or goes blank where its timeline and scene list disagree | The position of a moving bar and the shade of each frame, read from delivered frames, before and after a reorder | `npm run test:video-timeline-canary` |
| A page rewritten without its scene list comes out in the wrong order | `video.check` refuses it in a real window, and accepts the same page once they agree | `npm run test:video-timeline-canary` |
| A timeline the host cannot render reaches render | Schema, timing, slot and asset rules | `test/main/features/video_timeline.test.ts` |
| The same footage plays twice in a row unnoticed | Overlapping cuts of one clip in adjacent scenes warned with what to change, against cuts that only meet, the half-second boundary, scenes apart, other clips, stills and overlays | `test/main/features/video_timeline.test.ts` |
| Words overflow, cover something or sit on a blank frame | Findings measured on the real page | `test/main/features/video_timeline_render.test.ts` |
| Styling a padded image enlarges only its box, copy hides a source label, or a crop defeats the requested framing | Four real-production framing journeys: padded full-product showcase, preserved off-centre composition, requested label close-up, and captions over moving footage. Source identity, decoded output and scoped pixel preservation are independent of Agent claims; calibrated visual judging allows negative space and close-ups while rejecting label obstruction | Manual outcome procedure below; no automatic execution claimed |
| Operation success is reported as visual approval, or findings disappear between check and delivery | Advisory `visual_review` stays separate from `ok`; real-window small/static/empty findings survive render and delivery without blocking. Unchecked, changed, failed and malformed evidence stays unknown/stale; fresh checks and different output bytes cannot rewrite an earlier version's review | `test/main/features/video_timeline_render.test.ts`, `test/main/model/core-agent/video-timeline-tool.test.ts`, `test/main/features/video_agent_package.test.ts`, `test/gui/video-timeline-canary.ts` |
| Source inspection uses the wrong media tool, subtitle routes disagree, or an unmet requirement becomes an optional next step | Owning Skill and assembled Agent standards distinguish image/video inputs, plain subtitles/designed text, repair/incomplete/completed work. Delivery feedback reports available rework or the existing third-delivery limit; a fourth call still publishes and unchanged bytes keep one version. Actual copy and decoded final pixels require independent visual review; source-contract checks alone do not prove model recovery | `test/main/features/video_agent_package.test.ts`, `test/main/model/core-agent/video-timeline-tool.test.ts` |
| A repaired export loses its output frames after the edit script preserves an earlier file, or an unnecessary budget rejection defeats completed local work | Execute the real edit entry to obtain its collision-renamed export, then bind a unique published alias to observed export bytes. Missing publication, unrelated names, invalid suffixes, source copies and ambiguous versions remain failures. A rejected production plan cannot become success without a later actual delivery using independently accepted material; service/permission failures stay open | Manual outcome procedure below; no automatic execution claimed |
| A closing message is missing from inspection because regular sampling catches only its transparent entrance | Inspect the regular frames and the actual late ending. A real closing marker must be visible; a blank-ending control remains blank. Decoding never substitutes for visual acceptance or proves readable display time | Manual outcome procedure below; no automatic execution claimed |
| A later render changes a video already delivered, or a delivery loses the list of versions | Bytes and hash of each kept file after a new render, and a damaged list left as it was | `test/main/features/video_timeline_ship.test.ts` |
| A file rendered before the last change is delivered as if it were current | The finding at delivery after a change to the scenes, the page or a product fact the scenes quote; none for a fact no scene quotes or a file made elsewhere | `test/main/features/video_timeline_render.test.ts` |
| A short music bed ends in silence, fades at its first ending, or makes the mix hang | Timeline music repeats locally to the video length before mixing; AAC timestamp gaps are removed by counting decoded samples. Real AAC/WAV renders retain sound across repetitions and fade at the final ending; a mono bed under stereo narration also works with cached pictures and leaves source bytes unchanged. Narration and SFX still play once. No generation/service request is added. Existing remux timestamp padding remains within the duration tolerance; musical seam quality is not established by tone fixtures | `test/main/features/video_timeline.test.ts`, `test/main/features/video_timeline_render.test.ts` |
| A file is delivered that is not what was asked for | Probed length, canvas, audio, loudness and narration placement | `test/main/features/video_timeline_ship.test.ts`, `test/main/features/video_studio_delivery.test.ts` |
| A video that should have sound goes silent for a stretch, or narration plays while someone in the clip is talking, and the Agent is not asked to fix it (or is asked forever) | A real 10 s file silent after 4 s reported at 4–10 s; a mix records each line's spoken span and the clip under it, the record survives a loudness pass, delivery hears the clip's speech with a stand-in recognizer and names the line, a changed clip or a replaced soundtrack reports nothing; the delivery reply asks for a repair on the first two deliveries and to name the problems on the third, with a renamed repair counted as the same video. Failed without the silence measurement and without the rename rule | `test/main/features/video_delivery_repairs.test.ts`, `test/main/model/core-agent/video-timeline-tool.test.ts` |
| A montage cut to music lands off the beat, or its cuts drift later as they add up | The ported HyperFrames tracker on synthetic tracks of known tempo (beats within 20 ms, bars on the chord changes, a slow 64 BPM, noise and a too-short clip refused); a real trim of one 128 BPM beat at 30 fps is 14 frames and sixteen such cuts join to exactly 225 frames, failing without the frame rounding or with a constant-rate join; the beats op through the skill runner finds 128 BPM and flags every cut of a montage shifted three frames late; the page timeline cuts ten 1.875 s scenes at 30 fps on the frames nearest each bar, with every scene and clip edge within half a frame of its seconds (failed when each scene was rounded on its own); a real trim started too late in a 4 s clip for its length still cuts to the end but reports the length it cut and where to start for the full length | `test/main/features/audio_rhythm.test.ts`, `test/main/features/video_edit_assembly_fixes.test.ts`, `test/main/features/video_media_skill_scripts.test.ts`, `test/main/features/video_agent_package.test.ts`, `test/main/features/video_timeline.test.ts` |
| Invalid transcription timing overwrites a usable result or drops recognized wording, or a usable transcript is refused for times the recognizer runs past the end | Actual decoded WAV duration, ordered positive segment/merged-word intervals and malformed tokens; times past the end of the decoded audio end with it (a long video over short audio is bounded by the audio) and a word starting after it is left out of the words with its text kept, while timing is still refused when more than a tenth of the words start after the end (2026-11-19: this had refused 128 of 263 real transcripts, never with more than 5 of 89 words after the end); words timed to end before they start (whisper.cpp after a long pause: the segment's start, an end drifted into the pause) take the time between their neighbours, split at their own ends when those are in order, and are then placed in the measured speech, while a run with no time between its neighbours is still refused (2026-11-23: one 2.6 s pause refused a whole talk); a segment wholly inside a measured silence is dropped, at most one or a quarter of the segments and never all (2026-11-23: "(字幕:J Chong)" heard in the last 2.5 s); previous JSON and source unchanged, unique TXT with audio-text declaration, failed-write cleanup and caller-directed recovery outside the Chinese retry described below | `video_studio_transcript_timing.test.ts`, `video_studio_native_qa.test.ts`, `video-studio-transcribe_tool.test.ts` |
| Chinese speech is transcribed in Traditional characters and captioned that way for a Simplified reader, with more misheard words (2026-11-24: 會員/採過康 for 会员/踩过坑, 未國 for 魏国) | An explicit Chinese request starts with the account's opening sentence (Simplified or Traditional) and uses one full recording pass when its timing is valid. Automatically detected Chinese tries the sentence on a second pass and accepts it only with nonempty text and valid timing. Word placement uses the prompt of the selected reading. Other languages are read once. Real talk and lecture returned Simplified text in both modes (about 1.5 s more when the language was not given) | `video_studio_transcript_timing.test.ts` |
| The Chinese opening sentence can leave words with invalid times at the end of a recording | If explicit Chinese yields text with invalid timing, recognize the same decoded audio once more in Chinese without the opening sentence. Accept nonempty text with valid timing. If the retry produces no usable time intervals, preserve the first reading as plain text and keep any previously saved transcript JSON. A malformed first result returns its original error after one pass | `video_studio_transcript_timing.test.ts` |
| A mixed-sound join keeps an audio stream but drops or misplaces the original sound | Decoded audio checks confirm which intervals keep their original sound and which are padded with silence, in either input order, within the expected picture length. This covers `stage-edit`'s concat operation | `video_edit_assembly_fixes.test.ts` |
| A creative cut off the requested length is blocked, or a render off its own timeline length passes | A real 15-second MP4 with a 30-second requested length ships and returns both lengths in a warning, with or without a matching timeline. The tool leaves the editing decision to the Agent. The existing half-second tolerance applies. A mismatch with the current timeline still blocks and names the narration-and-captions timing; a wrong canvas or missing required audio also blocks in the presence of the warning. A file cut with edit_video or ffmpeg still goes straight to `video.ship` | `video_timeline_render.test.ts`, `video_timeline_ship.test.ts`, `video_studio_delivery.test.ts`, `video-timeline-tool.test.ts` |
| A delivered recap has sound but loses a clip's explicitly kept original audio | With a timeline, an altered and re-encoded original over a quiet bed still matches. Both a replacement soundtrack and a mix that masks the original ship with an advisory that names the span. The advisory uses the published file even if output finalization altered its sound, and a repeat checks the same published version. The tool leaves the editing decision to the Agent. Files delivered without a timeline have no original-audio selection to check | `video_timeline_ship.test.ts`, `video-timeline-tool.test.ts` |
| A joined video's picture starts a frame after its sound, so every cut of a montage lands a frame late | `concat` restarts the picture's timestamps at zero: sixteen beat cuts join with video and audio both starting at 0 and the first frame of the second cut at its frame time. Failed without the restart (video started at 0.033 s) | `test/main/features/video_edit_assembly_fixes.test.ts` |
| Another language's version keeps the original burned-in captions showing beside the new ones | `burnsubs --cover <top>,<bottom>` lays an opaque bar across the old captions' band and sets plain captions inside it: no pixel of the old red caption bar is left in the band, the new caption's white pixels are in it, the picture above is untouched, a band over half the height is refused; the same through the skill runner. Failed without the option | `test/main/features/video_edit_assembly_fixes.test.ts`, `test/main/features/video_media_skill_scripts.test.ts` |
| A montage said to be cut to its music is delivered with cuts off the beat, whether the Agent skipped its own check or ran it and shipped anyway | `video.ship` with `cut_to_beat` reads the delivered file's own sound and cuts with the beat check's numbers: a 16-cut montage on a 128 BPM click track passes when cut from the beat list and is named when built from a rounded two-beat length; a soundtrack with no steady beat and a ship without the flag report nothing; the tool asks for the repair within the rework limit. Failed with the finding left out of the repair set | `test/main/features/video_studio_delivery.test.ts`, `test/main/features/video_timeline_ship.test.ts`, `test/main/model/core-agent/video-timeline-tool.test.ts` |
| A reference's soundtrack tempo is missing or wrong, or reading it stalls the app | `reference.inspect` reads the tempo with the host's copy of the ported tracker, kept identical to the skill bundle's below its header: 120 BPM read as a clear beat, a slow 64 BPM the replaced estimator missed, noise withheld, a cancelled inspection stopping between slices. Failed with one constant changed in the host copy | `test/main/model/core-agent/video-reference_e2e_tool.test.ts`, `test/main/features/audio_rhythm.test.ts` |
| A transcript saved under a name relative to the production lands somewhere else | `speech.transcribe` resolves `transcript_path` inside the production, as it does `input_path`. Failed without the resolution | `test/main/model/core-agent/video-timeline-tool.test.ts` |
| A required soundtrack exists as a stream but every sample is zero | Real AAC files: nonzero timeline tracks and kept clip audio block before recording; a repaired mix delivers without changing old versions. Explicit mute, low signals below the LUFS gate, pauses, stereo channels and multiple streams contrast full digital silence. Changed output-policy copies are checked before recording; failed, timed-out or incomplete measurements warn without a silence verdict | `test/main/features/video_audio_e2e_delivery.test.ts`, `test/main/features/video_studio_delivery.test.ts`, `test/main/model/core-agent/video-timeline-tool.test.ts` |
| Silent or unmeasurable loudness is reported as normal, or normalized without usable measurements | Real silent loudnorm JSON and rendered mixes report unavailable measurement; finite normal/off-target controls retain their decisions | `test/main/features/video_studio_native_qa.test.ts`, `test/main/features/video_timeline_render.test.ts`, `test/main/features/video_audio_e2e_delivery.test.ts` |
| Evening out the loudness leaves the sound at an unusual sample rate | The rate probed from a high render of a 24 kHz voice, with the normalization known to have run; failed at 96 kHz before the fix | `test/main/features/video_timeline_render.test.ts` |
| Removing fillers in Chinese takes the words around them or the whole clip; a cut clicks at its join or lets the sound drift from the picture; captions on vertical video sit under the platform buttons; narration over a scene's own sound is buried, or the scene goes silent after the line | Word lists with Chinese fillers next to words, digits and punctuation-only tokens, with padding stopped at the neighbouring word. Real ffmpeg: ten filler cuts on a steady tone (largest sample jump against the source's, picture and sound lengths); the caption's lowest lit row on 9:16 and 16:9 frames; the original tone's level before, during and after a ducked line. The real-ffmpeg checks each failed on the code before the fix | `test/main/features/video_decide.test.ts`, `test/main/features/video_edit_assembly_fixes.test.ts`, `test/main/features/video_edit_mix_filter.test.ts` |
| Cut points hide in a transcript that folds short pauses into the words, or a long view floods the reply | The phrase view `speech.transcribe` returns ahead of the transcript, built from word times even when sentences are asked for and from pauses measured while the audio is extracted: words the recognizer placed inside a silence moved to the nearer speech, pauses taken from the measured silence, line edges on the silence edges, sentences never cut at their own pauses, nothing moved when the recording is quieter than the threshold, a 200-line cap; the host and skill-bundle packers kept identical. Failed with the measured pauses removed | `test/main/features/video_phrases.test.ts`, `test/main/model/core-agent/video-studio-transcribe_tool.test.ts`, `test/main/features/video_decide.test.ts`, `test/main/features/video_analyze.test.ts`, `test/main/features/video_media_skill_scripts.test.ts` |
| A cut moves inside a line to drop a word recognition placed on the wrong side of a pause, and clips the kept line | The view returned by `speech.transcribe` and by `analyze_media --op phrases` carries, before its lines, the caution that times are measured, words can sit a second off and cuts belong at line edges or marked pauses | `test/main/features/video_phrases.test.ts`, `test/main/features/video_media_skill_scripts.test.ts` |
| A word recognized across a pause lands in the line beside it, so a false start reads as the end of the sentence before it and a retake cleanup keeps it | After a valid transcription with two or more measured speech spans, `speech.transcribe` cuts each span from the extracted audio and recognizes it once more (240 spans and 900 s of speech at most, 90 s, a short audio context for spans up to 5 s, the whole file's language); that text only guides a character alignment that moves each word into its span. Words, order, text and sentences are unchanged. Unusable guidance (less than half the characters repeated), pauses that hold speech, a failed or overdue run, or too many spans keep the recognized times; cancellation writes nothing. Real lamp and camping recordings from the 2026-11-17 benchmark split into their script lines; failed with the placed words discarded | `video_phrases.test.ts`, `video_studio_transcript_timing.test.ts` |
| A stopped task loses its accepted-request identity | Delivered, failed and unresolved outcomes against the durable pending/completed record, without automatic resubmission | `test/main/model/core-agent/video-gen-tool.test.ts` |
| A narration line lands outside its production | Where VideoStudio's relative path is written, against another Agent's, and a path outside the workspace refused before synthesis | `test/main/model/core-agent/generate-speech-tool.test.ts` |
| A narration line is missing from the ledger, loses its voice, or takes over an older line's row | Rows the real speech tool writes: the voice actually used, a line voiced again under a new name, a long line's label, no production, an unreadable ledger, another Agent | `test/main/model/core-agent/generate-speech-tool.test.ts` |
| A render lands beside its production and an older file is delivered in its place | Where a relative `output_path` is written, with and without the production's name, and the file `video.ship` then delivers over an older one of that name | `test/main/model/core-agent/video-timeline-tool.test.ts` |
| A changed line is delivered on its old voice | Words changed on audio delivered before, by content and under a new name, against a new voice, punctuation only, the user's own recording, an accepted change, and a production delivered before the record | `test/main/features/video_timeline_ship.test.ts` |
| A request the configured video service cannot make reads as generating being unavailable | The real check against MiniMax H3 Lite and a Wan service set up wrongly: silence alone against another setting, the retry it asks for going through, nothing held | `test/main/model/core-agent/video-timeline-tool.test.ts`, `test/main/features/video_production_spend.test.ts` |
| Narration made for a video is left out of it | Lines noted by the real speech tool, against a delivery playing them on a scene, a narration track or another track, captions only, files gone since, several files, the user's choice and the next delivery; a whole voice-over put on a short first scene is told to go on a narration track, one starting in a later scene or beside another scene's voice to be split per scene, and one longer than the rest of the video to lengthen the scene or shorten the line | `test/main/features/video_timeline_ship.test.ts`, `test/main/model/core-agent/generate-speech-tool.test.ts` |
| Words sit on the product, or the delivery reply names a gap it could close without a next step, or pads one on when nothing is left | The approved delivery look and reply wording, exact; live runs judged from delivered frames and replies, with and without a gap left, in the plan | `test/main/model/core-agent/video-timeline-tool.test.ts` |
| Words on a marked product reach the render | Glyph-measured lines over a region mapped through the page's fit, position and push-in, in a real window, against a full-width heading whose word sits beside it; the request, its three-line naming and its limit of three per run | `test/main/features/video_timeline_render.test.ts`, `test/main/model/core-agent/video-timeline-tool.test.ts` |
| An old production is lost, changed or half upgraded, or a file that is not ours gets overwritten | Byte-identical old folder, idempotent second pass, a pass stopped or failed partway leaving nothing to skip, a foreign file left as it was | `test/main/features/video_project_upgrade.test.ts`, `test/main/model/core-agent/video-timeline-tool.test.ts` |
| The package tells the model something the tool cannot do | Operations named in the package against the tool's own list, retired wording, links | `test/main/features/video_agent_package.test.ts` |
| A short film reaches the Agent but its writing never loads the story guidance, or that guidance asks for a frame-and-reference mix or a voice-over the tool refuses | The routing description, the link before scripting, and the guidance's frame, reference and kept-sound instructions against the real frame check and timeline schema | `test/main/features/video_agent_package.test.ts` |
| Agent and App from different releases | Refusal with what to update, both directions | `test/main/model/core-agent/video-timeline-tool.test.ts` |
| The canvas shows the wrong cards, loses a change, writes over the page or a damaged file, or edits while the Agent works | Files on disk after each change, with refusals | `test/main/features/video_canvas.test.ts` |
| A change renders by itself, an update the user changed the video during is delivered or reported as failed, or a failure goes unseen | Job events and what render and delivery were asked for; the edit channel starts no render and stops one in progress | `test/main/features/video_canvas_jobs.test.ts`, `test/main/ipc/video-canvas-ipc.test.ts` |
| Making a shot again pays twice, loses the old take, renders on its own, misses a video showing the shot, or ignores the words or configured model the user chose | The real tool, spending record and ledger over a stubbed network | `test/main/features/video_canvas_redo.test.ts` |
| The shot panel offers a service that cannot make the take, changes a setting it does not show, ignores the settings the user picked, or starts on the wrong service | Each configured service and configured model against the take's recorded call and the user's settings, with what each makes, the nearest where it does not, the reason, the final parameters and the default | `test/main/features/video_canvas_jobs.test.ts`, `test/main/ipc/video-canvas-ipc.test.ts` |
| Footage added in the shot panel is lost, sent in the wrong part or order, mixes a video into a still or frames, or loses what a still's reference was for | Each take's call with added footage, by reference and as frames, both ways, with the refusals before dispatch and a still's cap | `test/main/features/video_canvas_jobs.test.ts`, `test/main/ipc/video-canvas-ipc.test.ts` |
| A new shot is lost on closing the canvas, loses its settings, made on a service other than the one shown, unavailable until its words are written, a still of another shape than its videos, pays twice for a lost result, goes into a video, or does not take its card's place | New shots in canvas.json across card moves and damage; each service's shapes, lengths and defaults; each image service's size for a shape; the call, its durable identity and its failure | `test/main/features/video_canvas.test.ts`, `test/main/features/video_canvas_jobs.test.ts`, `test/main/ipc/video-canvas-ipc.test.ts`, `test/main/features/image_gen.test.ts` |
| A chosen video service falls back to another, is checked as another, or a repeat of its request goes elsewhere | The chosen profile through availability checks, durable admission and generation over controlled services; a service named in the model's own call is ignored | `test/main/features/video_gen.test.ts`, `test/main/features/video_production_budget.test.ts`, `test/main/model/core-agent/video-gen-tool.test.ts` |
| Using another take misses a video, renders, or moves a picture the page places | Files on disk after the change, with refusals | `test/main/features/video_canvas.test.ts` |
| A product change marks too few videos, is lost at the next delivery, or lists facts noted later | Delivered product facts against the current file, per video, across delivery, a repeat delivery and an older record | `test/main/features/video_canvas.test.ts`, `test/main/features/video_timeline_ship.test.ts` |
| A removed scene shows up, or re-renders the others | The real window and encoder | `npm run test:video-timeline-canary` |
| Layout, lines, zoom, where a new shot goes and a pasted link read wrongly | The view model, with look-alikes and cyclic shot references that leave unrelated branches unselected | `test/renderer/video-canvas.test.ts` |
| The panel does not work in the app: media, dragging, keyboard, versions, download, languages, a shot's references, prompt and takes, added footage and new shots, the settings popover and its explanations, a new shot hiding a card or opening its panel off the board, a service check or request under way that looks idle or can still be changed | The real renderer and IPC, with real renders; service checks and paid requests controlled and held | `test/e2e/video_canvas_e2e_panel.spec.ts` |
| An older read overwrites newer work, a cancelled open reopens, a late response shows another task, or unavailable data clears known content or an unread update | Hold actual IPC read responses to reverse completion order; assert the visible version, panel state and reminder before and after recovery. Test rejected transport promises in the renderer lifecycle, and refused/missing responses in Electron | `test/e2e/video_canvas_e2e_boundaries.spec.ts`, `test/renderer/video-canvas-lifecycle.test.ts` |
| Canvas updates are missed while closed, false reminders appear for timestamp/order/layout changes, or removing a production leaves old cards instead of remaining work or the empty state | Actual workspace edits, timestamp-only reordering, deletion and new work in the real renderer; explicit empty opening and language changes remain usable | `test/e2e/video_canvas_e2e_updates.spec.ts`, `test/e2e/video_canvas_e2e_boundaries.spec.ts`, `test/e2e/video_canvas_e2e_panel.spec.ts` |
| Oversized or concurrent draft edits partly save, lose another field or bypass the draft cap | Read back saved files at 19,999/20,000/20,001 prompt characters, 199/200/201 service-id characters, 29/30/31 seconds and references; byte-identical refusals; concurrent field/layout saves and two creations competing for the fiftieth slot, followed by removal and recovery | `test/main/features/video_canvas.test.ts` |
| A picture the page shows by file has no line, is removed or swapped from the canvas, or goes unremarked | References resolved per scene on the timeline, with look-alikes; refusals with files unchanged; the check's warning and text; the line in the real renderer | `test/main/features/video_timeline.test.ts`, `test/main/features/video_canvas.test.ts`, `test/main/features/video_timeline_render.test.ts`, `test/e2e/video_canvas_e2e_panel.spec.ts` |
| A delivered export with the wrong name is mistaken for no video, or a supported `ship` alias loses its arguments | Decode a unique actually published, run-produced file independently of export-name acceptance; keep wrong-name, ambiguous publication, source-copy and unsupported-operation rejection separate | Manual outcome procedure below; no automatic execution claimed |
| An external ffmpeg pass loses narration timing evidence and delivery silently clears a speech-overlap check | Per-line mixes retain a metadata marker through ordinary MP4 transforms; missing, stale or malformed records report unverified. Existing comments and explicit voice replacement are preserved. An external tool that strips both metadata and sidecar remains unverified by this mechanism | `test/main/features/video_delivery_repairs.test.ts`, `test/main/features/video_studio_core_freshness.test.ts` |
| Captions follow a universal position instead of avoiding protected content, or cleanup deletes intended emphasis, a correction or a pause | Use natural placement-free requests, source hashes, decoded frames and protected-region measurements; any readable unobstructed layout is valid. Independently measure retained spoken lines and source-time offsets rather than total length alone; removed emphasis/correction and a compressed pause padded at the end fail. Preserve explicit positioning requests when supplied | Manual outcome procedure below; no automatic execution claimed |
| Dubbing shortens the picture for a short voice, or retake choices become mistyped cut times and delete intended pauses | Optional `audio-segments` picture windows reject overlong speech before output; fitting existing audio keeps the source video stream and duration. Captioned dubbing reuses complete voice slices, places English captions at the measured audible times, covers the declared old subtitle band and preserves an existing delivery on failure. A fixed-picture repair can fit existing lines into adjoining measured pauses and keep the source tail. When a line cannot fit, its structured issue identifies the segment and leaves the earlier export intact. `cut_selection` lists one phrase ID per measured pause of 0.15 s or more (a false start 0.3 s before its retake is its own candidate), lists short sounds with no aligned words as separate review candidates, rejects stale/reordered/invalid choices, executes whole selected phrases and preserves pauses between adjacent choices; keeping all IDs copies the source unchanged. Source and voice hashes, independently decoded video/audio and output duration check side effects. VideoStudio timing feedback distinguishes estimates, measured duration and uncovered/low-level intervals without prescribing added words, picture cuts or music. Algorithms, thresholds, per-line placement and non-VideoStudio speech feedback retain their contracts. Model use of the windows/executor and semantic take choice still require production outcomes, not just deterministic success | `test/main/features/video_picture_selection.test.ts`; existing assembly/decide/script/freshness/package tests |
| A reference link saves the wrong file (a short clip, the next video, a live preview), drops the sound, hangs on a stalled download, keeps a sign-in page from the user, or leaves files behind | Saved bytes and streams against the served files; requests the host made; the tab left open or closed; the exact refusal texts | `test/main/features/web_assist_page_video.test.ts`, `test/main/features/web_assist_media_capture.test.ts`, `test/main/model/core-agent/video-reference-page_tool.test.ts`, `test/e2e/video_reference_e2e_page.spec.ts` |
| A product page capture loses local assets, reads outside its entry directory, crops overlays instead of content, or leaves partial files after navigation fails | Real-window crops, decoded colors and dimensions, local path/symlink denial, and unchanged foreign files. The unreachable-page case runs in the audited E2E host: exact load refusal, an empty output directory and successful recovery precede the PID/URL/error-bound navigation receipt; raw diagnostics are retained | `test/gui/run-product-capture-canary.mjs`, `test/e2e/video_reference_e2e_page.spec.ts` |

## Manual journeys

| A reply says a notification was blurred or a word removed when the delivered file shows otherwise; the guide still told the Agent to blur private details the owner leaves to the user | The explainer guide keeps private details as recorded and asks the reply to say where they show, with no blurring instruction left in any guide; the Deliver section names in the reply only changes the delivered frames show. Failed with the old guide text | `video_agent_package.test.ts` |
| A reply links the delivered video with a long path copied wrong, so the link opens nothing; a delivery given a mistyped absolute path is refused with no way forward | `video.ship` returns `reply_link`, a link relative to the conversation folder that the app turns into the delivered file (spaces, parentheses and percent signs escaped; none for a file outside that folder), and asks the reply to carry it as given; a path outside the task's files is answered with how to pass it relative to the production. | `video-timeline-tool.test.ts`, `video_timeline_ship.test.ts` |
| A delivered video plays a narration line twice, cuts off its last words, or asks for a new recording when the original fits | `video.ship` matches each line made since the last delivery against the delivered sound: a line placed twice is named with both start times, and a line that stops early with where it stops and how much is not heard. If the audio track ends before the picture and a source line is confirmed cut off, the primary error asks to check and reuse the original recording in the mix. The cut version stays unpublished and a mix of the same picture with the complete source voice delivers. Unmatched short audio retains its general repair advice. A clean placement, a draft sharing a line's opening, no narration and unreadable sound report no playback issue | `video_narration_playback.test.ts`, `video_timeline_ship.test.ts` |

Before starting, verify native ffmpeg/ffprobe markers and reject foreign-platform
runtime payloads. Use controlled media services or separately authorized bounded
provider calls. A deterministic or model-fixture pass does not certify visual,
listening, Windows or packaged behavior.

### A finished video

Send one filled home-video request. Expect a playable result, choices and gaps,
with a concrete next step for every gap that can be closed. A local opening edit
changes only that scene and buys no new generation.

### A short film

1. In a group conversation, send `做一个 30 秒竖屏剧情短片：外卖员雨夜给独居老人送药，两人有一句对话`.
   **Expected:** the Commander dispatches VideoStudio; only configured user-owned
   services can make the character key images and clips, within explicit spending authority.
2. **Expected:** the production holds a cast sheet and one key image per character; the courier and
   the old person look the same in every shot and keep their side of the frame through the
   conversation.
3. **Expected:** the spoken line plays on the clip's own sound and shows as a caption; no
   synthesized voice is laid over a visible speaking mouth. If the clip came back silent, the line
   is regenerated or restaged off the speaker's mouth. No generated clip prints the line onto the
   picture or brings its own music under the video's music track.
4. In a new conversation, send `只写剧本和分镜：同一个故事`. **Expected:** a script with scenes,
   dialogue, per-shot framing and estimated time, with no price card and no render.

### A brand ad and test versions

1. Send `给我的社区瑜伽馆做一条 20 秒竖屏品牌广告，没有具体产品要卖，用来在抖音投放`.
   **Expected:** one idea a viewer could repeat, shown in people and places rather than adjectives;
   no invented results, ratings or customer quotes; the end card uses the studio's real name. Generated
   footage stays on screen until the end card instead of a run of plain text cards, and the ad has sound.
   Supplied music may be used locally. No official music-generation service is
   available here; without supplied music the reply states that gap. Configured
   narration requires its own service authority. Anything a check flagged and the Agent kept,
   such as a long still stretch, is named in the reply.
2. Reply `再出三个版本测试开头，再出一个 15 秒和一个 1:1 的`. **Expected:** five more versions beside
   the main cut, each changing only what was asked, with no new paid generation unless a new opening
   shot is needed; the 15-second cut is re-edited around the hook, the strongest proof and the action,
   and the 1:1 version keeps text inside its frame. The reply lists each version and what it tests.

### Recreating a viral video

1. In a group conversation, attach a short vertical reference video and your own product footage,
   then send `这条爆款短视频，帮我照着它复刻一条，换成我的产品：<产品>。素材用我的录屏，不要生成新素材`.
   **Expected:** the Commander dispatches VideoStudio, and no plan or preview is presented for
   approval.
2. **Expected:** the video follows the reference's beat order and pace and keeps its recognizable
   layout, with the product's own copy and footage. None of the reference's footage or copy is
   reused unless it is the user's own. The reply says what was kept and what was not, such as
   music or a person's movement the footage cannot show.
3. Repeat with a reference that has a voiceover, and allow narration. **Expected:** the new lines
   follow the reference's lines in order and roughly in pace and end on a call to action. When the
   footage cannot show the reference's action, VideoStudio may ask once whether to adapt instead.
4. Repeat with a musical reference. Without supplied usable music, deliver the
   supported work and name the omission; no additional paid service starts by
   itself. Reference omissions and separately authorized presenter work must be
   made explicit at first delivery.
5. Paste a Douyin video's share link instead of attaching it, signed out of Douyin in the built-in
   Browser. **Expected:** the page opens in the task's Browser and closes again, and the video is
   inspected without asking for a file. Repeat with a Xiaohongshu or TikTok link: when the page
   asks to sign in or shows a check, VideoStudio asks you to do it there, the page stays open, and
   after you say it is done it continues from the same link. A page that plays nothing leads to a
   request to save the video and attach it.

### A presenter selling a product

1. Attach a product photo and send `用一个 AI 主播口播，给这款护眼台灯做一条 15 秒抖音带货视频`.
   **Expected:** a fictional adult presenter made once and reused on every clip, with the product
   photo passed as a reference each time; the product appears in the first three seconds and is shown
   whole; the presenter states the product's facts and offer but never claims to have used it.
2. **Expected:** captions stay clear of the mouth; the voice is the same across clips, or one
   voice-over replaces mismatched clip voices; the reply says the video may need an AI label where it
   is published and offers to add a small visible one.
3. Reply `再做一条投亚马逊的`. **Expected:** that version has no price, promotion, link or contact details.

### An explainer and a tutorial

1. Send `做一条 45 秒左右的竖屏科普视频：为什么飞机能飞起来`. **Expected:** it looks the
   topic up with the web tools, keeps `facts.md` with the sources, presents the
   "equal transit time" story only as a misconception with its source, and each
   part of a diagram appears when the voice names it.
2. Attach a screen recording of a short software task that shows an email
   address, and ask for a tutorial. **Expected:** the address is blurred wherever
   it shows, each step has a short title, waits are cut, sped-up parts are
   labelled, and UI text is readable at phone size.

### Clips from a podcast

1. Attach a two-person podcast recorded on a still camera and send
   `帮我剪 3 条适合发抖音的竖屏切片`. **Expected:** each clip opens on the question
   when it is an answer, ends after its payoff with no word cut off, and is
   framed on whoever is speaking (or keeps the whole frame for slides or
   cross-talk); `clips.json` lists the clips; all three are delivered.
2. Read the reply against the clips. **Expected:** every description matches
   what the clip actually says, and fewer clips are offered when fewer stand
   alone.

### A drama recap

1. Attach two short-drama episodes that have subtitles burned in, and send
   `帮我把这两集剪成一条 30 秒左右的竖屏解说视频，配上解说配音`.
   **Expected:** the only question is whether you hold the rights; it mentions
   that the generated voice may need an AI label and offers a small visible one.
2. Answer `有授权`. **Expected:** the production holds `scenes.md` and
   `cuts.json`; title cards, credits and the next-episode preview are left out;
   names in the narration match the burned-in subtitles, not a misheard
   transcript; narration never plays over someone speaking, and at least one
   key line keeps its original sound.
3. Ask to replace just the closing narration line. The new version should
   play the replacement once and keep the picture, original dialogue and
   remaining narration at their existing times.

### User-owned service and interruption

1. Use an explicitly configured image/video/speech key. Only that service account
   pays; there is no official credit card, membership gate or managed fallback.
2. Submit with a controlled service, stop after acceptance, then restart/status
   check/repeat the same request. Durable pending state cannot buy another task.
   Do not promise automatic late-result collection where that API cannot resume.
3. Fail delivery after accepted generation. Preserve its receipt and prior files;
   bounded download or local recovery cannot become another generation POST.
4. With no configured service, explain unavailability and preserve the draft.
   Existing-material edits remain local and do not require a plan/preview gate.

### Free stock

Needs the Server's `STOCK_PEXELS_API_KEY` and `STOCK_PIXABAY_API_KEY`.

1. Ask for a 20-second vertical ad for a café with no footage attached. **Expected:** the Agent
   searches stock for the café scenes, uses real moving clips for them, generates only what stock
   does not show (or nothing), and the reply names Pexels or Pixabay. `assets.json` lists each
   stock file with `origin: "stock"` and its author and licence.
2. Ask for an ad of a specific product the user photographed. **Expected:** the product is never a
   stock picture, and no person from stock is captioned as a customer.
3. Sign out, or use a Server without the keys. **Expected:** the video is still delivered, made
   without stock, and the Agent does not ask the user to sign in for it.
4. On a mainland China network, import a Pexels and a Pixabay clip. **Expected:** both download, or
   the reply says which source could not be reached.
5. Ask for a 40-second explainer about the Moon landing with music. **Expected:** archive footage
   (Commons or NASA) plays without its own sound, no NASA logo is used as a brand, the music is
   archive music or none (not a generated bed), and the reply lists the credit lines also saved
   beside the delivered video as `<version>.credits.txt`.

### An old project

1. Open a conversation with a video made on App 2.4 or earlier, using a copy of the data folder.
2. Open the video canvas. **Expected:** the old video and its scenes show; the old folder's bytes do
   not change.
3. Ask for a word change. **Expected:** the Agent carries on from the upgraded video without asking
   for approval, and a new version is delivered.
4. Ask to move the last scene to the front. **Expected:** it finishes in seconds with no re-render.

### The canvas

1. With a finished video, open the film button in the task header. **Expected:** footage, shots and
   the video in columns, with the video playing from its card.
2. Change a word in a scene, including one that shows a product fact such as the price, then its
   order, then drag a shot onto another scene. **Expected:** no confirmation and no render, and
   the product card keeps its fact; nothing on the video says it is behind, and **Update video**
   stays beside its versions. **Update video** shows a progress pill and one new version with all
   three within seconds. Pressed again, or after changing a word and changing it back, it says the
   video is already up to date and adds no version. A chat link to an earlier version still plays
   that version. Then remove a scene and, after restarting the app, open **+** at the end of the
   scenes. **Expected:** its **Put back** line comes first and returns the scene as it was, in its
   place, and **Update video** again says the video is already up to date.
3. Change the price on the product card of a video whose narration says the price. **Expected:** **Update video** sends VideoStudio a message naming the old and new price, and its new version shows and says the new price.
4. Under the scenes of a video with narration, pick another voice in **Voice for the whole
   video**; then open a scene and change its narration. **Expected:** the voice is one field under
   the scenes whichever scene is open, never in a scene's editor; nothing renders; **Update
   video** sends VideoStudio one message naming the changed line and the new voice, and its new
   version speaks every line in the new voice, the changed one as written. Change only a line, and
   only that line is voiced again, in the old voice. Narration from an uploaded recording shows as
   a note that cannot be changed.
5. With explicitly authorized user-owned generation, select a generated shot, change its prompt, pick another video
   model, open the settings button and change the length and sound, and press **Generate**.
   **Expected:** the panel shows the references, prompt, model and settings; the settings list
   only what the model makes, greying out with the reason a way or sound it cannot take, and the
   button sums up what will be made; models that cannot take the footage are greyed with the reason;
   **Generate** stays grey until the prompt, footage, model or a setting differs from the take, and
   shows the configured service without official credit amounts; the new take goes into every video that uses the
   shot, and nothing renders before **Update video**; the old take stays on the card, and **Use this
   result** puts it back. A scene's **Generate again** opens the same panel.
6. With explicitly authorized user-owned generation, add a picture to a generated video shot with **+**, switch it to
   **First and last frames**, and press **Generate**. **Expected:** the two images are labelled
   first and last frame and the new take opens and ends on them; a video among the pictures leaves
   frames unavailable with the reason.
7. Select a picture, press the **+** on its right edge and choose **Video shot**; write a prompt,
   pick a model and, in the settings, a shape, resolution, length and sound, close and reopen the
   canvas, then **Generate**. **Expected:** the
   new shot is still there with its words and choices, **Generate** names no credits, the button
   says it is checking the configured service and then submitting while nothing
   in the panel can be changed, no official credit confirmation appears, and the result replaces it in
   place as a shot card in no video. A second new shot from the same picture goes below the first,
   one drawn near the bottom of the board opens its panel in full view, and an image new shot, titled
   **New image**, comes out in the video's shape on a card headed **Image** and numbered apart from
   the shots. Dragging a picture's **+** onto it adds that picture; dragging to empty
   board makes another new shot there.
8. Send the Agent a message while the canvas is open. **Expected:** it goes view only until the turn
   ends, then shows what the Agent changed. Your card positions stay.
9. Right-click open board and choose **Another version of the video**, or **Another version** in a
   video's menu; delete one footage line, write what to change and send. **Expected:** the composer
   gets the ask with the caret at its end and every footage and shot listed under it, and nothing
   goes out before you send; VideoStudio's new version leaves out the footage you deleted.

### Windows

1. Render with the data folder and the project on different drives. **Expected:** it finishes, and
   the cache holds no staging folder afterwards.
2. On a low-end machine, run `npm run test:video-timeline-canary -- --perf` and record the numbers
   in the plan.


## Cross-volume staging and cache ownership

Manual cross-volume procedure: on macOS mount a temporary APFS image with
`hdiutil`; on Windows place the project on C: and the isolated data/cache on D:.
Render the same two-scene draft with each side on the other volume, inspect the
playable output, two complete cache entries and absence of .staging remnants.
Interrupt once, resume without recreating completed segments, then repeat cache
pruning. Record platform, runtime versions, actual volume identities, output
probe and strict native logs. Missing platform, perceptual listening/visual QA
or real-provider evidence stays explicit. Private model-evaluation history and
monorepo production traces are not shipped as public instructions.

## Framing, retained speech and publication controls

Inspect padded full-product shots, off-centre compositions, a requested label
close-up and captions over moving footage. Compare original pixels and source
identity; allow intentional negative space/close-ups while rejecting obstruction.
For a collision-renamed edit export, locate its unique actual published bytes;
reject a source copy, ambiguous versions, an unsupported operation or a missing
publication. A late end-card inspection must distinguish a visible closing line
from a blank ending. None of these controls grants visual approval from decoding
alone or replaces a fresh human/perceptual assessment.

## Shared video delivery and concurrency

All configured video callers share four slots. A waiting cancellation sends no request; request deadlines begin after admission. Parallel calls claim distinct output names before asynchronous work and retain one ledger row each. Verify through `video_gen.test.ts` and `video-gen-tool.test.ts`. Account-based stock search/import is unavailable in this edition; local licensed asset source/author/licence fields remain readable. Delivery writes the used timeline credit lines, or all production credit lines for ffmpeg-only work, beside the delivered version and publishes them; `video-timeline-tool.test.ts` covers both paths.

## 2026-11-17: retain selected video frames after an accurate seek

On the declared Linux FFmpeg 7 build, a 30 fps fourteen-frame cut could be muxed as twelve frames after the filtered output cadence was inferred. Keep the selected input cadence explicit and preserve every filtered frame. The existing independent beat-grid check still requires fourteen frames for one cut, 225 frames across sixteen cuts, aligned picture/sound starts and the original frame timestamps. Source files and fallback handling for unknown frame rates remain unchanged.

### Narrated scene timing and sound

| A narrated video the user gave no length ends each scene in silence, because the scenes kept their planned lengths after the lines came out shorter | `generate_speech` timing feedback: a short line keeps its scene and is lengthened only when the user asked for a length, otherwise the scene becomes the line plus about half a second; a fitting line's scene does the same when no length was asked for. Failed with the speech tool before | `generate-speech-tool.test.ts` |
| A narrated video renders scenes with no line and nothing under them, so it goes silent after its first lines | `video.check` and the Agent's `video.render` name a run of 3 s or more of scenes with no narration, no kept clip sound and no music or narration track, as an error to fix before rendering; a canvas re-render of a user's edit is not held back; a video with no narration at all is not checked. Failed with the check, the render block or the tool's flag removed | `video_timeline.test.ts`, `video_timeline_render.test.ts`, `video-timeline-tool.test.ts` |
| A video whose narration was written for its scenes but never voiced renders as silent captions | The same check names scenes with narration text, no voiced scene anywhere and nothing under them (3 s or more) as `TIMELINE_NARRATION_UNVOICED`, an error before the Agent renders; a short or music-backed one is left alone. Failed with that branch removed | `video_timeline.test.ts`, `video_timeline_render.test.ts` |

## Still review, screen demonstrations, and caption recovery

| Scenario | Observable result | Owning cases |
| --- | --- | --- |
| A canvas update renders a video with too much held still time | Keep the earlier version selected while the user previews, returns to editing, or delivers the already rendered file. A stale review cannot publish after the inputs or active account change. | `video_canvas_jobs.test.ts`, `video_canvas_e2e_panel.spec.ts` |
| A product demonstration substitutes static screens for the requested step | Recognize real screen input. Use the bundled screenshot interaction library to show the named step. Layout checks distinguish text within the screenshot from surrounding captions, and delivery checks count held times within mixed scenes. | `video_timeline.test.ts`, `video_studio_vendor.test.ts`, `video-timeline-canary.ts`, `video_timeline_ship.test.ts` |
| A long video needs a sample, or the brief omitted the recording it asks to edit | Present the representative delivered segment before making the full video. Use a supplied script as written. Ask for the original recording when the request needs it and it did not arrive. | `video_agent_package.test.ts` |
| Recognition reports inverted token intervals after a pause | Recover ordered intervals while preserving the words when adjacent time bounds permit. Keep the existing invalid-timing refusal when the intervals cannot fit. Chinese caption output follows the current Simplified or Traditional UI choice. | `video_studio_transcript_timing.test.ts`, `video-studio-transcribe_tool.test.ts` |
| Long captions extend outside a vertical video or timing is stale | Wrap authored and timed dialogue inside the frame, preserve its timing and formatting, and remove temporary subtitle copies after success or failure. | `video_edit_assembly_fixes.test.ts`, `video_edit_mix_filter.test.ts` |
| A supplied local file is outside the conversation workspace | The same configured read policy as file tools applies to recognized video imports, transcription and reference inspection. Local HTML capture keeps its existing roots. The original stays unchanged and generated files stay in the writable production range. | `outside-read-gate.test.ts`, `video-timeline-tool.test.ts`, `video-studio-transcribe_tool.test.ts` |
