import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { expect, OrkasTestApp, test as base } from './fixtures/orkas';

const test = base.extend<{ softwareRendering: boolean }>({
  softwareRendering: [false, { option: true }],
  orkas: async ({ softwareRendering }, use, testInfo) => {
    const app = new OrkasTestApp(testInfo, { softwareRendering });
    try { await app.launch(); await use(app); } finally { await app.dispose(); }
  },
});

const colors = ['#ed1732', '#14cf52', '#195def'];
const sceneIds = ['red', 'green', 'blue'];

// A reduced production failure: a masked grid causes capturePage in a hidden
// on-screen window to return the previous scene, even after seek + two RAFs.
// Check delivered pixels, independently of DOM evidence and QA's own verdict.
function writeComposition(dir: string) {
  mkdirSync(path.join(dir, 'assets', 'vendor'), { recursive: true });
  copyFileSync(path.resolve(__dirname,
    '../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/stage-compose/scripts/vendor/gsap.min.js'),
  path.join(dir, 'assets', 'vendor', 'gsap.min.js'));
  writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html><head>
    <script src="./assets/vendor/gsap.min.js"></script><style>
    html,body{margin:0;width:1920px;height:1080px;overflow:hidden}
    main{position:relative;width:100%;height:100%}
    .clip{position:absolute;inset:0;opacity:0;visibility:hidden}
    .clip::before{content:"";position:absolute;inset:0;
      background-image:linear-gradient(rgba(242,165,26,.08) 1px,transparent 1px),linear-gradient(90deg,rgba(242,165,26,.06) 1px,transparent 1px);
      background-size:64px 64px;mask-image:radial-gradient(circle at 65% 35%,black,transparent 72%)}
    h1{position:relative;z-index:2;color:white;font:96px sans-serif;margin:120px}
    </style></head><body><main data-composition-id="main" data-start="0" data-duration="3" data-width="1920" data-height="1080">
    ${sceneIds.map((id, i) => `<section class="clip" data-scene-id="${id}" data-start="${i}" data-duration="1" data-track-index="1" style="background:${colors[i]}"><h1 data-role="title">${id} chapter</h1></section>`).join('')}
    </main><script>
    const tl=gsap.timeline({paused:true});window.__timelines={};window.__timelines['main']=tl;
    document.querySelectorAll('.clip').forEach((e,i)=>{
      const start=Number(e.dataset.start),end=start+Number(e.dataset.duration);
      tl.set(e,{autoAlpha:1},start);if(i<2)tl.set(e,{autoAlpha:0},end);
      tl.from(e.querySelector('h1'),{x:90,scale:.97,duration:.5},start+.1);
    });</script></body></html>`);
  writeFileSync(path.join(dir, 'composition-manifest.json'), JSON.stringify({
    schema_version: 1,
    composition: { id: 'main', width: 1920, height: 1080, duration: 3, fps: 10, language: 'en' },
    scenes: sceneIds.map((id, i) => ({ id, start: i, duration: 1, approved_copy: [`${id} chapter`],
      narration_refs: [], source_shots: [], roles: ['title'] })),
    audio: { owner: 'none', tracks: [] },
    art_direction: {
      aesthetic: { subject_world: 'three colored chapters', one_job: 'identify the current chapter',
        signature_device: 'full field chapter color', aesthetic_risk: 'color must follow scene time',
        anti_template_check: 'each chapter has its own distinct full field color' },
      visual_direction: { visual_tradition: 'color field typography',
        lazy_defaults_rejected: 'distinct full field colors instead of repeated cards',
        video_scale: { hero_title_min_px: 88, label_min_px: 28, safe_zone_px: { left: 120, right: 120, top: 90, bottom: 90 } },
        depth_layer_rule: 'color field, masked grid, chapter heading',
        motion_verb_rule: ['reveal', 'hold'], rhythm_pattern: 'three equal chapters' },
      cover: { scene_id: 'red', headline: 'red chapter', content_signals: ['red', 'chapter'],
        hero_visual: 'red field', composition_strategy: 'chapter heading on its color field', frame_time_sec: 0 },
      scenes: sceneIds.map((id, i) => ({ id, start: i, duration: 1, scene_world: `${id} field`,
        hero_visual: `${id} chapter`, depth_layers: ['field', 'grid', 'heading'], motion_verbs: ['reveal', 'hold'] })),
      layout_boxes: { safe_margin: 96, visual_zone: 'full field' },
      typography_tokens: { title: '96px', body: '32px', label: '28px' },
      color_tokens: { red: colors[0], green: colors[1], blue: colors[2] },
      motion_budget: { rule: 'chapter reveal then hold' }, scene_variation: { rule: 'change chapter color' },
    },
  }));
}

async function expectColor(file: string, color: string, encoded = false) {
  // Away from text/grid strokes. Encoding may convert the display color
  // profile; assert chapter identity by dominant channel, not exact RGB.
  const pixel = await sharp(file).extract({ left: 350, top: 350, width: 1, height: 1 }).raw().toBuffer();
  const expected = Buffer.from(color.slice(1), 'hex');
  if (encoded) {
    const channel = colors.indexOf(color);
    for (let c = 0; c < 3; c++) if (c !== channel) expect(pixel[channel] - pixel[c], path.basename(file)).toBeGreaterThan(70);
    return;
  }
  for (let c = 0; c < 3; c++) expect(Math.abs(pixel[c] - expected[c]), path.basename(file)).toBeLessThan(8);
}

for (const softwareRendering of [true, false]) test.describe(softwareRendering ? 'software compositor' : 'default compositor', () => {
  test.use({ softwareRendering });
  test('preview seeks and encoded scene transitions show the requested scene pixels', async ({ orkas }, testInfo) => {
    test.setTimeout(120_000);
    const dir = testInfo.outputPath('composition');
    writeComposition(dir);
    const nativeModule = path.resolve(__dirname, '../../src/main/features/video_studio.ts');
    const times = [0, .5, 1.5, 2.5, .5, 2.5];
    const preview = await orkas.electronApp!.evaluate(async (_electron, args) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      return require(args.module).snapshotComposition({ compositionDirAbs: args.dir,
        snapshotAbsPath: require('node:path').join(args.dir, 'preview', 'first.png'),
        frameSampleTimes: args.times.map((timeSec: number, i: number) => ({ label: i === 0 ? 'first-frame' : `seek-${i}`, timeSec,
          sceneId: args.sceneIds[Math.floor(timeSec)] })),
      });
    }, { module: nativeModule, dir, times, sceneIds });
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    const samples = preview.frame_evidence?.samples;
    expect(samples).toHaveLength(times.length);
    for (let i = 0; i < times.length; i++) await expectColor(samples[i].path, colors[Math.floor(times[i])]);

    const output = testInfo.outputPath('render.mp4');
    const rendered = await orkas.electronApp!.evaluate(async (_electron, args) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      return require(args.module).renderComposition({ compositionDirAbs: args.dir, outputAbsPath: args.output,
        fps: 10, allowFpsFallback: false, format: 'mp4' });
    }, { module: nativeModule, dir, output });
    expect(rendered.ok, JSON.stringify(rendered)).toBe(true);
    // Decode the encoded file, not the same capture buffer used by the producer.
    const decoded = await orkas.electronApp!.evaluate(async (_electron, args) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      const { ffmpeg } = require(args.binsModule).bundledFfmpegPaths();
      const pattern = require('node:path').join(args.dir, 'decoded-%02d.png');
      await new Promise<void>((resolve, reject) => require('node:child_process').execFile(ffmpeg,
        ['-hide_banner', '-loglevel', 'error', '-y', '-i', args.output, '-vf', 'select=eq(n\\,0)+eq(n\\,10)+eq(n\\,20)', '-vsync', '0', pattern],
        { timeout: 30000, windowsHide: true }, (error: Error | null) => error ? reject(error) : resolve()));
      return [1, 2, 3].map(i => pattern.replace('%02d', String(i).padStart(2, '0')));
    }, { binsModule: path.resolve(__dirname, '../../src/main/util/bundled-runtime.ts'), dir, output });
    for (let i = 0; i < colors.length; i++) await expectColor(decoded[i], colors[i], true);
  });
});

// A child entrance must finish visible whether a reviewer jumps straight to a
// scene or visits earlier scenes first. Exercise the actual generated scaffold:
// staggered entrances inherited hidden visibility as an inferred end opacity of 0.
test.describe('scaffold child motion', () => {
  test.use({ softwareRendering: true });
  test('child entrances survive sequential and backward seeks without overriding authored exits', async ({ orkas }, testInfo) => {
    test.setTimeout(120_000);
    const dir = testInfo.outputPath('composition');
    writeComposition(dir);
    const samples = await orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      const fs = require('node:fs');
      const path = require('node:path');
      const manifest = JSON.parse(fs.readFileSync(path.join(args.dir, 'composition-manifest.json'), 'utf8'));
      const htmlPath = path.join(args.dir, 'index.html');
      const html = require(args.contract).buildCompositionScaffold(manifest)
        .replace('</style>', `.clip { background: #195def; }
          [data-role="visual"] { position:absolute; left:800px; top:400px; width:200px; height:200px; background:white; }
          </style>`)
        .replace('// ORKAS-SCENE-MOTION-BEGIN:red',
          "tl.to('#scene-red [data-role=visual]', {autoAlpha:0, duration:.2}, .1);")
        .replace('// ORKAS-SCENE-MOTION-BEGIN:green',
          "tl.from('#scene-green [data-role=visual]', {y:30, autoAlpha:.55, duration:.2, stagger:.05}, 1.1);")
        .replace('// ORKAS-SCENE-MOTION-BEGIN:blue',
          "tl.from('#scene-blue [data-role=visual]', {y:30, autoAlpha:.55, duration:.2, stagger:.05}, 2.1);");
      fs.writeFileSync(htmlPath, html);
      const results: {time: number; path: string; opacity: number; visibility: string;
        x: number; y: number; viewportWidth: number; viewportHeight: number}[] = [];
      for (const times of [[1.5], [0, .5, 1.5, 2.5, .5, 1.5]]) {
        const win = new BrowserWindow({ show:false, width:1920, height:1080, useContentSize:true,
          webPreferences: { offscreen:true, nodeIntegration:false, contextIsolation:true, sandbox:true } });
        try {
          await win.loadFile(htmlPath);
          await win.webContents.executeJavaScript(require(args.native).buildTimelineAdapterScript({
            htmlPath, html, rootAttrs:{}, id:'main', width:1920, height:1080, durationSec:3, audioTracks:[],
          }));
          for (const time of times) {
            await win.webContents.executeJavaScript(`window.__ORKAS_VIDEO__.seek(${time})`);
            win.webContents.invalidate();
            await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>setTimeout(()=>requestAnimationFrame(r),0)))');
            const state = await win.webContents.executeJavaScript(`(() => {
              const node=document.querySelector('#scene-${['red','green','blue'][Math.floor(time)]} [data-role="visual"]');
              const style=getComputedStyle(node), rect=node.getBoundingClientRect();
              return {opacity:Number(style.opacity), visibility:style.visibility,
                x:rect.left+rect.width/2, y:rect.top+rect.height/2,
                viewportWidth:innerWidth, viewportHeight:innerHeight};
            })()`);
            const png = path.join(args.dir, `child-${results.length}.png`);
            fs.writeFileSync(png, (await win.webContents.capturePage()).toPNG());
            results.push({time, path:png, ...state});
          }
        } finally { win.destroy(); }
      }
      return results;
    }, { dir, contract:path.resolve(__dirname, '../../src/main/features/video_studio_contract.ts'),
      native:path.resolve(__dirname, '../../src/main/features/video_studio.ts') });
    expect(samples).toHaveLength(7);
    for (const sample of samples) {
      const visible = sample.time !== .5;
      expect(sample.opacity, `child at ${sample.time}s`).toBe(visible ? 1 : 0);
      expect(sample.visibility === 'hidden').toBe(!visible);
      const image = sharp(sample.path);
      const metadata = await image.metadata();
      const left = Math.floor(sample.x * Number(metadata.width) / sample.viewportWidth);
      const top = Math.floor(sample.y * Number(metadata.height) / sample.viewportHeight);
      const pixel = await image.extract({left,top,width:1,height:1}).raw().toBuffer();
      const expected = visible ? [255,255,255] : [25,93,239];
      for (let c=0;c<3;c++) expect(Math.abs(pixel[c]-expected[c]), sample.path).toBeLessThan(8);
    }
  });
});
