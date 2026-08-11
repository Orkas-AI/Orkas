<!-- stage-compose reference. Read this only when the composition actually
speaks: a visual-only or SFX-only piece never needs it, and a COMPOSE segment
inside an AUTO production renders silent because the assembler owns the voice. -->

# Narration / audio track

**WHO OWNS NARRATION — decide this first:**
- **Standalone COMPOSE deliverable** (the composition IS the finished video, no assemble step): plan with `audio.owner="none"`, then let `composition.materialize_narration` change the validated manifest to `audio.owner="composition"` and generate the `<audio>` scaffold element that the renderer muxes.
- **Composition is a SEGMENT in an AUTO/assemble pipeline** (the assembler will mix narration in its mix tier — `stage-assemble` step 3): render this composition **SILENT — do NOT add a narration `<audio>` track**. If you bake narration in here AND the assembler mixes it, narration is added twice and you get two overlapping, drifting voices (the "two voices" defect). The mix step now refuses a non-silent base (`E_EDIT_BASE_HAS_AUDIO`) precisely to catch this. Background music inside the composition is also best left to the assembler so it can duck consistently under the one narration.

To give a STANDALONE explainer a voiceover: approve its words at Gate B, write those exact words as scene `narration_text`, prepare the planned manifest, then call `composition.materialize_narration`. Do not call generic `generate_speech`, manually patch the resulting track, instantiate `Audio`, call `.play()`/`.pause()`, assign `.currentTime`, or use a GSAP callback to control media.

```json
"audio": {
  "owner": "composition",
  "tracks": [
    { "id": "narration", "kind": "narration", "src": "assets/narration.mp3", "start": 0, "duration": 60, "volume": 1 }
  ]
}
```

- `composition.target_duration` remains the Gate B delivery target. Native timing reserves every explicitly silent opening or ending scene at its authored duration, then uses the remaining delivery time as the narration target. The accepted narration band is that narration target plus or minus `max(target * 5%, 5s)`. A shorter fitting read may leave a visual hold; when measured speech plus reserved silence exceeds the delivery target, `composition.duration` expands so neither speech nor the silent beat is truncated.
- `composition.materialize_narration` derives that narration target from the approved manifest automatically. Its free mixed-language preflight counts CJK characters, Latin words/initialisms, numbers/versions, punctuation pauses, and speed. `E_TTS_TEXT_TOO_LONG` or `E_TTS_TEXT_TOO_SHORT` returns before billing and requires a timing-focused script revision instead of silently changing approved words.
- Do not call generic speech synthesis or supply an implicit, guessed, or whole-delivery narration target. Keep explicit silence in the manifest and let `composition.check_narration_fit` / `composition.materialize_narration` derive the speech budget from the approved delivery timeline.
- After synthesis, the operation records `measured_duration_sec`, the resolved band, `narration-map.json`, and the transaction in the durable ledger. If speech is outside the band, revise the synchronized narration copies to `suggested_units`, run the free fit check, then continue from `composition.prepare` when it returns `approval_inherited:true`. The timing episode permits one automatic revised synthesis across the changed text hash. If that attempt is still outside the band, end the turn with the returned user choices; do not synthesize again without a new user decision.
- When the user chooses another narration revision, that reply authorizes exactly one additional synthesis after the free fit check. When the user chooses to proceed, call `composition.materialize_narration` with the same current-turn decision evidence so the waiver is recorded and the composition is retimed to the complete current audio. A structural change or narration rewrite beyond the authorized edit scope still requires a new Gate B approval.
- If `composition.materialize_narration` fails for another reason, never silently continue: respect its production state and error code, then either fix the approved narration input or explicitly proceed silent with that stated at the gate. Draft QA flags a contract that declares narration while the composition has no audio (`NARRATION_DECLARED_BUT_SILENT`) — do not present such a draft as if it were complete.
- Narration output is fixed at `project/composition/assets/narration.mp3`, keeping the composition self-contained and making successful synthesis idempotent across resumed Agent turns.
- Add background music only after narration timing is materialized, keep its volume low (e.g. 0.2), update the manifest track, then call `composition.reconcile` so protected audio markup stays synchronized without replacing visual HTML. Do not make music part of narration duration fitting.
- Keep narration audio inside the composition dir so the render is self-contained.
- **Talking-head caveat:** when this composition is being overlaid onto AI-generated talking-head footage that already has **lip-synced built-in speech** (generation line), do NOT add a narration `<audio>` track. The renderer's muxed audio replaces the clip's own voice, so a synthesized narration would desync from the mouth. Use this composition for captions / lower-thirds only and let the clip's built-in audio stand (background music at low volume is fine; spoken narration is not).
