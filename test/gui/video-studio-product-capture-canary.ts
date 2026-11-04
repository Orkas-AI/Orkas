/**
 * product.capture canary — checks that need a real window.
 *
 * The unit suite scripts the page, so layout, region detection, lazy-loaded
 * images, DevTools screenshots at 2x and the isolated session are only real
 * here. A fixture page is served from 127.0.0.1: deterministic, no network.
 *
 * Optional live check (not part of the pass/fail cases):
 *   ORKAS_PRODUCT_CAPTURE_LIVE_URL=https://orkas.ai/?lang=zh \
 *   ORKAS_PRODUCT_CAPTURE_KEEP_DIR=/tmp/capture-out node test/gui/run-product-capture-canary.mjs
 *
 * Exit codes: 0 pass, 1 a case failed, 2 the host could not give us a window.
 */
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { nativeImage } from 'electron';

const CANARY_EXIT_PASS = 0;
const CANARY_EXIT_FAILED = 1;
const CANARY_EXIT_NO_WINDOW = 2;

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgaP0PAAMBAYCF5rUbAAAAAElFTkSuQmCC';

function fixtureHtml(): string {
  const card = (n: number, color: string) => `<div class="card" id="card-${n}" style="background:${color}"><h3>Agent ${n}</h3><p>launch.mp4 · product-copy.md</p></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Capture Fixture — Your AI team</title>
<meta name="description" content="Set a goal. The team delivers.">
<meta name="theme-color" content="#5B57D6">
<link rel="alternate" hreflang="zh-CN" href="/?lang=zh">
<style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #F7F9FC; color: #161A26; }
  header { height: 600px; padding: 80px; box-sizing: border-box; }
  h1 { font-size: 72px; margin: 0; }
  .grid { display: grid; grid-template-columns: repeat(3, 360px); gap: 40px; padding: 80px; }
  .card { height: 260px; border-radius: 16px; box-shadow: 0 12px 40px rgba(0,0,0,.18); padding: 24px; box-sizing: border-box; color: #fff; }
  .lazy { display: block; width: 640px; height: 360px; margin: 80px; }
  footer { height: 1600px; }
</style></head><body>
<header><h1>Scale without hiring</h1><p>Set a goal. The AI team delivers results.</p></header>
<h2 style="margin: 0 80px">Work that keeps moving</h2>
<section class="grid">${card(1, '#5B57D6')}${card(2, '#161A26')}${card(3, '#0F766E')}</section>
<img class="lazy" alt="Lazy hero" loading="lazy" src="/lazy.png">
<footer></footer>
</body></html>`;
}

// Patterns taken from real storefronts and landing pages, not from the
// detector's rules: a region-picker dialog over a dimming backdrop that locks
// scrolling, a consent bar, a fixed top bar, and cards in known colors.
function overlayHtml(): string {
  const card = (n: number, color: string) => `<div class="card" id="o-card-${n}" style="background:${color}"></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Overlay Fixture</title><style>
  html, body { overflow: hidden; }
  body { margin: 0; font-family: system-ui, sans-serif; background: #FFFFFF; }
  nav { position: fixed; top: 0; left: 0; right: 0; height: 64px; background: #111; color: #fff; z-index: 5; }
  main { padding: 140px 80px 1200px; }
  .grid { display: grid; grid-template-columns: repeat(3, 360px); gap: 40px; }
  .card { height: 260px; border-radius: 16px; box-shadow: 0 12px 40px rgba(0,0,0,.18); }
  .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 50; }
  .picker { position: fixed; top: 200px; left: 470px; width: 500px; height: 320px; background: #fff; border-radius: 12px; z-index: 51; box-shadow: 0 20px 60px rgba(0,0,0,.4); }
  .consent { position: fixed; bottom: 0; left: 0; right: 0; height: 120px; background: #222; color: #fff; z-index: 52; }
</style></head><body>
<nav>Brand</nav>
<main><h1>Tree runners</h1><section class="grid">${card(1, '#E11D48')}${card(2, '#0F766E')}${card(3, '#5B57D6')}</section></main>
<div class="backdrop"></div>
<div class="picker" role="dialog" aria-modal="true"><h2>Where are we shipping to?</h2></div>
<div class="consent">We use cookies <button>Accept</button></div>
</body></html>`;
}

// A full-bleed hero painted by a CSS background image, a card that a
// scroll-triggered observer keeps transparent until it enters the viewport,
// and a product video.
function revealHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reveal Fixture</title><style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #F7F9FC; }
  .bar { position: sticky; top: 0; height: 60px; background: #FFB000; z-index: 5; }
  .hero { height: 1000px; background-image: url(/lazy.png); background-size: cover; }
  #swap-wrap { width: 600px; margin: 0 auto 200px; }
  #swap-wrap img { display: block; width: 600px; height: 300px; }
  .spacer { height: 1400px; }
  #reveal { width: 640px; height: 360px; margin: 0 auto; background: #0F766E; border-radius: 16px; opacity: 0; transform: translateY(80px); transition: opacity .2s, transform .2s; }
  #reveal.in { opacity: 1; transform: none; }
  video { display: block; width: 640px; height: 360px; margin: 200px auto 1200px; background: #000; }
</style></head><body>
<div class="bar">Brand</div>
<header class="hero" role="banner"></header>
<div id="swap-wrap"><img id="swap" src="/lazy.png" alt="Carousel slide"></div>
<h1>Watch it work</h1>
<div class="spacer"></div>
<div id="reveal"></div>
<video src="/clip.mp4" poster="/lazy.png" aria-label="Product demo" muted playsinline></video>
<script>
  const io = new IntersectionObserver((entries) => entries.forEach((e) => e.target.classList.toggle('in', e.isIntersecting)), { threshold: 0.4 });
  io.observe(document.getElementById('reveal'));
  // Like a carousel re-initialising: the slide element is replaced on scroll.
  addEventListener('scroll', () => {
    const old = document.getElementById('swap');
    const fresh = old.cloneNode(false);
    fresh.removeAttribute('data-orkas-capture-id');
    old.replaceWith(fresh);
  });
</script>
</body></html>`;
}

async function serveFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === '/poison') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>Untrusted capture facts</title>
        <div style="width:400px;height:240px;border-radius:16px;background:#0F766E">Product</div>
        <script>
          const map = Array.prototype.map;
          Array.prototype.map = function(callback, ...args) {
            const result = map.call(this, callback, ...args);
            for (const value of result) {
              if (value && value.id === 'r01' && value.kind === 'panel') value.id = '../../../../victim';
            }
            return result;
          };
        </script>`);
      return;
    }
    if (req.url === '/redirect') {
      // Language routing that starts while the first document is loading.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><script>location.replace("/?lang=zh")</script><p>redirecting</p>');
      return;
    }
    if (req.url === '/overlay' || req.url === '/reveal') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(req.url === '/overlay' ? overlayHtml() : revealHtml());
      return;
    }
    if (req.url === '/lazy.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from(PIXEL, 'base64'));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fixtureHtml());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

type Capture = typeof import('../../src/main/features/video_studio_product_capture');

async function pngSize(file: string): Promise<{ width: number; height: number }> {
  return nativeImage.createFromBuffer(await fs.readFile(file)).getSize();
}

/** Color at a point of a saved crop (fractions of its size), as #RRGGBB. */
async function colorAt(file: string, fx: number, fy: number): Promise<string> {
  const image = nativeImage.createFromBuffer(await fs.readFile(file));
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  const at = (Math.min(height - 1, Math.floor(height * fy)) * width + Math.min(width - 1, Math.floor(width * fx))) * 4;
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(bitmap[at + 2])}${hex(bitmap[at + 1])}${hex(bitmap[at])}`.toUpperCase();
}
const centerColor = (file: string) => colorAt(file, 0.5, 0.5);
const near = (a: string, b: string) => [1, 3, 5].every((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= 12);

export async function main(): Promise<number> {
  const capture = await import('../../src/main/features/video_studio_product_capture') as Capture;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-product-capture-canary-'));
  const fixture = await serveFixture();
  let failed = 0;
  const check = async (name: string, run: () => Promise<string[]>) => {
    let failures: string[];
    try { failures = await run(); } catch (err) { failures = [`threw: ${(err as Error).message}`]; }
    if (failures.length) {
      failed += 1;
      process.stdout.write(`FAIL ${name}\n`);
      for (const reason of failures) process.stdout.write(`     ${reason}\n`);
    } else {
      process.stdout.write(`ok   ${name}\n`);
    }
  };
  try {
    const compositionDir = path.join(root, 'auto', 'composition');
    await fs.mkdir(compositionDir, { recursive: true });
    const auto = await capture.captureProductSource({ url: fixture.url, compositionDirAbs: compositionDir, writeRoots: [root] });
    if (!auto.ok && auto.errorCode === 'E_PRODUCT_CAPTURE_UNAVAILABLE') {
      process.stderr.write('[product-capture-canary] no usable window on this host; run it in a GUI Electron session.\n');
      return CANARY_EXIT_NO_WINDOW;
    }

    await check('auto capture saves the cards and the lazy image as 2x crops', async () => {
      if (!auto.ok) return [`capture failed: ${auto.errorCode} ${auto.message}`];
      const report = auto as any;
      const failures: string[] = [];
      if (report.page.title !== 'Capture Fixture — Your AI team') failures.push(`title ${report.page.title}`);
      if (report.page.theme_color !== '#5B57D6') failures.push(`theme ${report.page.theme_color}`);
      const cards = report.images.filter((image: any) => /^div\.card$|#card-/.test(image.selector_hint || ''));
      if (cards.length !== 3) failures.push(`expected 3 card regions, got ${JSON.stringify(report.images.map((i: any) => i.selector_hint))}`);
      for (const card of cards) {
        const size = await pngSize(path.join(compositionDir, card.path));
        if (size.width !== 720 || size.height !== 520) failures.push(`${card.id} is ${size.width}x${size.height}, expected 720x520`);
      }
      const lazy = report.images.find((image: any) => image.label === 'Lazy hero');
      if (!lazy) failures.push('lazy-loaded image below the fold was not captured');
      const tiles = report.tiles.map((tile: any) => tile.height);
      if (tiles.reduce((a: number, b: number) => a + b, 0) !== report.page.height_css) failures.push(`tiles ${tiles} do not cover ${report.page.height_css}`);
      const first = await pngSize(path.join(compositionDir, report.tiles[0].path));
      if (first.width !== 1440) failures.push(`page tiles should be 1x (1440 wide), got ${first.width}`);
      const words = await fs.readFile(path.join(compositionDir, report.text_path), 'utf8');
      if (!words.includes('## Work that keeps moving')) failures.push('headings missing from page-text.md');
      const overview = await pngSize(path.join(compositionDir, report.overview_path));
      if (overview.width < 800) failures.push(`overview too small: ${overview.width}`);
      return failures;
    });

    await check('requested selectors and clips produce exactly those crops', async () => {
      const dir = path.join(root, 'clips', 'composition');
      await fs.mkdir(dir, { recursive: true });
      const result = await capture.captureProductSource({
        url: fixture.url, compositionDirAbs: dir, writeRoots: [root],
        selectors: ['#card-2', '.does-not-exist'],
        clips: [{ id: 'headline', x: 60, y: 60, width: 900, height: 200 }],
      });
      if (!result.ok) return [`capture failed: ${result.errorCode} ${result.message}`];
      const report = result as any;
      const failures: string[] = [];
      const ids = report.images.map((image: any) => image.id);
      if (JSON.stringify(ids) !== JSON.stringify(['headline', 'sel-01'])) failures.push(`ids ${ids}`);
      const headline = await pngSize(path.join(dir, report.images[0].path));
      if (headline.width !== 1800 || headline.height !== 400) failures.push(`headline ${headline.width}x${headline.height}`);
      if (report.skipped?.[0]?.id !== 'sel-02') failures.push(`skipped ${JSON.stringify(report.skipped)}`);
      return failures;
    });

    await check('a page that redirects itself while loading is captured where it lands', async () => {
      const dir = path.join(root, 'redirect', 'composition');
      await fs.mkdir(dir, { recursive: true });
      const result = await capture.captureProductSource({ url: `${fixture.url}redirect`, compositionDirAbs: dir, writeRoots: [root] });
      if (!result.ok) return [`capture failed: ${result.errorCode} ${result.message}`];
      const report = result as any;
      const failures: string[] = [];
      if (report.final_url !== `${fixture.url}?lang=zh`) failures.push(`final_url ${report.final_url}`);
      if (report.page.title !== 'Capture Fixture — Your AI team') failures.push(`title ${report.page.title}`);
      if (JSON.stringify(report.alternates) !== JSON.stringify([{ hreflang: 'zh-CN', href: `${fixture.url}?lang=zh` }])) {
        failures.push(`alternates ${JSON.stringify(report.alternates)}`);
      }
      return failures;
    });

    await check('overlays are hidden: cards keep their true colors and no dialog is saved as a region', async () => {
      const dir = path.join(root, 'overlay', 'composition');
      await fs.mkdir(dir, { recursive: true });
      const result = await capture.captureProductSource({ url: `${fixture.url}overlay`, compositionDirAbs: dir, writeRoots: [root] });
      if (!result.ok) return [`capture failed: ${result.errorCode} ${result.message}`];
      const report = result as any;
      const failures: string[] = [];
      const reasons = report.hidden_overlays.map((o: any) => o.reason);
      for (const reason of ['backdrop', 'dialog', 'fixed_overlay']) if (!reasons.includes(reason)) failures.push(`overlay ${reason} not reported: ${JSON.stringify(report.hidden_overlays)}`);
      if (report.images.some((image: any) => /shipping|cookies/i.test(image.label))) failures.push('an overlay was saved as a region');
      const expected: Record<string, string> = { 'o-card-1': '#E11D48', 'o-card-2': '#0F766E', 'o-card-3': '#5B57D6' };
      for (const [id, color] of Object.entries(expected)) {
        const image = report.images.find((i: any) => i.selector_hint === `#${id}`);
        if (!image) { failures.push(`${id} not captured`); continue; }
        const got = await centerColor(path.join(dir, image.path));
        if (!near(got, color)) failures.push(`${id} is ${got}, expected ${color} (dimmed or covered)`);
      }
      return failures;
    });

    await check('a scroll-revealed card, a background-image hero and a video are captured as they appear in view', async () => {
      const dir = path.join(root, 'reveal', 'composition');
      await fs.mkdir(dir, { recursive: true });
      const result = await capture.captureProductSource({ url: `${fixture.url}reveal`, compositionDirAbs: dir, writeRoots: [root] });
      if (!result.ok) return [`capture failed: ${result.errorCode} ${result.message}`];
      const report = result as any;
      const failures: string[] = [];
      const hero = report.images.find((i: any) => i.kind === 'background');
      if (!hero || hero.page_rect.height !== 1000) failures.push(`background hero missing: ${JSON.stringify(report.images.map((i: any) => [i.kind, i.selector_hint, i.page_rect]))}`);
      const card = report.images.find((i: any) => i.selector_hint === '#reveal');
      if (!card) failures.push('scroll-revealed card not captured');
      else {
        const got = await centerColor(path.join(dir, card.path));
        if (!near(got, '#0F766E')) failures.push(`revealed card is ${got}, expected #0F766E (captured before it appeared)`);
      }
      if (!report.videos?.[0]?.src?.endsWith('/clip.mp4')) failures.push(`video not listed: ${JSON.stringify(report.videos)}`);
      if (!report.images.some((i: any) => i.selector_hint === '#swap')) failures.push(`a slide replaced on scroll was skipped: ${JSON.stringify(report.skipped)}`);
      if (hero) {
        const top = await colorAt(path.join(dir, hero.path), 0.5, 0.02);
        if (near(top, '#FFB000')) failures.push('the sticky bar covers the top of the hero crop');
      }
      return failures;
    });

    await check('an unreachable page fails cleanly without leaving files', async () => {
      const dir = path.join(root, 'dead', 'composition');
      await fs.mkdir(dir, { recursive: true });
      const closed = http.createServer();
      await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
      const deadUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}/`;
      await new Promise((resolve) => closed.close(resolve));
      // Retain the native negative-control diagnostic. The launcher attributes
      // only this exact closed loopback endpoint after the functional case passes.
      process.stdout.write(`[product-capture-canary] expected closed endpoint ${deadUrl}\n`);
      const result = await capture.captureProductSource({ url: deadUrl, compositionDirAbs: dir, writeRoots: [root] });
      const failures: string[] = [];
      if (result.ok) failures.push('expected a load failure');
      const left = await fs.readdir(path.join(dir, 'assets', 'product')).catch(() => []);
      if (left.length) failures.push(`left ${left.join(',')}`);
      return failures;
    });

    await check('a page that alters capture facts cannot overwrite a file outside its capture folder', async () => {
      const dir = path.join(root, 'poison', 'composition');
      await fs.mkdir(dir, { recursive: true });
      const victim = path.join(root, 'poison', 'victim.png');
      const original = 'Existing workspace bytes must survive an untrusted page.';
      await fs.writeFile(victim, original);
      const result = await capture.captureProductSource({ url: `${fixture.url}poison`, compositionDirAbs: dir, writeRoots: [dir] });
      const failures: string[] = [];
      if (result.ok || result.errorCode !== 'E_PRODUCT_CAPTURE_READ') failures.push('tampered page facts were not rejected');
      if ((await fs.readFile(victim)).toString() !== original) failures.push('the page overwrote a file outside its writable composition');
      const left = await fs.readdir(path.join(dir, 'assets', 'product')).catch(() => []);
      if (left.length) failures.push('a rejected page left a partial capture');
      return failures;
    });

    const liveUrl = process.env.ORKAS_PRODUCT_CAPTURE_LIVE_URL;
    const keepDir = process.env.ORKAS_PRODUCT_CAPTURE_KEEP_DIR;
    if (liveUrl && keepDir) {
      await fs.mkdir(keepDir, { recursive: true });
      const started = Date.now();
      const live = await capture.captureProductSource({ url: liveUrl, compositionDirAbs: keepDir, writeRoots: [keepDir] });
      process.stdout.write(`[product-capture-canary] live ${liveUrl}: ${live.ok ? `ok ${(live as any).capture_dir} images=${(live as any).images.length}` : `${live.errorCode} ${live.message}`} in ${Date.now() - started}ms\n`);
    }
    process.stdout.write(`[product-capture-canary] ${failed ? `${failed} failed` : 'all cases passed'}\n`);
    return failed ? CANARY_EXIT_FAILED : CANARY_EXIT_PASS;
  } finally {
    await fixture.close();
    await fs.rm(root, { recursive: true, force: true }).catch(() => { /* temp root */ });
  }
}
