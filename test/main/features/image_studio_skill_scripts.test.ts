import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { inspectPsdBytes } from '../../../eval/model-eval/regression/psd-inspection';

const require = createRequire(import.meta.url);
const structuredVisual = require('../../../resources/builtin/marketplace/agents/814b61b027f0/skills/image-compose/scripts/structured_visual.js') as
  ((input: { args: string[] }) => Promise<Record<string, unknown>>);
const imageAsset = require('../../../resources/builtin/marketplace/agents/814b61b027f0/skills/image-compose/scripts/image_asset.js') as
  ((input: { args: string[] }) => Promise<Record<string, unknown>>);
const layeredDocument = require('../../../resources/builtin/marketplace/agents/814b61b027f0/skills/image-compose/scripts/layered_document.js') as
  ((input: { args: string[] }) => Promise<Record<string, unknown>>);

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-image-skill-scripts-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(name: string, value: unknown): void {
  fs.writeFileSync(path.join(root, name), JSON.stringify(value));
}

describe('ImageStudio private skill scripts', () => {
  it.each(['compose', 'edit'])('prepares the layered-source reference and native %s manifest without flattening', async route => {
    const skillsDir = path.resolve(process.cwd(), 'resources/builtin/marketplace/agents/814b61b027f0/skills');
    const compose = fs.readFileSync(path.join(skillsDir, 'image-compose/SKILL.md'), 'utf8');
    const router = fs.readFileSync(path.join(skillsDir, 'image-router/SKILL.md'), 'utf8');
    const composeHandoff = router.split('\n').find(line => line.startsWith('- Add `image-compose`'));
    expect(composeHandoff).toContain('layered source');
    expect(composeHandoff).toContain('PSD delivery');
    expect(compose).toContain('](references/layered-documents.md)');
    expect(compose).toContain('a flattened image stays a single layer');
    expect(compose).toMatch(/After PNG export succeeds[^\n]*requested PSD[^\n]*same verified layered source/);
    const reference = fs.readFileSync(path.join(skillsDir, 'image-compose/references/layered-documents.md'), 'utf8');
    const examples = [...reference.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
    const document = examples.find(value => value.layers);
    const requests = examples.filter(value => value.op);
    expect(requests.map(value => value.op)).toEqual(['capabilities', 'render', 'export_psd']);
    fs.mkdirSync(path.join(root, 'assets'));
    const sources = new Map<string, Buffer>([
      ['assets/base.png', await sharp({ create: { width: 320, height: 240, channels: 4, background: '#f2ede4' } }).png().toBuffer()],
      ['assets/badge.png', await sharp({ create: { width: 64, height: 32, channels: 4, background: '#326496' } }).png().toBuffer()],
      ['assets/badge-mask.png', await sharp(Buffer.alloc(64 * 32, 128), { raw: { width: 64, height: 32, channels: 1 } }).png().toBuffer()],
    ]);
    for (const [file, bytes] of sources) fs.writeFileSync(path.join(root, file), bytes);
    writeJson('design.json', document);
    const native = await import('../../../src/main/features/image_studio');
    const original = structuredClone(document);
    original.layers[1].children[1].text = 'Draft notes';
    writeJson('original-design.json', original);
    if (route === 'edit') {
      writeJson('original-request.json', { op: 'render', document_path: 'original-design.json', output_path: 'out/original.png' });
      await layeredDocument({ args: ['--project', root, '--request', 'original-request.json'] });
    }
    for (const request of requests) {
      if (request.op === 'export_psd') {
        const manifest = JSON.parse(router.match(/```json\s*([\s\S]*?)\s*```/)![1]);
        manifest.canvas = document.canvas; manifest.route = route;
        manifest.raster_source = 'out/preview.png';
        manifest.brief.required_copy = ['Field notes'];
        if (route === 'edit') Object.assign(manifest, examples.find(value => value.reference_intent));
        expect(native.validateImageStudioManifest(manifest).issues).toEqual([]);
        writeJson('image-manifest.json', manifest);
        expect(fs.existsSync(path.resolve(root, manifest.raster_source))).toBe(true);
        for (const ref of manifest.references || []) expect(fs.existsSync(path.resolve(root, ref.path))).toBe(true);
      }
      writeJson('layered-request.json', request);
      const result = await layeredDocument({ args: ['--project', root, '--request', 'layered-request.json'] });
      expect(result).toMatchObject({ ok: true, model_calls: 0 });
      if (request.op === 'export_psd') expect(result).toMatchObject({
        delivery_state: 'candidate', structure_verified: true, external_editor_verified: false,
        final_export: { tool: 'image_studio', op: 'project.export', format: 'psd', input_path: fs.realpathSync(path.join(root, 'out/candidate.psd')) },
      });
    }
    const exported = inspectPsdBytes(fs.readFileSync(path.join(root, 'out/candidate.psd')));
    expect(exported.layers.find(layer => layer.name === 'Headline')?.text).toBe('Field notes');
    expect(exported.layers.find(layer => layer.name === 'Badge')?.channels.get(-2)).toEqual(Buffer.alloc(64 * 32, 128));
    expect(exported.rgba).toEqual(await sharp(path.join(root, 'out/preview.png')).ensureAlpha().raw().toBuffer());
    for (const [file, bytes] of sources) expect(fs.readFileSync(path.join(root, file))).toEqual(bytes);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'design.json'), 'utf8'))).toEqual(document);
  });

  it('executes the discoverable photo-processing examples with exact pixels, preserved sources and verified resume', async () => {
    const skillDir = path.resolve(process.cwd(), 'resources/builtin/marketplace/agents/814b61b027f0/skills/image-compose');
    const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const reference = 'references/photo-processing.md';
    expect(skill).toContain(`](${reference})`);
    const docs = fs.readFileSync(path.join(skillDir, reference), 'utf8');
    const requests = [...docs.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
    const batch = requests.find(request => request.op === 'batch');
    const mask = requests.find(request => request.op === 'masked_composite');
    expect(batch).toBeDefined();
    expect(mask).toBeDefined();
    fs.mkdirSync(path.join(root, 'photos'));
    fs.mkdirSync(path.join(root, 'artwork'));
    const photo = await sharp(Buffer.from([20, 40, 60, 255]), { raw: { width: 1, height: 1, channels: 4 } }).png().toBuffer();
    const originals = new Map<string, Buffer>();
    for (const name of ['a', 'b', 'c']) originals.set(`photos/${name}.png`, photo);
    const source = Buffer.from([20, 40, 60, 128, 10, 20, 30, 255]);
    for (const [name, pixels] of Object.entries({
      source,
      background: Buffer.from([100, 110, 120, 255, 130, 140, 150, 200]),
      mask: Buffer.from([0, 0, 0, 255, 255, 255, 255, 255]),
    })) originals.set(`artwork/${name}.png`, await sharp(pixels, { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer());
    for (const [file, bytes] of originals) fs.writeFileSync(path.join(root, file), bytes);
    writeJson('batch.json', batch);
    const run = (request: string) => imageAsset({ args: ['--project', root, '--request', request] });
    expect(await run('batch.json')).toMatchObject({ ok: true, completed: 3, reused: 0, failed: 0, model_calls: 0 });
    for (const [name, expected] of [['a', [27, 51, 75, 255]], ['b', [27, 51, 75, 255]], ['c', [20, 40, 30, 255]]] as const) {
      expect([...(await sharp(path.join(root, `out/${name}.png`)).ensureAlpha().raw().toBuffer())]).toEqual(expected);
    }
    expect(await run('batch.json')).toMatchObject({ completed: 0, reused: 3, failed: 0 });
    writeJson('mask.json', mask);
    expect(await run('mask.json')).toMatchObject({ ok: true, protected_pixels_verified: true, model_calls: 0 });
    expect([...(await sharp(path.join(root, 'out/masked.png')).ensureAlpha().raw().toBuffer())])
      .toEqual([20, 40, 60, 128, 130, 140, 150, 200]);
    for (const [file, bytes] of originals) expect(fs.readFileSync(path.join(root, file))).toEqual(bytes);
  });

  it.each(['diagram', 'bar', 'line', 'donut'] as const)('renders a deterministic zero-call %s SVG', async (kind) => {
    const common = {
      schema_version: 1,
      kind,
      canvas: { width: 800, height: 500 },
      title: 'Structured visual',
      theme: { accents: ['#5b4bdb', '#159f79', '#e6a23c'] },
    };
    const spec = kind === 'diagram'
      ? {
          ...common,
          diagram: {
            direction: 'LR',
            nodes: [{ id: 'brief', label: 'Lock brief' }, { id: 'review', label: 'Review evidence' }],
            edges: [{ from: 'brief', to: 'review', label: 'pixels' }],
          },
        }
      : {
          ...common,
          chart: {
            labels: ['Compose', 'Hybrid', 'Generate'],
            series: [{ name: 'Calls', values: kind === 'donut' ? [5, 3, 2] : [0, 1, 2] }],
          },
        };
    writeJson('visual.json', spec);
    const result = await structuredVisual({ args: ['--project', root, '--input', 'visual.json', '--output', `${kind}.svg`] });
    const svg = fs.readFileSync(path.join(root, `${kind}.svg`), 'utf8');

    expect(result).toMatchObject({ ok: true, kind, width: 800, height: 500, model_calls: 0 });
    expect(svg).toContain('<svg');
    expect(svg).toContain('Structured visual');
    expect(svg).not.toMatch(/<script|(?:href|src)=["']https?:\/\//i);
  });

  it('processes a raster through the skill-owned Sharp pipeline', async () => {
    fs.writeFileSync(path.join(root, 'source.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#6558d3"/></svg>');
    writeJson('asset.json', {
      op: 'process',
      input_path: 'source.svg',
      output_path: 'processed.webp',
      operations: [{ type: 'resize', width: 160, height: 80, fit: 'fill' }, { type: 'sharpen' }],
      quality: 90,
    });
    const result = await imageAsset({ args: ['--project', root, '--request', 'asset.json'] });

    expect(result).toMatchObject({ ok: true, op: 'process', engine: 'image-compose-skill-sharp', width: 160, height: 80, model_calls: 0 });
    expect(fs.statSync(path.join(root, 'processed.webp')).size).toBeGreaterThan(0);
  });

  it('executes the documented crop, edge-trim and resize requests without changing their source', async () => {
    const docs = fs.readFileSync(path.resolve('resources/builtin/marketplace/agents/814b61b027f0/skills/image-compose/references/photo-processing.md'), 'utf8');
    const requests = [...docs.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
      .map(match => JSON.parse(match[1])).filter(request => request.op === 'process');
    expect(requests.map(request => request.operations[0].type).sort()).toEqual(['extract', 'resize', 'trim']);
    fs.mkdirSync(path.join(root, 'photos'));
    const source = await sharp({ create: { width: 640, height: 480, channels: 4, background: '#ffffff' } })
      .composite([{ input: await sharp({ create: { width: 320, height: 240, channels: 4, background: '#1a6699' } }).png().toBuffer(), left: 160, top: 120 }])
      .png().toBuffer();
    fs.writeFileSync(path.join(root, 'photos/source.png'), source);
    for (const request of requests) {
      writeJson('asset.json', request);
      expect(await imageAsset({ args: ['--project', root, '--request', 'asset.json'] }))
        .toMatchObject({ ok: true, width: 320, height: 240, model_calls: 0 });
      const decoded = await sharp(path.join(root, request.output_path)).ensureAlpha().raw().toBuffer();
      const center = (120 * 320 + 160) * 4;
      expect([...decoded.subarray(center, center + 4)]).toEqual([26, 102, 153, 255]);
      if (request.operations[0].type === 'resize') {
        expect([...decoded.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
      } else {
        expect(decoded).toEqual(Buffer.alloc(320 * 240 * 4).fill(Buffer.from([26, 102, 153, 255])));
      }
      expect(fs.readFileSync(path.join(root, 'photos/source.png'))).toEqual(source);
    }
    const crop = requests.find(request => request.operations[0].type === 'extract');
    writeJson('invalid-crop.json', { ...crop, output_path: 'out/invalid.png',
      operations: [{ type: 'extract', left: 639, top: 0, width: 2, height: 1 }] });
    await expect(imageAsset({ args: ['--project', root, '--request', 'invalid-crop.json'] })).rejects.toThrow();
    expect(fs.existsSync(path.join(root, 'out/invalid.png'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'photos/source.png'))).toEqual(source);
  });

  it('recovers a rejected resize request into the delivery size without changing source or provider pixels', async () => {
    const source = await sharp({ create: { width: 900, height: 900, channels: 4, background: '#112233' } }).png().toBuffer();
    const provider = await sharp({ create: { width: 2048, height: 2048, channels: 4, background: '#bb6622' } }).png().toBuffer();
    fs.writeFileSync(path.join(root, 'original.png'), source);
    fs.writeFileSync(path.join(root, 'provider.png'), provider);
    const request = {
      op: 'process', input_path: 'provider.png', output_path: 'delivery.png',
      operations: [{ type: 'resize', width: 900, height: 900, fit: 'invalid-fit' }],
    };
    writeJson('resize.json', request);
    await expect(imageAsset({ args: ['--project', root, '--request', 'resize.json'] }))
      .rejects.toThrow('fit is invalid');
    expect(fs.existsSync(path.join(root, 'delivery.png'))).toBe(false);

    // A corrected request may use the same helper; the earlier failure does
    // not impose a retry cutoff or require touching the original/reference.
    request.operations[0].fit = 'contain';
    writeJson('resize.json', request);
    const result = await imageAsset({ args: ['--project', root, '--request', 'resize.json'] });
    expect(result).toMatchObject({ ok: true, width: 900, height: 900, model_calls: 0 });
    const decoded = await sharp(path.join(root, 'delivery.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({ width: 900, height: 900, channels: 4 });
    expect([...decoded.data.subarray(0, 4)]).toEqual([187, 102, 34, 255]);
    expect(fs.readFileSync(path.join(root, 'original.png'))).toEqual(source);
    expect(fs.readFileSync(path.join(root, 'provider.png'))).toEqual(provider);
    expect(fs.readdirSync(root).sort()).toEqual(['delivery.png', 'delivery.png.image-normalization.json', 'original.png', 'provider.png', 'resize.json']);
  });

  it('keeps script requests project-local and treats Real-ESRGAN as host-managed', async () => {
    fs.writeFileSync(path.join(root, 'source.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"/>');
    writeJson('outside.json', { op: 'process', input_path: 'source.svg', output_path: '../outside.png' });
    await expect(imageAsset({ args: ['--project', root, '--request', 'outside.json'] })).rejects.toThrow('must stay inside the project');

    writeJson('upscale.json', { op: 'upscale', input_path: 'source.svg', output_path: 'upscaled.png' });
    const previous = process.env.ORKAS_REALESRGAN_BIN;
    delete process.env.ORKAS_REALESRGAN_BIN;
    try {
      await expect(imageAsset({ args: ['--project', root, '--request', 'upscale.json'] })).rejects.toThrow('ORKAS_REALESRGAN_BIN');
    } finally {
      if (previous !== undefined) process.env.ORKAS_REALESRGAN_BIN = previous;
    }
  });

  it('rejects symlink escapes and remote SVG paint references', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-image-skill-outside-'));
    const escape = path.join(root, 'escape');
    try {
      fs.symlinkSync(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
      writeJson('visual.json', {
        schema_version: 1,
        kind: 'bar',
        canvas: { width: 800, height: 500 },
        theme: { accents: ['url(https://example.com/paint.svg)'] },
        chart: { labels: ['A'], series: [{ name: 'Series', values: [1] }] },
      });
      await expect(structuredVisual({ args: ['--project', root, '--input', 'visual.json', '--output', 'blocked.svg'] }))
        .rejects.toThrow('static CSS colors');

      writeJson('safe-visual.json', {
        schema_version: 1,
        kind: 'bar',
        canvas: { width: 800, height: 500 },
        chart: { labels: ['A'], series: [{ name: 'Series', values: [1] }] },
      });
      await expect(structuredVisual({ args: ['--project', root, '--input', 'safe-visual.json', '--output', 'escape/out.svg'] }))
        .rejects.toThrow('must stay inside the project');

      fs.writeFileSync(path.join(root, 'source.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"/>');
      writeJson('escape-asset.json', { op: 'process', input_path: 'source.svg', output_path: 'escape/out.png' });
      await expect(imageAsset({ args: ['--project', root, '--request', 'escape-asset.json'] }))
        .rejects.toThrow('must stay inside the project');
    } finally {
      fs.rmSync(escape, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});


describe('ImageStudio shipped resource handoffs', () => {
  it('hands authored revisions from current evidence to the on-demand review skill before submitting a verdict', () => {
    const compose = fs.readFileSync(new URL(
      '../../../resources/builtin/marketplace/agents/814b61b027f0/skills/image-compose/SKILL.md', import.meta.url,
    ), 'utf8');
    const reviewStep = compose.split('## Native workflow')[1]?.split('\n').find(line => line.startsWith('4.')) || '';
    // Protect the handoff at the production step the Agent is following, rather
    // than accepting a reviewer name elsewhere in a startup catalog.
    expect(reviewStep).toMatch(/non-generation[\s\S]*current visual evidence[\s\S]*read `image-design-review`[\s\S]*already loaded[\s\S]*project\.submit_design_review/i);
    expect(compose).toMatch(/skipping the scored-review steps only for `is_generation:true`/);
    expect(compose).toMatch(/changed manifest, HTML file, or local resource invalidates the prior review/i);
  });

  it('reviews the requested outcome rather than accepting a narrowed self-authored plan', () => {
    const review = fs.readFileSync(new URL(
      '../../../resources/builtin/marketplace/agents/814b61b027f0/skills/image-design-review/SKILL.md', import.meta.url,
    ), 'utf8');
    const intent = review.split('1. Intent:')[1].split('\n2. ')[0];
    expect(intent).toMatch(/user.*current requirements.*approved brief/i);
    expect(intent).toMatch(/self-authored manifest.*not narrow/i);
    expect(intent).toMatch(/missing requested message.*candidate matches.*plan/i);
    expect(intent).toMatch(/strict.*exact-only.*no-added-copy[\s\S]*blocker/i);
  });

  it('hands permitted product reframing to the existing photo owner before placement', () => {
    const root = '../../../resources/builtin/marketplace/agents/814b61b027f0/skills/';
    const compose = fs.readFileSync(new URL(root + 'image-compose/SKILL.md', import.meta.url), 'utf8');
    const photo = fs.readFileSync(new URL(root + 'image-compose/references/photo-processing.md', import.meta.url), 'utf8');
    const commerce = fs.readFileSync(new URL(root + 'image-craft/references/ecommerce.md', import.meta.url), 'utf8');
    const authoring = compose.split('## Authoring contract')[1].split('\n## ')[0];
    expect(authoring).toContain('references/photo-processing.md#source-region-before-placement');
    expect(photo).toMatch(/## Source region before placement[\s\S]*original framing[\s\S]*scoped edits/i);
    expect(photo).toMatch(/new asset[\s\S]*before choosing.*frame scale/i);
    expect(photo).toMatch(/cover[\s\S]*crop[\s\S]*contain[\s\S]*inside/i);
    expect(commerce).toContain('@skill/image-compose/references/photo-processing.md#source-region-before-placement');
    // Commerce owns the communication criterion; the photo reference owns processing.
    expect(commerce).not.toContain('trim unused surroundings or frame a verified subject region');
  });

});


describe('portable local trimming request boundary', () => {
  it('executes a real trim while rejecting an external request file without changing source pixels', async () => {
    const source = await sharp({ create: { width: 720, height: 1280, channels: 3, background: '#f5f5f2' } })
      .composite([{ input: await sharp({ create: { width: 200, height: 565, channels: 3, background: '#2468ae' } }).png().toBuffer(), left: 260, top: 325 }]).png().toBuffer();
    fs.writeFileSync(path.join(root, 'source.png'), source);
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-external-image-request-'));
    try {
      const request = { op: 'process', input_path: 'source.png', output_path: 'trimmed.png', operations: [{ type: 'trim', background: '#f5f5f2' }] };
      const outside = path.join(external, 'request.json');
      fs.writeFileSync(outside, JSON.stringify(request));
      await expect(imageAsset({ args: ['--project', root, '--request', outside] })).rejects.toThrow('E_IMAGE_ASSET_PATH');
      expect(fs.existsSync(path.join(root, 'trimmed.png'))).toBe(false);
      writeJson('trim.json', request);
      expect(await imageAsset({ args: ['--project', root, '--request', 'trim.json'] })).toMatchObject({ ok: true, width: 200, height: 565, model_calls: 0 });
      const pixels = await sharp(path.join(root, 'trimmed.png')).metadata();
      expect([pixels.width, pixels.height]).toEqual([200, 565]);
      expect(fs.readFileSync(path.join(root, 'source.png'))).toEqual(source);
    } finally { fs.rmSync(external, { recursive: true, force: true }); }
  });
});
