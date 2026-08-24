<!-- gate-control reference. Read this only for AUTO child-composition
preview, segment revision, or whole-production assembly transitions. -->

# Assembled productions are one video

An AUTO production is authored as one composition per segment, but the user made
one video. The number of times it stops for them is fixed by the gate table in
`gate-control` and never grows with the number of segments.

- **The complete frame set is the keyframe preview stop.** When
  `production_review.uncaptured_segment_ids` is empty and before any assembly
  operation, end the turn with the whole production's frames and their exact
  locators, one line inviting changes, and `<plan-interaction status="open" />`.
  Segments never get their own stop — seven segments still make exactly one
  preview message. A segment with nothing to show is not ready to present — run
  its QA phase first.
- **The production's own contact sheet is that stop's artifact.** The batched
  snapshot phase returns `production_contact_sheet` — one image of the whole
  video, segments in playback order, media segments included as an extracted
  still. Lead with it, then list each segment's locators beneath. A media
  segment — a cut of the user's own footage, a generated shot — has no
  snapshot because its own file is the artifact: carry its `produced_path` so
  the user can play it. Never substitute one contact sheet per child.
- **A user-requested change to one segment is applied without re-asking.** They
  named the change, so applying it is already authorized. Before the
  production's preview go-ahead, apply the edit, re-capture that segment, and
  answer with ONE message: what changed, the re-captured frames' locators, and
  the same one-line go-ahead question — never a separate confirmation of the
  change itself; the host refuses per-segment approvals with
  `E_SEGMENT_HAS_NO_USER_GATE`. The same holds for a repair they told you to
  make. After the go-ahead — or once assembly is under way — a named change or
  internal repair is applied, its re-captured frames are published as
  progress, and the work continues without stopping: the finished video is the
  next stop.
- **Editing one segment does not disturb the others.** An edit drops only that
  segment back to uncaptured. Re-run its QA phase and leave every other segment
  alone — never re-render or re-check an unchanged segment because a sibling
  changed.
- After its plan, an assembled production stops twice: the keyframe preview
  and the finished video.
