import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inspectPsdBytes } from '../../../eval/model-eval/regression/psd-inspection';
const require = createRequire(import.meta.url);
const run = require('../../../resources/builtin/marketplace/agents/814b61b027f0/skills/image-compose/scripts/layered_document.js');
const psd = require('ag-psd');
psd.initializeCanvas(() => { throw new Error('Canvas must not be needed'); }, (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));
let root: string;
let document: any;
beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'image-layered-')));
  await sharp({ create: { width: 64, height: 48, channels: 4, background: '#112233' } }).png().toFile(path.join(root, 'background.png'));
  await sharp(Buffer.from([255, 0, 0, 255, 0, 255, 0, 128]), { raw: { width: 2, height: 1, channels: 4 } }).png().toFile(path.join(root, 'product.png'));
  await sharp(Buffer.from([255, 0]), { raw: { width: 2, height: 1, channels: 1 } }).png().toFile(path.join(root, 'mask.png'));
  document = { schema_version: 1, canvas: { width: 64, height: 48 }, layers: [
    { id: 'background', type: 'image', name: 'Background', path: 'background.png' },
    { id: 'foreground', type: 'group', name: 'Foreground', children: [
      { id: 'product', type: 'image', name: 'Product', path: 'product.png', left: 3, top: 4, mask_path: 'mask.png', opacity: 0.5 },
      { id: 'title', type: 'text', name: 'Title', text: 'Sale', left: 2, top: 12, width: 60, height: 32, font_family: 'Arial', font_postscript_name: 'ArialMT', font_size: 20, color: '#ff0000' },
    ] },
  ] };
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
function writeDoc() { fs.writeFileSync(path.join(root, 'design.json'), JSON.stringify(document)); }
async function invoke(request: any) {
  fs.writeFileSync(path.join(root, 'request.json'), JSON.stringify(request));
  return run({ args: ['--project', root, '--request', 'request.json'] });
}
const render = (output = 'preview.png') => invoke({ op: 'render', document_path: 'design.json', output_path: output });
const exportPsd = (output = 'design.psd', preview = 'preview.png') => invoke({ op: 'export_psd', document_path: 'design.json', preview_path: preview, output_path: output });
const readPsd = () => psd.readPsd(fs.readFileSync(path.join(root, 'design.psd')), { useImageData: true });

it('reports an older host without the PSD writer and retains its useful preview', async () => {
  writeDoc(); await render();
  const script = require.resolve('../../../resources/builtin/marketplace/agents/814b61b027f0/skills/image-compose/scripts/layered_document.js');
  fs.writeFileSync(path.join(root, 'cap.json'), JSON.stringify({ op: 'capabilities' }));
  fs.writeFileSync(path.join(root, 'export.json'), JSON.stringify({ op: 'export_psd', document_path: 'design.json', preview_path: 'preview.png', output_path: 'design.psd' }));
  const code = `const M=require('module'),resolve=M._resolveFilename;M._resolveFilename=function(name,...args){if(name==='ag-psd')throw Object.assign(new Error('missing'),{code:'MODULE_NOT_FOUND'});return resolve.call(this,name,...args)};const run=require(${JSON.stringify(script)});(async()=>{const cap=await run({args:['--project',${JSON.stringify(root)},'--request','cap.json']});let error;try{await run({args:['--project',${JSON.stringify(root)},'--request','export.json']})}catch(e){error=e.code}console.log(JSON.stringify({cap,error}))})().catch(()=>process.exitCode=1);`;
  const result = JSON.parse(execFileSync(process.execPath, ['-e', code], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 15000 }));
  expect(result.cap).toMatchObject({ psd_available: false, operations: ['render'] });
  expect(result.error).toBe('E_LAYERED_PSD_UNAVAILABLE');
  expect(fs.existsSync(path.join(root, 'preview.png'))).toBe(true);
  expect(fs.existsSync(path.join(root, 'design.psd'))).toBe(false);
});

it('preserves a group, image pixels, mask and native text plus a matching composite', async () => {
  writeDoc(); const source = fs.readFileSync(path.join(root, 'product.png'));
  expect(await render()).toMatchObject({ ok: true, layer_count: 3, text_layer_count: 1, model_calls: 0 });
  expect(await exportPsd()).toMatchObject({ ok: true, structure_verified: true, preview_verified: true });
  const file = fs.readFileSync(path.join(root, 'design.psd'));
  expect(file.toString('ascii', 0, 4)).toBe('8BPS');
  expect(file.readUInt16BE(4)).toBe(1);
  expect(file.readUInt16BE(22)).toBe(8);
  expect(file.readUInt16BE(24)).toBe(3);
  const independent = inspectPsdBytes(file);
  expect(independent.layers.find(layer => layer.name === 'Title')?.text).toBe('Sale');
  expect(independent.layers.find(layer => layer.name === 'Product')?.channels.get(-2)).toEqual(Buffer.from([255, 0]));
  expect(independent.layers.find(layer => layer.name === 'Product')?.channels.get(0)).toEqual(Buffer.from([255, 0]));
  expect(independent.layers.find(layer => layer.name === 'Foreground')?.section).toBe(1);
  const parsed = readPsd();
  expect(parsed.children.map((layer: any) => layer.name)).toEqual(['Background', 'Foreground']);
  const [product, title] = parsed.children[1].children;
  expect(product).toMatchObject({ name: 'Product', left: 3, top: 4 });
  expect(product.opacity).toBeCloseTo(128 / 255, 4);
  expect([...product.imageData.data]).toEqual([255, 0, 0, 255, 0, 255, 0, 128]);
  expect([...product.mask.imageData.data]).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
  expect(title.text).toMatchObject({ text: 'Sale', style: { font: { name: 'ArialMT' }, fontSize: 20 } });
  const preview = await sharp(path.join(root, 'preview.png')).ensureAlpha().raw().toBuffer();
  expect(Buffer.from(parsed.imageData.data)).toEqual(preview);
  expect(independent.rgba).toEqual(preview);
  expect(() => inspectPsdBytes(file.subarray(0, 100))).toThrow();
  expect(fs.readFileSync(path.join(root, 'product.png'))).toEqual(source);
});

it('reopens the durable source for a bounded revision and refuses a stale preview', async () => {
  writeDoc(); await render(); await exportPsd();
  const old = fs.readFileSync(path.join(root, 'design.psd'));
  document.layers[1].children[1].text = 'New'; writeDoc();
  await expect(exportPsd('revision.psd')).rejects.toThrow(/STALE/);
  expect(fs.existsSync(path.join(root, 'revision.psd'))).toBe(false);
  await render('revision.png'); await exportPsd('revision.psd', 'revision.png');
  const revised = psd.readPsd(fs.readFileSync(path.join(root, 'revision.psd')), { useImageData: true });
  expect(revised.children[1].children[1].text.text).toBe('New');
  expect([...revised.children[1].children[0].imageData.data]).toEqual([255, 0, 0, 255, 0, 255, 0, 128]);
  expect(fs.readFileSync(path.join(root, 'design.psd'))).toEqual(old);
});

it('exports a flat supplied image as one image layer without inventing native text', async () => {
  document.layers = [document.layers[0]]; writeDoc(); await render();
  expect(await exportPsd()).toMatchObject({ layer_count: 1, text_layer_count: 0 });
  const parsed = readPsd(); expect(parsed.children).toHaveLength(1); expect(parsed.children[0].text).toBeUndefined();
});

it.each([
  (d: any) => { d.canvas.width = 100000; },
  (d: any) => { d.layers[1].children[0].path = '../outside.png'; },
  (d: any) => { d.layers[1].children[0].blend_mode = 'multiply'; },
  (d: any) => { d.layers[1].children[1].orientation = 'vertical'; },
  (d: any) => { d.layers[1].children[1].font_size = NaN; },
  (d: any) => { d.layers[1].children[1].id = 'product'; },
  (d: any) => { d.layers[1].opacity = 0.3; },
  (d: any) => { d.layers[1].children[0].left = 64; },
  (d: any) => { d.layers[1].children[1].width = 5; },
  (d: any) => { d.layers[1].children[1].color = ['#ff0000']; },
  (d: any) => { d.layers[1].children[1].font_family = '   '; },
  (d: any) => { d.layers[1].children[1] = null; },
])('rejects unsupported or unsafe source without publishing a misleading preview (%#)', async mutate => {
  mutate(document); writeDoc(); await expect(render()).rejects.toThrow(/E_(LAYERED|IMAGE_ASSET_PATH)/);
  expect(fs.existsSync(path.join(root, 'preview.png'))).toBe(false);
});

it('protects originals, rejects existing outputs and detects preview tampering', async () => {
  writeDoc(); await expect(render('product.png')).rejects.toThrow(/E_LAYERED/);
  await render(); await expect(render()).rejects.toThrow(/EXISTS/);
  await sharp({ create: { width: 64, height: 48, channels: 4, background: '#ffffff' } }).png().toFile(path.join(root, 'preview.png'));
  await expect(exportPsd()).rejects.toThrow(/STALE/);
  expect(fs.existsSync(path.join(root, 'design.psd'))).toBe(false);
});

it('applies group visibility while preserving hidden children for future edits', async () => {
  document.layers[1].visible = false; writeDoc(); await render(); await exportPsd();
  const parsed = readPsd(); expect(parsed.children[1].hidden).toBe(true);
  expect(parsed.children[1].children).toHaveLength(2);
  expect([...await sharp(path.join(root, 'preview.png')).raw().toBuffer()].every((v, i) => v === [17, 34, 51, 255][i % 4])).toBe(true);
});

it('retains Unicode multiline text, zero opacity and partial raster mask values', async () => {
  const product = document.layers[1].children[0], title = document.layers[1].children[1];
  product.opacity = 0; title.text = 'Café\n新'; title.font_size = 12; title.height = 36;
  await sharp(Buffer.from([128, 64]), { raw: { width: 2, height: 1, channels: 1 } }).png().toFile(path.join(root, 'mask.png'));
  writeDoc(); await render(); await exportPsd();
  const parsed = readPsd();
  expect(parsed.children[1].children[0].opacity).toBe(0);
  expect([...parsed.children[1].children[0].mask.imageData.data]).toEqual([128, 128, 128, 255, 64, 64, 64, 255]);
  expect(parsed.children[1].children[1].text.text).toBe('Café\n新');
});

it('retains a partially transparent saturated pixel in the merged preview and its editable layer', async () => {
  await sharp(Buffer.from([255, 0, 0, 90]), { raw: { width: 1, height: 1, channels: 4 } })
    .png().toFile(path.join(root, 'edge.png'));
  document = { schema_version: 1, canvas: { width: 1, height: 1 }, layers: [
    { id: 'edge', type: 'image', name: 'Edge', path: 'edge.png' },
  ] };
  writeDoc(); await render(); await exportPsd();
  const independent = inspectPsdBytes(fs.readFileSync(path.join(root, 'design.psd')));
  // A 90/255 red pixel over PSD's white matte has exact RGB 255,165,165.
  expect([...independent.rgba]).toEqual([255, 165, 165, 90]);
  const reopened = readPsd();
  expect([...reopened.imageData.data]).toEqual([255, 0, 0, 90]);
  expect([...reopened.children[0].imageData.data]).toEqual([255, 0, 0, 90]);
});

it('rejects colored, translucent and mismatched masks without publishing an output', async () => {
  writeDoc();
  for (const pixel of [[255, 0, 0, 255], [255, 255, 255, 128]]) {
    await sharp(Buffer.from([...pixel, ...pixel]), { raw: { width: 2, height: 1, channels: 4 } }).png().toFile(path.join(root, 'mask.png'));
    await expect(render()).rejects.toThrow(/opaque grayscale/);
    expect(fs.existsSync(path.join(root, 'preview.png'))).toBe(false);
  }
  await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toFile(path.join(root, 'mask.png'));
  await expect(render()).rejects.toThrow(/mask dimensions/);
});

it('rejects an escaping symlink and preserves a concurrent output collision', async () => {
  writeDoc(); const escape = path.join(root, 'escape');
  fs.symlinkSync(os.tmpdir(), escape, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await expect(render('escape/should-not-exist.png')).rejects.toThrow(/E_IMAGE_ASSET_PATH/);
  } finally {
    // Remove this fixture's parent-pointing junction before recursive cleanup.
    fs.unlinkSync(escape);
  }
  const originalLink = fs.promises.link;
  vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
    if (String(target).endsWith('preview.png')) fs.writeFileSync(target, 'another operation');
    return originalLink(source, target);
  });
  await expect(render()).rejects.toThrow();
  expect(fs.readFileSync(path.join(root, 'preview.png'), 'utf8')).toBe('another operation');
  expect(fs.existsSync(path.join(root, 'preview.png.layered-source.json'))).toBe(false);
});

it('cleans up a failed preview publication so retry can succeed', async () => {
  writeDoc(); const originalLink = fs.promises.link; let links = 0;
  vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
    if (++links === 2) throw new Error('injected publication interruption');
    return originalLink(source, target);
  });
  await expect(render()).rejects.toThrow(/interruption/);
  expect(fs.existsSync(path.join(root, 'preview.png'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'preview.png.layered-source.json'))).toBe(false);
  vi.restoreAllMocks(); await render(); await exportPsd();
  expect(readPsd().children[1].children[1].text.text).toBe('Sale');
});
