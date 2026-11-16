import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createCanvas } from '@napi-rs/canvas';
import { test } from './fixtures/web-app-eval';
import { expect } from './fixtures/orkas';

const modulePath = path.resolve(__dirname, '../../src/main/features/image_studio.ts');
const scores = { intent_alignment: 90, composition: 90, craft: 90, text_legibility: 90, defect_freedom: 90, specificity: 90 };
function project(orkas: { createWorkspaceFile(name: string, content: string): string }, name: string, extra = '') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#f5eddf"/><path d="M20 340 L20 300 L620 300 L620 340Z" fill="#336699"/><text x="30" y="80" font-family="sans-serif" font-size="32">春日设计</text><text x="30" y="140" font-family="sans-serif" font-size="24">Vector proof</text></svg>`;
  const entry = orkas.createWorkspaceFile(`${name}/index.html`, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:640px;height:360px}svg{display:block}${extra}</style></head><body>${svg}</body></html>`);
  orkas.createWorkspaceFile(`${name}/source.svg`, svg);
  orkas.createWorkspaceFile(`${name}/image-manifest.json`, JSON.stringify({ schema_version: 1, route: 'compose', entry: 'index.html', canvas: { width: 640, height: 360 },
    brief: { purpose: 'Web illustration', audience: 'Designers', required_copy: ['春日设计', 'Vector proof'], must_include: [], must_avoid: [] },
    art_direction: { subject_world: 'Spring', one_job: 'Present a title', visual_tradition: 'Editorial', composition: 'Type above a rule', signature_device: 'Blue rule', typography: 'Sans serif', color_light_material: 'Cream' },
    generation_budget: { max_calls: 0 } }));
  const root = path.dirname(entry);
  return { projectDirAbs: root, outputAbsPath: path.join(root, 'preview.png'), stateAbsPath: path.join(root, 'state.json') };
}
async function inspectPdf(file: string, preview: string, footer?: string) {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), isEvalSupported: false });
  try {
    const doc = await task.promise;
    expect(doc.numPages).toBe(1);
    const page = await doc.getPage(1), viewport = page.getViewport({ scale: 4 / 3 });
    expect(viewport.width).toBeCloseTo(640, 1); expect(viewport.height).toBeCloseTo(360, 1);
    const text = (await page.getTextContent()).items.map((item: any) => item.str || '').join('').normalize('NFKC');
    // Chromium may map a shared CJK glyph to its compatibility radical;
    // compare Unicode-normalized wording and independently rendered glyphs.
    expect(text).toContain('春日设计'); expect(text).toContain('Vector proof');
    if (footer) expect(text).toContain(footer);
    const ops = await page.getOperatorList();
    expect(ops.fnArray).toContain(pdfjs.OPS.showText);
    expect(ops.fnArray).toContain(pdfjs.OPS.constructPath);
    const canvas = createCanvas(640, 360);
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
    const actual = await sharp(canvas.toBuffer('image/png')).removeAlpha().raw().toBuffer();
    const expected = await sharp(preview).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer();
    expect(actual.length).toBe(expected.length);
    const difference = actual.reduce((sum, value, index) => sum + Math.abs(value - expected[index]), 0) / actual.length;
    // Independent PDF rasterization permits glyph antialiasing, never a missing
    // page, cropped bottom rule or a changed background.
    expect(difference).toBeLessThan(4);
    for (const [x, y] of [[5, 5], [630, 350], [40, 320]]) {
      const offset = (y * 640 + x) * 3;
      for (let channel = 0; channel < 3; channel++) expect(Math.abs(actual[offset + channel] - expected[offset + channel])).toBeLessThan(8);
    }
  } finally { await task.destroy(); }
}

test('exports requested CJK vector PDF, preserves sources and keeps PNG-only delivery unchanged', async ({ sdkOrkas: orkas }) => {
  const input = project(orkas, 'vector-pdf'), root = input.projectDirAbs;
  const source = readFileSync(path.join(root, 'source.svg'));
  const result = await orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
    const studio = (process as any).mainModule.require(args.modulePath);
    const fs = (process as any).mainModule.require('node:fs'), path = (process as any).mainModule.require('node:path');
    const before = BrowserWindow.getAllWindows().length;
    const inspection = await studio.snapshotImageStudioProject(args.input);
    if (!inspection.ok) return { blockers: inspection.blockers };
    let reviewRequired = false;
    try { await studio.exportImageStudioProject({ stateAbsPath: args.input.stateAbsPath, outputAbsPath: path.join(args.input.projectDirAbs, 'blocked.pdf'), format: 'pdf' }); }
    catch (error) { reviewRequired = String(error).includes('E_IMAGE_REVIEW_PASS_REQUIRED'); }
    await studio.submitImageStudioDesignReview({ stateAbsPath: args.input.stateAbsPath, evidenceAbsPath: args.input.outputAbsPath,
      verdict: 'passed', scope: 'Synthetic state-transition fixture; PDF pixels are independently checked', findings: [], qualityScores: args.scores });
    await studio.exportImageStudioProject({ stateAbsPath: args.input.stateAbsPath, outputAbsPath: path.join(args.input.projectDirAbs, 'final.png'), format: 'png' });
    const noImplicitPdf = !fs.existsSync(path.join(args.input.projectDirAbs, 'final.pdf'));
    await studio.exportImageStudioProject({ stateAbsPath: args.input.stateAbsPath, outputAbsPath: path.join(args.input.projectDirAbs, 'final.pdf'), format: 'pdf' });
    let collisionRejected = false;
    try { await studio.exportImageStudioProject({ stateAbsPath: args.input.stateAbsPath, outputAbsPath: path.join(args.input.projectDirAbs, 'final.pdf'), format: 'pdf' }); }
    catch (error) { collisionRejected = String(error).includes('EEXIST'); }
    return { reviewRequired, noImplicitPdf, collisionRejected, windowsRemaining: BrowserWindow.getAllWindows().length - before };
  }, { input, modulePath, scores });
  expect(result).toEqual({ reviewRequired: true, noImplicitPdf: true, collisionRejected: true, windowsRemaining: 0 });
  expect(existsSync(path.join(root, 'blocked.pdf'))).toBe(false);
  expect(readFileSync(path.join(root, 'source.svg'))).toEqual(source);
  await inspectPdf(path.join(root, 'final.pdf'), path.join(root, 'final.png'));
  await test.info().attach('vector-delivery.pdf', { path: path.join(root, 'final.pdf'), contentType: 'application/pdf' });
  await test.info().attach('vector-preview.png', { path: path.join(root, 'final.png'), contentType: 'image/png' });
  await test.info().attach('vector-source.svg', { path: path.join(root, 'source.svg'), contentType: 'image/svg+xml' });
  const original = readFileSync(path.join(root, 'final.pdf'));
  const html = readFileSync(path.join(root, 'index.html'), 'utf8');
  writeFileSync(path.join(root, 'index.html'), html.replace('#336699', '#993366'));
  const revision = await orkas.electronApp!.evaluate(async (_, args) => {
    const studio = (process as any).mainModule.require(args.modulePath);
    let staleRejected = false;
    try { await studio.exportImageStudioProject({ stateAbsPath: args.input.stateAbsPath, outputAbsPath: args.next, format: 'pdf' }); }
    catch (error) { staleRejected = String(error).includes('E_IMAGE_REVIEW_EVIDENCE_STALE'); }
    await studio.snapshotImageStudioProject(args.input);
    await studio.submitImageStudioDesignReview({ stateAbsPath: args.input.stateAbsPath, evidenceAbsPath: args.input.outputAbsPath,
      verdict: 'passed', scope: 'Revised fixture', findings: [], qualityScores: args.scores });
    await studio.exportImageStudioProject({ stateAbsPath: args.input.stateAbsPath, outputAbsPath: args.next, format: 'pdf' });
    return staleRejected;
  }, { input, modulePath, scores, next: path.join(root, 'revision.pdf') });
  expect(revision).toBe(true); expect(readFileSync(path.join(root, 'final.pdf'))).toEqual(original);
  await inspectPdf(path.join(root, 'revision.pdf'), input.outputAbsPath);
});

test('rejects changed print layout without output and recovers after print-style repair', async ({ sdkOrkas: orkas }) => {
  const input = project(orkas, 'print-mismatch', '@media print{svg{display:none!important}}');
  const result = await orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
    const studio = (process as any).mainModule.require(args.modulePath);
    const path = (process as any).mainModule.require('node:path');
    const before = BrowserWindow.getAllWindows().length;
    await studio.snapshotImageStudioProject(args.input);
    await studio.submitImageStudioDesignReview({ stateAbsPath: args.input.stateAbsPath, evidenceAbsPath: args.input.outputAbsPath,
      verdict: 'passed', scope: 'Print mismatch fixture', findings: [], qualityScores: args.scores });
    let mismatch = false;
    try { await studio.exportImageStudioProject({ stateAbsPath: args.input.stateAbsPath, outputAbsPath: path.join(args.input.projectDirAbs, 'bad.pdf'), format: 'pdf' }); }
    catch (error) { mismatch = String(error).includes('E_IMAGE_PDF_PREVIEW_MISMATCH'); }
    return { mismatch, windowsRemaining: BrowserWindow.getAllWindows().length - before };
  }, { input, modulePath, scores });
  expect(result).toEqual({ mismatch: true, windowsRemaining: 0 });
  expect(existsSync(path.join(input.projectDirAbs, 'bad.pdf'))).toBe(false);
  const repaired = project(orkas, 'print-mismatch');
  await orkas.electronApp!.evaluate(async (_, args) => {
    const studio = (process as any).mainModule.require(args.modulePath);
    await studio.snapshotImageStudioProject(args.input);
    await studio.submitImageStudioDesignReview({ stateAbsPath: args.input.stateAbsPath, evidenceAbsPath: args.input.outputAbsPath,
      verdict: 'passed', scope: 'Repaired print fixture', findings: [], qualityScores: args.scores });
    await studio.exportImageStudioProject({ stateAbsPath: args.input.stateAbsPath, outputAbsPath: args.out, format: 'pdf' });
  }, { input: repaired, modulePath, scores, out: path.join(input.projectDirAbs, 'fixed.pdf') });
  await inspectPdf(path.join(input.projectDirAbs, 'fixed.pdf'), input.outputAbsPath);
});

test('preserves the reviewed candidate after a print failure and succeeds on an explicit later attempt', async ({ sdkOrkas: orkas }) => {
  const input = project(orkas, 'pdf-failure');
  const result = await orkas.electronApp!.evaluate(async ({ app, BrowserWindow }, args) => {
    const studio = (process as any).mainModule.require(args.modulePath);
    const fs = (process as any).mainModule.require('node:fs'), path = (process as any).mainModule.require('node:path');
    await studio.snapshotImageStudioProject(args.input);
    await studio.submitImageStudioDesignReview({ stateAbsPath: args.input.stateAbsPath, evidenceAbsPath: args.input.outputAbsPath,
      verdict: 'passed', scope: 'Print failure fixture', findings: [], qualityScores: args.scores });
    const beforeState = fs.readFileSync(args.input.stateAbsPath).toString('base64');
    const beforeImage = fs.readFileSync(args.input.outputAbsPath).toString('base64');
    const count = BrowserWindow.getAllWindows().length;
    const fault = (_: unknown, win: Electron.BrowserWindow) => { win.webContents.printToPDF = async () => { throw new Error('fixture-print-failure'); }; };
    const output = path.join(args.input.projectDirAbs, 'failed.pdf');
    let rejected = false;
    app.on('browser-window-created', fault);
    try { await studio.exportImageStudioProject({ stateAbsPath: args.input.stateAbsPath, outputAbsPath: output, format: 'pdf' }); }
    catch (error) { rejected = String(error).includes('fixture-print-failure'); }
    finally { app.removeListener('browser-window-created', fault); }
    const preserved = beforeState === fs.readFileSync(args.input.stateAbsPath).toString('base64')
      && beforeImage === fs.readFileSync(args.input.outputAbsPath).toString('base64');
    const noOutput = !fs.existsSync(output), windowsRemaining = BrowserWindow.getAllWindows().length - count;
    await studio.exportImageStudioProject({ stateAbsPath: args.input.stateAbsPath, outputAbsPath: path.join(args.input.projectDirAbs, 'recovered.pdf'), format: 'pdf' });
    let changedOutputRejected = false;
    const changedOutput = path.join(args.input.projectDirAbs, 'changed-output.pdf');
    try {
      await studio.exportImageStudioProject({ stateAbsPath: args.input.stateAbsPath, outputAbsPath: changedOutput, format: 'pdf',
        finalizeOutput: async (output: string) => fs.writeFileSync(output, 'not PDF') });
    } catch (error) { changedOutputRejected = String(error).includes('E_IMAGE_PDF_FINALIZED_MISMATCH'); }
    return { rejected, preserved, noOutput, windowsRemaining, changedOutputRejected, changedOutputAbsent: !fs.existsSync(changedOutput) };
  }, { input, modulePath, scores });
  expect(result).toEqual({ rejected: true, preserved: true, noOutput: true, windowsRemaining: 0, changedOutputRejected: true, changedOutputAbsent: true });
  await inspectPdf(path.join(input.projectDirAbs, 'recovered.pdf'), input.outputAbsPath);
});

test('reports a missing local font or image and repairs without losing the source', async ({ sdkOrkas: orkas }) => {
  for (const [name, style] of [['font', '@font-face{font-family:LocalTitle;src:url(missing.woff2)}text{font-family:LocalTitle}'],
    ['image', 'body{background-image:url(missing.png)}']]) {
    const input = project(orkas, `missing-${name}`, style);
    const source = readFileSync(path.join(input.projectDirAbs, 'source.svg'));
    const rejected = await orkas.electronApp!.evaluate(async (_, args) => {
      const studio = (process as any).mainModule.require(args.modulePath);
      const result = await studio.snapshotImageStudioProject(args.input);
      return { ok: result.ok, codes: result.blockers.map((item: any) => item.code) };
    }, { input, modulePath });
    expect(rejected.ok).toBe(false); expect(rejected.codes).toContain('E_RESOURCE_MISSING');
    expect(existsSync(input.outputAbsPath)).toBe(false);
    expect(readFileSync(path.join(input.projectDirAbs, 'source.svg'))).toEqual(source);
    const repaired = project(orkas, `missing-${name}`);
    const good = await orkas.electronApp!.evaluate(async (_, args) =>
      (process as any).mainModule.require(args.modulePath).snapshotImageStudioProject(args.input), { input: repaired, modulePath });
    expect(good.ok).toBe(true);
  }
});

test('retains vector text when a local blur effect requires an embedded raster', async ({ sdkOrkas: orkas }) => {
  const input = project(orkas, 'mixed-vector-pdf', 'path{filter:blur(2px)}');
  const output = path.join(input.projectDirAbs, 'mixed.pdf');
  const report = await orkas.electronApp!.evaluate(async (_, args) => {
    const studio = (process as any).mainModule.require(args.modulePath);
    const validator = (process as any).mainModule.require(args.validator);
    const fs = (process as any).mainModule.require('node:fs');
    await studio.snapshotImageStudioProject(args.input);
    await studio.submitImageStudioDesignReview({ stateAbsPath: args.input.stateAbsPath, evidenceAbsPath: args.input.outputAbsPath,
      verdict: 'passed', scope: 'Mixed vector/raster fixture', findings: [], qualityScores: args.scores });
    await studio.exportImageStudioProject({ stateAbsPath: args.input.stateAbsPath, outputAbsPath: args.output, format: 'pdf' });
    return validator.inspectImageStudioPdf(fs.readFileSync(args.output), { width: 640, height: 360 });
  }, { input, output, modulePath, scores, validator: path.resolve(__dirname, '../../src/main/features/image_studio_pdf.ts') });
  expect(report.has_text).toBe(true); expect(report.embedded_images).toBeGreaterThan(0);
  await inspectPdf(output, input.outputAbsPath);
});

test('refuses old PDF bytes when another reviewed revision becomes current during printing', async ({ sdkOrkas: orkas }) => {
  const input = project(orkas, 'pdf-revision-race');
  const result = await orkas.electronApp!.evaluate(async ({ app, BrowserWindow }, args) => {
    const studio = (process as any).mainModule.require(args.modulePath);
    const fs = (process as any).mainModule.require('node:fs'), path = (process as any).mainModule.require('node:path');
    const approve = () => studio.submitImageStudioDesignReview({ stateAbsPath: args.input.stateAbsPath, evidenceAbsPath: args.input.outputAbsPath,
      verdict: 'passed', scope: 'Concurrent revision fixture', findings: [], qualityScores: args.scores });
    await studio.snapshotImageStudioProject(args.input); await approve();
    let injected = false;
    const fault = (_: unknown, win: Electron.BrowserWindow) => {
      if (injected) return; injected = true;
      const print = win.webContents.printToPDF.bind(win.webContents);
      win.webContents.printToPDF = async options => {
        const bytes = await print(options);
        const entry = path.join(args.input.projectDirAbs, 'index.html');
        fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8').replace('#336699', '#993366'));
        await studio.snapshotImageStudioProject(args.input); await approve();
        return bytes;
      };
    };
    const output = path.join(args.input.projectDirAbs, 'stale.pdf');
    let rejected = false;
    app.on('browser-window-created', fault);
    try { await studio.exportImageStudioProject({ stateAbsPath: args.input.stateAbsPath, outputAbsPath: output, format: 'pdf' }); }
    catch (error) { rejected = String(error).includes('E_IMAGE_PDF_SOURCE_CHANGED'); }
    finally { app.removeListener('browser-window-created', fault); }
    return { rejected, noOutput: !fs.existsSync(output) };
  }, { input, modulePath, scores });
  expect(result).toEqual({ rejected: true, noOutput: true });
});

test('delivers requested PDF through the owner tool with suffix inference, versioned names and existing scope gates', async ({ sdkOrkas: orkas }) => {
  const input = project(orkas, 'pdf-tool');
  const manifestFile = path.join(input.projectDirAbs, 'image-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  manifest.references = [{ id: 'source', path: 'source.svg', role: 'content', strength: 1, required: true,
    preserve: ['Original geometry and title'], may_change: [], region_ids: [] }];
  writeFileSync(manifestFile, JSON.stringify(manifest));
  const result = await orkas.electronApp!.evaluate(async (_, args) => {
    const toolModule = (process as any).mainModule.require(args.toolModule);
    const path = (process as any).mainModule.require('node:path');
    const written: string[] = [], published: string[] = [];
    const opts = { userId: 'pdf-native-user', agentId: '814b61b027f0', extraRoots: [args.input.projectDirAbs],
      onFileWritten: async (file: string) => { written.push(path.basename(file)); },
      onOutputsPublished: async (files: string[]) => { published.push(...files.map(file => path.basename(file))); } };
    const tool = toolModule.createImageStudioTool(opts), ctx = { workingDir: args.input.projectDirAbs };
    const call = async (op: string, extra: object = {}) => {
      const result = await tool.execute({ op, project_dir: args.input.projectDirAbs, ...extra }, ctx);
      if (result.isError) throw new Error(result.content);
      return JSON.parse(result.content.split('\n\n<file-renamed>\n', 1)[0]);
    };
    await call('project.inspect');
    const snapshot = await call('project.snapshot', { output_path: 'preview.png' });
    await call('project.submit_design_review', { evidence_path: snapshot.inspection.evidence_path, review_verdict: 'passed',
      review_scope: 'Native tool wiring fixture', review_findings: [], quality_scores: { ...args.scores, reference_fidelity: 90 } });
    await call('project.export', { output_path: 'out/tool.png' });
    const hooks = (process as any).mainModule.require(args.hooksModule);
    const restore = hooks.registerProducedOutputHooks({ documentFooterText: () => 'Fixture output label' });
    let first: any, second: any;
    try {
      first = await call('project.export', { output_path: 'out/tool.pdf' });
      second = await call('project.export', { output_path: 'out/tool.pdf', format: 'pdf' });
    } finally { restore(); }
    const foreign = toolModule.createImageStudioTool({ ...opts, agentId: 'other-agent' });
    const refused = await foreign.execute({ op: 'project.export', project_dir: args.input.projectDirAbs, output_path: 'foreign.pdf', format: 'pdf' }, ctx);
    return { referencesAttached: snapshot.visual_evidence.image_count, format: first.format, hasImageMedia: !!first.media, first: path.basename(first.output_path), second: path.basename(second.output_path),
      refused: refused.isError === true, written, published };
  }, { input, scores, toolModule: path.resolve(__dirname, '../../src/main/model/core-agent/image-studio-tool.ts'), hooksModule: path.resolve(__dirname, '../../src/main/features/produced_output_hooks.ts') });
  expect(result.referencesAttached).toBe(2); expect(result.format).toBe('pdf'); expect(result.hasImageMedia).toBe(false);
  expect(result.first).toBe('tool.pdf'); expect(result.second).toBe('tool-2.pdf'); expect(result.refused).toBe(true);
  expect(result.published).toEqual(expect.arrayContaining(['tool.png', 'tool.pdf', 'tool-2.pdf']));
  await inspectPdf(path.join(input.projectDirAbs, 'out/tool.pdf'), path.join(input.projectDirAbs, 'out/tool.png'), 'Fixture output label');
});


test('preserves exact odd canvas dimensions despite Chromium paper-size rounding', async ({ sdkOrkas: orkas }) => {
  const input = project(orkas, 'odd-pdf');
  const entry = path.join(input.projectDirAbs, 'index.html');
  writeFileSync(entry, readFileSync(entry, 'utf8').replaceAll('640', '641').replaceAll('360', '359'));
  const manifestPath = path.join(input.projectDirAbs, 'image-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); manifest.canvas = { width: 641, height: 359 };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const output = path.join(input.projectDirAbs, 'odd.pdf');
  await orkas.electronApp!.evaluate(async (_, args) => {
    const studio = (process as any).mainModule.require(args.modulePath);
    await studio.snapshotImageStudioProject(args.input);
    await studio.submitImageStudioDesignReview({ stateAbsPath: args.input.stateAbsPath, evidenceAbsPath: args.input.outputAbsPath,
      verdict: 'passed', scope: 'Odd canvas fixture', findings: [], qualityScores: args.scores });
    await studio.exportImageStudioProject({ stateAbsPath: args.input.stateAbsPath, outputAbsPath: args.output, format: 'pdf' });
  }, { input, output, modulePath, scores });
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.load(readFileSync(output));
  expect(pdf.getPage(0).getSize()).toEqual({ width: 641 * .75, height: 359 * .75 });
});
