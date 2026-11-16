import { describe, expect, it } from 'vitest';

import {
  buildTimelineSceneKey,
  captionCues,
  compileVideoPage,
  deriveVideoTimeline,
  dominantFlatShare,
  pagePictureIssues,
  pagePictureRefs,
  sheetLayoutFor,
  summarizeCheckWarnings,
  parseVideoManifest,
  timelineAudioTracks,
  validateVideoTimeline,
  type VideoAssetRecord,
  type VideoManifestV3,
  type VideoProduct,
} from '../../../src/main/features/video_timeline';

// One video is one array of scenes. These cases protect the promises the rest of
// the product leans on: reordering only moves array items, editing one scene's
// words touches only that scene, and text the user typed cannot become markup.

function video(overrides: Partial<VideoManifestV3> = {}): VideoManifestV3 {
  return {
    schema_version: 3,
    id: 'main',
    label: 'Lamp ad',
    canvas: { width: 1080, height: 1920, fps: 30 },
    scenes: [
      { id: 'hook', clips: [{ id: 'c1', asset: 'shot', in: 0, dur: 2 }], text: { headline: { value: 'No flicker' } } },
      { id: 'price', duration: 3, text: { amount: { value: '$19' }, headline: { value: 'Today only' } } },
    ],
    ...overrides,
  };
}

const ASSETS: VideoAssetRecord[] = [
  { id: 'shot', kind: 'video', label: 'Shot', path: 'assets/shot.mp4', origin: 'generated' },
  { id: 'photo', kind: 'image', label: 'Photo', path: 'assets/photo.jpg', origin: 'upload' },
  { id: 'song', kind: 'audio', label: 'Song', path: 'assets/song.mp3', origin: 'generated' },
  { id: 'voice', kind: 'audio', label: 'Voice', path: 'assets/voice.mp3', origin: 'generated' },
];

function codes(issues: Array<{ code: string; severity: string }>, severity = 'error'): string[] {
  return issues.filter((issue) => issue.severity === severity).map((issue) => issue.code);
}

function check(manifest: VideoManifestV3, extra: Partial<Parameters<typeof validateVideoTimeline>[0]> = {}): string[] {
  return codes(validateVideoTimeline({ manifest, assets: ASSETS, product: null, ...extra }));
}

describe('parseVideoManifest', () => {
  it('accepts the documented shape and rejects a misspelled field instead of ignoring it', () => {
    expect(parseVideoManifest(video()).manifest?.scenes).toHaveLength(2);
    const typo = video() as unknown as Record<string, unknown>;
    (typo.scenes as Array<Record<string, unknown>>)[1].durration = 3;
    const parsed = parseVideoManifest(typo);
    expect(parsed.manifest).toBeNull();
    expect(codes(parsed.issues)).toContain('TIMELINE_SCHEMA_INVALID');
  });

  it('rejects older schema versions so they go through the upgrader', () => {
    expect(parseVideoManifest({ ...video(), schema_version: 2 }).manifest).toBeNull();
  });
});

describe('deriveVideoTimeline', () => {
  it('derives start, length and total from array order alone', () => {
    const timeline = deriveVideoTimeline(video());
    expect(timeline.fps).toBe(30);
    expect(timeline.scenes.map((scene) => [scene.id, scene.startFrame, scene.frameCount])).toEqual([
      ['hook', 0, 60],
      ['price', 60, 90],
    ]);
    expect(timeline.totalFrames).toBe(150);
    expect(timeline.durationSec).toBe(5);
  });

  it('moves start times and nothing else when scenes are reordered', () => {
    const original = deriveVideoTimeline(video());
    const reordered = deriveVideoTimeline(video({ scenes: [...video().scenes].reverse() }));
    expect(reordered.scenes.map((scene) => [scene.id, scene.startFrame, scene.frameCount])).toEqual([
      ['price', 0, 90],
      ['hook', 90, 60],
    ]);
    expect(reordered.totalFrames).toBe(original.totalFrames);
  });

  it('plays sequential clips back to back without accumulating rounding drift', () => {
    const timeline = deriveVideoTimeline(video({
      scenes: [{
        id: 'long',
        clips: Array.from({ length: 7 }, (_item, index) => ({ id: `c${index}`, asset: 'shot', in: index, dur: 1.37 })),
      }],
    }));
    const [scene] = timeline.scenes;
    // 7 x 1.37s = 9.59s = 287.7 frames at 30fps; independent of per-clip rounding.
    expect(scene.frameCount).toBe(288);
    let cursor = 0;
    for (const clip of scene.clips) {
      expect(clip.startFrame).toBe(cursor);
      cursor += clip.frameCount;
    }
    expect(cursor).toBe(288);
  });

  it('keeps an overlay clip from lengthening its scene', () => {
    const timeline = deriveVideoTimeline(video({
      scenes: [{
        id: 'pip',
        clips: [
          { id: 'main-clip', asset: 'shot', in: 0, dur: 4 },
          { id: 'corner', asset: 'shot', in: 10, dur: 1, at: 2 },
        ],
      }],
    }));
    const [scene] = timeline.scenes;
    expect(scene.frameCount).toBe(120);
    expect(scene.clips.find((clip) => clip.id === 'corner')).toMatchObject({ startFrame: 60, frameCount: 30, overlay: true });
  });

  it('honours a requested frame rate over the declared one', () => {
    const timeline = deriveVideoTimeline(video(), 15);
    expect(timeline.fps).toBe(15);
    expect(timeline.totalFrames).toBe(75);
  });
});

describe('validateVideoTimeline', () => {
  it('rejects a sequential clip that cumulative frame rounding would erase', () => {
    const clips = [0, 1].map((n) => ({ id: `c${n}`, asset: 'shot', in: 0, dur: 0.02 }));
    const manifest = video({ scenes: [{ id: 'a', clips }] });
    expect(deriveVideoTimeline(manifest).scenes[0].clips.map(c => c.frameCount)).toEqual([1, 0]);
    expect(check(manifest)).toContain('TIMELINE_CLIP_TOO_SHORT');
    expect(check(video({ scenes: [{ id: 'a', clips: clips.map(c => ({ ...c, dur: 1 / 30 })) }] }))).toEqual([]);
  });

  it('applies the duration limit to rendered frames as well as nominal seconds', () => {
    const manifest = video({ canvas: { width: 1080, height: 1920, fps: 1 },
      scenes: Array.from({ length: 601 }, (_, n) => ({ id: `s${n}`, duration: 0.99 })) });
    expect(deriveVideoTimeline(manifest).durationSec).toBe(601);
    expect(check(manifest)).toContain('TIMELINE_TOO_LONG');
    expect(check({ ...manifest, scenes: manifest.scenes.slice(0, 600) })).toEqual([]);
  });

  it('passes a well-formed video', () => {
    expect(check(video())).toEqual([]);
  });

  it('accepts exactly the 600 second limit and rejects anything past it', () => {
    const at = video({ scenes: [{ id: 'a', duration: 600 }] });
    const over = video({ scenes: [{ id: 'a', duration: 600.5 }] });
    expect(check(at)).toEqual([]);
    expect(check(over)).toContain('TIMELINE_TOO_LONG');
  });

  it('requires a length for scenes without sequential clips and refuses a second source of length', () => {
    expect(check(video({ scenes: [{ id: 'a' }] }))).toContain('TIMELINE_SCENE_LENGTH_MISSING');
    expect(check(video({
      scenes: [{ id: 'a', duration: 2, clips: [{ id: 'c', asset: 'shot', in: 0, dur: 2 }] }],
    }))).toContain('TIMELINE_SCENE_LENGTH_CONFLICT');
    expect(check(video({
      scenes: [{ id: 'a', duration: 2, clips: [{ id: 'c', asset: 'shot', in: 0, dur: 1, at: 0 }] }],
    }))).toEqual([]);
  });

  it('refuses ids a page could not address unambiguously', () => {
    expect(check(video({
      scenes: [{ id: 'a', duration: 1 }, { id: 'a', duration: 1 }],
    }))).toContain('TIMELINE_SCENE_ID_DUPLICATE');
    expect(check(video({
      scenes: [
        { id: 'a', clips: [{ id: 'c', asset: 'shot', in: 0, dur: 1 }] },
        { id: 'b', clips: [{ id: 'c', asset: 'shot', in: 1, dur: 1 }] },
      ],
    }))).toContain('TIMELINE_CLIP_ID_DUPLICATE');
  });

  it('names unknown and unusable assets', () => {
    expect(check(video({
      scenes: [{ id: 'a', clips: [{ id: 'c', asset: 'nope', in: 0, dur: 1 }] }],
    }))).toContain('TIMELINE_ASSET_UNKNOWN');
    expect(check(video({
      scenes: [{ id: 'a', clips: [{ id: 'c', asset: 'song', in: 0, dur: 1 }] }],
    }))).toContain('TIMELINE_CLIP_NOT_VISUAL');
    expect(check(video({
      scenes: [{ id: 'a', duration: 1, narration: { text: 'Hi', asset: 'shot' } }],
    }))).toContain('TIMELINE_AUDIO_ASSET_NOT_AUDIO');
    expect(check(video({
      scenes: [{ id: 'a', duration: 1 }],
      tracks: [{ kind: 'music', asset: 'missing', volume: 0.3 }],
    }))).toContain('TIMELINE_ASSET_UNKNOWN');
  });

  it('checks clip ranges against the measured media at the boundary', () => {
    const manifest = (dur: number) => video({
      scenes: [{ id: 'a', clips: [{ id: 'c', asset: 'shot', in: 3, dur }] }],
    });
    const mediaDurations = new Map([['shot', 5]]);
    expect(check(manifest(2), { mediaDurations })).toEqual([]);
    expect(check(manifest(2.5), { mediaDurations })).toContain('TIMELINE_CLIP_PAST_MEDIA_END');
  });

  it('refuses a clip too short to occupy one frame', () => {
    expect(check(video({
      scenes: [{ id: 'a', clips: [{ id: 'c', asset: 'shot', in: 0, dur: 0.01 }] }],
    }))).toContain('TIMELINE_CLIP_TOO_SHORT');
  });

  it('refuses an overlay that runs past its scene', () => {
    expect(check(video({
      scenes: [{ id: 'a', duration: 2, clips: [{ id: 'c', asset: 'shot', in: 0, dur: 1.5, at: 1 }] }],
    }))).toContain('TIMELINE_OVERLAY_PAST_SCENE');
  });

  it('refuses a canvas the encoder cannot produce', () => {
    expect(check(video({ canvas: { width: 1081, height: 1920, fps: 30 } }))).toContain('TIMELINE_CANVAS_ODD');
  });

  it('refuses a price bound to a fact that does not exist', () => {
    const manifest = video({ scenes: [{ id: 'a', duration: 1, text: { amount: { fact_id: 'price' } } }] });
    const product: VideoProduct = { name: 'Lamp', facts: [{ id: 'price', text: '$19', source: 'user' }], images: [] };
    expect(check(manifest, { product })).toEqual([]);
    expect(check(manifest, { product: null })).toContain('TIMELINE_FACT_UNKNOWN');
  });

  it('warns when narration cannot fit in its scene instead of silently overlapping the next', () => {
    const manifest = video({
      scenes: [{ id: 'a', duration: 2, narration: { text: 'Hello', asset: 'voice' } }, { id: 'b', duration: 2 }],
    });
    const fits = validateVideoTimeline({ manifest, assets: ASSETS, product: null, mediaDurations: new Map([['voice', 2]]) });
    const over = validateVideoTimeline({ manifest, assets: ASSETS, product: null, mediaDurations: new Map([['voice', 2.6]]) });
    expect(codes(fits)).toEqual([]);
    expect(codes(over)).toContain('TIMELINE_NARRATION_OVERRUNS_SCENE');
  });

  // On 2026-11-07 a launch video cut 23–30s of the site's demo into one scene and 26–33s into the
  // next, so the same four seconds played twice in a row. Nothing said so.
  describe('the same footage in two scenes in a row', () => {
    const cut = (id: string, start: number, dur: number, asset = 'shot', at?: number) => ({ id, asset, in: start, dur, ...(at === undefined ? {} : { at }) });
    const pair = (first: ReturnType<typeof cut>, second: ReturnType<typeof cut>, between: VideoManifestV3['scenes'] = []) => video({
      scenes: [{ id: 'intro', clips: [first] }, ...between, { id: 'team', clips: [second] }],
    });
    const assets: VideoAssetRecord[] = [...ASSETS, { id: 'other-shot', kind: 'video', label: 'Other', path: 'assets/other.mp4', origin: 'page' }];
    const repeats = (manifest: VideoManifestV3) => validateVideoTimeline({ manifest, assets, product: null })
      .filter((issue) => issue.code === 'TIMELINE_ADJACENT_FOOTAGE_OVERLAP');

    it('warns, saying which scenes, which seconds and what to change, without blocking', () => {
      const manifest = pair(cut('a', 23, 7), cut('b', 26, 7));
      expect(repeats(manifest)).toEqual([expect.objectContaining({
        severity: 'warning',
        sceneId: 'team',
        message: 'Scenes "intro" and "team" both show 26.0–30.0s of "shot", so the same footage plays twice in a row. Move one of them to a part of the clip the other does not use, or use another clip.',
      })]);
      expect(check(manifest)).toEqual([]);
    });

    it('says nothing about cuts that only meet, or overlap by less than half a second', () => {
      expect(repeats(pair(cut('a', 23, 7), cut('b', 30, 7)))).toEqual([]);
      expect(repeats(pair(cut('a', 23, 7), cut('b', 29.6, 7)))).toEqual([]);
      expect(repeats(pair(cut('a', 23, 7), cut('b', 29.5, 7)))).toHaveLength(1);
    });

    it('leaves scenes apart, other clips and stills alone', () => {
      expect(repeats(pair(cut('a', 23, 7), cut('b', 26, 7), [{ id: 'logo', duration: 2 }]))).toEqual([]);
      expect(repeats(video({
        scenes: [{ id: 'intro', clips: [cut('a', 0, 4)] }, { id: 'team', clips: [{ id: 'b', asset: 'other-shot', in: 0, dur: 4 }] }],
      }))).toEqual([]);
      expect(repeats(pair(cut('a', 0, 3, 'photo'), cut('b', 0, 3, 'photo')))).toEqual([]);
    });

    it('counts a clip shown over the scene as footage too', () => {
      const manifest = video({
        scenes: [
          { id: 'intro', clips: [cut('a', 10, 4)] },
          { id: 'team', duration: 4, clips: [cut('b', 12, 2, 'shot', 1)] },
        ],
      });
      expect(repeats(manifest)).toHaveLength(1);
    });
  });
});

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>h1 { color: white; }</style>
</head>
<body>
  <main data-composition-id="main" data-width="1080" data-height="1920">
    <section data-scene-id="hook">
      <img data-clip="c1" style="width: 50%" alt="" />
      <h1 data-slot="headline">placeholder</h1>
    </section>
    <section data-scene-id='price'>
      <div data-slot='amount'><span>old</span><div>nested</div></div>
      <p data-slot="headline">not the hook headline</p>
    </section>
  </main>
  <script>
    window.__timelines = {};
    const note = '<h1 data-slot="headline">string in a script</h1>';
    // ORKAS-SCENE-MOTION-BEGIN:hook
    window.__timelines.hook = gsap.timeline({ paused: true });
    // ORKAS-SCENE-MOTION-END:hook
    // ORKAS-SCENE-MOTION-BEGIN:price
    window.__timelines.price = gsap.timeline({ paused: true });
    // ORKAS-SCENE-MOTION-END:price
  </script>
</body>
</html>`;

function compile(manifest: VideoManifestV3 = video(), html: string | null = PAGE, product: VideoProduct | null = null) {
  return compileVideoPage({ html, manifest, product, baseHref: 'file:///project/videos/main/' });
}

describe('compileVideoPage', () => {
  it('writes each scene\'s text into that scene\'s slots only', () => {
    const manifest = video({
      scenes: [
        { id: 'hook', clips: [{ id: 'c1', asset: 'shot', in: 0, dur: 2 }], text: { headline: { value: 'No flicker' } } },
        { id: 'price', duration: 3, text: { amount: { value: '$19' }, headline: { value: 'Today only' } } },
      ],
    });
    const { html, issues } = compile(manifest);
    expect(codes(issues)).toEqual([]);
    expect(html).toContain('<h1 data-slot="headline">No flicker</h1>');
    expect(html).toContain('<p data-slot="headline">Today only</p>');
    expect(html).toContain("<div data-slot='amount'>$19</div>");
    expect(html).not.toContain('nested');
  });

  it('leaves look-alikes in scripts and comments alone', () => {
    const { html } = compile();
    expect(html).toContain(`const note = '<h1 data-slot="headline">string in a script</h1>';`);
    const commented = PAGE.replace(
      '<h1 data-slot="headline">placeholder</h1>',
      '<!-- <h1 data-slot="headline">old copy</h1> --><h1 data-slot="headline">placeholder</h1>',
    );
    const out = compile(video(), commented).html;
    expect(out).toContain('<!-- <h1 data-slot="headline">old copy</h1> -->');
    expect(out).toContain('<h1 data-slot="headline">No flicker</h1>');
  });

  it('never lets typed text become markup', () => {
    const hostile = '</h1><script>alert(1)</script><img src=x onerror=alert(2)>&"\'';
    const { html } = compile(video({
      scenes: [
        { id: 'hook', clips: [{ id: 'c1', asset: 'shot', in: 0, dur: 2 }], text: { headline: { value: hostile } } },
        { id: 'price', duration: 3, text: { amount: { value: '$19' }, headline: { value: 'Today only' } } },
      ],
    }));
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;/h1&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('survives replacement patterns in typed text', () => {
    const { html } = compile(video({
      scenes: [
        { id: 'hook', clips: [{ id: 'c1', asset: 'shot', in: 0, dur: 2 }], text: { headline: { value: "Save $& and $' today" } } },
        { id: 'price', duration: 3, text: { amount: { value: '$1' } } },
      ],
    }));
    expect(html).toContain("Save $&amp; and $' today");
    expect(html).toContain("<div data-slot='amount'>$1</div>");
  });

  it('resolves a bound price from the product facts', () => {
    const product: VideoProduct = { name: 'Lamp', facts: [{ id: 'price', text: '$29', source: 'user' }], images: [] };
    const { html } = compile(video({
      scenes: [
        { id: 'hook', clips: [{ id: 'c1', asset: 'shot', in: 0, dur: 2 }], text: { headline: { value: 'x' } } },
        { id: 'price', duration: 3, text: { amount: { fact_id: 'price' } } },
      ],
    }), PAGE, product);
    expect(html).toContain("<div data-slot='amount'>$29</div>");
  });

  it('reports a slot with no text, and text with no slot, by name', () => {
    const missing = compile(video({
      scenes: [
        { id: 'hook', clips: [{ id: 'c1', asset: 'shot', in: 0, dur: 2 }] },
        { id: 'price', duration: 3, text: { amount: { value: '$19' }, nope: { value: 'x' } } },
      ],
    }));
    expect(missing.issues.find((issue) => issue.code === 'PAGE_SLOT_UNFILLED')).toMatchObject({ severity: 'error', sceneId: 'hook' });
    expect(missing.issues.find((issue) => issue.code === 'PAGE_SLOT_MISSING')).toMatchObject({ severity: 'error', sceneId: 'price' });
  });

  it('refuses <video> and <audio> elements but not the word in a script', () => {
    const withVideo = PAGE.replace('<h1 data-slot="headline">placeholder</h1>', '<h1 data-slot="headline"></h1><video src="./a.mp4"></video>');
    expect(codes(compile(video(), withVideo).issues)).toContain('PAGE_MEDIA_ELEMENT_FORBIDDEN');
    const inScript = PAGE.replace('window.__timelines = {};', 'window.__timelines = {}; const t = "<video>";');
    expect(codes(compile(video(), inScript).issues)).not.toContain('PAGE_MEDIA_ELEMENT_FORBIDDEN');
    const withAudio = PAGE.replace('</main>', '<audio src="./a.mp3"></audio></main>');
    expect(codes(compile(video(), withAudio).issues)).toContain('PAGE_MEDIA_ELEMENT_FORBIDDEN');
  });

  it('fills the frame with a clip the page did not place, behind the page content', () => {
    const noPlacement = PAGE.replace('<img data-clip="c1" style="width: 50%" alt="" />', '');
    const { html, issues } = compile(video(), noPlacement);
    expect(codes(issues)).toEqual([]);
    expect(html).toMatch(/<img data-clip="c1" class="orkas-fill"/);
  });

  it('keeps a clip the page placed and does not add a second one', () => {
    const { html } = compile();
    expect(html.match(/data-clip="c1"/g)).toHaveLength(1);
    expect(html).toContain('<img data-clip="c1" style="width: 50%" alt="" />');
  });

  it('builds a full-frame section for a clip-only scene the page does not mention', () => {
    const { html, issues } = compile(video({
      scenes: [
        { id: 'hook', clips: [{ id: 'c1', asset: 'shot', in: 0, dur: 2 }], text: { headline: { value: 'x' } } },
        { id: 'broll', clips: [{ id: 'c2', asset: 'shot', in: 5, dur: 2 }] },
        { id: 'price', duration: 3, text: { amount: { value: '$19' }, headline: { value: 'Today only' } } },
      ],
    }));
    expect(codes(issues)).toEqual([]);
    expect(html).toMatch(/<section data-scene-id="broll"[^>]*><img data-clip="c2" class="orkas-fill"/);
  });

  it('needs no page at all when every scene is only clips', () => {
    const { html, issues } = compile(video({
      scenes: [{ id: 'broll', clips: [{ id: 'c2', asset: 'shot', in: 5, dur: 2 }] }],
    }), null);
    expect(codes(issues)).toEqual([]);
    expect(html).toContain('data-composition-id="main"');
    expect(html).toContain('data-clip="c2"');
  });

  it('refuses a text-only scene the page does not mention', () => {
    expect(codes(compile(video({
      scenes: [{ id: 'gone', duration: 1 }],
    })).issues)).toContain('PAGE_SCENE_MISSING');
  });

  it('points relative resources at the video directory exactly once', () => {
    const { html } = compile();
    expect(html.match(/<base /g)).toHaveLength(1);
    expect(html).toContain('<base href="file:///project/videos/main/">');
    expect(html.indexOf('<base ')).toBeLessThan(html.indexOf('<style>h1'));
    const ownBase = PAGE.replace('<meta charset="UTF-8" />', '<meta charset="UTF-8" /><base href="https://example.com/">');
    expect(codes(compile(video(), ownBase).issues)).toContain('PAGE_BASE_FORBIDDEN');
  });

  it('adds a caption layer only to narrated scenes when captions are on', () => {
    const scenes: VideoManifestV3['scenes'] = [
      { id: 'hook', clips: [{ id: 'c1', asset: 'shot', in: 0, dur: 2 }], text: { headline: { value: 'x' } }, narration: { text: 'Hello there.' } },
      { id: 'price', duration: 3, text: { amount: { value: '$19' }, headline: { value: 'Today only' } } },
    ];
    const off = compile(video({ scenes }));
    expect(off.html).not.toContain('data-orkas-caption');
    const on = compile(video({ scenes, captions: { enabled: true } }));
    expect(on.scenes.hook.subtree).toContain('data-orkas-caption');
    expect(on.scenes.price.subtree).not.toContain('data-orkas-caption');
  });

  it('attributes every byte of the page to one scene or to the shared surface', () => {
    const base = compile();
    const editedText = compile(video({
      scenes: [
        { id: 'hook', clips: [{ id: 'c1', asset: 'shot', in: 0, dur: 2 }], text: { headline: { value: 'Different' } } },
        { id: 'price', duration: 3, text: { amount: { value: '$19' }, headline: { value: 'Today only' } } },
      ],
    }));
    expect(editedText.scenes.hook.subtree).not.toBe(base.scenes.hook.subtree);
    expect(editedText.scenes.price.subtree).toBe(base.scenes.price.subtree);
    expect(editedText.shared).toBe(base.shared);

    const editedCss = compile(video(), PAGE.replace('color: white', 'color: black'));
    expect(editedCss.shared).not.toBe(base.shared);
    expect(editedCss.scenes.hook.subtree).toBe(base.scenes.hook.subtree);

    const editedMotion = compile(video(), PAGE.replace(
      'window.__timelines.price = gsap.timeline({ paused: true });',
      'window.__timelines.price = gsap.timeline({ paused: true }).to("h1", { x: 1 });',
    ));
    expect(editedMotion.scenes.price.motion).not.toBe(base.scenes.price.motion);
    expect(editedMotion.scenes.hook.motion).toBe(base.scenes.hook.motion);
    expect(editedMotion.shared).toBe(base.shared);
  });

  it('keeps the other scenes\' identity when a scene is taken off the timeline', () => {
    const base = compile();
    const without = compile(video({ scenes: video().scenes.filter((scene) => scene.id !== 'price') }));

    // Their cached segments stay valid, because nothing they depend on changed.
    expect(without.shared).toBe(base.shared);
    expect(without.scenes.hook).toEqual(base.scenes.hook);
    expect(without.scenes.price).toBeUndefined();
    // The page itself still holds it, for the renderer to hide.
    expect(without.html).toContain('data-scene-id=\'price\'');
    expect(without.issues).toEqual([]);
  });

  it('does not let the project location change the identity of the page', () => {
    const here = compileVideoPage({ html: PAGE, manifest: video(), product: null, baseHref: 'file:///a/' });
    const there = compileVideoPage({ html: PAGE, manifest: video(), product: null, baseHref: 'file:///b/c/' });
    expect(here.shared).toBe(there.shared);
    expect(here.scenes.hook.subtree).toBe(there.scenes.hook.subtree);
  });
});

describe('buildTimelineSceneKey', () => {
  const key = (overrides: Partial<Parameters<typeof buildTimelineSceneKey>[0]> = {}) => buildTimelineSceneKey({
    subtree: '<section data-scene-id="a"></section>',
    motion: '',
    shared: '<html></html>',
    sceneAssetsSha256: 'scene-assets',
    sharedAssetsSha256: 'shared-assets',
    clips: [{ id: 'c', assetSha256: 'aaa', inSec: 1, startFrame: 0, frameCount: 30 }],
    captions: [],
    frameCount: 30,
    fps: 30,
    width: 1080,
    height: 1920,
    quality: 'high',
    format: 'mp4',
    ...overrides,
  });

  it.each([
    ['the words', { subtree: '<section data-scene-id="a">x</section>' }],
    ['the motion', { motion: 'tl.to()' }],
    ['the shared page', { shared: '<html>x</html>' }],
    ['a referenced image', { sceneAssetsSha256: 'other' }],
    ['the source file', { clips: [{ id: 'c', assetSha256: 'bbb', inSec: 1, startFrame: 0, frameCount: 30 }] }],
    ['the in point', { clips: [{ id: 'c', assetSha256: 'aaa', inSec: 2, startFrame: 0, frameCount: 30 }] }],
    ['the length', { frameCount: 31 }],
    ['the frame rate', { fps: 24 }],
    ['the canvas', { width: 720 }],
    ['the quality', { quality: 'draft' as const }],
    ['the captions', { captions: [{ fromFrame: 0, toFrame: 30, text: 'Hi' }] }],
  ])('changes with %s', (_label, overrides) => {
    expect(key(overrides)).not.toBe(key());
  });
});

describe('summarizeCheckWarnings', () => {
  it('separates repeated observations from located targets and retains one sampled measurement per example', () => {
    const first = [0, 0.5, 1].map(sampleTimeSec => ({
      code: 'LOW_CONTRAST', sceneId: 'opening', selector: '.title', message: 'Title contrast', sampleTimeSec,
      evidence: { contrast_ratio: sampleTimeSec === 0 ? 1.2 : 2.4, minimum_ratio: 4.5,
        rect: { left: 10, top: 20, width: 100, height: 30 }, canvas: { width: 1080, height: 1920 } },
    }));
    const second = [0, 0.5, 1].map(sampleTimeSec => ({
      code: 'LOW_CONTRAST', sceneId: 'opening', selector: '.caption', message: 'Caption contrast', sampleTimeSec,
      evidence: { contrast_ratio: 2.1, minimum_ratio: 4.5 },
    }));
    const [row] = summarizeCheckWarnings([...first, ...second]);
    expect(row).toMatchObject({ count: 6, target_count: 2, unlocated_count: 0 });
    expect(row.examples).toEqual([
      { scene_id: 'opening', selector: '.title', message: 'Title contrast', occurrences: 3, scene_time_sec: 0,
        evidence: { contrast_ratio: 1.2, minimum_ratio: 4.5, rect: { left: 10, top: 20, width: 100, height: 30 }, canvas: { width: 1080, height: 1920 } } },
      { scene_id: 'opening', selector: '.caption', message: 'Caption contrast', occurrences: 3, scene_time_sec: 0,
        evidence: { contrast_ratio: 2.1, minimum_ratio: 4.5 } },
    ]);
  });

  it('prioritizes another scene, preserves omitted target counts, and never merges equal selectors across scenes', () => {
    const rows = summarizeCheckWarnings([
      { code: 'FONT_TOO_SMALL', sceneId: 'a', selector: '.title', message: 'First' },
      { code: 'FONT_TOO_SMALL', sceneId: 'a', selector: '.caption', message: 'Second' },
      { code: 'FONT_TOO_SMALL', sceneId: 'b', selector: '.title', message: 'Third' },
      { code: 'FONT_TOO_SMALL', sceneId: 'a', selector: '.title', message: 'Repeated' },
    ]);
    expect(rows[0]).toMatchObject({ count: 4, target_count: 3, omitted_targets: 1 });
    expect(rows[0].examples).toEqual([
      expect.objectContaining({ scene_id: 'a', selector: '.title', occurrences: 2, message: 'First' }),
      expect.objectContaining({ scene_id: 'b', selector: '.title', occurrences: 1, message: 'Third' }),
    ]);
  });

  it('keeps unlocated observations explicit and bounds private or malformed evidence by code', () => {
    const [row] = summarizeCheckWarnings([
      { code: 'TEXT_OVERFLOW', message: 'No location' },
      { code: 'TEXT_OVERFLOW', sceneId: 'opening', selector: '.copy', message: 'Too wide', sampleTimeSec: 0.25,
        evidence: { overflow_pixels: { x: 18, y: 0, private: 'private-data' }, contrast_ratio: 1.2,
          rect: { left: -3, top: 20, width: 100, height: 30, private: 'private-data' },
          canvas: { width: 1080, height: 1920 }, private: 'private-data' } },
    ]);
    expect(row).toMatchObject({ count: 2, target_count: 1, unlocated_count: 1 });
    expect(row.examples[0]).not.toHaveProperty('occurrences');
    expect(row.examples[1]).toMatchObject({ scene_time_sec: 0.25, evidence: { overflow_pixels: { x: 18, y: 0 } } });
    expect(row.examples[1].evidence).not.toHaveProperty('contrast_ratio');
    expect(JSON.stringify(row)).not.toContain('private-data');
    for (const code of ['UNKNOWN', '__proto__', 'constructor', 'LOW_CONTRAST.lookalike']) {
      const [unknown] = summarizeCheckWarnings([{ code, message: 'Unknown', evidence: { contrast_ratio: 1, private: 'private-data' } }]);
      expect(unknown.examples[0]).not.toHaveProperty('evidence');
    }
  });

  it('counts full target identities before clipping display fields and keeps large reports bounded', () => {
    const warnings = Array.from({ length: 2000 }, (_, index) => ({
      code: 'FONT_TOO_SMALL', sceneId: `scene-${index % 20}`, selector: `${'p'.repeat(200)}-${index}`,
      message: 'x'.repeat(4000), sampleTimeSec: 1,
      evidence: { font_size_px: 12, minimum_px: 18, private: 'private-data' },
    }));
    const [row] = summarizeCheckWarnings(warnings);
    expect(row).toMatchObject({ count: 2000, target_count: 2000, omitted_targets: 1998 });
    expect(row.scenes).toHaveLength(12);
    expect(row.examples).toHaveLength(2);
    for (const example of row.examples) {
      expect(example.selector).toHaveLength(200);
      expect(example.message).toHaveLength(200);
      expect(example.evidence).toEqual({ font_size_px: 12, minimum_px: 18 });
    }
    expect(JSON.stringify(row).length).toBeLessThan(2000);
  });

  it.each([
    ['ELEMENT_OUT_OF_CANVAS', { overflow_pixels: { left: 12, right: 0, top: 0, bottom: 0 }, intersection_ratio: 0.9 }],
    ['SAFE_AREA_VIOLATION', { safe_area: { x: 54, y: 96 } }],
    ['TEXT_OCCLUDED', { overlap_area: 20, overlap_ratio: 0.5, other_selector: '.caption' }],
    ['TEXT_DENSITY_HIGH', { character_count: 200 }],
  ] as const)('retains the typed measurement for %s without adding another inspection', (code, evidence) => {
    const [row] = summarizeCheckWarnings([{ code, sceneId: 'a', selector: '.title', message: 'Finding', evidence }]);
    expect(row.examples[0].evidence).toEqual(evidence);
  });

  it('omits invalid measurement values without inventing zero or hiding a finding', () => {
    const [row] = summarizeCheckWarnings([{ code: 'FONT_TOO_SMALL', sceneId: 'a', selector: '.title', message: 'Small text',
      sampleTimeSec: Number.NaN, evidence: { font_size_px: Number.NaN, minimum_px: 18, rect: { left: -3, width: Number.POSITIVE_INFINITY } } }]);
    expect(row).toMatchObject({ count: 1, target_count: 1 });
    expect(row.examples[0]).not.toHaveProperty('scene_time_sec');
    expect(row.examples[0].evidence).toEqual({ minimum_px: 18, rect: { left: -3 } });
  });

  it('keeps one row per kind, with where it happens and an example or two', () => {
    const many = Array.from({ length: 30 }, (_item, index) => ({
      code: 'LOW_CONTRAST',
      sceneId: `scene-${index % 3}`,
      selector: `.line-${index}`,
      message: `Line ${index} is hard to read`,
    }));
    const rows = summarizeCheckWarnings([...many, { code: 'SCENE_STATIC', sceneId: 'hook', message: 'Still' }]);
    expect(rows.map((row) => [row.code, row.count])).toEqual([['LOW_CONTRAST', 30], ['SCENE_STATIC', 1]]);
    expect(rows[0].scenes).toEqual(['scene-0', 'scene-1', 'scene-2']);
    expect(rows[0].examples).toEqual([
      { scene_id: 'scene-0', selector: '.line-0', message: 'Line 0 is hard to read', occurrences: 1 },
      { scene_id: 'scene-1', selector: '.line-1', message: 'Line 1 is hard to read', occurrences: 1 },
    ]);
  });

  it('stays small however many findings a page raises', () => {
    const flood = Array.from({ length: 2000 }, (_item, index) => ({
      code: `CODE_${index % 8}`,
      sceneId: `scene-${index}`,
      message: 'x'.repeat(4000),
    }));
    expect(JSON.stringify(summarizeCheckWarnings(flood)).length).toBeLessThan(8000);
  });

  it('copes with a finding that belongs to no scene', () => {
    expect(summarizeCheckWarnings([{ code: 'PAGE', message: 'Whole page' }])).toEqual([
      { code: 'PAGE', count: 1, scenes: [], target_count: 0, unlocated_count: 1, examples: [{ message: 'Whole page' }] },
    ]);
  });
});

describe('sheetLayoutFor', () => {
  it('shapes the cell like the video, so a frame fills it', () => {
    expect(sheetLayoutFor(1080, 1920)).toEqual({ thumbWidth: 270, thumbHeight: 480, columns: 6 });
    expect(sheetLayoutFor(1920, 1080)).toEqual({ thumbWidth: 480, thumbHeight: 270, columns: 3 });
    expect(sheetLayoutFor(1080, 1080)).toEqual({ thumbWidth: 480, thumbHeight: 480, columns: 4 });
  });
});

describe('dominantFlatShare', () => {
  function bitmap(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Uint8Array {
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const [b, g, r] = pixel(x, y);
        out.set([b, g, r, 255], (y * width + x) * 4);
      }
    }
    return out;
  }

  it('reads a blank frame as fully flat', () => {
    expect(dominantFlatShare(bitmap(10, 10, () => [240, 240, 240]), 10, 10)).toBe(1);
  });

  it('ignores noise on a flat background', () => {
    const noisy = bitmap(10, 10, (x, y) => [240 + ((x + y) % 2), 241, 240]);
    expect(dominantFlatShare(noisy, 10, 10)).toBe(1);
  });

  it('measures the part of the frame a picture leaves empty', () => {
    const halfEmpty = bitmap(10, 10, (x, y) => (y < 5 ? [240, 240, 240] : [x * 25, y * 25, (x + y) * 12]));
    expect(dominantFlatShare(halfEmpty, 10, 10)).toBeCloseTo(0.5, 1);
  });

  it('does not call a varied picture empty', () => {
    const photo = bitmap(16, 16, (x, y) => [x * 16, y * 16, (x * y) % 256]);
    expect(dominantFlatShare(photo, 16, 16)).toBeLessThan(0.1);
  });
});

describe('captionCues', () => {
  it('splits on sentence punctuation and shares time by length', () => {
    const cues = captionCues('今天聊视频。开头三秒最重要！', 6);
    expect(cues.map((cue) => cue.text)).toEqual(['今天聊视频', '开头三秒最重要']);
    expect(cues[0].startSec).toBe(0);
    expect(cues[0].endSec).toBeCloseTo(6 * 5 / 12, 2);
    expect(cues[1].endSec).toBe(6);
  });

  it('breaks a long line at a comma before it ever cuts a word', () => {
    const cues = captionCues('This lamp has no flicker at all, three colour temperatures, and a wireless charging base.', 9);
    for (const cue of cues) {
      expect(cue.text.length).toBeLessThanOrEqual(42);
      expect(cue.text).toMatch(/^\S/);
    }
    expect(cues.map((cue) => cue.text).join(' ')).toContain('three colour temperatures');
  });

  it('breaks an unpunctuated long run by display width without losing characters', () => {
    const text = '这是一段没有任何标点的很长很长很长很长很长很长很长很长很长很长的字幕内容';
    const cues = captionCues(text, 8);
    expect(cues.length).toBeGreaterThan(1);
    expect(cues.map((cue) => cue.text).join('')).toBe(text);
    for (const cue of cues) expect(cue.text.length).toBeLessThanOrEqual(21);
  });

  it('keeps cues contiguous across the whole span', () => {
    const cues = captionCues('One. Two. Three.', 3);
    expect(cues[0].startSec).toBe(0);
    for (let index = 1; index < cues.length; index += 1) {
      expect(cues[index].startSec).toBe(cues[index - 1].endSec);
    }
    expect(cues.at(-1)?.endSec).toBe(3);
  });

  it('has nothing to show for empty text or no time', () => {
    expect(captionCues('   ', 3)).toEqual([]);
    expect(captionCues('Hello', 0)).toEqual([]);
  });
});

describe('timelineAudioTracks', () => {
  const resolve = (assetId: string) => `/abs/${assetId}`;

  it('places narration at its scene wherever the scene moved to', () => {
    const scenes: VideoManifestV3['scenes'] = [
      { id: 'a', duration: 2, narration: { text: 'First', asset: 'voice' } },
      { id: 'b', duration: 3 },
    ];
    const forward = deriveVideoTimeline(video({ scenes }));
    expect(timelineAudioTracks({ manifest: video({ scenes }), timeline: forward, resolve })).toEqual([
      expect.objectContaining({ absPath: '/abs/voice', startSec: 0, voice: true }),
    ]);
    const moved = video({ scenes: [...scenes].reverse() });
    expect(timelineAudioTracks({ manifest: moved, timeline: deriveVideoTimeline(moved), resolve })).toEqual([
      expect.objectContaining({ absPath: '/abs/voice', startSec: 3, voice: true }),
    ]);
  });

  it('keeps a clip\'s own sound only when asked, from its in point, for its length', () => {
    const manifest = video({
      scenes: [
        { id: 'a', duration: 1 },
        {
          id: 'b',
          clips: [
            { id: 'quiet', asset: 'shot', in: 5, dur: 1 },
            { id: 'loud', asset: 'shot', in: 7, dur: 2, audio: 'keep', volume: 0.8 },
          ],
        },
      ],
    });
    expect(timelineAudioTracks({ manifest, timeline: deriveVideoTimeline(manifest), resolve })).toEqual([
      expect.objectContaining({ absPath: '/abs/shot', startSec: 2, inSec: 7, durSec: 2, volume: 0.8, voice: true }),
    ]);
  });

  it('carries whole-video tracks with their fades and ducking', () => {
    const manifest = video({
      tracks: [{ kind: 'music', asset: 'song', volume: 0.4, fade_in: 1, fade_out: 2, duck: true }],
    });
    expect(timelineAudioTracks({ manifest, timeline: deriveVideoTimeline(manifest), resolve })).toEqual([
      expect.objectContaining({
        absPath: '/abs/song', startSec: 0, volume: 0.4, fadeInSec: 1, fadeOutSec: 2, duck: true,
      }),
    ]);
  });

  it('loops background music while narration and sound effects play once', () => {
    const manifest = video({ tracks: [
      { kind: 'music', asset: 'song', volume: 0.4 },
      { kind: 'narration', asset: 'voice', volume: 1 },
      { kind: 'sfx', asset: 'effect', volume: 1 },
    ] });
    const tracks = timelineAudioTracks({ manifest, timeline: deriveVideoTimeline(manifest), resolve });
    expect(tracks[0]).toMatchObject({ absPath: '/abs/song', loop: true });
    expect(tracks[1].loop).not.toBe(true);
    expect(tracks[2].loop).not.toBe(true);
  });

  it('treats an upgraded whole narration track as voice so music still ducks under it', () => {
    const manifest = video({ tracks: [{ kind: 'narration', asset: 'voice', volume: 1 }] });
    expect(timelineAudioTracks({ manifest, timeline: deriveVideoTimeline(manifest), resolve })[0]).toMatchObject({ voice: true });
  });
});

describe('pictures a page places by file', () => {
  // On 2026-11-07 a launch video showed two site screenshots in a scene through <img src>,
  // so the canvas, which reads pictures from clips, drew no line to them and could not
  // keep them or swap them.
  const production = '/work/launch';
  const videoDir = `${production}/videos/main`;
  const rows: VideoAssetRecord[] = [
    { id: 'shot', kind: 'video', label: 'Shot', path: 'assets/shot.mp4', origin: 'generated' },
    { id: 'r18', kind: 'image', label: 'Site', path: 'videos/main/assets/product/image-r18.png', origin: 'page' },
    { id: 'r13', kind: 'image', label: 'Site', path: 'videos/main/assets/product/image r13.png', origin: 'page' },
    { id: 'logo', kind: 'image', label: 'Logo', path: 'videos/main/assets/logo.png', origin: 'upload' },
    { id: 'old', kind: 'image', label: 'Old', path: 'videos/main/assets/old.png', origin: 'upload' },
    { id: 'voice', kind: 'audio', label: 'Voice', path: 'videos/main/assets/voice.mp3', origin: 'generated' },
  ];
  const manifest = video({ scenes: [
    { id: 'hook', clips: [{ id: 'c1', asset: 'shot', in: 0, dur: 2 }] },
    { id: 'memory', duration: 3 },
  ] });
  // Each look-alike in "memory" points somewhere else: another site, another folder, a sound.
  const PAGE = `<!doctype html><html><head></head><body><main data-composition-id="main">
<img class="logo" src="assets/logo.png">
<section data-scene-id="hook"><img data-clip="c1"></section>
<section data-scene-id="memory">
  <img class="shot one" src="assets/product/image-r18.png">
  <div style="background-image: url('./assets/product/image%20r13.png')"></div>
  <img src="assets/product/image-r18.png?v=2">
  <img src="https://example.com/videos/main/assets/product/image-r18.png">
  <img src="other/image-r18.png">
  <img src="assets/voice.mp3">
</section>
<section data-scene-id="cut"><img src="./assets/old.png"></section>
</main></body></html>`;
  const refsOf = (m: VideoManifestV3) => pagePictureRefs({
    compiled: compileVideoPage({ html: PAGE, manifest: m, product: null, baseHref: `file://${videoDir}/` }),
    assets: rows,
    videoDirAbs: videoDir,
    productionDirAbs: production,
  });
  const fix = 'show it with <img data-clip="id">.';

  it('finds what each scene on the timeline shows by file, and what the page shows around them', () => {
    expect(refsOf(manifest)).toEqual({ shared: ['logo'], scenes: { hook: [], memory: ['r18', 'r13'] } });
    // The scene off the timeline counts once it is back on.
    const restored = video({ scenes: [...manifest.scenes, { id: 'cut', duration: 1 }] });
    expect(refsOf(restored).scenes.cut).toEqual(['old']);
  });

  it('warns once for each scene that does, naming its pictures, and not for the page around them', () => {
    expect(pagePictureIssues(manifest, refsOf(manifest))).toEqual([{
      code: 'PAGE_PICTURE_NOT_A_CLIP',
      severity: 'warning',
      message: 'Scene "memory" places "r18" and "r13" from assets.json straight in its page markup, so the canvas cannot show or swap them. Add each to the scene\'s "clips" and show it with <img data-clip="id">.',
      selector: '[data-scene-id="memory"]',
      source: 'orkas-video-timeline',
      sceneId: 'memory',
    }]);
    expect(pagePictureIssues(manifest, { shared: [], scenes: { memory: ['r18'] } })[0].message).toBe(
      'Scene "memory" places "r18" from assets.json straight in its page markup, so the canvas cannot show or swap it. Add it to the scene\'s "clips" and show it with <img data-clip="id">.',
    );
    expect(pagePictureIssues(manifest, { shared: ['logo'], scenes: { hook: [], memory: [] } })).toEqual([]);
  });

  it('names only as many as leave the fix whole in the reported message', () => {
    const ids = (count: number, length: number) => Array.from({ length: count }, (_, i) => String(i).padStart(length, 'p'));
    // What the model reads is the check's summary, which shortens each message.
    const reported = (memory: string[]) => summarizeCheckWarnings(pagePictureIssues(manifest, { shared: [], scenes: { memory } }))[0].examples[0].message;

    const short = reported(ids(7, 2));
    expect(short).toMatch(/places "p0", "p1"(, "p\d")* and [2-5] more from assets\.json/);
    expect(short.endsWith(fix)).toBe(true);
    const longer = reported(ids(7, 8));
    expect(longer).toContain('places "ppppppp0" and 6 more from assets.json');
    expect(longer.endsWith(fix)).toBe(true);
    // A name that alone would push the fix off is left out, and the count stands in.
    const longest = reported(ids(7, 40));
    expect(longest).toContain('places 7 pictures from assets.json');
    expect(longest.endsWith(fix)).toBe(true);
    expect(reported(ids(1, 40))).toContain('places a picture from assets.json straight in its page markup, so the canvas cannot show or swap it. Add it');
  });
});
