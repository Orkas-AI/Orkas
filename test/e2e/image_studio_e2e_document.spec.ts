import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createCanvas } from '@napi-rs/canvas';
import { test } from './fixtures/web-app-eval';
import { expect } from './fixtures/orkas';

const studioPath = path.resolve(__dirname, '../../src/main/features/image_studio.ts');
const documentPath = path.resolve(__dirname, '../../src/main/features/image_studio_document.ts');
const scores = { intent_alignment: 90, composition: 90, craft: 90, text_legibility: 90, defect_freedom: 90, specificity: 90 };
function fixture(orkas: { createWorkspaceFile(name: string, content: string): string }, name: string) {
  const titles = ['春日产品', 'Details', 'Contact'];
  const pages = titles.map((title, index) => ({ id: `p${index + 1}`, entry: `pages/p${index + 1}.html`, required_copy: [title] }));
  const manifest = { schema_version: 2, route: 'compose', canvas: { width: 641, height: 359 },
    brief: { purpose: 'Product catalogue', audience: 'Customers', required_copy: [], must_include: [], must_avoid: [] },
    art_direction: { subject_world: 'Spring', one_job: 'Present the collection', visual_tradition: 'Editorial', composition: 'Headline and rule', signature_device: 'Blue rule', typography: 'Sans', color_light_material: 'White and blue' },
    generation_budget: { max_calls: 0 }, document: { pages, page_numbers: { start: 1 } } };
  const file = orkas.createWorkspaceFile(`${name}/image-manifest.json`, JSON.stringify(manifest));
  orkas.createWorkspaceFile(`${name}/theme.css`, 'html,body{margin:0;width:641px;height:359px;background:#fff}svg{display:block}.accent{fill:#2468ae}.number{position:absolute;bottom:10px;right:20px;font:16px sans-serif;color:#123}');
  for (const [index, page] of pages.entries()) orkas.createWorkspaceFile(`${name}/${page.entry}`, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="../theme.css"></head><body><svg width="641" height="300"><rect class="accent" x="20" y="180" width="601" height="80"/><text x="20" y="80" font-family="sans-serif" font-size="30">${titles[index]}</text></svg><div class="number"><span data-image-page-number></span> / <span data-image-page-count></span></div></body></html>`);
  return { root: path.dirname(file), file, manifest, titles };
}
async function operate(orkas: any, root: string, action: string, extra: Record<string, unknown> = {}) {
  return orkas.electronApp.evaluate(async ({ BrowserWindow }: any, args: any) => {
    const studio = (process as any).mainModule.require(args.studioPath), document = (process as any).mainModule.require(args.documentPath);
    const fs = (process as any).mainModule.require('node:fs'), path = (process as any).mainModule.require('node:path');
    const statePath = (id: string) => path.join(args.root, '.state', `${id}.json`);
    const controller = new AbortController();
    const approve = async (id: string) => {
      const preview = path.join(args.root, `${id}.png`);
      const inspection = await studio.snapshotImageStudioProject({ projectDirAbs: args.root, pageId: id, outputAbsPath: preview, stateAbsPath: statePath(id) });
      if (!inspection.ok) throw new Error(JSON.stringify(inspection.blockers));
      await studio.submitImageStudioDesignReview({ stateAbsPath: statePath(id), evidenceAbsPath: preview,
        verdict: 'passed', scope: 'Synthetic page fixture; final PDF independently decoded and rendered', findings: [], qualityScores: args.scores });
    };
    const exportBook = () => document.exportImageStudioDocument({ projectDir: args.root, statePath,
      scratchDir: path.join(args.root, '.scratch'), outputAbsPath: path.join(args.root, args.name || 'book.pdf'),
      ...(args.abort ? { signal: AbortSignal.abort() } : {}),
      ...(args.abortDuring ? { signal: controller.signal } : {}),
      ...(args.mutate ? { finalizeOutput: async () => { const file = path.join(args.root, 'theme.css'); fs.appendFileSync(file, 'body{color:red}'); } } : {}),
    });
    const beforeWindows = BrowserWindow.getAllWindows().length;
    if (args.action === 'approve') { for (const id of args.ids || ['p1', 'p2', 'p3']) await approve(id); }
    if (args.action === 'export') {
      if (args.failPrint || args.abortDuring || args.reorderDuring) {
        // Fault at the real print boundary, then restore in finally.
        let changed = false;
        const created = (_event: any, win: any) => {
          const print = win.webContents.printToPDF.bind(win.webContents);
          win.webContents.printToPDF = async (...options: any[]) => {
            if (args.failPrint) throw new Error('injected document print failure');
            const pending = print(...options);
            if (args.abortDuring) controller.abort();
            const bytes = await pending;
            if (args.reorderDuring && !changed) {
              changed = true; const file = path.join(args.root, 'image-manifest.json');
              const manifest = JSON.parse(fs.readFileSync(file, 'utf8')); manifest.document.pages.reverse(); fs.writeFileSync(file, JSON.stringify(manifest));
            }
            return bytes;
          };
        };
        const electron = (process as any).mainModule.require('electron'); electron.app.on('browser-window-created', created);
        try { return { result: await exportBook(), windows: BrowserWindow.getAllWindows().length - beforeWindows }; } catch (error) { return { error: String(error), windows: BrowserWindow.getAllWindows().length - beforeWindows }; }
        finally { electron.app.removeListener('browser-window-created', created); }
      }
      try { return { result: await exportBook(), windows: BrowserWindow.getAllWindows().length - beforeWindows }; }
      catch (error) { return { error: String(error), windows: BrowserWindow.getAllWindows().length - beforeWindows }; }
    }
    return document.inspectImageStudioDocument(args.root, statePath);
  }, { root, action, studioPath, documentPath, scores, ...extra });
}
async function verifyPdf(file: string, root: string, ids: string[], titles: string[], numbering = true) {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), isEvalSupported: false });
  try {
    const document = await task.promise; expect(document.numPages).toBe(ids.length);
    for (const [index, id] of ids.entries()) {
      const page = await document.getPage(index + 1), viewport = page.getViewport({ scale: 4 / 3 });
      expect(viewport.width).toBeCloseTo(641, 1); expect(viewport.height).toBeCloseTo(359, 1);
      const text = (await page.getTextContent()).items.map((item: any) => item.str || '').join('').normalize('NFKC');
      if (titles[index]) expect(text).toContain(titles[index]);
      if (numbering) expect(text).toMatch(new RegExp(`${index + 1}\\s*/\\s*${ids.length}`));
      const ops = await page.getOperatorList();
      if (titles[index]) { expect(ops.fnArray).toContain(pdfjs.OPS.showText); expect(ops.fnArray).toContain(pdfjs.OPS.constructPath); }
      const canvas = createCanvas(641, 359); await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
      const actual = await sharp(canvas.toBuffer('image/png')).removeAlpha().raw().toBuffer();
      const expected = await sharp(path.join(root, `${id}.png`)).flatten({ background: '#fff' }).removeAlpha().raw().toBuffer();
      expect(actual.reduce((sum, value, i) => sum + Math.abs(value - expected[i]), 0) / actual.length).toBeLessThan(4);
    }
  } finally { await task.destroy(); }
}

test('creates a durable three-page catalogue, modifies one page, reorders and delivers current vectors', async ({ sdkOrkas: orkas }) => {
  const input = fixture(orkas, 'book-main'), original = readFileSync(path.join(input.root, 'pages/p1.html'));
  expect((await operate(orkas, input.root, 'status')).ready_to_export).toBe(false);
  expect((await operate(orkas, input.root, 'approve')).ready_to_export).toBe(true);
  const detailPreview = path.join(input.root, 'p2.png');
  const reviewedPreview = readFileSync(detailPreview);
  const reviewedStatePath = path.join(input.root, '.state/p2.json');
  const reviewedState = readFileSync(reviewedStatePath);
  writeFileSync(detailPreview, readFileSync(path.join(input.root, 'p1.png')));
  const replacedPreview = await operate(orkas, input.root, 'status');
  expect(replacedPreview.ready_to_export).toBe(false);
  expect(replacedPreview.pages[1]).toMatchObject({
    id: 'p2', ok: true, evidence_current: false, review_current: false, next_operation: 'project.snapshot',
  });
  expect(replacedPreview.pages.map((page: any) => page.review_current)).toEqual([true, false, true]);
  const rejected = await operate(orkas, input.root, 'export', { name: 'changed-preview.pdf' });
  expect(rejected.error).toContain('E_IMAGE_REVIEW_EVIDENCE_CHANGED');
  expect(existsSync(path.join(input.root, 'changed-preview.pdf'))).toBe(false);
  expect(readFileSync(reviewedStatePath)).toEqual(reviewedState);
  writeFileSync(detailPreview, reviewedPreview);
  const result = await operate(orkas, input.root, 'export'); expect(result.windows).toBe(0); expect(result.result.page_count).toBe(3);
  await verifyPdf(path.join(input.root, 'book.pdf'), input.root, ['p1', 'p2', 'p3'], input.titles);
  const previous = readFileSync(path.join(input.root, 'book.pdf'));
  const details = path.join(input.root, 'pages/p2.html'); writeFileSync(details, readFileSync(details, 'utf8').replace('Details', 'Details revised'));
  input.manifest.document.pages[1].required_copy = ['Details revised']; writeFileSync(input.file, JSON.stringify(input.manifest));
  const status = await operate(orkas, input.root, 'status');
  expect(status.pages.map((page: any) => page.review_current)).toEqual([true, false, true]);
  const blocked = await operate(orkas, input.root, 'export', { name: 'incomplete.pdf' }); expect(blocked.error).toContain('E_IMAGE_REVIEW'); expect(existsSync(path.join(input.root, 'incomplete.pdf'))).toBe(false);
  await operate(orkas, input.root, 'approve', { ids: ['p2'] });
  input.manifest.document.pages.reverse(); writeFileSync(input.file, JSON.stringify(input.manifest));
  expect((await operate(orkas, input.root, 'status')).pages.map((page: any) => page.review_current)).toEqual([false, true, false]);
  await operate(orkas, input.root, 'approve', { ids: ['p3', 'p1'] });
  expect((await operate(orkas, input.root, 'export', { name: 'revision.pdf' })).result.pages).toEqual(['p3', 'p2', 'p1']);
  await verifyPdf(path.join(input.root, 'revision.pdf'), input.root, ['p3', 'p2', 'p1'], ['Contact', 'Details revised', '春日产品']);
  expect(readFileSync(path.join(input.root, 'book.pdf'))).toEqual(previous); expect(readFileSync(path.join(input.root, 'pages/p1.html'))).toEqual(original);
  expect(readdirSync(path.join(input.root, '.scratch'))).toEqual([]);
  await test.info().attach('catalogue.pdf', { path: path.join(input.root, 'revision.pdf'), contentType: 'application/pdf' });
  const proof = test.info().outputPath('catalogue-source.json');
  writeFileSync(proof, JSON.stringify({ manifest: JSON.parse(readFileSync(input.file, 'utf8')), theme: readFileSync(path.join(input.root, 'theme.css'), 'utf8'),
    pages: input.manifest.document.pages.map(page => ({ id: page.id, html: readFileSync(path.join(input.root, page.entry), 'utf8'), preview_png_base64: readFileSync(path.join(input.root, `${page.id}.png`)).toString('base64') })) }));
  await test.info().attach('catalogue-source', { path: proof, contentType: 'application/json' });
});

test('retains reviewed pages after a print failure or cancellation and resumes without duplicate output', async ({ sdkOrkas: orkas }) => {
  const input = fixture(orkas, 'book-recovery'); await operate(orkas, input.root, 'approve');
  const state = readFileSync(path.join(input.root, '.state/p1.json'));
  const failure = await operate(orkas, input.root, 'export', { failPrint: true });
  expect(failure.error).toContain('injected document print failure'); expect(failure.windows).toBe(0); expect(existsSync(path.join(input.root, 'book.pdf'))).toBe(false);
  const aborted = await operate(orkas, input.root, 'export', { abort: true }); expect(aborted.error).toContain('AbortError');
  expect((await operate(orkas, input.root, 'status')).ready_to_export).toBe(true); expect(readFileSync(path.join(input.root, '.state/p1.json'))).toEqual(state);
  expect((await operate(orkas, input.root, 'export')).result.page_count).toBe(3);
  const previous = readFileSync(path.join(input.root, 'book.pdf'));
  expect((await operate(orkas, input.root, 'export')).error).toContain('EEXIST'); expect(readFileSync(path.join(input.root, 'book.pdf'))).toEqual(previous);
  expect(readdirSync(path.join(input.root, '.scratch'))).toEqual([]);
});

test('shared style changes invalidate all affected pages and reject stale publication', async ({ sdkOrkas: orkas }) => {
  const input = fixture(orkas, 'book-shared'); await operate(orkas, input.root, 'approve');
  const result = await operate(orkas, input.root, 'export', { mutate: true });
  expect(result.error).toContain('E_IMAGE_REVIEW_EVIDENCE_STALE'); expect(existsSync(path.join(input.root, 'book.pdf'))).toBe(false);
  expect((await operate(orkas, input.root, 'status')).pages.every((page: any) => !page.review_current)).toBe(true);
  await operate(orkas, input.root, 'approve'); expect((await operate(orkas, input.root, 'export')).result.page_count).toBe(3);
});

test('delivers eight pages including a photo and blank divider without rasterizing vector pages', async ({ sdkOrkas: orkas }) => {
  const input = fixture(orkas, 'book-eight');
  const value: any = input.manifest; delete value.document.page_numbers;
  for (let index = 4; index <= 8; index++) {
    value.document.pages.push({ id: `p${index}`, entry: `pages/p${index}.html`, required_copy: [`Collection ${index}`] });
    orkas.createWorkspaceFile(`book-eight/pages/p${index}.html`, `<!doctype html><html><head><link rel="stylesheet" href="../theme.css"></head><body><svg width="641" height="300"><rect class="accent" x="20" y="180" width="601" height="80"/><text x="20" y="80" font-size="30">Collection ${index}</text></svg></body></html>`);
  }
  const first = path.join(input.root, 'pages/p1.html'); writeFileSync(first, readFileSync(first, 'utf8').replace(/<div class="number">.*?<\/div>/, ''));
  writeFileSync(path.join(input.root, 'photo.png'), await sharp({ create: { width: 641, height: 359, channels: 3, background: '#ab3456' } }).png().toBuffer());
  writeFileSync(path.join(input.root, 'pages/p2.html'), '<!doctype html><html><head><link rel="stylesheet" href="../theme.css"></head><body><img src="../photo.png" style="display:block;width:641px;height:359px"></body></html>');
  writeFileSync(path.join(input.root, 'pages/p3.html'), '<!doctype html><html><head><link rel="stylesheet" href="../theme.css"></head><body></body></html>');
  value.document.pages[1].required_copy = []; value.document.pages[2].required_copy = [];
  writeFileSync(input.file, JSON.stringify(value));
  const ids = value.document.pages.map((page: any) => page.id);
  await operate(orkas, input.root, 'approve', { ids });
  const started = performance.now();
  const result = await operate(orkas, input.root, 'export'); expect(result.result.page_count).toBe(8); expect(result.windows).toBe(0);
  const elapsedMs = performance.now() - started;
  await verifyPdf(path.join(input.root, 'book.pdf'), input.root, ids, ['春日产品', '', '', ...Array.from({ length: 5 }, (_, i) => `Collection ${i + 4}`)], false);
  const measurement = test.info().outputPath('eight-page-export-measurement.json');
  writeFileSync(measurement, JSON.stringify({ measurement: 'Electron evaluate dispatch through complete native book export; excludes source creation and page review', elapsedMs, pages: 8, bytes: readFileSync(path.join(input.root, 'book.pdf')).length }));
  await test.info().attach('eight-page-export-measurement', { path: measurement, contentType: 'application/json' });
});

test('rejects an order changed during printing and cancels an active print without publishing a partial book', async ({ sdkOrkas: orkas }) => {
  const input = fixture(orkas, 'book-active');
  delete (input.manifest.document as any).page_numbers;
  for (const page of input.manifest.document.pages) {
    const file = path.join(input.root, page.entry); writeFileSync(file, readFileSync(file, 'utf8').replace(/<div class="number">.*?<\/div>/, ''));
  }
  writeFileSync(input.file, JSON.stringify(input.manifest)); await operate(orkas, input.root, 'approve');
  const reordered = await operate(orkas, input.root, 'export', { name: 'old-order.pdf', reorderDuring: true });
  expect(reordered.error).toContain('E_IMAGE_DOCUMENT_CHANGED'); expect(existsSync(path.join(input.root, 'old-order.pdf'))).toBe(false);
  expect((await operate(orkas, input.root, 'status')).ready_to_export).toBe(true);
  const aborted = await operate(orkas, input.root, 'export', { name: 'aborted.pdf', abortDuring: true });
  expect(aborted.error).toBeTruthy(); expect(aborted.windows).toBe(0); expect(existsSync(path.join(input.root, 'aborted.pdf'))).toBe(false);
  const current = await operate(orkas, input.root, 'export'); expect(current.result.pages).toEqual(['p3', 'p2', 'p1']);
  await verifyPdf(path.join(input.root, 'book.pdf'), input.root, ['p3', 'p2', 'p1'], ['Contact', 'Details', '春日产品'], false);
  expect(readdirSync(path.join(input.root, '.scratch'))).toEqual([]);
});

test('uses page selectors through the actual Agent tool, publishes only final outputs and preserves old versions', async ({ sdkOrkas: orkas }) => {
  const input = fixture(orkas, 'book-agent-tool');
  const result = await orkas.electronApp!.evaluate(async (_, args) => {
    const owner = (process as any).mainModule.require(args.toolPath);
    const path = (process as any).mainModule.require('node:path');
    const published: string[] = [];
    const options = { userId: 'document-native-user', agentId: '814b61b027f0', extraRoots: [args.root],
      onOutputsPublished: async (files: string[]) => { published.push(...files.map(file => path.basename(file))); } };
    const tool = owner.createImageStudioTool(options), ctx = { workingDir: args.root };
    const call = async (op: string, extra: object = {}) => {
      const result = await tool.execute({ op, project_dir: args.root, ...extra }, ctx);
      if (result.isError) throw new Error(result.content);
      return { value: JSON.parse(result.content.split('\n\n<file-renamed>\n', 1)[0]), images: result.images?.length || 0 };
    };
    const initial = await call('project.inspect');
    for (const page_id of ['p1', 'p2', 'p3']) {
      await call('project.inspect', { page_id });
      const snapshot = await call('project.snapshot', { page_id, output_path: `${page_id}.png` });
      if (snapshot.images !== 1) throw new Error('Missing page attachment');
      await call('project.submit_design_review', { page_id, evidence_path: snapshot.value.inspection.evidence_path,
        review_verdict: 'passed', review_scope: 'Actual Agent-tool page fixture', review_findings: [], quality_scores: args.scores });
      await call('project.export', { page_id, output_path: `out/${page_id}.png` });
    }
    const first = await call('project.export', { output_path: 'out/book.pdf' });
    const second = await call('project.export', { output_path: 'out/book.pdf', format: 'pdf' });
    const ambiguous = await tool.execute({ op: 'project.export', project_dir: args.root, output_path: 'out/ambiguous.png' }, ctx);
    const foreign = await owner.createImageStudioTool({ ...options, agentId: 'another-agent' }).execute({ op: 'project.export', project_dir: args.root, output_path: 'out/foreign.pdf' }, ctx);
    const later = owner.createImageStudioTool({ ...options, turnId: 'later' });
    const status = JSON.parse((await later.execute({ op: 'project.status', project_dir: args.root }, ctx)).content);
    return { initialPages: initial.value.document.pages.map((page: any) => page.id), inventoryImages: initial.images,
      first: path.basename(first.value.output_path), second: path.basename(second.value.output_path), pageCount: first.value.page_count,
      format: first.value.format, ready: status.document.ready_to_export, published,
      ambiguous: JSON.parse(ambiguous.content).error_code, foreign: foreign.isError === true };
  }, { root: input.root, scores, toolPath: path.resolve(__dirname, '../../src/main/model/core-agent/image-studio-tool.ts') });
  expect(result).toEqual({ initialPages: ['p1', 'p2', 'p3'], inventoryImages: 0, first: 'book.pdf', second: 'book-2.pdf',
    pageCount: 3, format: 'pdf', ready: true, published: ['p1.png', 'p2.png', 'p3.png', 'book.pdf', 'book-2.pdf'],
    ambiguous: 'E_IMAGE_DOCUMENT_PAGE_REQUIRED', foreign: true });
  expect(existsSync(path.join(input.root, 'out/ambiguous.png'))).toBe(false);
  expect(existsSync(path.join(input.root, 'out/foreign.pdf'))).toBe(false);
  await verifyPdf(path.join(input.root, 'out/book.pdf'), input.root, ['p1', 'p2', 'p3'], input.titles);
  await verifyPdf(path.join(input.root, 'out/book-2.pdf'), input.root, ['p1', 'p2', 'p3'], input.titles);
  await test.info().attach('agent-tool-catalogue.pdf', { path: path.join(input.root, 'out/book.pdf'), contentType: 'application/pdf' });
});
