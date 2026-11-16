# Generating shots and images

## Before spending

`video.request_budget` with everything you plan, once, before the first paid call:

```json
{ "op": "video.request_budget", "production_dir": "lamp-ad",
  "planned": [{ "kind": "video", "count": 2, "duration": 8, "resolution": "720p", "ratio": "9:16" }] }
```

`covered` means configured services can make the plan. It is not a price, balance check or spending authorization: service accounts bill directly and this build cannot verify their charges. State the planned external calls and obtain the user's authorization once before sending them. With unavailable services or declined spending, use [Material fallback](../SKILL.md#material-fallback) to decide whether existing material meets the request or an alternative needs the user's decision.

## Calling

Pass `production_dir` on every `generate_video` and `generate_image`. Up to 4 can run at once, so request independent shots together.

```json
{ "prompt": "...", "output_path": "lamp-ad/shots/glow.mp4", "production_dir": "lamp-ad",
  "shot": "glow", "label": "灯光特写", "ratio": "9:16", "duration": 8,
  "reference_image_paths": ["lamp-ad/media/lamp.jpg"], "generate_audio": false }
```

Each result returns the real length, frames to look at, and an `asset_id` already in `assets.json`. Write the timeline from the real length.

Reuse an existing completed file when the tool returns it. An interrupted or unclear request may already have been billed: retain its local request record, check `video.status` and the service account, and do not dispatch another request automatically. A different prompt or output path is not permission for another paid attempt. Only a confirmed undispatched failure can be repaired under the unchanged authorization; an explicit new paid attempt needs the user's authorization for that attempt.

## Writing the prompt

Describe what a camera would see, not how it should feel. Subject, action, camera move, light, setting. One action per shot. See `video-craft` §9 and §10.

Ask for `"generate_audio": false` unless the shot's own sound matters; some services always return sound and refuse it. Whenever a clip has sound, name what should be heard and write "No music". Music, voice and captions are added later, so also write "No on-screen text or subtitles": a service may print a spoken line onto the picture.

## Judging

Look at the frames that come back. Each shot gets at most 2 retries; change something specific each time. Still wrong: stop generating that shot and follow [Material fallback](../SKILL.md#material-fallback); real material is usable only when it meets the shot's purpose or an accepted alternative. A failed attempt may already have been billed; keep its request state and available outputs, and do not retry without a reason and the required authority.

## Consistent characters

For recurring people or places, write `cast.md` with a look line for each before checking service availability, make a key image from each line, and in every prompt that shows them pass the key image and paste the look line word for word, as in [short-film guidance](@skill/video-craft/references/short-film.md). Neither the words nor the image alone draws the same person twice.
