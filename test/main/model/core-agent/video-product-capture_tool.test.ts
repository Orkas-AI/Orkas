import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

// A scripted page stands in for Chromium: the test owns the facts the page
// reports and returns a solid image for every requested screenshot rectangle.
const page = vi.hoisted(() => ({
  facts: null as unknown,
  url: 'https://example.com/',
  screenshots: [] as Array<{ format: string; clip: { x: number; y: number; width: number; height: number; scale: number } }>,
  /** Photographic detail that PNG cannot compress, unlike the solid default. */
  incompressibleCrops: false,
  cropBytes: [] as Buffer[],
  partitions: [] as string[],
  loadError: null as Error | null,
  redirectTo: '' as string,
  destroyed: 0,
  deniedPopups: 0,
  targetCalls: 0,
  lateOverlays: [] as Array<{ reason: string; selector_hint: string; label: string }>,
}));

vi.mock('electron', () => {
  class FakeBrowserWindow {
    private destroyedFlag = false;
    webContents = {
      debugger: {
        attached: false,
        attach() { this.attached = true; },
        detach() { this.attached = false; },
        isAttached() { return this.attached; },
        async sendCommand(method: string, params: any) {
          if (method !== 'Page.captureScreenshot') return {};
          page.screenshots.push({ format: params.format, clip: params.clip });
          const width = Math.max(1, Math.round(params.clip.width * params.clip.scale * 2));
          const height = Math.max(1, Math.round(params.clip.height * params.clip.scale * 2));
          if (params.format === 'png' && page.incompressibleCrops) {
            const noise = await sharp(crypto.randomBytes(width * height * 3), { raw: { width, height, channels: 3 } })
              .png({ compressionLevel: 1 }).toBuffer();
            page.cropBytes.push(noise);
            return { data: noise.toString('base64') };
          }
          const image = sharp({ create: { width, height, channels: 3, background: { r: 91, g: 87, b: 214 } } });
          const data = params.format === 'jpeg' ? await image.jpeg().toBuffer() : await image.png().toBuffer();
          return { data: data.toString('base64') };
        },
      },
      setWindowOpenHandler(handler: () => { action: string }) { if (handler().action === 'deny') page.deniedPopups += 1; },
      on() {},
      setAudioMuted() {},
      // Scripts are told apart by their marker comment: tiles report the
      // scroll offset, targets report the element's rect after scrolling.
      async executeJavaScript(code: string) {
        if (code.includes('orkas-capture:tile')) return Number(/scrollTo\(0, (\d+)\)/.exec(code)?.[1] || 0);
        if (code.includes('orkas-capture:target')) {
          const facts = page.facts as any;
          const id = /data-orkas-capture-id="([^"]+)"/.exec(code)?.[1];
          const fixed = /const fixed = (\{[^\n]*\});/.exec(code)?.[1];
          const rect = (id && [...facts.regions, ...facts.selector_rects].find((r: any) => r.id === id))
            || (fixed && fixed !== 'null' ? JSON.parse(fixed) : null);
          const box = rect ? { x: rect.x ?? rect.rect?.x, y: rect.y ?? rect.rect?.y, width: rect.width ?? rect.rect?.width, height: rect.height ?? rect.rect?.height } : null;
          page.targetCalls += 1;
          return { rect: box, scroll_y: box ? Math.max(0, box.y - 100) : 0, hidden_overlays: page.lateOverlays.splice(0) };
        }
        return page.facts;
      },
      getURL() { return page.url; },
      isDestroyed() { return false; },
      isLoading() { return false; },
      once() {},
    };
    constructor(public options: any) {}
    setContentSize() {}
    async loadURL() {
      if (page.loadError) throw page.loadError;
      if (page.redirectTo) {
        page.url = page.redirectTo;
        throw Object.assign(new Error(`ERR_ABORTED (-3) loading '${page.url}'`), { code: 'ERR_ABORTED', errno: -3 });
      }
    }
    isDestroyed() { return this.destroyedFlag; }
    destroy() { if (!this.destroyedFlag) page.destroyed += 1; this.destroyedFlag = true; }
  }
  return {
    BrowserWindow: FakeBrowserWindow,
    session: {
      fromPartition(name: string) {
        page.partitions.push(name);
        return { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} };
      },
    },
  };
});

const UID = 'product-capture';
let root: string;
let previousRoot: string | undefined;
let workspace: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-product-capture-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  (await import('../../../../src/main/features/users')).activateUser(UID);
  workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  (await import('../../../../src/main/features/user_workspace')).setWorkspacePath(UID, workspace);
  Object.assign(page, {
    url: 'https://example.com/',
    screenshots: [],
    incompressibleCrops: false,
    cropBytes: [],
    partitions: [],
    loadError: null,
    redirectTo: '',
    destroyed: 0,
    deniedPopups: 0,
    targetCalls: 0,
    lateOverlays: [{ reason: 'fixed_overlay', selector_hint: 'div.newsletter', label: 'Subscribe' }],
    facts: {
      title: 'Example — Your AI team',
      description: 'Set a goal. The team delivers.',
      lang: 'en',
      theme_color: '#5B57D6',
      height: 2400,
      headings: [{ level: 1, text: 'Scale without hiring', y: 120 }, { level: 2, text: 'Work that keeps moving', y: 1300 }],
      text: 'Scale without hiring\nWork that keeps moving inside your project',
      regions: [
        { id: 'r01', kind: 'panel', content: 'panel_media', label: 'VideoStudio launch.mp4', selector_hint: 'div.oks-ui', x: 635, y: 1235, width: 653, height: 447 },
        { id: 'r02', kind: 'image', content: 'media', label: 'hero poster', selector_hint: 'img.hero', x: 291, y: 444, width: 858, height: 482 },
      ],
      selector_rects: [],
      alternates: [
        { hreflang: 'zh-CN', href: 'https://example.com/?lang=zh' },
        { hreflang: 'x-default', href: 'javascript:alert(1)' },
      ],
      hidden_overlays: [{ reason: 'backdrop', selector_hint: 'div.modal-backdrop', label: '' }, { reason: 'dialog', selector_hint: 'div.region-picker', label: 'Where are we shipping to?' }],
      videos: [
        { src: 'https://example.com/demo.mp4', poster: 'https://example.com/demo.jpg', label: 'Product demo', x: 120, y: 900, width: 1200, height: 675 },
        { src: 'javascript:alert(1)', poster: '', label: 'bad', x: 0, y: 0, width: 400, height: 300 },
      ],
    },
  });
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

async function tool() {
  return (await import('../../../../src/main/model/core-agent/video-studio-tool')).createVideoStudioTool({
    userId: UID, cid: 'current-chat',
  } as any);
}
const ctx = () => ({ workingDir: workspace, state: {} } as any);
function body(result: any) { return JSON.parse(result.content); }

describe('product.capture input normalization', () => {
  it('accepts only credential-free http(s) pages and bounded page rectangles', async () => {
    const capture = await import('../../../../src/main/features/video_studio_product_capture');
    expect(capture.normalizeProductCaptureUrl('https://orkas.ai/?lang=zh')).toBe('https://orkas.ai/?lang=zh');
    for (const bad of ['file:///etc/hosts', 'javascript:alert(1)', 'https://user:pw@orkas.ai/', '', 42]) {
      expect(capture.normalizeProductCaptureUrl(bad)).toBeNull();
    }
    expect(capture.normalizeProductCaptureClips([{ x: 10.4, y: 20, width: 300, height: 200 }]))
      .toEqual({ clips: [{ id: 'clip-01', x: 10, y: 20, width: 300, height: 200 }] });
    expect(capture.normalizeProductCaptureClips([{ x: 1400, y: 0, width: 100, height: 100 }])).toHaveProperty('error');
    expect(capture.normalizeProductCaptureClips([{ x: 0, y: 0, width: 100, height: 3001 }])).toHaveProperty('error');
    expect(capture.normalizeProductCaptureClips([{ id: 'a', x: 0, y: 0, width: 50, height: 50 }, { id: 'A', x: 0, y: 60, width: 50, height: 50 }]))
      .toHaveProperty('error');
    expect(capture.normalizeProductCaptureClips(new Array(13).fill({ x: 0, y: 0, width: 50, height: 50 }))).toHaveProperty('error');
    expect(capture.normalizeProductCaptureSelectors(['.oks-ui', ' #hero '])).toEqual({ selectors: ['.oks-ui', '#hero'] });
    expect(capture.normalizeProductCaptureSelectors([''])).toHaveProperty('error');
  });
});

describe('product.capture through the real tool', () => {
  it('returns cancellation and removes partial assets when cancelled during overview encoding', async () => {
    const controller = new AbortController();
    const runtime = await import('../../../../src/main/util/sharp-runtime');
    const encode = runtime.encodeImage;
    const encoding = vi.spyOn(runtime, 'encodeImage').mockImplementationOnce(async (...args) => {
      controller.abort();
      return encode(...args);
    });
    try {
      const t = await tool();
      const result: any = await t.execute({ op: 'product.capture', url: 'https://example.com/' }, { ...ctx(), signal: controller.signal });
      expect(controller.signal.aborted).toBe(true);
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({ ok: false, errorCode: 'E_PRODUCT_CAPTURE_CANCELLED' });
      expect(result.images).toBeUndefined();
      expect(fs.readdirSync(path.join(workspace, 'project/composition/assets/product'))).toEqual([]);
      expect(page.destroyed).toBe(1);
    } finally {
      encoding.mockRestore();
    }
  });

  it('keeps a real page whose crop is too large to embed directly in the overview', async () => {
    // Over about 10 MB of base64, one SVG attribute exceeds the parser limit. Real
    // photos and gradients reach that on large crops; solid fixtures never do.
    page.incompressibleCrops = true;
    (page.facts as any).regions = [{ ...(page.facts as any).regions[0], x: 0, y: 0, width: 1440, height: 700 }];
    const t = await tool();
    const result: any = await t.execute({ op: 'product.capture', url: 'https://example.com/' }, ctx());
    expect(body(result)).toMatchObject({ ok: true, visual_evidence: { attached: true, role: 'product_capture_overview' } });
    expect(result.isError).toBeFalsy();
    expect(result.images).toHaveLength(1);

    // The saved asset is the untouched 2x capture, whatever the overview used.
    const report = body(result);
    const compositionDir = path.join(workspace, 'project/composition');
    const saved = fs.readFileSync(path.join(compositionDir, report.images[0].path));
    expect(saved.length).toBeGreaterThanOrEqual(8_000_000);
    expect(saved.equals(page.cropBytes[0])).toBe(true);
    expect(report.images[0]).toMatchObject({ pixel_width: 2880, pixel_height: 1400 });

    // The overview really shows the crop: its one cell is noise, not the empty
    // backdrop a dropped image would leave. Cell layout is the sheet's 400x260
    // grid, last row, first column, above a 30px caption and 16px margins.
    const overview = sharp(path.join(compositionDir, report.overview_path));
    const { width, height } = await overview.metadata();
    expect(width).toBeGreaterThan(0);
    const cell = await overview.clone().extract({ left: 16, top: height! - 16 - 30 - 16 - 260, width: 400, height: 260 }).stats();
    expect(Math.max(...cell.channels.map(channel => channel.stdev))).toBeGreaterThan(20);
  }, 60_000);

  it('keeps every saved crop and reports no visual evidence when the overview cannot be built', async () => {
    const runtime = await import('../../../../src/main/util/sharp-runtime');
    const encoding = vi.spyOn(runtime, 'encodeImage').mockRejectedValue(new Error('SYNTHETIC_ENCODER_FAILURE'));
    try {
      const t = await tool();
      const result: any = await t.execute({ op: 'product.capture', url: 'https://example.com/' }, ctx());
      expect(result.isError).toBeFalsy();
      expect(result.images).toBeUndefined();
      const report = body(result);
      expect(report).toMatchObject({ ok: true, visual_evidence: { attached: false } });
      expect(report.overview_path).toBeUndefined();
      expect(report.overview_abs_path).toBeUndefined();
      expect(result.content).not.toContain('SYNTHETIC_ENCODER_FAILURE');

      const compositionDir = path.join(workspace, 'project/composition');
      expect(report.images.map((image: any) => image.id)).toEqual(['r01', 'r02']);
      for (const rel of [...report.tiles.map((x: any) => x.path), ...report.images.map((x: any) => x.path), report.text_path, report.manifest_path]) {
        expect(fs.existsSync(path.join(compositionDir, rel)), rel).toBe(true);
      }
      const manifest = JSON.parse(fs.readFileSync(path.join(compositionDir, report.manifest_path), 'utf8'));
      expect(manifest.images).toHaveLength(2);
      expect(manifest.overview_path).toBeUndefined();
      expect(fs.existsSync(path.join(compositionDir, report.capture_dir, 'overview.png'))).toBe(false);
    } finally {
      encoding.mockRestore();
    }
  });

  it('still reports cancellation and removes partial assets when the overview fails because of it', async () => {
    const controller = new AbortController();
    const runtime = await import('../../../../src/main/util/sharp-runtime');
    const encoding = vi.spyOn(runtime, 'encodeImage').mockImplementation(async () => {
      controller.abort();
      throw new Error('SYNTHETIC_ENCODER_FAILURE');
    });
    try {
      const t = await tool();
      const result: any = await t.execute({ op: 'product.capture', url: 'https://example.com/' }, { ...ctx(), signal: controller.signal });
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({ ok: false, errorCode: 'E_PRODUCT_CAPTURE_CANCELLED' });
      expect(fs.readdirSync(path.join(workspace, 'project/composition/assets/product'))).toEqual([]);
    } finally {
      encoding.mockRestore();
    }
  });

  it.each(['../../escape', '..\\escape', 'r01/child', 'r01\\child', 'r01:stream', 'r01\0', 'r01\n'])('rejects a page-controlled filename %j before writing capture files', async (id) => {
    (page.facts as any).regions = [{ ...(page.facts as any).regions[0], id }];
    const t = await tool();
    const result: any = await t.execute({ op: 'product.capture', url: 'https://example.com/' }, ctx());
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ ok: false, errorCode: 'E_PRODUCT_CAPTURE_READ' });
    const product = path.join(workspace, 'project/composition/assets/product');
    expect(fs.existsSync(product) ? fs.readdirSync(product) : []).toEqual([]);
    expect(fs.existsSync(path.join(workspace, 'project/composition/assets/escape.png'))).toBe(false);
    expect(page.screenshots).toEqual([]);
    expect(page.destroyed).toBe(1);
  });

  it('keeps a requested crop named overview separate from the generated overview sheet', async () => {
    const t = await tool();
    const result: any = await t.execute({ op: 'product.capture', url: 'https://example.com/',
      clips: [{ id: 'overview', x: 10, y: 20, width: 100, height: 50 }],
    }, ctx());
    expect(result.isError).toBeFalsy();
    const report = body(result);
    expect(report.images[0].id).toBe('overview');
    expect(report.images[0].path).not.toBe(report.overview_path);
    const crop = await sharp(path.join(workspace, 'project/composition', report.images[0].path)).metadata();
    expect([crop.width, crop.height]).toEqual([200, 100]);
  });

  it('saves page tiles, 2x region crops, page words and a manifest under the composition, then attaches the overview', async () => {
    const t = await tool();
    const result: any = await t.execute({ op: 'product.capture', url: 'https://example.com/' }, ctx());
    expect(result.isError).toBeFalsy();
    const report = body(result);
    expect(report).toMatchObject({ ok: true, op: 'product.capture', mode: 'auto_regions', visual_evidence: { attached: true, role: 'product_capture_overview' } });
    expect(report.overview_abs_path).toBeUndefined();
    expect(result.images).toHaveLength(1);
    expect(result.imageRetention).toBe('active_turn');

    const compositionDir = path.join(workspace, 'project/composition');
    expect(report.capture_dir).toMatch(/^assets\/product\/example\.com-\d{8}-\d{6}-[0-9a-f]{4}$/);
    // One viewport per tile, each captured after scrolling to it.
    expect(report.tiles.map((tile: any) => [tile.y, tile.height])).toEqual([[0, 900], [900, 900], [1800, 600]]);
    expect(report.images.map((image: any) => [image.id, image.kind, image.content, image.pixel_width, image.pixel_height])).toEqual([
      ['r01', 'panel', 'panel_media', 1306, 894],
      ['r02', 'image', 'media', 1716, 964],
    ]);
    // Each region is scrolled into view before its screenshot; overlays found
    // then and at load are reported, and only web video addresses survive.
    expect(page.targetCalls).toBe(2);
    expect(report.hidden_overlays.map((o: any) => o.reason)).toEqual(['backdrop', 'dialog', 'fixed_overlay']);
    expect(report.videos).toEqual([{ src: 'https://example.com/demo.mp4', poster: 'https://example.com/demo.jpg', label: 'Product demo', page_rect: { x: 120, y: 900, width: 1200, height: 675 } }]);
    for (const rel of [...report.tiles.map((x: any) => x.path), ...report.images.map((x: any) => x.path), report.text_path, report.overview_path, report.manifest_path]) {
      expect(fs.existsSync(path.join(compositionDir, rel)), rel).toBe(true);
    }
    const crop = await sharp(path.join(compositionDir, report.images[0].path)).metadata();
    expect([crop.width, crop.height]).toEqual([1306, 894]);
    const words = fs.readFileSync(path.join(compositionDir, report.text_path), 'utf8');
    expect(words).toContain('Untrusted page text');
    expect(words).toContain('# Scale without hiring');
    expect(words).toContain('## Work that keeps moving');
    const manifest = JSON.parse(fs.readFileSync(path.join(compositionDir, report.manifest_path), 'utf8'));
    expect(manifest).toMatchObject({ source_url: 'https://example.com/', final_url: 'https://example.com/', viewport: { width: 1440, deviceScaleFactor: 2 } });

    // Tiles are 1x JPEG overview plates; crops are 2x PNG assets.
    expect(page.screenshots.filter(s => s.format === 'jpeg').every(s => s.clip.scale === 0.5)).toBe(true);
    expect(page.screenshots.filter(s => s.format === 'png').map(s => s.clip)).toEqual([
      { x: 635, y: 1235, width: 653, height: 447, scale: 1 },
      { x: 291, y: 444, width: 858, height: 482, scale: 1 },
    ]);
    // Isolated in-memory session, popups denied, window always destroyed.
    expect(page.partitions).toHaveLength(1);
    expect(page.partitions[0]).toMatch(/^video-studio-product-/);
    expect(page.deniedPopups).toBe(1);
    expect(page.destroyed).toBe(1);
  });

  it('follows a redirect the page starts while loading and reports language alternates', async () => {
    page.redirectTo = 'https://example.com/?lang=zh';
    const t = await tool();
    const result: any = await t.execute({ op: 'product.capture', url: 'https://example.com/' }, ctx());
    expect(result.isError).toBeFalsy();
    const report = body(result);
    expect(report.final_url).toBe('https://example.com/?lang=zh');
    expect(report.page.lang).toBe('en');
    // Only web alternates survive; the page cannot smuggle other schemes.
    expect(report.alternates).toEqual([{ hreflang: 'zh-CN', href: 'https://example.com/?lang=zh' }]);
  });

  it('captures only the requested clips and selectors and reports unmatched selectors', async () => {
    (page.facts as any).selector_rects = [
      { id: 'sel-01', selector: '.oks-ui', rect: { x: 600, y: 1200, width: 700, height: 500 } },
      { id: 'sel-02', selector: '.missing', rect: null },
    ];
    const t = await tool();
    const report = body(await t.execute({
      op: 'product.capture', url: 'https://example.com/',
      clips: [{ id: 'commander', x: 100, y: 2300, width: 400, height: 300 }],
      selectors: ['.oks-ui', '.missing'],
    }, ctx()));
    expect(report.mode).toBe('requested_clips');
    // The clip is cut at the page bottom (2400) rather than inventing pixels.
    expect(report.images.map((image: any) => [image.id, image.page_rect])).toEqual([
      ['commander', { x: 100, y: 2300, width: 400, height: 100 }],
      ['sel-01', { x: 600, y: 1200, width: 700, height: 500 }],
    ]);
    expect(report.skipped).toEqual([{ id: 'sel-02', reason: 'selector not found or not visible' }]);
  });

  it('rejects unsafe input before opening a window and leaves no partial capture on failure', async () => {
    const t = await tool();
    for (const input of [
      { url: 'file:///etc/hosts' },
      { url: 'https://example.com/', clips: [{ x: -1, y: 0, width: 50, height: 50 }] },
      { url: 'https://example.com/', selectors: [123] },
    ]) {
      const result: any = await t.execute({ op: 'product.capture', ...input }, ctx());
      expect(result.isError).toBe(true);
    }
    expect(page.partitions).toHaveLength(0);

    page.loadError = new Error('ERR_NAME_NOT_RESOLVED');
    const failed: any = await t.execute({ op: 'product.capture', url: 'https://example.com/' }, ctx());
    expect(failed.isError).toBe(true);
    expect(body(failed)).toMatchObject({ ok: false, errorCode: 'E_PRODUCT_CAPTURE_LOAD' });
    expect(failed.images).toBeUndefined();
    expect(fs.existsSync(path.join(workspace, 'project/composition/assets/product'))
      ? fs.readdirSync(path.join(workspace, 'project/composition/assets/product')) : []).toEqual([]);
    expect(page.destroyed).toBe(1);
  });

  it('refuses a composition directory outside the writable workspace', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-product-outside-'));
    try {
      const t = await tool();
      const result: any = await t.execute({ op: 'product.capture', url: 'https://example.com/', composition_dir: outside }, ctx());
      expect(result.isError).toBe(true);
      expect(page.partitions).toHaveLength(0);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
