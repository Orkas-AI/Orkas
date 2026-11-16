# Script timing before synthesis

Before drafting a timed script, choose the main message the requested length can
support. Sketch the visual and spoken beats together, leaving room for actions,
reading and pauses. Keep shot times flexible as the story develops. Let visuals
carry explanations they show clearly; narration can reinforce key points and
the CTA. This is creative guidance, not a fixed word count or shot recipe.

Estimate exact spoken lines early enough to revise them, including for a
script-only delivery. Use the private read-only `storyboard_timing` script
through this Skill's bound runner command:

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" video-studio storyboard_timing -- --input lamp-ad/timing.json
```

Write the planned spoken text and shot times to the input JSON:

```json
{"duration_sec":20,"segments":[
  {"id":"opening","text":"剩菜滤出，提起倒掉。","start_sec":0,"target_sec":4},
  {"id":"detail","text":"","start_sec":4,"target_sec":16}
]}
```

`start_sec` is the start time; `target_sec` is the shot duration, not its end
time. A shot from 4s to 8s uses `start_sec:4,target_sec:4`.
Use an empty string for a silent shot; captions are not automatically spoken.
Segments are ordered and nonoverlapping, with unique ids and positive durations.
The script accepts up to 1,000 segments in a 1 MiB JSON file. It writes no files,
makes no model or service call and sends no billable request.

`ok:true` means estimation succeeded; `kind:"estimate"` distinguishes it from
measured audio. `timing_review` is advisory, not an export gate: it lists crowded
segment ids with `over_by_sec` and any `timeline_over_by_sec`. Review each line's
`estimated_sec` and `remaining_sec`, not just the speech total. To ease a crowded
beat, simplify narration, let the visual carry part of the message, or redistribute
time within the requested total. Use natural speed (default 1) rather than
accelerating speech to hide a long script.

Apply accepted edits to the delivered script, then compare its final spoken lines
and shot times with the estimated input. Re-estimate changed lines or times;
reuse current results for unchanged ones. The per-line `text_sha256` identifies
the exact estimated text; it does not inspect a document or verify its facts.
Base any timing note on the matching result, rather than an earlier draft or a
manual character count. Keep the user's requested document format.

The estimate accounts for language mix, numbers and punctuation using the
existing narration algorithm. Actual speakers and pauses can differ. On a
script-only delivery, describe timing as estimated. When making audio, keep
`target_duration` on `generate_speech`, then align each shot with the returned
measured audio duration under [audio.md](audio.md). This check does not authorize
paid synthesis or turn a script-only request into video production.
