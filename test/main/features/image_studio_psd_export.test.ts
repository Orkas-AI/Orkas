import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inspectPsdBytes } from '../../../eval/model-eval/regression/psd-inspection';
import * as sharpRuntime from '../../../src/main/util/sharp-runtime';

const nativePixels = vi.hoisted(() => ({ bgra: [51, 34, 17, 255] }));
vi.mock('electron', () => ({ nativeImage: {
  createFromPath: (file: string) => { const bgra = [...nativePixels.bgra]; return ({
    getSize: () => ({ width: 256, height: 256 }), isEmpty: () => false,
    toPNG: () => fs.readFileSync(file),
    toBitmap: () => Buffer.from(Array.from({ length: 256 * 256 }, () => bgra).flat()),
  }); },
} }));
import { exportImageStudioProject, recordRasterEvidence, submitImageStudioDesignReview } from '../../../src/main/features/image_studio';
import { imageStudioFileHash } from '../../../src/main/features/image_studio_provenance';

const require = createRequire(import.meta.url);
const layered = require('../../../resources/builtin/marketplace/agents/814b61b027f0/skills/image-compose/scripts/layered_document.js');
let root: string, stateAbsPath: string, document: any;
const scores = { intent_alignment: 90, composition: 90, craft: 90, text_legibility: 90, defect_freedom: 90, specificity: 90 };
async function helper(request: object) {
  fs.writeFileSync(path.join(root, 'request.json'), JSON.stringify(request));
  return layered({ args: ['--project', root, '--request', 'request.json'] });
}
async function prepare() {
  fs.writeFileSync(path.join(root, 'design.json'), JSON.stringify(document));
  await helper({ op: 'render', document_path: 'design.json', output_path: 'preview.png' });
  await helper({ op: 'export_psd', document_path: 'design.json', preview_path: 'preview.png', output_path: 'candidate.psd' });
}
async function inspect(generated = false) {
  return recordRasterEvidence({ projectDirAbs: root, stateAbsPath,
    generationOutputs: generated ? [{ output_path: path.join(root, 'base.png'), output_sha256: await imageStudioFileHash(path.join(root, 'base.png')) }] : [] });
}
async function approve() {
  await submitImageStudioDesignReview({ stateAbsPath, evidenceAbsPath: path.join(root, 'base.png'), verdict: 'passed',
    scope: 'Synthetic state-transition fixture, not visual certification', findings: [], qualityScores: scores });
}
const exportFile = (format: string, output = `final.${format}`, input = 'candidate.psd') => exportImageStudioProject({
  stateAbsPath, format, outputAbsPath: path.join(root, output), inputAbsPath: path.join(root, input),
} as any);

beforeEach(async () => {
  nativePixels.bgra = [51, 34, 17, 255];
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'psd-native-export-')));
  stateAbsPath = path.join(root, 'state.json');
  await sharp({ create: { width: 256, height: 256, channels: 4, background: '#112233' } }).png().toFile(path.join(root, 'base.png'));
  document = { schema_version: 1, canvas: { width: 256, height: 256 }, layers: [
    { id: 'base', type: 'image', name: 'Base', path: 'base.png' },
  ] };
  const router = fs.readFileSync(path.resolve('resources/builtin/marketplace/agents/814b61b027f0/skills/image-router/SKILL.md'), 'utf8');
  const manifest = JSON.parse(router.match(/```json\s*([\s\S]*?)\s*```/)![1]);
  manifest.canvas = document.canvas; manifest.raster_source = 'base.png';
  fs.writeFileSync(path.join(root, 'image-manifest.json'), JSON.stringify(manifest));
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

async function replaceWithValidRevision() {
  await sharp({ create: { width: 256, height: 256, channels: 4, background: '#556677' } }).png().toFile(path.join(root, 'base.png'));
  nativePixels.bgra = [119, 102, 85, 255];
  await inspect(true);
  await exportFile('png', 'new-revision.png');
  const current = JSON.parse(fs.readFileSync(stateAbsPath, 'utf8'));
  expect(current.exported_png.signature).toBe(current.signature);
  expect(inspectPsdBytes(fs.readFileSync(path.join(root, 'candidate.psd'))).rgba)
    .not.toEqual(await sharp(path.join(root, 'base.png')).ensureAlpha().raw().toBuffer());
}

it('rejects a valid newer revision admitted while the real PSD preview comparison completes', async () => {
  await prepare(); await inspect(true); await exportFile('png');
  const compare = sharpRuntime.matchesPsdPreview;
  vi.spyOn(sharpRuntime, 'matchesPsdPreview').mockImplementationOnce(async (...args) => {
    const matches = await compare(...args);
    expect(matches).toBe(true);
    await replaceWithValidRevision();
    return matches;
  });
  await expect(exportFile('psd')).rejects.toThrow('E_IMAGE_PSD_SOURCE_CHANGED');
  expect(fs.existsSync(path.join(root, 'final.psd'))).toBe(false);
});

it.each(['revision', 'bytes', 'failure'])('removes its new PSD when finalization changes %s', async fault => {
  await prepare(); await inspect(true); await exportFile('png');
  await expect(exportImageStudioProject({ stateAbsPath, format: 'psd', inputAbsPath: path.join(root, 'candidate.psd'),
    outputAbsPath: path.join(root, 'final.psd'), finalizeOutput: async file => {
      if (fault === 'revision') await replaceWithValidRevision();
      else if (fault === 'bytes') fs.writeFileSync(file, 'changed');
      else throw new Error('fixture finalization failed');
    } })).rejects.toThrow(fault === 'revision' ? 'E_IMAGE_PSD_SOURCE_CHANGED'
      : fault === 'bytes' ? 'E_IMAGE_PSD_FINALIZED_MISMATCH' : 'fixture finalization failed');
  expect(fs.existsSync(path.join(root, 'final.psd'))).toBe(false);
});

it('requires authored review and a current native PNG before exporting the unchanged PSD bytes', async () => {
  await prepare(); expect((await inspect()).is_generation).toBe(false);
  await expect(exportFile('psd')).rejects.toThrow('E_IMAGE_REVIEW_PASS_REQUIRED');
  expect(fs.existsSync(path.join(root, 'final.psd'))).toBe(false);
  await approve();
  await expect(exportFile('psd')).rejects.toThrow('E_IMAGE_PSD_PNG_REQUIRED');
  await exportFile('png'); await exportFile('psd');
  expect(fs.readFileSync(path.join(root, 'final.psd'))).toEqual(fs.readFileSync(path.join(root, 'candidate.psd')));
  expect(inspectPsdBytes(fs.readFileSync(path.join(root, 'final.psd'))).layers).toHaveLength(1);
});

it('exports a proven generation unchanged as a one-layer PSD without any visual score', async () => {
  await prepare(); expect((await inspect(true)).is_generation).toBe(true);
  await expect(approve()).rejects.toThrow('E_IMAGE_REVIEW_NOT_APPLICABLE');
  await exportFile('png'); const exported = await exportFile('psd');
  expect(exported.is_generation).toBe(true);
  const actual = inspectPsdBytes(fs.readFileSync(path.join(root, 'final.psd')));
  expect(actual.layers).toHaveLength(1); expect(actual.layers[0].text).toBeUndefined();
  expect(actual.rgba).toEqual(await sharp(path.join(root, 'base.png')).ensureAlpha().raw().toBuffer());
  expect(JSON.parse(fs.readFileSync(stateAbsPath, 'utf8')).review).toBeUndefined();
});

it.each(['changed-pixels', 'not-psd', 'missing-png', 'changed-png', 'changed-source'])('rejects %s without publishing a PSD', async fault => {
  await prepare(); await inspect(true); await exportFile('png');
  if (fault === 'changed-pixels') {
    await sharp({ create: { width: 256, height: 256, channels: 4, background: '#ff0000' } }).png().toFile(path.join(root, 'other.png'));
    document.layers[0].path = 'other.png'; fs.writeFileSync(path.join(root, 'design.json'), JSON.stringify(document));
    await helper({ op: 'render', document_path: 'design.json', output_path: 'other-preview.png' });
    await helper({ op: 'export_psd', document_path: 'design.json', preview_path: 'other-preview.png', output_path: 'other.psd' });
    fs.copyFileSync(path.join(root, 'other.psd'), path.join(root, 'candidate.psd'));
  } else if (fault === 'not-psd') fs.copyFileSync(path.join(root, 'base.png'), path.join(root, 'candidate.psd'));
  else if (fault === 'missing-png') fs.unlinkSync(path.join(root, 'final.png'));
  else if (fault === 'changed-png') fs.writeFileSync(path.join(root, 'final.png'), 'changed');
  else fs.writeFileSync(path.join(root, 'base.png'), 'changed');
  await expect(exportFile('psd')).rejects.toThrow();
  expect(fs.existsSync(path.join(root, 'final.psd'))).toBe(false);
});

it('does not exempt an authored overlay just because its base has a provider record', async () => {
  document.layers.push({ id: 'label', type: 'text', name: 'Label', text: 'New', left: 16, top: 24,
    width: 224, height: 48, font_family: 'Arial', font_postscript_name: 'ArialMT', font_size: 28, color: '#ff0000' });
  await prepare(); const file = path.join(root, 'image-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')); manifest.raster_source = 'preview.png';
  fs.writeFileSync(file, JSON.stringify(manifest));
  expect((await inspect(true)).is_generation).toBe(false);
  await expect(exportFile('psd')).rejects.toThrow('E_IMAGE_REVIEW_PASS_REQUIRED');
  expect(fs.existsSync(path.join(root, 'final.psd'))).toBe(false);
});

it.each(['version', 'depth', 'channels', 'dimensions', 'truncated'])('rejects unsupported PSD %s before publishing', async fault => {
  await prepare(); await inspect(true); await exportFile('png');
  let bytes = fs.readFileSync(path.join(root, 'candidate.psd'));
  if (fault === 'version') bytes.writeUInt16BE(2, 4);
  if (fault === 'depth') bytes.writeUInt16BE(16, 22);
  if (fault === 'channels') bytes.writeUInt16BE(56, 12);
  if (fault === 'dimensions') bytes.writeUInt32BE(0xffffffff, 18);
  if (fault === 'truncated') bytes = bytes.subarray(0, 70);
  fs.writeFileSync(path.join(root, 'candidate.psd'), bytes);
  await expect(exportFile('psd')).rejects.toThrow('E_IMAGE_PSD_INVALID');
  expect(fs.existsSync(path.join(root, 'final.psd'))).toBe(false);
});

it('records the PNG after existing presentation finalization without changing PSD artwork', async () => {
  await prepare(); await inspect(true);
  await exportImageStudioProject({ stateAbsPath, outputAbsPath: path.join(root, 'final.png'), format: 'png',
    finalizeOutput: async file => { await sharp({ create: { width: 256, height: 256, channels: 4, background: '#ffffff' } }).png().toFile(file); } });
  await exportFile('psd');
  expect(fs.readFileSync(path.join(root, 'final.psd'))).toEqual(fs.readFileSync(path.join(root, 'candidate.psd')));
});

it('rejects ZIP composite input outside the private writer subset before decompression', async () => {
  await prepare(); await inspect(true); await exportFile('png');
  const bytes = fs.readFileSync(path.join(root, 'candidate.psd'));
  let composite = 26;
  for (let i = 0; i < 3; i++) composite += 4 + bytes.readUInt32BE(composite);
  const planes = Buffer.concat([17, 34, 51, 255].slice(0, bytes.readUInt16BE(12)).map(value => Buffer.alloc(256 * 256, value)));
  fs.writeFileSync(path.join(root, 'candidate.psd'), Buffer.concat([bytes.subarray(0, composite), Buffer.from([0, 2]), deflateSync(planes)]));
  await expect(exportFile('psd')).rejects.toThrow('E_IMAGE_PSD_INVALID');
  expect(fs.existsSync(path.join(root, 'final.psd'))).toBe(false);
});
