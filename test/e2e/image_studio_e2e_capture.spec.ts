import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { test } from './fixtures/web-app-eval';
import { expect } from './fixtures/orkas';
import { inspectPsdBytes } from '../../eval/model-eval/regression/psd-inspection';
import { bayerDng } from '../../eval/model-eval/regression/raw-fixture';

const modulePath = path.resolve(__dirname, '../../src/main/features/image_studio.ts');
const scores = { intent_alignment: 90, composition: 90, craft: 90, text_legibility: 90, defect_freedom: 90, specificity: 90 };

test('reproduces at source size and preserves every pixel outside the approved title region', async ({ sdkOrkas: orkas }) => {
  const canvas = { width: 1200, height: 1500 };
  const title = { left: 120, top: 500, width: 940, height: 240 };
  const rect = `<rect x="${title.left}" y="${title.top}" width="${title.width}" height="${title.height}" fill="white"/>`;
  const svg = (body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}">${body}</svg>`);
  const renderTitle = (copy: string) => sharp(svg(`<rect width="100%" height="100%" fill="#f2efe6"/><circle cx="800" cy="1100" r="180" fill="#ef6a4c"/><text x="140" y="650" font-family="sans-serif" font-size="104" fill="#18233b">${copy}</text>`)).png().toBuffer();
  const original = await renderTitle('Original title');
  const replacement = await renderTitle('New title');
  const project = path.dirname(orkas.createWorkspaceFile('source-size-reproduction/image-manifest.json', JSON.stringify({
    schema_version: 1, route: 'compose', canvas, raster_source: 'candidate.png',
    brief: { purpose: 'Revise title', audience: 'Original readers', required_copy: ['New title'], must_include: [], must_avoid: [] },
    art_direction: { subject_world: 'Editorial poster', one_job: 'Replace its title', visual_tradition: 'Poster design',
      composition: 'Preserve original layout', signature_device: 'Orange circle', typography: 'Sans serif', color_light_material: 'Cream paper' },
    reference_intent: { mode: 'reproduce', basis: 'user', instructions: ['Replace title at its original position and size'], minimum_score: 85 },
    references: [{ id: 'layout', path: 'original.png', role: 'composition', required: true, strength: 1,
      preserve: ['Layout, color, title position and size'], may_change: ['Title copy'], region_ids: [] }],
    generation_budget: { max_calls: 0 },
  })));
  writeFileSync(path.join(project, 'original.png'), original);
  writeFileSync(path.join(project, 'replacement.png'), replacement);
  await sharp(svg(`<rect width="100%" height="100%" fill="black"/>${rect}`)).png().toFile(path.join(project, 'mask.png'));
  orkas.createWorkspaceFile('source-size-reproduction/request.json', JSON.stringify({
    op: 'masked_composite', input_path: 'original.png', background_path: 'replacement.png', mask_path: 'mask.png', output_path: 'candidate.png',
  }));
  const outputAbsPath = path.join(project, 'final.png');
  const result = await orkas.electronApp!.evaluate(async (_, args) => {
    const require = (process as any).mainModule.require.bind((process as any).mainModule);
    const studio = require(args.modulePath);
    const path = require('node:path');
    const composite = await require(args.assetScript)({ args: ['--project', args.project, '--request', 'request.json'] });
    const stateAbsPath = path.join(args.project, 'native-state.json');
    const inspected = await studio.recordRasterEvidence({ projectDirAbs: args.project, stateAbsPath });
    if (!inspected.ok) return { blockers: inspected.blockers.map((issue: any) => issue.code) };
    await studio.submitImageStudioDesignReview({ stateAbsPath, evidenceAbsPath: inspected.evidence_path,
      verdict: 'passed', scope: 'Controlled native review of the masked composition', findings: [],
      qualityScores: { ...args.scores, reference_fidelity: 85 } });
    await studio.exportImageStudioProject({ stateAbsPath, outputAbsPath: args.outputAbsPath, format: 'png' });
    return { protectedPixels: composite.protected_pixels, generationCalls: composite.model_calls };
  }, { modulePath, project, outputAbsPath, scores,
    assetScript: path.resolve(__dirname, '../../resources/builtin/marketplace/agents/814b61b027f0/skills/image-compose/scripts/image_asset.js') });
  expect(result).toEqual({ protectedPixels: canvas.width * canvas.height - title.width * title.height, generationCalls: 0 });
  const decode = (input: string | Buffer) => sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [before, patch, after] = await Promise.all([decode(original), decode(replacement), decode(outputAbsPath)]);
  expect(after.info).toMatchObject({ ...canvas, channels: 4 });
  const expected = Buffer.from(before.data);
  for (let y = title.top; y < title.top + title.height; y++) {
    const offset = (y * canvas.width + title.left) * 4;
    patch.data.copy(expected, offset, offset, offset + title.width * 4);
  }
  expect(expected.equals(before.data)).toBe(false);
  expect(after.data.equals(expected)).toBe(true);
  expect(readFileSync(path.join(project, 'original.png'))).toEqual(original);
});

test('exports the verified pixels when evidence is replaced during validation and rechecks the next request', async ({ sdkOrkas: orkas }) => {
  for (const format of ['png', 'jpeg'] as const) {
    const input = createPoster(orkas, `verified-export-${format}`, '');
    const replacement = await sharp({ create: { width: 1080, height: 1080, channels: 4, background: '#ff00ff' } }).png().toBuffer();
    const output = path.join(input.projectDirAbs, `final.${format}`);
    const result = await orkas.electronApp!.evaluate(async ({ nativeImage }, args) => {
      const studio = (process as any).mainModule.require(args.modulePath);
      const fs = (process as any).mainModule.require('node:fs');
      const inspection = await studio.snapshotImageStudioProject(args.input);
      if (!inspection.ok) throw new Error('Fixture snapshot failed');
      await studio.submitImageStudioDesignReview({ stateAbsPath: args.input.stateAbsPath, evidenceAbsPath: args.input.outputAbsPath,
        verdict: 'passed', scope: 'Controlled evidence replacement; no model visual judgment', findings: [], qualityScores: args.scores });
      const reviewed = fs.readFileSync(args.input.outputAbsPath).toString('base64');
      const create = nativeImage.createFromPath;
      let injected = false;
      nativeImage.createFromPath = file => {
        const image = create(file);
        if (file === args.input.outputAbsPath && !injected) {
          const bitmap = image.toBitmap.bind(image);
          // Replace the file just after the validator obtains its pixel bytes.
          // The oracle below checks the delivered pixels, not a private call count.
          image.toBitmap = () => {
            const pixels = bitmap();
            if (!injected) { injected = true; fs.writeFileSync(file, Buffer.from(args.replacement, 'base64')); }
            return pixels;
          };
        }
        return image;
      };
      try { await studio.exportImageStudioProject({ stateAbsPath: args.input.stateAbsPath, outputAbsPath: args.output, format: args.format }); }
      finally { nativeImage.createFromPath = create; }
      let nextRejected = false;
      const next = args.output + '.next';
      try { await studio.exportImageStudioProject({ stateAbsPath: args.input.stateAbsPath, outputAbsPath: next, format: args.format }); }
      catch (error) { nextRejected = String(error).includes('E_IMAGE_REVIEW_EVIDENCE_CHANGED'); }
      return { reviewed, injected, nextRejected, nextAbsent: !fs.existsSync(next) };
    }, { modulePath, input, output, format, scores, replacement: replacement.toString('base64') });
    expect(result).toMatchObject({ injected: true, nextRejected: true, nextAbsent: true });
    const expected = await sharp(Buffer.from(result.reviewed, 'base64')).removeAlpha().raw().toBuffer();
    const actual = await sharp(output).removeAlpha().raw().toBuffer();
    expect(actual.length).toBe(expected.length);
    if (format === 'png') expect(actual.equals(expected)).toBe(true);
    else expect(actual.reduce((sum, value, index) => sum + Math.abs(value - expected[index]), 0) / actual.length).toBeLessThan(4);
  }
});

test('runs bundled RAW development through the real Electron Skill environment and resumes the batch', async ({ sdkOrkas: orkas }) => {
  const project = path.dirname(orkas.createWorkspaceFile('raw-photos/request.json', JSON.stringify({ op: 'batch', raw: { exposure_ev: 1, white_balance: 'camera' },
    items: [{ input_path: 'original.dng', output_path: 'out/photo.png' }] })));
  const original = bayerDng(); writeFileSync(path.join(project, 'original.dng'), original);
  const result = await orkas.electronApp!.evaluate(async (_, args) => {
    const require = (process as any).mainModule.require.bind((process as any).mainModule);
    const runtime = require(args.runtime), child = require('node:child_process'), path = require('node:path');
    const env = { ...process.env, ...runtime.bundledRuntimeEnv(), ORKAS_PC_DIR: args.pcRoot, ORKAS_RUN_SKILL_DIR: args.skillDir };
    const run = () => new Promise<any>((resolve, reject) => {
      child.execFile(runtime.bundledNodeExecutable(), [path.join(args.pcRoot, 'bin/run-skill.cjs'), 'image-compose', 'image_asset', '--',
        '--project', args.project, '--request', 'request.json'], { env, timeout: 30_000, windowsHide: true }, (error: any, stdout: string, stderr: string) => {
        if (error || stderr) reject(new Error('RAW Skill child failed or emitted diagnostics')); else resolve(JSON.parse(stdout));
      });
    });
    const first = await run(), resumed = await run();
    return { engineResolved: !!env.ORKAS_LIBRAW, first: { completed: first.completed, failed: first.failed }, resumed: { reused: resumed.reused, failed: resumed.failed } };
  }, { project, pcRoot: path.resolve(__dirname, '../..'), runtime: path.resolve(__dirname, '../../src/main/util/bundled-runtime.ts'),
    skillDir: path.resolve(__dirname, '../../resources/builtin/marketplace/agents/814b61b027f0/skills/image-compose') });
  expect(result).toEqual({ engineResolved: true, first: { completed: 1, failed: 0 }, resumed: { reused: 1, failed: 0 } });
  expect(await sharp(path.join(project, 'out/photo.png')).metadata()).toMatchObject({ width: 256, height: 192, hasProfile: true });
  expect(readFileSync(path.join(project, 'original.dng'))).toEqual(original);
});

test('keeps a generated PSD score-free and restores review after local text authoring', async ({ sdkOrkas: orkas }) => {
  const skills = path.resolve(__dirname, '../../resources/builtin/marketplace/agents/814b61b027f0/skills');
  const project = path.dirname(orkas.createWorkspaceFile('generated-psd/design.json', JSON.stringify({
    schema_version: 1, canvas: { width: 128, height: 128 }, layers: [{ id: 'base', type: 'image', name: 'Generated original', path: 'original.png' }],
  })));
  const original = await sharp({ create: { width: 128, height: 128, channels: 4,
    background: { r: 32, g: 64, b: 96, alpha: 80 / 255 } } }).png().toBuffer();
  writeFileSync(path.join(project, 'original.png'), original);
  const manifest = JSON.parse(readFileSync(path.join(skills, 'image-router/SKILL.md'), 'utf8').match(/```json\s*([\s\S]*?)\s*```/)![1]);
  manifest.route = 'generate'; manifest.generation_budget.max_calls = 1;
  manifest.canvas = { width: 128, height: 128 }; manifest.raster_source = 'original.png'; manifest.brief.required_copy = [];
  orkas.createWorkspaceFile('generated-psd/image-manifest.json', JSON.stringify(manifest));
  const result = await orkas.electronApp!.evaluate(async (_, args) => {
    const studio = (process as any).mainModule.require(args.modulePath);
    const provenance = (process as any).mainModule.require(args.provenance);
    const layered = (process as any).mainModule.require(args.helper);
    const fs = (process as any).mainModule.require('node:fs'), path = (process as any).mainModule.require('node:path');
    async function invoke(request: object) {
      fs.writeFileSync(path.join(args.project, 'request.json'), JSON.stringify(request));
      return layered({ args: ['--project', args.project, '--request', 'request.json'] });
    }
    const stateAbsPath = path.join(args.project, 'native-state.json');
    const source = path.join(args.project, 'original.png');
    // Model only the isolated successful provider record, not a paid request or verdict.
    const generationOutputs = [{ output_path: source, output_sha256: await provenance.imageStudioFileHash(source) }];
    await invoke({ op: 'render', document_path: 'design.json', output_path: 'preview.png' });
    await invoke({ op: 'export_psd', document_path: 'design.json', preview_path: 'preview.png', output_path: 'candidate.psd' });
    const initial = await studio.recordRasterEvidence({ projectDirAbs: args.project, stateAbsPath, generationOutputs });
    await studio.exportImageStudioProject({ stateAbsPath, format: 'png', outputAbsPath: path.join(args.project, 'original-final.png') });
    await studio.exportImageStudioProject({ stateAbsPath, format: 'psd', inputAbsPath: path.join(args.project, 'candidate.psd'), outputAbsPath: path.join(args.project, 'original-final.psd') });
    const before = await studio.readImageStudioEvidenceState(stateAbsPath);
    const document = JSON.parse(fs.readFileSync(path.join(args.project, 'design.json'), 'utf8'));
    document.layers.push({ id: 'title', type: 'text', name: 'Title', text: 'New', left: 8, top: 8,
      width: 112, height: 40, font_family: 'Arial', font_postscript_name: 'ArialMT', font_size: 20, color: '#ff0000' });
    fs.writeFileSync(path.join(args.project, 'edited.json'), JSON.stringify(document));
    await invoke({ op: 'render', document_path: 'edited.json', output_path: 'edited.png' });
    await invoke({ op: 'export_psd', document_path: 'edited.json', preview_path: 'edited.png', output_path: 'edited-candidate.psd' });
    const manifest = JSON.parse(fs.readFileSync(path.join(args.project, 'image-manifest.json'), 'utf8'));
    manifest.raster_source = 'edited.png'; fs.writeFileSync(path.join(args.project, 'image-manifest.json'), JSON.stringify(manifest));
    const authored = await studio.recordRasterEvidence({ projectDirAbs: args.project, stateAbsPath, generationOutputs });
    let rejected = false;
    try { await studio.exportImageStudioProject({ stateAbsPath, format: 'psd', inputAbsPath: path.join(args.project, 'edited-candidate.psd'), outputAbsPath: path.join(args.project, 'blocked.psd') }); }
    catch (error) { rejected = String(error).includes('E_IMAGE_REVIEW_PASS_REQUIRED'); }
    return { generated: initial.is_generation, generationHasReview: !!before.review, authored: authored.is_generation, rejected,
      blockedFileExists: fs.existsSync(path.join(args.project, 'blocked.psd')) };
  }, { modulePath, provenance: path.resolve(__dirname, '../../src/main/features/image_studio_provenance.ts'),
    helper: path.join(skills, 'image-compose/scripts/layered_document.js'), project });
  expect(result).toEqual({ generated: true, generationHasReview: false, authored: false, rejected: true, blockedFileExists: false });
  const parsed = inspectPsdBytes(readFileSync(path.join(project, 'original-final.psd')));
  expect(parsed.layers).toHaveLength(1); expect(parsed.layers[0].text).toBeUndefined();
  expect(readFileSync(path.join(project, 'original-final.psd'))).toEqual(readFileSync(path.join(project, 'candidate.psd')));
  expect(readFileSync(path.join(project, 'original.png'))).toEqual(original);
});

for (const route of ['compose', 'edit']) test(`exports documented layered ${route} through real native PNG review before PSD`, async ({ sdkOrkas: orkas }) => {
  const skills = path.resolve(__dirname, '../../resources/builtin/marketplace/agents/814b61b027f0/skills');
  const reference = readFileSync(path.join(skills, 'image-compose/references/layered-documents.md'), 'utf8');
  const examples = [...reference.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
  const document = examples.find(value => value.layers);
  const requests = examples.filter(value => value.op);
  const original = structuredClone(document); original.layers[1].children[1].text = 'Draft notes';
  const project = path.dirname(orkas.createWorkspaceFile(`layered-${route}/design.json`, JSON.stringify(document)));
  orkas.createWorkspaceFile(`layered-${route}/original-design.json`, JSON.stringify(original));
  const manifest = JSON.parse(readFileSync(path.join(skills, 'image-router/SKILL.md'), 'utf8').match(/```json\s*([\s\S]*?)\s*```/)![1]);
  manifest.route = route; manifest.canvas = document.canvas; manifest.raster_source = 'out/preview.png';
  manifest.brief.required_copy = ['Field notes'];
  if (route === 'edit') Object.assign(manifest, examples.find(value => value.reference_intent));
  orkas.createWorkspaceFile(`layered-${route}/image-manifest.json`, JSON.stringify(manifest));
  mkdirSync(path.join(project, 'assets'));
  const assets = new Map<string, Buffer>([
    ['base.png', await sharp({ create: { width: 320, height: 240, channels: 4, background: '#f2ede4' } }).png().toBuffer()],
    ['badge.png', await sharp({ create: { width: 64, height: 32, channels: 4, background: '#326496' } }).png().toBuffer()],
    ['badge-mask.png', await sharp(Buffer.alloc(64 * 32, 128), { raw: { width: 64, height: 32, channels: 1 } }).png().toBuffer()],
  ]);
  for (const [file, bytes] of assets) writeFileSync(path.join(project, 'assets', file), bytes);
  const result = await orkas.electronApp!.evaluate(async (_, args) => {
    const studio = (process as any).mainModule.require(args.modulePath);
    const layered = (process as any).mainModule.require(args.helper);
    const fs = (process as any).mainModule.require('node:fs');
    const path = (process as any).mainModule.require('node:path');
    async function invoke(request: object) {
      fs.writeFileSync(path.join(args.project, 'request.json'), JSON.stringify(request));
      return layered({ args: ['--project', args.project, '--request', 'request.json'] });
    }
    if (args.route === 'edit') await invoke({ op: 'render', document_path: 'original-design.json', output_path: 'out/original.png' });
    await invoke(args.requests[0]); await invoke(args.requests[1]);
    const stateAbsPath = path.join(args.project, 'native-state.json');
    const inspection = await studio.recordRasterEvidence({ projectDirAbs: args.project, stateAbsPath });
    if (!inspection.ok) return { ok: false, blockers: inspection.blockers.map((issue: any) => issue.code) };
    const outputAbsPath = path.join(args.project, 'out/final.png');
    let rejectedBeforeReview = false;
    try { await studio.exportImageStudioProject({ stateAbsPath, outputAbsPath, format: 'png' }); }
    catch (error) { rejectedBeforeReview = String(error).includes('E_IMAGE_REVIEW_PASS_REQUIRED'); }
    // Fixture scores prove the native state transition, not visual quality.
    await studio.submitImageStudioDesignReview({ stateAbsPath, evidenceAbsPath: inspection.evidence_path,
      verdict: 'passed', scope: 'Synthetic native state-transition fixture', findings: [],
      qualityScores: { ...args.scores, ...(args.route === 'edit' ? { reference_fidelity: 90 } : {}) } });
    await studio.exportImageStudioProject({ stateAbsPath, outputAbsPath, format: 'png' });
    const psd = await invoke(args.requests[2]);
    await studio.exportImageStudioProject({ stateAbsPath, format: 'psd',
      inputAbsPath: psd.final_export.input_path, outputAbsPath: path.join(args.project, 'out/design.psd') });
    return { ok: true, rejectedBeforeReview, verified: psd.structure_verified, externalEditorVerified: psd.external_editor_verified };
  }, { modulePath, helper: path.join(skills, 'image-compose/scripts/layered_document.js'), project, route, requests, scores });
  expect(result).toEqual({ ok: true, rejectedBeforeReview: true, verified: true, externalEditorVerified: false });
  const decoded = await sharp(path.join(project, 'out/final.png')).ensureAlpha().raw().toBuffer();
  const psd = inspectPsdBytes(readFileSync(path.join(project, 'out/design.psd')));
  expect(psd.rgba).toEqual(decoded);
  expect(psd.layers.find(layer => layer.name === 'Headline')?.text).toBe('Field notes');
  expect(psd.layers.find(layer => layer.name === 'Badge')?.channels.get(-2)).toEqual(Buffer.alloc(64 * 32, 128));
  for (const [file, bytes] of assets) expect(readFileSync(path.join(project, 'assets', file))).toEqual(bytes);
});

function createPoster(orkas: { createWorkspaceFile(name: string, content: string): string }, name: string, content: string, height = 1080) {
  const entry = orkas.createWorkspaceFile(`${name}/index.html`, `<!doctype html><html><head><style>
    html,body{margin:0}main{position:relative;width:1080px;height:${height}px;background:#f6efdc}
    p{margin:0}svg{position:absolute;right:0;bottom:0;width:40px;height:40px}
    </style></head><body><main><p>City Coffee Fest</p>${content}
    <svg xmlns="http://www.w3.org/2000/svg"><rect width="40" height="40" fill="#2468ae"/></svg>
    <div style="position:absolute;left:0;bottom:0;width:40px;height:40px;background:#b82e37"></div>
    </main></body></html>`);
  orkas.createWorkspaceFile(`${name}/image-manifest.json`, JSON.stringify({
    schema_version: 1, route: 'compose', entry: 'index.html', canvas: { width: 1080, height },
    brief: { purpose: 'Event poster', audience: 'Coffee lovers', required_copy: ['City Coffee Fest'], must_include: [], must_avoid: [] },
    art_direction: { subject_world: 'Coffee festival', one_job: 'Announce the event', visual_tradition: 'Editorial poster',
      composition: 'Title and illustration', signature_device: 'Coffee cup', typography: 'Sans serif', color_light_material: 'Cream paper' },
    generation_budget: { max_calls: 0 },
  }));
  return { projectDirAbs: path.dirname(entry), outputAbsPath: path.join(path.dirname(entry), 'evidence.png'),
    stateAbsPath: path.join(path.dirname(entry), 'state.json') };
}

test('exports a six-member authored set only from current reference-bound reviews', async ({ sdkOrkas: orkas }) => {
  const inputs = Array.from({ length: 6 }, (_, i) => createPoster(orkas, `set-${i + 1}`, `<p>Session ${i + 1}</p>`));
  const result = await orkas.electronApp!.evaluate(async (_, args) => {
    const require = (process as any).mainModule.require.bind((process as any).mainModule);
    const studio = require(args.modulePath), fs = require('node:fs'), path = require('node:path');
    const failures: string[] = [], members: any[] = [];
    const reject = async (label: string, operation: () => Promise<unknown>) => {
      try { await operation(); failures.push(`${label}:unexpected-success`); }
      catch (error) { failures.push(`${label}:${String(error).match(/E_[A-Z_]+/)?.[0] ?? 'unknown'}`); }
    };
    for (let i = 0; i < args.inputs.length; i++) {
      const input = args.inputs[i], manifestPath = path.join(input.projectDirAbs, 'image-manifest.json');
      const outputAbsPath = path.join(input.projectDirAbs, 'final.png');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.brief.required_copy.push(`Session ${i + 1}`);
      if (i > 0) {
        fs.copyFileSync(members[0].outputAbsPath, path.join(input.projectDirAbs, 'anchor.png'));
        manifest.references = [{ id: 'anchor', path: 'anchor.png', role: 'style', required: true, strength: 1,
          preserve: ['palette', 'typography', 'spacing/grid', 'shape/icon/stroke', 'material', 'signature'],
          may_change: ['session content'], region_ids: [] }];
        manifest.reference_intent = { mode: 'guide', basis: 'user', instructions: [], minimum_score: 85 };
      }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      const entry = path.join(input.projectDirAbs, 'index.html'), original = fs.readFileSync(entry, 'utf8');
      // Controlled scores test the native lifecycle, not model visual judgement.
      // The second member has an actual palette deviation, followed by a real repair.
      if (i === 1) fs.writeFileSync(entry, original.replace('#f6efdc', '#bb0000'));
      let evidence = await studio.snapshotImageStudioProject(input);
      if (!evidence.ok) throw new Error('Set candidate did not produce valid native evidence');
      const submit = (verdict: string, fidelity: number, findings: string[] = []) => studio.submitImageStudioDesignReview({
        stateAbsPath: input.stateAbsPath, evidenceAbsPath: input.outputAbsPath,
        verdict, scope: 'Controlled native execution fixture; no model visual certification', findings,
        qualityScores: { ...args.scores, ...(i > 0 ? { reference_fidelity: fidelity } : {}) },
      });
      const exportImage = () => studio.exportImageStudioProject({ stateAbsPath: input.stateAbsPath, outputAbsPath, format: 'png' });
      if (i === 1) {
        fs.copyFileSync(input.outputAbsPath, path.join(input.projectDirAbs, 'palette-deviation.png'));
        await reject('unreviewed-export', exportImage);
        await reject('below-floor', () => submit('passed', 84));
        await reject('high-score-with-fix', () => submit('passed', 99, ['fix: paper palette changed to red']));
        await submit('repair', 84, ['fix: restore the anchor paper palette']);
        await reject('score-only-retry', () => submit('passed', 99));
        if (fs.existsSync(outputAbsPath)) throw new Error('Rejected candidate leaked a final export');
        fs.writeFileSync(entry, original);
        evidence = await studio.snapshotImageStudioProject(input);
        if (!evidence.ok) throw new Error('Repaired member did not recapture');
        await reject('recaptured-without-review', exportImage);
      }
      await submit('passed', i === 1 ? 85 : 86);
      if (i === 4) {
        const anchor = path.join(input.projectDirAbs, 'anchor.png');
        fs.copyFileSync(members[1].outputAbsPath, anchor);
        await reject('changed-anchor', exportImage);
        // Restoring exact approved bytes restores the original signature.
        fs.copyFileSync(members[0].outputAbsPath, anchor);
      }
      await exportImage();
      const persisted = await studio.readImageStudioEvidenceState(input.stateAbsPath);
      members.push({ outputAbsPath, signatureBound: persisted.review.signature === evidence.signature,
        mode: manifest.reference_intent?.mode, minimum: manifest.reference_intent?.minimum_score,
        anchorRequired: manifest.references?.[0].required, anchorRole: manifest.references?.[0].role,
        fidelity: persisted.review.quality_scorecard.reference_fidelity, isGeneration: persisted.is_generation });
    }
    return { failures, members };
  }, { modulePath, inputs, scores });
  expect(result.failures).toEqual([
    'unreviewed-export:E_IMAGE_REVIEW_PASS_REQUIRED', 'below-floor:E_IMAGE_REFERENCE_FIDELITY_BELOW_FLOOR',
    'high-score-with-fix:E_IMAGE_REVIEW_PASS_FINDINGS', 'score-only-retry:E_IMAGE_REVIEW_REPAIR_REQUIRED',
    'recaptured-without-review:E_IMAGE_REVIEW_PASS_REQUIRED', 'changed-anchor:E_IMAGE_REVIEW_EVIDENCE_STALE',
  ]);
  expect(result.members).toHaveLength(6);
  let anchorPixel: number[] = [];
  for (let i = 0; i < result.members.length; i++) {
    expect(result.members[i]).toMatchObject({ signatureBound: true, isGeneration: false,
      ...(i > 0 ? { mode: 'guide', minimum: 85, anchorRequired: true, anchorRole: 'style', fidelity: i === 1 ? 85 : 86 } : {}) });
    const pixels = await sharp(result.members[i].outputAbsPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(pixels.info).toMatchObject({ width: 1080, height: 1080 });
    const center = (540 * 1080 + 540) * 4;
    // Compare with the actual approved anchor under the same browser/display
    // color management, not an assumed CSS-to-export channel identity.
    if (i === 0) anchorPixel = [...pixels.data.subarray(center, center + 4)];
    expect([...pixels.data.subarray(center, center + 4)]).toEqual(anchorPixel);
  }
  const drift = path.join(inputs[1].projectDirAbs, 'palette-deviation.png');
  const driftPixel = await sharp(drift).extract({ left: 540, top: 540, width: 1, height: 1 }).ensureAlpha().raw().toBuffer();
  expect([...driftPixel]).not.toEqual(anchorPixel);
  expect(driftPixel[0]).toBeGreaterThan(driftPixel[1] * 2);
  const report = process.env.ORKAS_IMAGE_SET_EXECUTION_REPORT;
  if (report) writeFileSync(report, JSON.stringify({ kind: 'real-electron-set-execution',
    members: result.members.map(({ outputAbsPath, ...member }: any) => member),
    rejectedOperations: result.failures, repairedPalette: true,
    limitation: 'Controlled review scores verify native execution gates; they do not establish model visual scoring or semantic whole-set acceptance.' }, null, 2));
});

test('recovers fragmented poster copy and exports it without accepting missing word spaces', async ({ sdkOrkas: orkas }) => {
  const input = createPoster(orkas, 'fragmented-copy', [
    '<h1 style="font-size:60px">让协作<br><span>更简单</span></h1>',
    '<p>co<em>operate</em></p><p><span>&yen;</span><span>99</span></p>',
    '<p>Orkas<em>Studio</em></p>',
  ].join(''));
  const manifestPath = path.join(input.projectDirAbs, 'image-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.brief.required_copy = ['让协作更简单', 'cooperate', '¥99', 'Orkas Studio'];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const output = path.join(input.projectDirAbs, 'final.png');
  const result = await orkas.electronApp!.evaluate(async (_, args) => {
    const studio = (process as any).mainModule.require(args.modulePath);
    const fs = (process as any).mainModule.require('node:fs'), path = (process as any).mainModule.require('node:path');
    const invalid = await studio.snapshotImageStudioProject(args.input);
    const createdInvalidEvidence = fs.existsSync(args.input.outputAbsPath) || fs.existsSync(args.input.stateAbsPath);
    const htmlPath = path.join(args.input.projectDirAbs, 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8').replace('Orkas<em>', 'Orkas <em>');
    fs.writeFileSync(htmlPath, html);
    const repaired = await studio.snapshotImageStudioProject(args.input);
    if (!repaired.ok) throw new Error('Repaired fragmented copy must be capturable: ' + repaired.blockers.map((x: any) => x.code).join(','));
    // Scores exercise the existing native review/export gate, not visual quality.
    await studio.submitImageStudioDesignReview({ stateAbsPath: args.input.stateAbsPath, evidenceAbsPath: args.input.outputAbsPath,
      verdict: 'passed', scope: 'Synthetic copy recovery state transition', findings: [], qualityScores: args.scores });
    await studio.exportImageStudioProject({ stateAbsPath: args.input.stateAbsPath, outputAbsPath: args.output, format: 'png' });
    const evidence = fs.readFileSync(args.input.outputAbsPath), state = fs.readFileSync(args.input.stateAbsPath), final = fs.readFileSync(args.output);
    fs.writeFileSync(htmlPath, html.replace('更简单', '更简'));
    const missingGlyph = await studio.snapshotImageStudioProject(args.input);
    return { initialBlockers: invalid.blockers.map((x: any) => x.code), createdInvalidEvidence,
      missingCopy: missingGlyph.blockers.map((x: any) => x.code), preserved: evidence.equals(fs.readFileSync(args.input.outputAbsPath))
        && state.equals(fs.readFileSync(args.input.stateAbsPath)) && final.equals(fs.readFileSync(args.output)) };
  }, { input, modulePath, scores, output });
  expect(result).toEqual({ initialBlockers: ['E_REQUIRED_COPY_MISSING'], createdInvalidEvidence: false,
    missingCopy: ['E_REQUIRED_COPY_MISSING'], preserved: true });
  expect(await sharp(output).metadata()).toMatchObject({ width: 1080, height: 1080 });
});

test('uses the first visible occurrence of repeated required copy of equal length', async ({ sdkOrkas: orkas }) => {
  const wrapped = '<p style="font:24px monospace;width:3.2ch;overflow-wrap:anywhere">A1B2</p>';
  const unwrapped = '<p style="font:24px monospace">A1B2</p>';
  const hidden = wrapped.replace('font:', 'display:none;font:');
  const input = createPoster(orkas, 'repeated-required-copy', hidden + wrapped + unwrapped);
  const manifestPath = path.join(input.projectDirAbs, 'image-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.brief.required_copy.push('A1B2');
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const capture = () => orkas.electronApp!.evaluate(async (_, args) => {
    const studio = (process as any).mainModule.require(args.modulePath);
    const result = await studio.snapshotImageStudioProject(args.input);
    return { ok: result.ok, blockers: result.blockers.map((issue: any) => issue.code) };
  }, { input, modulePath });

  expect(await capture()).toEqual({ ok: false, blockers: ['E_REQUIRED_COPY_ORPHAN_LINE'] });
  const entry = path.join(input.projectDirAbs, 'index.html');
  writeFileSync(entry, readFileSync(entry, 'utf8').replace(wrapped + unwrapped, unwrapped + wrapped));
  expect(await capture()).toEqual({ ok: true, blockers: [] });
});

test('exports all poster corners after the host initially constrains the capture window', async ({ sdkOrkas: orkas }) => {
  // Real Chromium pixels are the oracle. The event simulates work-area clamping
  // without supplying a mock screenshot or the expected rendered answer.
  // Native screenshots apply the display's color conversion before production.
  // Render an independent small reference rather than assume literal RGB bytes.
  const referencePng = await orkas.electronApp!.evaluate(async ({ BrowserWindow }) => {
    const win = new BrowserWindow({ width: 120, height: 60, useContentSize: true, show: false,
      backgroundColor: '#00000000', webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    try {
      await win.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><style>
        html,body{margin:0}div{position:absolute;top:0;width:40px;height:40px}
        </style><div style="left:0;background:#b82e37"></div><div style="left:60px;background:#2468ae"></div>`));
      return (await win.webContents.capturePage()).toPNG().toString('base64');
    } finally { win.destroy(); }
  });
  const reference = await sharp(Buffer.from(referencePng, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const referencePixel = (x: number) => {
    const px = Math.floor(x * reference.info.width / 120), py = Math.floor(20 * reference.info.height / 60);
    return [...reference.data.subarray((py * reference.info.width + px) * 4, (py * reference.info.width + px) * 4 + 4)];
  };
  expect(referencePixel(20)[3]).toBe(255);
  expect(referencePixel(80)[3]).toBe(255);
  for (const height of [1080, 2160]) {
    const input = createPoster(orkas, `poster-${height}`, '', height);
    const output = path.join(input.projectDirAbs, 'delivery.png');
    const result = await orkas.electronApp!.evaluate(async ({ app, BrowserWindow }, args) => {
      const studio = (process as any).mainModule.require(args.modulePath);
      const clamp = (_event: unknown, win: Electron.BrowserWindow) => win.setContentSize(640, 480);
      const before = BrowserWindow.getAllWindows().length;
      app.on('browser-window-created', clamp);
      try {
        const inspection = await studio.snapshotImageStudioProject(args.input);
        if (inspection.ok) {
          await studio.submitImageStudioDesignReview({ stateAbsPath: args.input.stateAbsPath,
            evidenceAbsPath: args.input.outputAbsPath, verdict: 'passed', scope: 'Complete poster', findings: [], qualityScores: args.scores });
          await studio.exportImageStudioProject({ stateAbsPath: args.input.stateAbsPath, outputAbsPath: args.output, format: 'png' });
        }
        return { ok: inspection.ok, blockers: inspection.blockers, remaining: BrowserWindow.getAllWindows().length - before };
      } finally { app.removeListener('browser-window-created', clamp); }
    }, { modulePath, input, output, scores });
    expect(result).toEqual({ ok: true, blockers: [], remaining: 0 });
    const decoded = await sharp(readFileSync(output)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({ width: 1080, height, channels: 4 });
    const pixel = (x: number, y: number) => [...decoded.data.subarray((y * 1080 + x) * 4, (y * 1080 + x) * 4 + 4)];
    expect(pixel(20, height - 20)).toEqual(referencePixel(20));
    expect(pixel(1060, height - 20)).toEqual(referencePixel(80));
  }
});

test('blocks page and nested scrolling before export and succeeds after the layout is repaired', async ({ sdkOrkas: orkas }) => {
  for (const [name, content] of [
    ['page', '<div style="position:absolute;top:1070px;width:1120px;height:100px">Event details</div>'],
    ['nested', '<section style="width:200px;height:100px;overflow:auto"><div style="width:300px;height:200px">Event details</div></section>'],
    ['forced', '<section style="width:200px;height:100px;overflow:scroll">Event details</section>'],
  ]) {
    const input = createPoster(orkas, `overflow-${name}`, content);
    const result = await orkas.electronApp!.evaluate(async (_, args) => {
      const studio = (process as any).mainModule.require(args.modulePath);
      const inspection = await studio.snapshotImageStudioProject(args.input);
      let reviewError = '';
      try {
        await studio.submitImageStudioDesignReview({ stateAbsPath: args.input.stateAbsPath,
          evidenceAbsPath: args.input.outputAbsPath, verdict: 'passed', scope: 'Complete poster', findings: [], qualityScores: args.scores });
      } catch (error) { reviewError = String(error); }
      return { ok: inspection.ok, blockers: inspection.blockers, reviewError };
    }, { modulePath, input, scores });
    expect(result.ok).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'E_IMAGE_LAYOUT_SCROLLING' })]));
    expect(result.reviewError).toContain('E_IMAGE_REVIEW_EVIDENCE_REQUIRED');
    expect(existsSync(input.outputAbsPath)).toBe(false);
    expect(existsSync(input.stateAbsPath)).toBe(false);
    // Intentional cropping of decorative bleed is valid; scrollable deliverables
    // are not. A repaired layout must be capturable without restarting the app.
    const repaired = createPoster(orkas, `overflow-${name}`, '<section style="width:200px;height:100px;overflow:hidden"><div style="width:300px;height:200px">Decoration</div></section>');
    const inspection = await orkas.electronApp!.evaluate(async (_, args) =>
      (process as any).mainModule.require(args.modulePath).snapshotImageStudioProject(args.input), { modulePath, input: repaired });
    expect(inspection.ok).toBe(true);
  }
});

test('rejects an unrecoverable viewport mismatch without replacing existing evidence', async ({ sdkOrkas: orkas }) => {
  const input = createPoster(orkas, 'unresizable', '');
  const good = await orkas.electronApp!.evaluate(async (_, args) =>
    (process as any).mainModule.require(args.modulePath).snapshotImageStudioProject(args.input), { modulePath, input });
  expect(good.ok).toBe(true);
  const imageBefore = readFileSync(input.outputAbsPath);
  const stateBefore = readFileSync(input.stateAbsPath);
  const result = await orkas.electronApp!.evaluate(async ({ app, BrowserWindow }, args) => {
    const studio = (process as any).mainModule.require(args.modulePath);
    const constrain = (_event: unknown, win: Electron.BrowserWindow) => {
      win.setContentSize(640, 480);
      win.setContentSize = () => {};
    };
    const before = BrowserWindow.getAllWindows().length;
    app.on('browser-window-created', constrain);
    try {
      await studio.snapshotImageStudioProject(args.input);
      return { error: '', remaining: BrowserWindow.getAllWindows().length - before };
    } catch (error) {
      return { error: String(error), remaining: BrowserWindow.getAllWindows().length - before };
    } finally { app.removeListener('browser-window-created', constrain); }
  }, { modulePath, input });
  expect(result.error).toContain('E_IMAGE_STUDIO_VIEWPORT_MISMATCH');
  expect(result.remaining).toBe(0);
  expect(readFileSync(input.outputAbsPath)).toEqual(imageBefore);
  expect(readFileSync(input.stateAbsPath)).toEqual(stateBefore);
});
