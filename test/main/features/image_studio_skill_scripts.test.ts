import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const structuredVisual = require('../../../resources/builtin/marketplace/agents/814b61b027f0/skills/image-compose/scripts/structured_visual.js') as
  ((input: { args: string[] }) => Promise<Record<string, unknown>>);
const imageAsset = require('../../../resources/builtin/marketplace/agents/814b61b027f0/skills/image-compose/scripts/image_asset.js') as
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
