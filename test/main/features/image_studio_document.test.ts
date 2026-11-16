import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectImageStudioProject } from '../../../src/main/features/image_studio';

let root: string;
const book = () => ({ schema_version: 2, route: 'compose', canvas: { width: 640, height: 360 },
  brief: { purpose: 'Product booklet', audience: 'Customers', required_copy: [], must_include: [], must_avoid: [] },
  art_direction: { subject_world: 'Products', one_job: 'Introduce a collection', visual_tradition: 'Editorial', composition: 'Type and image', signature_device: 'Blue rule', typography: 'Sans', color_light_material: 'White and blue' },
  generation_budget: { max_calls: 0 }, document: { pages: [
    { id: 'cover', entry: 'pages/cover.html', required_copy: ['Cover'] },
    { id: 'details', entry: 'pages/details.html', required_copy: ['Details'] },
  ] } });
async function write(value = book()) { await fs.writeFile(path.join(root, 'image-manifest.json'), JSON.stringify(value)); }
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-book-'));
  await fs.mkdir(path.join(root, 'pages'));
  await fs.writeFile(path.join(root, 'theme.css'), 'body { color: blue; }');
  for (const [id, title] of [['cover', 'Cover'], ['details', 'Details']]) await fs.writeFile(path.join(root, `pages/${id}.html`), `<html><head><link rel="stylesheet" href="../theme.css"></head><body><svg><text>${title}</text></svg></body></html>`);
  await write();
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
describe('durable fixed-page booklet sources', () => {
  it('requires an explicit page and inspects the selected page copy and shared resources', async () => {
    expect((await inspectImageStudioProject(root)).blockers.map(x => x.code)).toContain('E_IMAGE_DOCUMENT_PAGE_REQUIRED');
    const result = await inspectImageStudioProject(root, undefined, 'cover');
    expect(result.ok).toBe(true); expect(result.manifest?.brief.required_copy).toEqual(['Cover']);
    expect(result.resources).toContain('theme.css');
    expect((await inspectImageStudioProject(root, undefined, 'missing')).blockers.map(x => x.code)).toContain('E_IMAGE_DOCUMENT_PAGE_UNKNOWN');
  });
  it('invalidates only dependencies of an edited page; shared style changes invalidate both', async () => {
    const before = await Promise.all(['cover', 'details'].map(id => inspectImageStudioProject(root, undefined, id)));
    await fs.appendFile(path.join(root, 'pages/details.html'), '<!-- revised -->');
    expect((await inspectImageStudioProject(root, undefined, 'cover')).signature).toBe(before[0].signature);
    expect((await inspectImageStudioProject(root, undefined, 'details')).signature).not.toBe(before[1].signature);
    await fs.appendFile(path.join(root, 'theme.css'), 'svg { fill: navy; }');
    for (const [index, id] of ['cover', 'details'].entries()) expect((await inspectImageStudioProject(root, undefined, id)).signature).not.toBe(before[index].signature);
  });
  it('preserves page identity through reorder and binds page numbers to the current order', async () => {
    const before = (await inspectImageStudioProject(root, undefined, 'cover')).signature;
    const value = book(); value.document.pages.reverse(); await write(value);
    expect((await inspectImageStudioProject(root, undefined, 'cover')).signature).toBe(before);
    for (const id of ['cover', 'details']) await fs.appendFile(path.join(root, `pages/${id}.html`), '<span data-image-page-number></span>');
    (value.document as any).page_numbers = { start: 1 }; await write(value);
    const numbered = await inspectImageStudioProject(root, undefined, 'cover');
    expect(numbered.page?.number).toBe(2);
    value.document.pages.reverse(); await write(value);
    expect((await inspectImageStudioProject(root, undefined, 'cover')).signature).not.toBe(numbered.signature);
  });
  it('admits the supported page-count boundary and rejects missing or escaped page resources', async () => {
    const value = book(); value.document.pages = Array.from({ length: 32 }, (_, i) => ({ id: `p${i}`, entry: 'pages/cover.html', required_copy: ['Cover'] }));
    await write(value); expect((await inspectImageStudioProject(root, undefined, 'p31')).ok).toBe(true);
    await fs.rm(path.join(root, 'theme.css'));
    expect((await inspectImageStudioProject(root, undefined, 'p31')).ok).toBe(false);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-book-outside-'));
    try {
      const file = path.join(outside, 'external.css'); await fs.writeFile(file, 'body{color:red}');
      await fs.symlink(file, path.join(root, 'theme.css'));
      const result = await inspectImageStudioProject(root, undefined, 'p31');
      expect(result.ok).toBe(false); expect(result.resources).not.toContain(file);
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });
  it.each([-1, 0, 1])('enforces the document byte bound at 1 MiB %+d', async delta => {
    const value: any = book(); value.padding = '';
    value.padding = 'x'.repeat(1_048_576 + delta - Buffer.byteLength(JSON.stringify(value)));
    await write(value); expect((await fs.stat(path.join(root, 'image-manifest.json'))).size).toBe(1_048_576 + delta);
    expect((await inspectImageStudioProject(root, undefined, 'cover')).ok).toBe(delta <= 0);
  });
  it.each([0, 1, 9999, 10000])('validates visible numbering start %d without changing original pages', async start => {
    const value: any = book(); value.document.page_numbers = { start }; await write(value);
    await fs.appendFile(path.join(root, 'pages/cover.html'), '<span data-image-page-number></span>');
    expect((await inspectImageStudioProject(root, undefined, 'cover')).ok).toBe(start >= 1 && start <= 9999);
  });
  it.each(['duplicate', 'outside', 'empty', 'too-many', 'legacy', 'conflicting-source'])('rejects %s without writing source or evidence', async kind => {
    const value: any = book();
    if (kind === 'duplicate') value.document.pages[1].id = 'cover';
    if (kind === 'outside') value.document.pages[0].entry = '../outside.html';
    if (kind === 'empty') value.document.pages = [];
    if (kind === 'too-many') value.document.pages = Array.from({ length: 33 }, (_, i) => ({ ...value.document.pages[0], id: `p${i}` }));
    if (kind === 'legacy') value.schema_version = 1;
    if (kind === 'conflicting-source') value.entry = 'index.html';
    await write(value); const original = await fs.readFile(path.join(root, 'image-manifest.json'));
    expect((await inspectImageStudioProject(root, undefined, 'cover')).ok).toBe(false);
    expect(await fs.readFile(path.join(root, 'image-manifest.json'))).toEqual(original);
  });
});

it('accepts the shipped on-demand document example as an extension of the canonical source', async () => {
  const base = path.resolve(process.cwd(), 'resources/builtin/marketplace/agents/814b61b027f0/skills');
  const router = await fs.readFile(path.join(base, 'image-router/SKILL.md'), 'utf8');
  const reference = await fs.readFile(path.join(base, 'image-compose/references/multipage-documents.md'), 'utf8');
  const manifest = JSON.parse(router.match(/```json\s*([\s\S]*?)\s*```/)![1]);
  delete manifest.entry; delete manifest.raster_source;
  Object.assign(manifest, JSON.parse(reference.match(/```json\s*([\s\S]*?)\s*```/)![1]), { schema_version: 2, route: 'compose', generation_budget: { max_calls: 0 } });
  const { compileImageStudioDocument } = await import('../../../src/main/features/image_studio_document');
  const { validateImageStudioManifest } = await import('../../../src/main/features/image_studio');
  const document = compileImageStudioDocument(manifest, validateImageStudioManifest)!;
  expect(document.pages.map(page => page.id)).toEqual(['cover', 'products']);
  expect(document.pages[1].required_copy).toContain('$49'); expect(document.numberStart).toBe(1);
});
