import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadCompositionMeta } from '../../../src/main/features/video_studio';

const VENDOR_DIR = path.join(
  __dirname, '../../../resources/builtin/marketplace/agents/79df9cc89f5f',
  'skills/video-studio/assets/vendor',
);

const page = (scripts: string[]) => `<!doctype html><html><head>${scripts.map((src) => `<script src="${src}"></script>`).join('')}</head>
<body><main data-composition-id="main" data-width="1080" data-height="1920" data-duration="2"><section data-scene-id="a"></section></main></body></html>`;

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  dirs = [];
});

async function composition(html: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-video-vendor-'));
  dirs.push(dir);
  await fs.writeFile(path.join(dir, 'index.html'), html, 'utf8');
  return dir;
}

describe('page scripts VideoStudio provides', () => {
  it('prepares the screen demo helper next to GSAP when a page references it', async () => {
    const dir = await composition(page(['./assets/vendor/gsap.min.js', './assets/vendor/screen-demo.js']));
    const { issues } = await loadCompositionMeta(dir);
    expect(issues.filter((issue) => /RESOURCE|VENDOR/.test(issue.code))).toEqual([]);
    const copied = await fs.readFile(path.join(dir, 'assets/vendor/screen-demo.js'), 'utf8');
    expect(copied).toBe(await fs.readFile(path.join(VENDOR_DIR, 'screen-demo.js'), 'utf8'));
    await expect(fs.stat(path.join(dir, 'assets/vendor/gsap.min.js'))).resolves.toBeTruthy();
  });

  it('keeps an edited copy and does not hold it to the GSAP API check', async () => {
    const dir = await composition(page(['./assets/vendor/screen-demo.js']));
    await fs.mkdir(path.join(dir, 'assets/vendor'), { recursive: true });
    await fs.writeFile(path.join(dir, 'assets/vendor/screen-demo.js'), '/* edited */', 'utf8');
    const { issues } = await loadCompositionMeta(dir);
    expect(issues.filter((issue) => /RESOURCE|VENDOR/.test(issue.code))).toEqual([]);
    expect(await fs.readFile(path.join(dir, 'assets/vendor/screen-demo.js'), 'utf8')).toBe('/* edited */');
  });

  it('still reports a vendor script it does not provide', async () => {
    const dir = await composition(page(['./assets/vendor/other-helper.js']));
    const { issues } = await loadCompositionMeta(dir);
    expect(issues.map((issue) => issue.code)).toContain('LOCAL_RESOURCE_MISSING');
    await expect(fs.stat(path.join(dir, 'assets/vendor/other-helper.js'))).rejects.toThrow();
  });
});

describe('what product.capture said its pictures are', () => {
  it('keeps it by the bytes, so a crop copied out of the capture folder is still known', async () => {
    const { capturedPictureKinds } = await import('../../../src/main/features/video_timeline_render');
    const { sha256OfFileStream } = await import('../../../src/main/util/sha256');
    const production = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-video-capture-kinds-'));
    dirs.push(production);
    const capture = path.join(production, 'videos', 'main', 'assets', 'product', 'shop-1');
    await fs.mkdir(capture, { recursive: true });
    const files: Record<string, string> = { 'page-01.jpg': 'tile', 'image-r01.png': 'photo', 'image-r02.png': 'ui', 'image-r03.png': 'words' };
    for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(capture, name), body);
    await fs.writeFile(path.join(capture, 'capture.json'), JSON.stringify({
      tiles: [{ path: 'assets/product/shop-1/page-01.jpg' }],
      images: [
        { path: 'assets/product/shop-1/image-r01.png', content: 'media' },
        { path: 'assets/product/shop-1/image-r02.png', content: 'panel_ui' },
        { path: 'assets/product/shop-1/image-r03.png', content: 'text' },
      ],
    }));
    const kinds = await capturedPictureKinds(production);
    const sha = (name: string) => sha256OfFileStream(path.join(capture, name));
    expect(kinds.get(await sha('page-01.jpg'))).toBe(true);
    expect(kinds.get(await sha('image-r01.png'))).toBe(false);
    expect(kinds.get(await sha('image-r02.png'))).toBe(true);
    // A card of words is neither: the picture itself decides.
    expect(kinds.has(await sha('image-r03.png'))).toBe(false);
  });

  it('says what looks like a screen when pictures arrive, as a question', async () => {
    const { importedScreensMessage } = await import('../../../src/main/model/core-agent/video-timeline-tool');
    expect(importedScreensMessage(['01'])).toMatch(/^01 looks like a screen of a site or app\. .*screen-demo\.js .*A photograph needs none of this\.$/);
    expect(importedScreensMessage(['01', '02'])).toMatch(/^01, 02 look like screens of a site or app\./);
  });
});
