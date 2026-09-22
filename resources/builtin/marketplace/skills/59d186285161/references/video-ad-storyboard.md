# Video creative

Choose the structure for the placement and audience: reason to watch → use or problem → supported product demonstration → objection → action. Before delivering a timed script, run `storyboard_timing` on its final narration and shot windows. Shorten or redistribute over-budget lines, allow for the requested delivery style and visual actions, and rerun after revising text or timing.

TikTok Shop, Douyin, Kuaishou and short-form placements may need hooks and creator-style demonstrations; a storefront product video may need a calm specification/use sequence. Treat these as creative options and validate with the supplied channel data. Do not invent testimonials or pretend a scripted actor's experience is an actual review.

Each shot records time, SKU/source asset, visual action, factual proof, exact caption, narration and CTA. At a variant cut, reset the product, price, quantity and captions together. Keep claimed accessories and effects bound to evidence.

For experiments vary the hook, first frame, proof or CTA separately. Use the platform's actual view/click/conversion definitions and comparable windows. View-through or attributed sales do not by themselves establish incremental lift; returns and complaints can reveal an expectation gap.

## Check script timing

Use the execution template returned when reading this Skill: script name
`storyboard_timing` (without a file extension), arguments `--input timing.json`.
The [script](../scripts/storyboard_timing.js) runs the shared local narration estimator without producing audio or opening
a video-production project.

Prepare working JSON from the script's exact spoken lines and planned shot
times. Each segment has `id`, `text`, `start_sec` and `target_sec` (duration,
not end time). Include silent shots with empty `text`; omit captions and stage
directions from speech. Segments are ordered and do not overlap.

```json
{
  "duration_sec": 15,
  "segments": [
    {"id": "opening", "start_sec": 0, "target_sec": 3, "text": "A fresh start."},
    {"id": "detail", "start_sec": 3, "target_sec": 9, "text": ""},
    {"id": "cta", "start_sec": 12, "target_sec": 3, "text": "Find your favorite."}
  ]
}
```

Optional `speed` is a multiplier from 0.5 to 2, default 1 for a natural-pace
estimate. Use the requested pace when specified; do not raise speed merely to
make crowded copy fit. This is an estimate, not a voice-specific measurement
or a guarantee of relaxed delivery.

Each result reports `estimated_sec` and `remaining_sec` for the exact text
identified by `text_sha256`. Negative remaining time indicates that the line
needs more time under that estimate. `remaining_timeline_sec` compares the last
shot's end with the requested duration; total speech alone does not prove that
each shot fits. Positive remaining time can support a pause or visual action;
judge those against the actual scene and style rather than filling every gap
with more words.

Revise the script and its working JSON together, then rerun for the final text
and timings. The script does not rewrite the deliverable or approve a shoot.
Return the requested storyboard through the normal output tools; the estimate
JSON is working material, not an additional requested deliverable.
