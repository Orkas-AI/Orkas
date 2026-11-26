# Timeline and page

For timeline renders, edit the manifest with file tools, along with the HTML page when the video has one. Use `video.check` to check the timeline.

## manifest.json

```json
{
  "schema_version": 3,
  "id": "main",
  "label": "Lamp ad, night reading",
  "canvas": { "platform": "tiktok", "width": 1080, "height": 1920, "fps": 30, "language": "zh-CN" },
  "scenes": [
    {
      "id": "hook",
      "clips": [{ "id": "hook-shot", "asset": "lamp-photo", "in": 0, "dur": 3.2 }],
      "text": { "headline": { "value": "孩子写作业总说眼睛累？" } },
      "narration": { "text": "孩子写作业总说眼睛累？", "asset": "voice-hook" }
    },
    {
      "id": "price",
      "duration": 3,
      "text": { "amount": { "fact_id": "price" }, "cta": { "value": "点击下方购买" } }
    }
  ],
  "tracks": [{ "kind": "music", "asset": "bed", "volume": 0.3, "fade_out": 1, "duck": true }],
  "captions": { "enabled": true }
}
```

- `scenes` order is playback order. Start times and total length are worked out from it; never store them.
- A scene with `clips` takes its length from them. A scene without needs `duration`. Not both.
- `clips` play one after another. Add `"at": 2` to play a clip alongside them from 2s into the scene, for split screen or picture in picture; it does not add length.
- `asset` is an id from `assets.json`. `in` and `dur` are seconds of the source.
- `"audio": "keep"` uses the clip's own sound, with optional `volume`. The default is silent.
- `text` fills the page's `data-slot` elements of that scene. `{ "fact_id": "price" }` reads from `product.json`, so a price changes in one place. Use it for prices and specs.
- `narration.text` drives captions when `captions.enabled` is true. `narration.asset` is its audio; it must fit inside the scene.
- `tracks` start at 0s: `music`, `sfx`, or `narration`. For one take covering several scenes from the start, add `{ "kind": "narration", "asset": "voice-all", "volume": 1 }`, using the real asset id. `duck` lowers music under speech.
- Use even numbers for width and height. 9:16 is 1080×1920, 1:1 is 1080×1080, 16:9 is 1920×1080. Total limit 600s.

## assets.json

```json
{ "assets": [
  { "id": "lamp-photo", "kind": "image", "label": "商品图", "path": "media/lamp.jpg", "origin": "upload" },
  { "id": "voice-hook", "kind": "audio", "label": "开场配音", "path": "voice/hook.mp3", "origin": "generated" },
  { "id": "bed", "kind": "audio", "label": "背景音乐", "path": "music/bed.wav", "origin": "generated" }
] }
```

`video.import`, `generate_video`, `generate_image` and `generate_speech` add their own rows and return the `asset_id`, so the file may already exist: read it, then add to it. Add a row yourself for anything else you use, including output from `edit_video`. Paths are relative to the production folder. Length and hash are read from the file, so do not write them. `origin` is `upload`, `page`, `generated` or `edited`.

For a product image, inspect the source and record `"subject": [left, top, right, bottom]`: the visible product bounds as fractions of the source width and height, for example `[0.55, 0.05, 0.95, 0.95]`. Use those bounds when composing the scene; `video.check` also uses them to find words on the product.

An image can be a clip too: it holds still for `dur`; move it with the page's motion.

## product.json

```json
{ "name": "护眼台灯", "images": ["lamp-photo"], "facts": [
  { "id": "price", "text": "¥199", "source": "user" },
  { "id": "wireless", "text": "底座带无线充", "source": "page" }
] }
```

`source` is `user`, `page`, or `unverified` for anything you could not confirm.

## index.html

A clip-only scene needs no page: footage fills the frame. A video with no text at all needs no `index.html`.

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<script src="./assets/vendor/gsap.min.js"></script>
<style>
  html, body { width: 1080px; height: 1920px; margin: 0; overflow: hidden; background: #111; color: #fff; }
  main { position: relative; width: 100%; height: 100%; overflow: hidden; }
  section { position: absolute; inset: 0; }
  h1 { position: absolute; left: 80px; top: 180px; width: 920px; margin: 0; font-size: 72px; }
  .picture { position: absolute; left: 80px; top: 520px; width: 920px; height: 1040px; object-fit: contain; }
  .price { position: absolute; left: 80px; top: 300px; font-size: 120px; }
  .cta { position: absolute; left: 80px; top: 510px; font-size: 56px; }
</style>
</head>
<body>
<main data-composition-id="main">
  <section data-scene-id="hook">
    <img class="picture" data-clip="hook-shot" alt="">
    <h1 data-slot="headline"></h1>
  </section>
  <section data-scene-id="price">
    <div class="price" data-slot="amount"></div>
    <div class="cta" data-slot="cta"></div>
  </section>
</main>
<script>
  window.__timelines = {};
  // ORKAS-SCENE-MOTION-BEGIN:hook
  window.__timelines.hook = gsap.timeline({ paused: true })
    .from('[data-scene-id="hook"] h1', { y: 40, duration: 0.5, ease: 'power2.out' }, 0);
  // ORKAS-SCENE-MOTION-END:hook
  // ORKAS-SCENE-MOTION-BEGIN:price
  window.__timelines.price = gsap.timeline({ paused: true })
    .from('[data-scene-id="price"] .price', { scale: 0.8, opacity: 0, duration: 0.4, ease: 'back.out(2)' }, 0.2);
  // ORKAS-SCENE-MOTION-END:price
</script>
</body>
</html>
```

The rules behind it:

- These examples form one timeline: `clips[].asset` names a row in
  `assets.json`; `<img data-clip="hook-shot">` names that scene's clip `id`,
  not the asset id or file path. The host supplies its image source; omit `src`.
  Ledger paths start at the production directory; page resources such as GSAP
  start at `videos/main`. Use the actual supplied/generated files for these
  example rows; adding a row does not create the file.
- One `<section data-scene-id>` per scene. Only the current scene is shown; hiding and showing is done for you.
- **Each scene has its own paused timeline, `window.__timelines[<scene id>]`, with time starting at 0 for that scene.** This is what lets scenes be reordered without re-rendering. A timeline under any other name is refused. A scene with no motion needs none, but a motionless scene reads as a slide.
- Keep each scene's motion between its `ORKAS-SCENE-MOTION` comments, so changing it re-renders only that scene.
- There are no transitions across scenes: a cut is a hard cut, the norm in short ads. Animate entrances and exits inside a scene if you want a softer change.
- Put no words directly in the page that belong to `text`. Every `data-slot` in a scene needs a value in that scene's `text`, and every `text` key needs its `data-slot`.
- `<img data-clip="id">` places a clip yourself. A clip you do not place fills the frame behind the content. Never use `<video>` or `<audio>`: they are refused, because they do not render frame-accurately.
- Keep local files inside the video folder, for example `./assets/logo.png`, and reference them relatively. `product.capture` saves there: into `videos/main` unless you pass `video_dir`, with its paths relative to that folder. Nothing remote: no web fonts, CDNs or remote images.
- `./assets/vendor/gsap.min.js` is provided; just reference it.
- `./assets/vendor/screen-demo.js`, loaded after GSAP, shows a step done on a
  screenshot: a pointer or finger that taps, text typed into a field, the view
  moving in on a part, a ring or spotlight on it. Put the scene's screenshots in
  one box with explicit geometry; it frames them as a browser or phone
  (`ScreenDemo(box, tl, { frame: 'none' })` for no frame). A scene's screenshots
  are its clips in order, so the next screen cuts in where the tap leads to it.

  ```html
  <div class="demo" style="position: absolute; left: 120px; top: 420px; width: 840px; height: 1300px">
    <img data-clip="pick" alt=""><img data-clip="slots" alt="">
  </div>
  ```

  ```js
  window.__timelines.book = gsap.timeline({ paused: true });
  ScreenDemo('[data-scene-id="book"] .demo', window.__timelines.book)
    .tap(0.38, 0.42, 0.8)                         // x, y on the screenshot, at 0.8 s
    .type([0.06, 0.12, 0.88, 0.05], '老街', 1.4)  // the field's [x, y, width, height], typed from 1.4 s
    .tap(0.5, 0.88, 2.6)                          // just before the clip "slots" starts
    .zoom([0.04, 0.12, 0.92, 0.3], 3.0)           // move in on the result; zoom(null, t) moves back out
    .mark([0.04, 0.12, 0.92, 0.1], 3.4);          // ring it; { spot: true } dims the rest, { until: t } ends it
  ```

  Positions are fractions of the screenshot, or its own pixels. Read them off
  the screenshot and check them in the `video.check` previews. The view moves in
  on each tap or typing as it happens and back out when nothing happens for a
  moment; `zoom` sets it yourself, and `{ follow: false }` keeps it still.
- Style captions with `.orkas-caption` if the default does not suit.

## Frame 0

The first frame is the thumbnail, and a viewer decides on it. The opening scene's headline must be fully visible at time 0. Entrances that start from `opacity: 0` belong on secondary elements or later in the scene.

## Filling the frame

For original dimensions and local crop/resize/padding, follow
[image-preparation.md](image-preparation.md) before placing a prepared image.

Before styling a scene, locate the visible subject and the original labels, logos or details the viewer needs to see. Choose framing for the requested shot: the complete product, a specific detail, or the original composition. Preserve requested framing and intentional negative space; a close-up can omit parts outside its purpose.

Compose around that content, then place copy and motion where they leave it clear. An enlarged image box still scales the source padding under `object-fit: contain`; judge the product itself. When reframing is allowed and padding prevents the intended view, prepare a crop from verified source-pixel bounds before fitting it into the scene. Keep the original and inspect the prepared asset for clipped labels or parts. A crop chosen for one detail is not a complete-product view. Set size, position and motion origin from that prepared content and the shot's purpose. For moving footage, inspect relevant frames before choosing the crop and copy area: a subject position at one time does not describe its whole path. Keep every word, captions included, off the product. Verify the actual scene frames after changing the layout.

A cinematic letterbox (电影黑边) keeps the picture as wide as the frame, with black bars only above and below: fill the band between the bars with `object-fit: cover`. `object-fit: contain` in that band shrinks a picture taller than the band and leaves bars at its sides as well.

A page screenshot holds words, so a crop must not cut them in half. Capture just the part you want with `product.capture` `selectors` or `clips`, and show it whole on a card rather than cropped to fill.

Keep text readable with a small backing or a gradient behind the text alone. A dark layer over the whole picture hides the product. `video.check` tells you when a scene is nearly all one flat colour.

## Making a scene feel alive

Choose motion for the scene's purpose: reveal a detail, follow an action, build a
comparison or direct attention. A deliberate hold can give the viewer time to
inspect or read. Do not add movement just to change pixels; judge the actual
result when `video.check` reports a static or mostly empty scene. Those findings
are advisory and do not determine whether the sequence communicates its point.
