import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { nativeImage } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appMedia=vi.hoisted(()=>({route:vi.fn()}));
vi.mock('../../../../src/main/features/app_media_route',()=>({appTaskMediaRoute:appMedia.route}));
beforeEach(()=>{appMedia.route.mockReset();});
import sharp from '../../../helpers/fixture-sharp';

const servicePreflight = vi.hoisted(() => ({
  estimate: vi.fn(),
}));

const imageProvider = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('../../../../src/main/features/image_gen', () => ({
  generateImage: (...args: unknown[]) => imageProvider.generate(...args),
}));
vi.mock('../../../../src/main/features/user_workspace', () => ({
  getWorkspacePath: () => root,
}));

const electronImage = vi.hoisted(() => {
  const makeImage = (bitmap: Buffer, png: Buffer) => ({
    getSize: () => ({ width: 128, height: 128 }),
    toBitmap: () => bitmap,
    toPNG: () => png,
    toJPEG: () => png,
    isEmpty: () => false,
  });
  const baseImage = makeImage(
    Buffer.from([
      24, 32, 96, 255, 36, 48, 128, 255,
      220, 160, 48, 255, 245, 232, 190, 255,
    ]),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWOQUEj4D8IMMAYAM2QGXeoNXYQAAAAASUVORK5CYII=', 'base64'),
  );
  const changedImage = makeImage(
    Buffer.from([
      15, 180, 90, 255, 15, 180, 90, 255,
      15, 180, 90, 255, 15, 180, 90, 255,
    ]),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPg3xL1H4QZYAwARxYIcbngJeoAAAAASUVORK5CYII=', 'base64'),
  );
  return {
    image: baseImage,
    baseImage,
    changedImage,
    scrollingAreas: 0,
    requiredCopyLayouts: [] as Array<{
      copy: string;
      lineGlyphCounts: number[];
      explicitBreak: boolean;
      writingMode: string;
    }>,
  };
});

vi.mock('electron', () => ({
  session: {
    fromPartition: () => ({ webRequest: { onBeforeRequest: vi.fn() } }),
  },
  BrowserWindow: class BrowserWindow {
    viewport = { width: 0, height: 0 };
    setContentSize(width: number, height: number) { this.viewport = { width, height }; }
    webContents = {
      executeJavaScript: vi.fn(async () => ({ viewport: this.viewport,
        scrollingAreas: electronImage.scrollingAreas, requiredCopyLayouts: electronImage.requiredCopyLayouts })),
      capturePage: vi.fn(async () => electronImage.image),
    };
    loadURL = vi.fn(async () => undefined);
    destroy = vi.fn();
  },
  nativeImage: {
    createFromPath: () => electronImage.image,
    createFromBuffer: () => electronImage.image,
  },
}));

vi.mock('../../../../src/main/features/image_production_services', () => ({
  checkImageProductionServices: (...args: unknown[]) => servicePreflight.estimate(...args),
}));

import {
  createImageStudioTool,
  imageStudioStatePath,
} from '../../../../src/main/model/core-agent/image-studio-tool';
import { createImageGenTool } from '../../../../src/main/model/core-agent/image-gen-tool';
import { ImageStudioNativePngDelivery } from '../../../../src/main/features/image_studio_delivery';
import {
  beginImageStudioGeneration,
  finishImageStudioGeneration,
  imageGenerationControlStatePath,
} from '../../../../src/main/features/image_production_control';

const IMAGE_STUDIO_AGENT_ID = '814b61b027f0';
const USER_ID = 'u-image-studio';
let root = '';
let projectDir = '';

beforeEach(() => {
  electronImage.image = electronImage.baseImage;
  electronImage.requiredCopyLayouts = [];
  electronImage.scrollingAreas = 0;
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network call in ImageStudio integration test'); }));
  imageProvider.generate.mockReset().mockImplementation(async (request) => {
    const bytes = electronImage.image.toPNG();
    fs.mkdirSync(path.dirname(request.outputAbsPath), { recursive: true });
    fs.writeFileSync(request.outputAbsPath, bytes);
    return { ok: true, path: request.outputAbsPath, width: 128, height: 128, bytes: bytes.length, provider: 'fixture', model: 'fixture' };
  });
  servicePreflight.estimate.mockReset();
  servicePreflight.estimate.mockResolvedValue({
    sufficient: true,
    external_billing_estimate_available: false,
    externally_billed_segment_ids: ['hero-initial'],
    unavailable_segment_ids: [],
    segments: [{ segment_id: 'hero-initial', billing_mode: 'external' }],
  });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-image-studio-tool-'));
  projectDir = path.join(root, 'image-project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'image-manifest.json'), JSON.stringify({
    schema_version: 1,
    route: 'compose',
    canvas: { width: 1080, height: 1080 },
    brief: {
      purpose: 'Editorial cover',
      audience: 'Creative teams',
      required_copy: ['A deliberate image'],
      must_include: [],
      must_avoid: ['template cards'],
    },
    art_direction: {
      subject_world: 'Independent culture magazine',
      one_job: 'Make the theme memorable',
      visual_tradition: 'Editorial photomontage',
      composition: 'One oversized diagonal title and a quiet lower field',
      signature_device: 'A torn circular window',
      typography: 'Condensed display with humanist captions',
      color_light_material: 'Warm paper, carbon black, cobalt ink',
    },
    generation_budget: { max_calls: 0 },
  }, null, 2));
  fs.writeFileSync(path.join(projectDir, 'index.html'), '<!doctype html><html><body><h1>A deliberate image</h1><svg></svg></body></html>');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
  if (process.env.ORKAS_WORKSPACE_ROOT) {
    fs.rmSync(path.join(process.env.ORKAS_WORKSPACE_ROOT, USER_ID, 'local', 'image_studio'), { recursive: true, force: true });
  }
});

async function generateProviderOutput(outputPath: string, extra: Record<string, unknown> = {}): Promise<void> {
  // Mock only the external generation/quote boundaries; the tools must persist
  // provenance themselves before inspection can grant an export exemption.
  const tool = createImageGenTool({ userId: USER_ID, agentId: IMAGE_STUDIO_AGENT_ID, hasProducedPath: () => true });
  const result = await tool.execute!({
    prompt: 'An editorial cover', output_path: outputPath,
    image_project_path: projectDir, image_request_id: 'provider-output', ...extra,
  }, { workingDir: root } as any);
  expect(result.isError, String(result.content)).not.toBe(true);
  expect(imageProvider.generate).toHaveBeenCalledOnce();
  expect(fs.existsSync(outputPath)).toBe(true);
}

describe('image_studio tool', () => {
  it('returns a recoverable SVG reference error without rewriting the source or losing the candidate', async () => {
    const manifestPath = path.join(projectDir, 'image-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><image href="https://example.com/outside.png"/></svg>';
    fs.writeFileSync(path.join(projectDir, 'source.svg'), source);
    manifest.references = [{ id: 'source', path: 'source.svg', role: 'content', strength: 1, required: true,
      preserve: ['Source contents'], may_change: [], region_ids: [] }];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const tool = createImageStudioTool({ userId: USER_ID, agentId: IMAGE_STUDIO_AGENT_ID, extraRoots: [root] });
    const result = await tool.execute({ op: 'project.snapshot', project_dir: projectDir, output_path: path.join(projectDir, 'candidate.png') }, { workingDir: root } as any);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({ error_code: 'E_IMAGE_SVG_REFERENCE', recovery_context: { evidence_available: true } });
    expect(fs.readFileSync(path.join(projectDir, 'source.svg'), 'utf8')).toBe(source);
    expect(fs.existsSync(path.join(projectDir, 'candidate.png'))).toBe(true);
  });
  it('advertises optional PDF delivery while keeping the default format implicit', () => {
    const tool = createImageStudioTool({ userId: USER_ID, agentId: IMAGE_STUDIO_AGENT_ID });
    expect((tool.inputSchema.properties as any).format.enum).toContain('pdf');
    expect((tool.inputSchema.required || [])).not.toContain('format');
  });
  it('keeps PSD export explicit and rejects a missing or foreign candidate without publishing', async () => {
    const onOutputsPublished = vi.fn();
    const tool = createImageStudioTool({ userId: USER_ID, agentId: IMAGE_STUDIO_AGENT_ID, onOutputsPublished });
    expect((tool.inputSchema.properties as any).format.enum).toContain('psd');
    for (const input_path of [undefined, path.join(root, 'foreign.psd')]) {
      const result = await tool.execute!({ op: 'project.export', project_dir: projectDir,
        format: 'psd', output_path: path.join(root, 'final.psd'), input_path }, { workingDir: root } as any);
      expect(result.isError).toBe(true); expect(result.content).toContain('E_IMAGE_PSD_INPUT_REQUIRED');
    }
    expect(onOutputsPublished).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, 'final.psd'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'final.png'))).toBe(false);
  });
  it('directly executes structural project inspection for its owner', async () => {
    const tool = createImageStudioTool({ userId: USER_ID, agentId: IMAGE_STUDIO_AGENT_ID, extraRoots: [root] });
    const result = await tool.execute({ op: 'project.inspect', project_dir: projectDir }, { workingDir: root } as any);
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('"signature"');
    expect(result.content).toContain('"route":"compose"');
  });

  // 2026-11-23: inspection reads only inside the image project; a file from elsewhere is
  // refused with how to bring it in, not with a bare scope error.
  it('says to copy an image from elsewhere into the project before inspecting it', async () => {
    const tool = createImageStudioTool({ userId: USER_ID, agentId: IMAGE_STUDIO_AGENT_ID, extraRoots: [root] });
    const elsewhere = path.join(os.tmpdir(), `orkas-image-elsewhere-${process.pid}.png`);
    const result = await tool.execute({ op: 'project.inspect', project_dir: projectDir, input_path: elsewhere }, { workingDir: root } as any);
    expect(result.isError).toBe(true);
    expect(result.content).toBe(`E_PATH_OUT_OF_SCOPE: input_path is outside this conversation's files: ${elsewhere}. Copy it into the image project first, then inspect it there.`);
  });

  it('does not attach visual evidence before deterministic project inspection passes', async () => {
    fs.unlinkSync(path.join(projectDir, 'index.html'));
    const tool = createImageStudioTool({
      userId: USER_ID,
      agentId: IMAGE_STUDIO_AGENT_ID,
      extraRoots: [root],
    });

    const result = await tool.execute({
      op: 'project.snapshot',
      project_dir: projectDir,
      output_path: path.join(root, 'evidence', 'blocked.png'),
    }, { workingDir: root } as any);

    expect(result.isError).toBe(true);
    expect(result.images).toBeUndefined();
    expect(JSON.parse(result.content)).toMatchObject({
      ok: false,
      recovery_context: { next_operation: 'repair_project_then_project.snapshot' },
    });
    expect(fs.existsSync(path.join(root, 'evidence', 'blocked.png'))).toBe(false);
    fs.writeFileSync(path.join(projectDir, 'index.html'), '<html><body><h1>A deliberate image</h1><svg></svg></body></html>');
    const repaired = await tool.execute({
      op: 'project.snapshot', project_dir: projectDir,
      output_path: path.join(root, 'evidence', 'repaired.png'),
    }, { workingDir: root } as any);
    expect(repaired.isError).not.toBe(true);
    expect(repaired.images).toHaveLength(1);
    expect(JSON.parse(repaired.content)).toMatchObject({
      recovery_context: { next_operation: 'project.submit_design_review' },
    });
  });

  it('keeps a scrolling composition out of delivered files and gives a layout repair handoff', async () => {
    electronImage.scrollingAreas = 1;
    const onFileWritten = vi.fn();
    const onOutputsPublished = vi.fn();
    const tool = createImageStudioTool({ userId: USER_ID, agentId: IMAGE_STUDIO_AGENT_ID,
      extraRoots: [root], onFileWritten, onOutputsPublished });
    const outputPath = path.join(root, 'evidence', 'scrolling.png');
    const result = await tool.execute({ op: 'project.snapshot', project_dir: projectDir, output_path: outputPath }, { workingDir: root } as any);
    expect(result.isError).toBe(true);
    expect(result.images).toBeUndefined();
    expect(JSON.parse(result.content)).toMatchObject({ ok: false, current_candidate: null,
      inspection: { blockers: [expect.objectContaining({ code: 'E_IMAGE_LAYOUT_SCROLLING' })] },
      recovery_context: { next_operation: 'repair_project_then_project.snapshot' } });
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(onFileWritten).not.toHaveBeenCalled();
    expect(onOutputsPublished).not.toHaveBeenCalled();
    const exported = await tool.execute({ op: 'project.export', project_dir: projectDir, output_path: path.join(root, 'final.png') }, { workingDir: root } as any);
    expect(exported.isError).toBe(true);
    expect(exported.content).toContain('E_IMAGE_REVIEW_EVIDENCE_REQUIRED');
    expect(fs.existsSync(path.join(root, 'final.png'))).toBe(false);
  });

  it('attaches the passing candidate and declared references in one ordered visual batch', async () => {
    const referencePath = path.join(projectDir, 'assets', 'reference.png');
    fs.mkdirSync(path.dirname(referencePath), { recursive: true });
    const referencePng = await sharp({
      create: {
        width: 3,
        height: 1,
        channels: 4,
        background: { r: 210, g: 42, b: 96, alpha: 1 },
      },
    }).png({ compressionLevel: 0 }).toBuffer();
    fs.writeFileSync(referencePath, referencePng);
    const manifestPath = path.join(projectDir, 'image-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.references = [{
      id: 'style-anchor',
      path: 'assets/reference.png',
      role: 'style',
      strength: 1,
      required: true,
      preserve: ['palette roles'],
      may_change: ['content'],
      region_ids: [],
    }];
    manifest.reference_intent = {
      mode: 'guide',
      basis: 'user',
      instructions: ['Use the supplied palette as a guide.'],
      minimum_score: 75,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const tool = createImageStudioTool({
      userId: USER_ID,
      agentId: IMAGE_STUDIO_AGENT_ID,
      extraRoots: [root],
    });
    const snapshotPath = path.join(root, 'evidence', 'with-reference.png');

    const result = await tool.execute({
      op: 'project.snapshot',
      project_dir: projectDir,
      output_path: snapshotPath,
    }, { workingDir: root } as any);

    expect(result.isError).not.toBe(true);
    expect(result.images).toHaveLength(2);
    expect(await sharp(snapshotPath).metadata()).toMatchObject({ width: 1080, height: 1080 });
    expect(result.images).toEqual([
      expect.objectContaining({ analysisMode: 'quality_review' }),
      expect.objectContaining({ analysisMode: 'understand' }),
    ]);
    expect(JSON.parse(result.content)).toMatchObject({
      visual_evidence: {
        attached: true,
        analysis_mode: 'quality_review',
        image_count: 2,
        images: [
          {
            order: 1, role: 'candidate', analysis_mode: 'quality_review',
            path: snapshotPath, width: 1080, height: 1080,
          },
          {
            order: 2, role: 'reference:style-anchor', analysis_mode: 'understand',
            path: referencePath, width: 3, height: 1,
          },
        ],
      },
    });
    const candidatePixels = await sharp(fs.readFileSync(snapshotPath)).ensureAlpha().raw().toBuffer();
    const attachedCandidatePixels = await sharp(Buffer.from(result.images![0].data, 'base64'))
      .ensureAlpha().raw().toBuffer();
    const referencePixels = await sharp(referencePng).ensureAlpha().raw().toBuffer();
    const attachedReferencePixels = await sharp(Buffer.from(result.images![1].data, 'base64'))
      .ensureAlpha().raw().toBuffer();
    expect(attachedCandidatePixels.equals(candidatePixels)).toBe(true);
    expect(attachedReferencePixels.equals(referencePixels)).toBe(true);
  });

  it('fails closed when invoked by a non-owner', async () => {
    const tool = createImageStudioTool({ userId: USER_ID, agentId: 'someone-else', extraRoots: [root] });
    const result = await tool.execute({ op: 'project.inspect', project_dir: projectDir }, { workingDir: root } as any);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('E_IMAGE_STUDIO_OWNER_REQUIRED');
  });

  it('keeps evolving asset libraries out of the native tool surface', () => {
    const tool = createImageStudioTool({ userId: USER_ID, agentId: IMAGE_STUDIO_AGENT_ID, extraRoots: [root] });
    const operations = (((tool.inputSchema as any).properties.op.enum) as string[]);
    expect(operations).toEqual([
      'project.status',
      'generation.quote',
      'project.inspect',
      'project.snapshot',
      'project.submit_design_review',
      'project.export',
    ]);
    for (const field of ['workflow_engine', 'workflow_path', 'output_node_id', 'output_index', 'timeout_ms']) {
      expect((tool.inputSchema as any).properties[field]).toBeUndefined();
    }
    expect((tool.inputSchema as any).properties.operations).toBeUndefined();
    expect((tool.inputSchema as any).properties.composite_layers).toBeUndefined();
    expect((tool.inputSchema as any).properties.quality_review).toBeUndefined();
    expect((tool.inputSchema as any).properties.review_verdict.description)
      .toContain('same call as review_scope, review_findings, and complete quality_scores');
    expect((tool.inputSchema as any).properties.review_verdict.description)
      .toContain('One submission per exact evidence');
    expect((tool.inputSchema as any).properties.quality_scores.description)
      .toContain('Required as one complete object in every project.submit_design_review call');
    expect((tool.inputSchema as any).properties.quality_scores.required).toEqual([
      'intent_alignment',
      'composition',
      'craft',
      'text_legibility',
      'defect_freedom',
      'specificity',
    ]);
    const additionalDimensions = (tool.inputSchema as any).properties.additional_dimensions;
    expect(additionalDimensions.description).toContain('open-ended task-specific review dimensions');
    expect(additionalDimensions.maxItems).toBe(8);
    expect(additionalDimensions.items.required).toEqual([
      'id',
      'label',
      'reason',
      'evidence',
      'score',
    ]);
  });

  it('returns a local provider-availability quote for the exact next direct generation request', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, 'image-manifest.json'), 'utf8'));
    manifest.route = 'generate';
    manifest.generation_budget.max_calls = 2;
    fs.writeFileSync(path.join(projectDir, 'image-manifest.json'), JSON.stringify(manifest));
    const tool = createImageStudioTool({
      userId: USER_ID,
      agentId: IMAGE_STUDIO_AGENT_ID,
      extraRoots: [root],
    });

    const result = await tool.execute({
      op: 'generation.quote',
      project_dir: projectDir,
      image_request_id: 'hero-initial',
      size: '2048x2048',
      reference_count: 1,
    }, { workingDir: root } as any);

    expect(result.isError).not.toBe(true);
    expect(servicePreflight.estimate).toHaveBeenCalledWith({
      requestId: 'hero-initial',
      size: '2048x2048',
      referenceCount: 1,
    }, undefined);
    expect(JSON.parse(result.content)).toMatchObject({
      ok: true,
      op: 'generation.quote',
      source: 'local_provider_configuration',
      generation: { calls_started: 0, max_calls: 2, calls_remaining: 2 },
      service_availability: { sufficient: true, external_billing_estimate_available: false, externally_billed_segment_ids: ['hero-initial'] },
    });
  });

  it('returns every current manifest blocker without failure-grouping metadata', async () => {
    const manifestPath = path.join(projectDir, 'image-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.references = [{
      id: 'composition-source',
      path: '/tmp/composition-source.png',
      role: 'composition',
      strength: 1,
      required: false,
      preserve: ['subject', 'crop', 'palette'],
      may_change: [],
      region_ids: [],
    }];
    manifest.reference_intent = {
      mode: 'reproduce',
      basis: 'user',
      instructions: ['Reproduce the supplied composition exactly.'],
      minimum_score: 90,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const tool = createImageStudioTool({
      userId: USER_ID,
      turnId: 'validation-turn',
      agentId: IMAGE_STUDIO_AGENT_ID,
      extraRoots: [root],
    });

    const result = await tool.execute({
      op: 'generation.quote',
      project_dir: projectDir,
      image_request_id: 'blocked-quote',
    }, { workingDir: root } as any);

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.inspection.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'E_MANIFEST_REFERENCE_PATH' }),
      expect.objectContaining({ code: 'E_MANIFEST_REPRODUCE_REFERENCE_REQUIRED' }),
    ]));
    expect(result).not.toHaveProperty("failureContext");
  });

  it('requires an exact generated-raster canvas before export without visual review', async () => {
    const generatedPath = path.join(projectDir, 'generated.png');
    fs.writeFileSync(generatedPath, electronImage.baseImage.toPNG());
    const manifestPath = path.join(projectDir, 'image-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.route = 'generate';
    manifest.raster_source = 'generated.png';
    manifest.generation_budget.max_calls = 1;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const tool = createImageStudioTool({
      userId: USER_ID,
      agentId: IMAGE_STUDIO_AGENT_ID,
      extraRoots: [root],
    });
    const ctx = { workingDir: root } as any;

    const mismatched = await tool.execute({
      op: 'project.inspect',
      project_dir: projectDir,
      input_path: generatedPath,
    }, ctx);
    expect(mismatched.isError).toBe(true);
    expect(JSON.parse(mismatched.content)).toMatchObject({
      ok: false,
      inspection: {
        blockers: [expect.objectContaining({ code: 'E_RASTER_CANVAS_SIZE_MISMATCH' })],
      },
      recovery_context: { next_operation: 'repair_project_then_project.inspect' },
    });
    expect((await tool.execute({
      op: 'project.export',
      project_dir: projectDir,
      output_path: path.join(root, 'final', 'mismatched.png'),
    }, ctx)).isError).toBe(true);

    manifest.canvas = { width: 128, height: 128 };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    await generateProviderOutput(generatedPath);
    const inspected = await tool.execute({
      op: 'project.inspect',
      project_dir: projectDir,
      input_path: generatedPath,
    }, ctx);

    expect(inspected.isError).not.toBe(true);
    expect(inspected.images).toBeUndefined();
    expect(JSON.parse(inspected.content)).toMatchObject({
      ok: true,
      current_candidate: {
        status: 'validated',
        path: generatedPath,
        is_generation: true,
      },
      recovery_context: {
        is_generation: true,
        next_operation: 'project.export',
      },
    });

    const unrequestedReview = await tool.execute({
      op: 'project.submit_design_review',
      project_dir: projectDir,
      evidence_path: generatedPath,
      review_verdict: 'passed',
      review_scope: 'This should not be accepted without attached visual evidence.',
      review_findings: [],
      quality_scores: {
        intent_alignment: 90,
        composition: 90,
        craft: 90,
        text_legibility: 90,
        defect_freedom: 90,
        specificity: 90,
      },
    }, ctx);
    expect(JSON.parse(unrequestedReview.content)).toMatchObject({
      ok: false,
      error_code: 'E_IMAGE_REVIEW_NOT_APPLICABLE',
    });

    const finalPath = path.join(root, 'final', 'generated.png');
    const exported = await tool.execute({
      op: 'project.export',
      project_dir: projectDir,
      output_path: finalPath,
    }, ctx);
    expect(exported.isError).not.toBe(true);
    expect(fs.existsSync(finalPath)).toBe(true);
  });

  it('resumes inspection from the current turn latest completed generation', async () => {
    const manifestPath = path.join(projectDir, 'image-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.route = 'generate';
    manifest.canvas = { width: 128, height: 128 };
    manifest.generation_budget.max_calls = 1;
    delete manifest.raster_source;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const previousPath = path.join(projectDir, 'previous-turn.png');
    const currentPath = path.join(projectDir, 'current-turn.png');
    fs.writeFileSync(previousPath, electronImage.baseImage.toPNG());
    fs.writeFileSync(currentPath, electronImage.baseImage.toPNG());
    const stateAbsPath = imageGenerationControlStatePath(USER_ID, projectDir);
    const previous = await beginImageStudioGeneration({
      stateAbsPath,
      projectDirAbs: projectDir,
      requestId: 'previous-turn-image',
      outputAbsPath: previousPath,
      turnId: 'turn-previous',
    });
    await finishImageStudioGeneration({
      stateAbsPath,
      transactionId: previous.transaction.transaction_id,
      ok: true,
      outputPath: previousPath,
    });
    const current = await beginImageStudioGeneration({
      stateAbsPath,
      projectDirAbs: projectDir,
      requestId: 'current-turn-image',
      outputAbsPath: currentPath,
      turnId: 'turn-current',
    });
    await finishImageStudioGeneration({
      stateAbsPath,
      transactionId: current.transaction.transaction_id,
      ok: true,
      outputPath: currentPath,
    });

    const tool = createImageStudioTool({
      userId: USER_ID,
      turnId: 'turn-current',
      agentId: IMAGE_STUDIO_AGENT_ID,
      extraRoots: [root],
    });
    const inspected = await tool.execute({
      op: 'project.inspect',
      project_dir: projectDir,
    }, { workingDir: root } as any);

    expect(inspected.isError).not.toBe(true);
    expect(JSON.parse(inspected.content)).toMatchObject({
      ok: true,
      inspection: { source_path: currentPath },
      current_candidate: {
        status: 'validated',
        path: currentPath,
      },
      recovery_context: { next_operation: 'project.export' },
    });
  });

  it('keeps technical raster validation fail-closed without falling back to visual review', async () => {
    const missingPath = path.join(projectDir, 'missing.png');
    const manifestPath = path.join(projectDir, 'image-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.route = 'generate';
    manifest.canvas = { width: 128, height: 128 };
    manifest.raster_source = 'missing.png';
    manifest.generation_budget.max_calls = 1;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const tool = createImageStudioTool({
      userId: USER_ID,
      agentId: IMAGE_STUDIO_AGENT_ID,
      extraRoots: [root],
    });
    const ctx = { workingDir: root } as any;

    const inspected = await tool.execute({
      op: 'project.inspect',
      project_dir: projectDir,
      input_path: missingPath,
      quality_review: true,
    }, ctx);
    expect(inspected.isError).toBe(true);
    expect(inspected.images).toBeUndefined();
    expect(inspected.content).not.toContain('visual_evidence');
    expect(JSON.parse(inspected.content)).toMatchObject({
      ok: false,
      inspection: {
        ok: false,
        route: 'generate',
        blockers: [expect.objectContaining({ code: 'E_RASTER_SOURCE_INVALID' })],
      },
      current_candidate: null,
      recovery_context: {
        next_operation: 'repair_project_then_project.inspect',
      },
    });

    const blockedExport = await tool.execute({
      op: 'project.export',
      project_dir: projectDir,
      output_path: path.join(root, 'final', 'missing.png'),
    }, ctx);
    expect(blockedExport.isError).toBe(true);
    expect(JSON.parse(blockedExport.content)).toMatchObject({
      ok: false,
      error_code: 'E_IMAGE_REVIEW_EVIDENCE_REQUIRED',
    });
  });

  it('rejects a manifest passed as the raster and accepts an explicit corrected inspection', async ({ onTestFinished }) => {
    const manifestPath = path.join(projectDir, 'image-manifest.json');
    const rasterPath = path.join(projectDir, 'source.png');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    Object.assign(manifest, {
      route: 'generate', canvas: { width: 128, height: 128 }, raster_source: 'source.png', generation_budget: { max_calls: 1 },
    });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    await generateProviderOutput(rasterPath);
    const decoder = vi.spyOn(nativeImage, 'createFromPath').mockImplementation(file => (
      file === manifestPath ? { ...electronImage.image, isEmpty: () => true } : electronImage.image
    ) as ReturnType<typeof nativeImage.createFromPath>);
    onTestFinished(() => { decoder.mockRestore(); });
    const opts = { userId: USER_ID, agentId: IMAGE_STUDIO_AGENT_ID, extraRoots: [projectDir] };
    const tool = createImageStudioTool(opts);
    const args = { op: 'project.inspect', project_dir: '.' };
    const ctx = { workingDir: projectDir } as any;

    const failed = await tool.execute({ ...args, input_path: 'image-manifest.json' }, ctx);
    expect(failed.isError).toBe(true);
    expect(JSON.parse(failed.content)).toMatchObject({
      inspection: { blockers: [{ code: 'E_RASTER_SOURCE_INVALID', message: expect.stringContaining('Omit input_path') }] },
    });
    expect(failed.images).toBeUndefined();
    expect(decoder).not.toHaveBeenCalled();
    expect(fs.existsSync(imageStudioStatePath(opts, projectDir))).toBe(false);

    for (const retry of [args, { ...args, input_path: 'source.png' }]) {
      const inspected = await tool.execute(retry, ctx);
      expect(inspected.isError).not.toBe(true);
      expect(JSON.parse(inspected.content).inspection).toMatchObject({
        ok: true, source_kind: 'raster', source_path: rasterPath,
      });
    }
  });

  it.each([
    {
      name: 'strict reference reproduction',
      route: 'generate',
      reference: {
        id: 'composition-source',
        path: 'assets/composition-source.png',
        role: 'composition',
        strength: 1,
        required: true,
        preserve: ['subject', 'crop', 'palette'],
        may_change: [],
        region_ids: [],
      },
      referenceIntent: {
        mode: 'reproduce',
        basis: 'user',
        instructions: ['Reproduce the declared composition and subject exactly.'],
        minimum_score: 90,
      },
    },
    {
      name: 'semantic edit fidelity',
      route: 'edit',
      reference: {
        id: 'edit-source',
        path: 'assets/edit-source.png',
        role: 'edit_source',
        strength: 1,
        required: true,
        preserve: ['subject identity', 'foreground geometry'],
        may_change: ['background'],
        region_ids: [],
      },
      referenceIntent: {
        mode: 'edit',
        basis: 'user',
        instructions: ['Replace only the background.'],
        minimum_score: 88,
      },
    },
    {
      name: 'generated set consistency',
      route: 'generate',
      reference: {
        id: 'set-anchor',
        path: 'assets/set-anchor.png',
        role: 'style',
        strength: 1,
        required: true,
        preserve: ['palette roles', 'lighting', 'material treatment'],
        may_change: ['subject content', 'local composition'],
        region_ids: [],
      },
      referenceIntent: {
        mode: 'guide',
        basis: 'user',
        instructions: ['Keep this member consistent with the generated set anchor.'],
        minimum_score: 85,
      },
    },
  ])('delivers low-contrast $name without aesthetic advice or ImageStudio visual review', async ({
    route,
    reference,
    referenceIntent,
  }) => {
    const generatedPath = path.join(projectDir, 'provider-result.png');
    const referencePath = path.join(projectDir, reference.path);
    fs.mkdirSync(path.dirname(referencePath), { recursive: true });
    // A deliberately uniform provider result is valid, not a request to
    // improve contrast. Use a full-sized bitmap so image analysis is real.
    const providerBytes = await sharp({
      create: { width: 128, height: 128, channels: 4, background: '#808080' },
    }).png().toBuffer();
    const bitmap = Buffer.alloc(128 * 128 * 4);
    for (let offset = 0; offset < bitmap.length; offset += 4) {
      bitmap.set([128, 128, 128, 255], offset);
    }
    electronImage.image = {
      ...electronImage.baseImage,
      toBitmap: () => bitmap,
      toPNG: () => providerBytes,
      toJPEG: () => providerBytes,
    };
    fs.writeFileSync(referencePath, electronImage.changedImage.toPNG());
    const manifestPath = path.join(projectDir, 'image-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.route = route;
    manifest.canvas = { width: 128, height: 128 };
    manifest.raster_source = 'provider-result.png';
    manifest.generation_budget.max_calls = 1;
    manifest.references = [reference];
    manifest.reference_intent = referenceIntent;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const binding = {
      index: 0, role: reference.role, strength: reference.strength,
      preserve: reference.preserve, may_change: reference.may_change,
    };
    await generateProviderOutput(generatedPath, {
      prompt: referenceIntent.instructions[0], reference_images: [referencePath], reference_bindings: [binding],
    });
    expect(imageProvider.generate).toHaveBeenCalledWith(expect.objectContaining({
      referenceImagePaths: [referencePath],
      referenceBindings: [{
        index: 0, role: reference.role, strength: reference.strength,
        preserve: reference.preserve, mayChange: reference.may_change,
      }],
      prompt: expect.stringContaining(referenceIntent.instructions[0]),
    }));
    const tool = createImageStudioTool({
      userId: USER_ID,
      agentId: IMAGE_STUDIO_AGENT_ID,
      extraRoots: [root],
    });
    const ctx = { workingDir: root } as any;

    const inspected = await tool.execute({
      op: 'project.inspect',
      project_dir: projectDir,
      input_path: generatedPath,
      quality_review: true,
    }, ctx);
    expect(inspected.isError).not.toBe(true);
    expect(inspected.images).toBeUndefined();
    expect(inspected.content).not.toContain('visual_evidence');
    const inspectedPayload = JSON.parse(inspected.content);
    // The manifest is the file the model wrote; the result carries only the
    // derived facts (route, counts, budget) — see K-3.
    expect(inspectedPayload.inspection.manifest).toBeUndefined();
    expect(inspectedPayload).toMatchObject({
      inspection: { route, advisories: [], image: { contrast: 0 } },
      current_candidate: {
        status: 'validated',
        path: generatedPath,
        is_generation: true,
      },
      recovery_context: {
        inspection_advisories: [],
        is_generation: true,
        next_operation: 'project.export',
      },
    });

    const ungroundedReview = await tool.execute({
      op: 'project.submit_design_review',
      project_dir: projectDir,
      evidence_path: generatedPath,
      review_verdict: 'passed',
      review_scope: 'A generated raster cannot enter the ImageStudio review gate.',
      review_findings: [],
      quality_scores: {
        intent_alignment: 90,
        composition: 90,
        craft: 90,
        text_legibility: 90,
        defect_freedom: 90,
        specificity: 90,
      },
    }, ctx);
    expect(JSON.parse(ungroundedReview.content)).toMatchObject({
      ok: false,
      error_code: 'E_IMAGE_REVIEW_NOT_APPLICABLE',
    });

    const exported = await tool.execute({
      op: 'project.export',
      project_dir: projectDir,
      output_path: path.join(root, 'final', `${route}-provider-result.png`),
    }, ctx);
    expect(exported.isError).not.toBe(true);
    expect(fs.readFileSync(path.join(root, 'final', `${route}-provider-result.png`))).toEqual(providerBytes);
    expect(fs.readFileSync(generatedPath)).toEqual(providerBytes);
  });

  it('reuses a generated request after tool recreation and retains its export exemption in a later turn', async () => {
    const manifestPath = path.join(projectDir, 'image-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    Object.assign(manifest, { route: 'generate', canvas: { width: 128, height: 128 }, generation_budget: { max_calls: 1 } });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const outputPath = path.join(projectDir, 'generated.png');
    const request = {
      prompt: 'An editorial cover', output_path: outputPath,
      image_project_path: projectDir, image_request_id: 'cover',
    };
    const opts = { userId: USER_ID, agentId: IMAGE_STUDIO_AGENT_ID, turnId: 'generation-turn' };
    const ctx = { workingDir: root } as any;
    expect((await createImageGenTool(opts).execute!(request, ctx)).isError).not.toBe(true);
    const original = fs.readFileSync(outputPath);
    const reused = await createImageGenTool(opts).execute!(request, ctx);
    expect(reused.isError).not.toBe(true);
    expect(String(reused.content)).toContain('reused completed generation');
    expect(imageProvider.generate).toHaveBeenCalledOnce();
    expect(servicePreflight.estimate).toHaveBeenCalledOnce();
    expect(fs.readFileSync(outputPath)).toEqual(original);
    expect(fs.existsSync(path.join(projectDir, 'generated-2.png'))).toBe(false);

    const tool = createImageStudioTool({ ...opts, extraRoots: [root] });
    const inspected = await tool.execute({ op: 'project.inspect', project_dir: projectDir }, ctx);
    expect(inspected.isError).not.toBe(true);
    expect(inspected.images).toBeUndefined();
    expect(JSON.parse(inspected.content).current_candidate).toMatchObject({ path: outputPath, is_generation: true });

    const nextTurn = createImageStudioTool({ ...opts, turnId: 'delivery-turn', extraRoots: [root] });
    const status = await nextTurn.execute({ op: 'project.status', project_dir: projectDir }, ctx);
    expect(JSON.parse(status.content)).toMatchObject({
      generation: { calls_started: 0, calls_remaining: 1 },
      current_candidate: { path: outputPath, is_generation: true },
      recovery_context: { next_operation: 'project.export' },
    });
    const finalPath = path.join(root, 'delivered.png');
    const exported = await nextTurn.execute({ op: 'project.export', project_dir: projectDir, output_path: finalPath }, ctx);
    expect(exported.isError).not.toBe(true);
    expect(JSON.parse(exported.content).is_generation).toBe(true);
    expect(fs.readFileSync(finalPath)).toEqual(original);
    expect(imageProvider.generate).toHaveBeenCalledOnce();
  });

  it.each(['failed', 'pending'] as const)('does not exempt a partial provider file or redispatch a %s generation', async (status) => {
    const manifestPath = path.join(projectDir, 'image-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const referencePath = path.join(projectDir, 'source.png');
    fs.writeFileSync(referencePath, electronImage.changedImage.toPNG());
    Object.assign(manifest, {
      route: 'edit', canvas: { width: 128, height: 128 },
      raster_source: 'partial.png', generation_budget: { max_calls: 1 },
      references: [{ id: 'source', path: 'source.png', role: 'edit_source', required: true, strength: 1, preserve: ['subject'], may_change: ['background'], region_ids: [] }],
      reference_intent: { mode: 'edit', basis: 'user', instructions: ['Replace the background.'], minimum_score: 80 },
    });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const outputPath = path.join(projectDir, 'partial.png');
    imageProvider.generate.mockImplementationOnce(async (request) => {
      fs.writeFileSync(request.outputAbsPath, electronImage.baseImage.toPNG());
      if (status === 'pending') throw new Error('Synthetic interrupted delivery');
      return { ok: false, errorCode: 'PROVIDER_API_ERROR', message: 'Synthetic terminal failure' };
    });
    const onFileWritten = vi.fn();
    const opts = { userId: USER_ID, agentId: IMAGE_STUDIO_AGENT_ID, turnId: 'fault-turn', onFileWritten };
    const request = {
      prompt: 'Replace the background.', output_path: outputPath,
      image_project_path: projectDir, image_request_id: 'cover', reference_images: [referencePath],
      reference_bindings: [{ index: 0, role: 'edit_source', preserve: ['subject'], may_change: ['background'] }],
    };
    const ctx = { workingDir: root } as any;
    const result = await createImageGenTool(opts).execute!(request, ctx);
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain(status === 'pending' ? 'E_IMAGE_GENERATION_UNCERTAIN' : 'PROVIDER_API_ERROR');
    const state = JSON.parse(fs.readFileSync(imageGenerationControlStatePath(USER_ID, projectDir), 'utf8'));
    expect(state.transactions).toHaveLength(1);
    expect(state.transactions[0].status).toBe(status);
    expect(state.transactions[0]).not.toHaveProperty('output_sha256');
    expect(state.transactions[0]).not.toHaveProperty('output_path');
    expect(onFileWritten).not.toHaveBeenCalled();

    const duplicate = await createImageGenTool(opts).execute!(request, ctx);
    expect(duplicate.isError).toBe(true);
    expect(String(duplicate.content)).toContain('E_IMAGE_GENERATION_REQUEST_ALREADY_USED');
    const exhausted = await createImageGenTool(opts).execute!({ ...request, image_request_id: 'another-cover' }, ctx);
    expect(exhausted.isError).toBe(true);
    expect(String(exhausted.content)).toContain('E_IMAGE_GENERATION_BUDGET_EXHAUSTED');
    expect(imageProvider.generate).toHaveBeenCalledOnce();
    expect(onFileWritten).not.toHaveBeenCalled();

    const studio = createImageStudioTool({ ...opts, extraRoots: [root] });
    const inspected = await studio.execute({ op: 'project.inspect', project_dir: projectDir }, ctx);
    expect(inspected.isError).not.toBe(true);
    expect(inspected.images).toHaveLength(2);
    expect(JSON.parse(inspected.content)).toMatchObject({
      current_candidate: { is_generation: false, status: 'current_unapproved' },
      recovery_context: { next_operation: 'project.submit_design_review' },
    });
    const finalPath = path.join(root, 'blocked.png');
    const exported = await studio.execute({ op: 'project.export', project_dir: projectDir, output_path: finalPath }, ctx);
    expect(exported.isError).toBe(true);
    expect(JSON.parse(exported.content).error_code).toBe('E_IMAGE_REVIEW_PASS_REQUIRED');
    expect(fs.existsSync(finalPath)).toBe(false);
    expect(onFileWritten).not.toHaveBeenCalled();
  });

  it('requires reinspection of legacy evidence and only clears its review after provider proof', async () => {
    const generatedPath = path.join(projectDir, 'legacy.png');
    fs.writeFileSync(generatedPath, electronImage.baseImage.toPNG());
    const manifestPath = path.join(projectDir, 'image-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.route = 'generate';
    manifest.canvas = { width: 128, height: 128 };
    manifest.raster_source = 'legacy.png';
    manifest.generation_budget.max_calls = 1;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const toolOpts = {
      userId: USER_ID,
      agentId: IMAGE_STUDIO_AGENT_ID,
      extraRoots: [root],
    };
    const tool = createImageStudioTool(toolOpts);
    const ctx = { workingDir: root } as any;
    expect((await tool.execute({
      op: 'project.inspect',
      project_dir: projectDir,
      input_path: generatedPath,
    }, ctx)).isError).not.toBe(true);

    const statePath = imageStudioStatePath(toolOpts, projectDir);
    const legacyState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    delete legacyState.is_generation;
    delete legacyState.source_kind;
    legacyState.review_required = false;
    legacyState.review = {
      verdict: 'repair',
      scope: 'Legacy automatic visual review.',
      findings: ['Legacy crop finding must no longer gate generated output.'],
      quality_scorecard: {},
      signature: legacyState.signature,
      evidence_path: legacyState.evidence_path,
      reviewed_at: new Date().toISOString(),
    };
    fs.writeFileSync(statePath, JSON.stringify(legacyState, null, 2));

    expect((await tool.execute({ op: 'project.export', project_dir: projectDir, output_path: path.join(root, 'unverified.png') }, ctx)).isError).toBe(true);
    await generateProviderOutput(generatedPath);
    await tool.execute({ op: 'project.inspect', project_dir: projectDir }, ctx);
    const status = await tool.execute({
      op: 'project.status',
      project_dir: projectDir,
    }, ctx);
    expect(JSON.parse(status.content)).toMatchObject({
      current_candidate: {
        status: 'validated',
        is_generation: true,
        review_current: false,
        review_verdict: null,
        review_findings: [],
      },
      recovery_context: {
        is_generation: true,
        review_current: false,
        review_verdict: null,
        next_operation: 'project.export',
      },
    });

    const exported = await tool.execute({
      op: 'project.export',
      project_dir: projectDir,
      output_path: path.join(root, 'final', 'legacy.png'),
    }, ctx);
    expect(exported.isError).not.toBe(true);
  });

  it.each(['html', 'raster'] as const)('reviews a non-generated EDIT %s and preserves its current candidate on resume', async (kind) => {
    const manifestPath = path.join(projectDir, 'image-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const providerPath = path.join(projectDir, 'provider.png');
    const candidatePath = path.join(projectDir, 'composed.png');
    fs.writeFileSync(providerPath, electronImage.baseImage.toPNG());
    fs.writeFileSync(candidatePath, electronImage.changedImage.toPNG());
    manifest.route = 'edit';
    manifest.canvas = { width: 128, height: 128 };
    manifest.generation_budget.max_calls = 1;
    manifest.references = [{ id: 'source', path: 'provider.png', role: 'edit_source', strength: 1, required: true, preserve: ['product'], may_change: ['headline'], region_ids: [] }];
    manifest.reference_intent = { mode: 'edit', basis: 'user', instructions: ['Replace the headline'], minimum_score: 80 };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    await generateProviderOutput(providerPath);
    if (kind === 'html') manifest.entry = 'index.html';
    else manifest.raster_source = 'composed.png';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    electronImage.image = electronImage.changedImage;
    const delivery = new ImageStudioNativePngDelivery();
    const publish = vi.fn((paths: string[]) => paths.filter(file => delivery.permits(file)));
    const opts = { userId: USER_ID, agentId: IMAGE_STUDIO_AGENT_ID, extraRoots: [root],
      imageStudioNativePngDelivery: delivery, onOutputsPublished: publish };
    const tool = createImageStudioTool(opts);
    const ctx = { workingDir: root } as any;
    const execute = (op: string, extra = {}) => tool.execute({ op, project_dir: projectDir, ...extra }, ctx);
    expect((await execute('project.inspect')).isError).not.toBe(true);
    const evidence = kind === 'html'
      ? await execute('project.snapshot', { output_path: path.join(projectDir, 'snapshot.png') })
      : await execute('project.inspect');
    expect(evidence.isError).not.toBe(true);
    expect(evidence.images).toHaveLength(2);
    const payload = JSON.parse(evidence.content);
    const evidencePath = payload.current_candidate.path;
    expect(payload.current_candidate).toMatchObject({ is_generation: false, status: 'current_unapproved' });
    expect(payload.recovery_context.next_operation).toBe('project.submit_design_review');
    expect(payload.current_candidate).not.toHaveProperty('review_required');
    expect((await execute('project.export', { output_path: path.join(root, 'blocked.png') })).isError).toBe(true);
    expect(fs.existsSync(path.join(root, 'blocked.png'))).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    const status = JSON.parse((await execute('project.status')).content);
    expect(status.current_candidate.path).toBe(evidencePath);
    expect(status.current_candidate.is_generation).toBe(false);
    const review = await execute('project.submit_design_review', {
      evidence_path: evidencePath, review_verdict: 'passed', review_scope: 'Current composition and protected source compared.', review_findings: [],
      quality_scores: { intent_alignment: 90, composition: 90, craft: 90, text_legibility: 90, defect_freedom: 90, specificity: 90, reference_fidelity: 90 },
    });
    expect(review.isError).not.toBe(true);
    // Reading the same authored raster again must not erase its passing review.
    if (kind === 'raster') expect(JSON.parse((await execute('project.inspect')).content).current_candidate.status).toBe('approved');
    const final = path.join(root, 'final.png');
    expect((await execute('project.export', { output_path: final })).isError).not.toBe(true);
    expect(publish.mock.results[0].value).toEqual([final]);
    expect(delivery.permits(candidatePath)).toBe(false);
    const copy = path.join(root, 'copy.png');
    fs.copyFileSync(final, copy);
    expect(delivery.permits(copy)).toBe(false);
    fs.renameSync(copy, final);
    expect(delivery.permits(final)).toBe(false);
    expect(fs.readFileSync(providerPath)).toEqual(electronImage.baseImage.toPNG());
    expect(JSON.parse(fs.readFileSync(imageStudioStatePath(opts, projectDir), 'utf8'))).not.toHaveProperty('review_required');
  });

  it('revokes a provider artifact exemption after the same path is overwritten', async () => {
    const manifestPath = path.join(projectDir, 'image-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const providerPath = path.join(projectDir, 'provider.png');
    fs.writeFileSync(providerPath, electronImage.baseImage.toPNG());
    Object.assign(manifest, { route: 'generate', canvas: { width: 128, height: 128 }, raster_source: 'provider.png', generation_budget: { max_calls: 1 }, is_generation: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    await generateProviderOutput(providerPath);
    const tool = createImageStudioTool({ userId: USER_ID, agentId: IMAGE_STUDIO_AGENT_ID, extraRoots: [root] });
    const call = (op: string, extra = {}) => tool.execute({ op, project_dir: projectDir, ...extra }, { workingDir: root } as any);
    expect(JSON.parse((await call('project.inspect')).content).current_candidate.is_generation).toBe(true);
    fs.writeFileSync(providerPath, electronImage.changedImage.toPNG());
    electronImage.image = electronImage.changedImage;
    expect((await call('project.export', { output_path: path.join(root, 'stale.png') })).isError).toBe(true);
    const refreshed = await call('project.inspect');
    expect(refreshed.images).toHaveLength(1);
    expect(JSON.parse(refreshed.content).current_candidate.is_generation).toBe(false);
    expect((await call('project.export', { output_path: path.join(root, 'unreviewed.png') })).isError).toBe(true);
  });

  it('runs the COMPOSE snapshot, scored review, and export gate through the production tool path', async () => {
    const published: string[][] = [];
    const tool = createImageStudioTool({
      userId: USER_ID,
      agentId: IMAGE_STUDIO_AGENT_ID,
      extraRoots: [root],
      onOutputsPublished: async (paths) => {
        published.push(paths);
        return paths;
      },
    });
    const ctx = { workingDir: root } as any;
    const snapshotPath = path.join(root, 'evidence', 'compose.png');
    const snapshot = await tool.execute({
      op: 'project.snapshot',
      project_dir: projectDir,
      output_path: snapshotPath,
    }, ctx);
    expect(snapshot.isError).not.toBe(true);
    expect(fs.existsSync(snapshotPath)).toBe(true);
    expect(snapshot.images).toHaveLength(1);
    expect(snapshot.images![0]).toMatchObject({ analysisMode: 'quality_review' });
    const snapshotPayload = JSON.parse(snapshot.content);
    expect(snapshotPayload.inspection).toMatchObject({
      ok: true,
      route: 'compose',
      evidence_path: snapshotPath,
      image: { width: 128, height: 128 },
    });
    expect(snapshotPayload.visual_evidence).toMatchObject({
      attached: true,
      role: 'candidate',
      path: snapshotPath,
      width: 1080,
      height: 1080,
      policy: 'attached_only_after_deterministic_inspection_passed',
      review_gate: {
        scope: 'candidate_only',
        max_submissions_per_evidence: 1,
        recheck_requires: ['source_signature_changed', 'candidate_pixels_changed'],
        required_checks: [
          'contrast',
          'clipping',
          'overlap',
          'duplicate_text',
          'alignment',
          'placeholder_residue',
        ],
      },
    });
    expect(snapshotPayload.visual_evidence.review_gate.passing_rule).toContain(
      'A fail or uncertain check requires repair or another inspection',
    );
    const evidencePixels = await sharp(fs.readFileSync(snapshotPath)).ensureAlpha().raw().toBuffer();
    const modelPixels = await sharp(Buffer.from(snapshot.images![0].data, 'base64')).ensureAlpha().raw().toBuffer();
    expect(modelPixels.equals(evidencePixels)).toBe(true);

    const review = await tool.execute({
      op: 'project.submit_design_review',
      project_dir: projectDir,
      evidence_path: snapshotPath,
      review_verdict: 'passed',
      review_scope: 'Checked the exact captured composition for hierarchy, copy, crop, and visible defects.',
      review_findings: [],
      quality_scores: {
        intent_alignment: 92,
        composition: 88,
        craft: 86,
        text_legibility: 94,
        defect_freedom: 90,
        specificity: 84,
      },
      additional_dimensions: [{
        id: 'editorial_rhythm',
        label: 'Editorial rhythm',
        reason: 'The declared visual tradition depends on an intentional type-and-shape cadence.',
        evidence: 'The diagonal title and lower caption field form a clear alternating rhythm.',
        score: 82,
      }],
    }, ctx);
    expect(review.isError).not.toBe(true);
    expect(JSON.parse(review.content)).toMatchObject({
      ok: true,
      status: 'passed',
      next_action: 'project.export',
      review: {
        quality_scorecard: {
          overall: 89,
          additional_dimensions: [{ id: 'editorial_rhythm', score: 82 }],
        },
      },
    });

    const finalPath = path.join(root, 'final', 'compose-final.png');
    const exported = await tool.execute({
      op: 'project.export',
      project_dir: projectDir,
      output_path: finalPath,
      format: 'png',
    }, ctx);
    expect(exported.isError).not.toBe(true);
    expect(fs.existsSync(finalPath)).toBe(true);
    expect(JSON.parse(exported.content)).toMatchObject({ ok: true, output_path: finalPath, image: { width: 128, height: 128 } });
    expect(published).toEqual([[finalPath]]);

    fs.appendFileSync(path.join(projectDir, 'index.html'), '<!-- source changed -->');
    const staleExport = await tool.execute({
      op: 'project.export',
      project_dir: projectDir,
      output_path: path.join(root, 'final', 'stale.png'),
    }, ctx);
    expect(staleExport.isError).toBe(true);
    expect(JSON.parse(staleExport.content)).toMatchObject({
      ok: false,
      error_code: 'E_IMAGE_REVIEW_EVIDENCE_STALE',
      current_candidate: {
        status: 'stale_unapproved',
        path: snapshotPath,
        evidence_current: false,
      },
      recovery_context: {
        next_operation: 'project.snapshot',
      },
    });
  });

  it('invalidates a prior passing review when a recapture fails the required-copy layout gate', async () => {
    const tool = createImageStudioTool({
      userId: USER_ID,
      agentId: IMAGE_STUDIO_AGENT_ID,
      extraRoots: [root],
    });
    const ctx = { workingDir: root } as any;
    const firstEvidence = path.join(root, 'evidence', 'layout-pass.png');
    expect((await tool.execute({
      op: 'project.snapshot',
      project_dir: projectDir,
      output_path: firstEvidence,
    }, ctx)).isError).not.toBe(true);
    expect((await tool.execute({
      op: 'project.submit_design_review',
      project_dir: projectDir,
      evidence_path: firstEvidence,
      review_verdict: 'passed',
      review_scope: 'Checked the exact captured composition and required-copy layout.',
      review_findings: [],
      quality_scores: {
        intent_alignment: 92,
        composition: 88,
        craft: 86,
        text_legibility: 94,
        defect_freedom: 90,
        specificity: 84,
      },
    }, ctx)).isError).not.toBe(true);

    electronImage.requiredCopyLayouts = [{
      copy: 'A deliberate image',
      lineGlyphCounts: [17, 1],
      explicitBreak: false,
      writingMode: 'horizontal-tb',
    }];
    const failedEvidence = path.join(root, 'evidence', 'layout-blocked.png');
    const blockedSnapshot = await tool.execute({
      op: 'project.snapshot',
      project_dir: projectDir,
      output_path: failedEvidence,
    }, ctx);
    expect(blockedSnapshot.isError).toBe(true);
    expect(JSON.parse(blockedSnapshot.content)).toMatchObject({
      inspection: {
        ok: false,
        evidence_path: failedEvidence,
        blockers: [expect.objectContaining({ code: 'E_REQUIRED_COPY_ORPHAN_LINE' })],
      },
      current_candidate: {
        status: 'current_unapproved',
        path: failedEvidence,
        review_verdict: null,
      },
    });

    const blockedExport = await tool.execute({
      op: 'project.export',
      project_dir: projectDir,
      output_path: path.join(root, 'final', 'layout-must-not-export.png'),
    }, ctx);
    expect(blockedExport.isError).toBe(true);
    expect(blockedExport.content).toContain('E_IMAGE_REVIEW_PASS_REQUIRED');
  });

  it('blocks export when a grounded task-specific review dimension is below the native floor', async () => {
    const tool = createImageStudioTool({
      userId: USER_ID,
      agentId: IMAGE_STUDIO_AGENT_ID,
      extraRoots: [root],
    });
    const ctx = { workingDir: root } as any;
    const evidencePath = path.join(root, 'evidence', 'weak-brand.png');
    await tool.execute({
      op: 'project.snapshot',
      project_dir: projectDir,
      output_path: evidencePath,
    }, ctx);

    const review = await tool.execute({
      op: 'project.submit_design_review',
      project_dir: projectDir,
      evidence_path: evidencePath,
      review_verdict: 'passed',
      review_scope: 'Checked the exact evidence, including the task-specific brand system.',
      review_findings: [],
      quality_scores: {
        intent_alignment: 92,
        composition: 88,
        craft: 86,
        text_legibility: 94,
        defect_freedom: 90,
        specificity: 84,
      },
      additional_dimensions: [{
        id: 'brand_coherence',
        label: 'Brand coherence',
        reason: 'The requested image must preserve the supplied visual identity.',
        evidence: 'The candidate introduces an unrelated accent color and icon treatment.',
        score: 62,
      }],
    }, ctx);

    expect(review.isError).toBe(true);
    expect(JSON.parse(review.content)).toMatchObject({
      ok: false,
      error_code: 'E_IMAGE_REVIEW_SCORE_BELOW_FLOOR',
      current_candidate: {
        status: 'current_unapproved',
        review_verdict: null,
      },
      recovery_context: {
        next_operation: 'project.submit_design_review',
      },
    });
    const blockedExport = await tool.execute({
      op: 'project.export',
      project_dir: projectDir,
      output_path: path.join(root, 'final', 'must-not-export.png'),
    }, ctx);
    expect(blockedExport.isError).toBe(true);
    expect(blockedExport.content).toContain('E_IMAGE_REVIEW_PASS_REQUIRED');
  });

  it('never overwrites a delivered export when a later turn re-exports the same path', async () => {
    // Mirrors the bus wiring: `producedPaths` is conversation-scoped, so a path
    // exported in an earlier turn is still "ours" when the user asks for a
    // revision. Export must stay immutable anyway — the first PNG is already
    // attached to a chat message the user can scroll back to.
    const produced = new Set<string>();
    const tool = createImageStudioTool({
      userId: USER_ID,
      agentId: IMAGE_STUDIO_AGENT_ID,
      extraRoots: [root],
      onFileWritten: (absPath) => { produced.add(path.resolve(absPath)); },
      hasProducedPath: (absPath) => produced.has(path.resolve(absPath)),
    });
    const ctx = { workingDir: root } as any;
    const finalPath = path.join(root, 'final', 'cover.png');

    const approveAndExport = async (evidenceName: string) => {
      const evidencePath = path.join(root, 'evidence', evidenceName);
      await tool.execute({
        op: 'project.snapshot', project_dir: projectDir, output_path: evidencePath,
      }, ctx);
      await tool.execute({
        op: 'project.submit_design_review',
        project_dir: projectDir,
        evidence_path: evidencePath,
        review_verdict: 'passed',
        review_scope: 'Checked the exact captured composition at delivery size.',
        review_findings: [],
        quality_scores: {
          intent_alignment: 92,
          composition: 88,
          craft: 86,
          text_legibility: 94,
          defect_freedom: 90,
          specificity: 84,
        },
      }, ctx);
      return tool.execute({
        op: 'project.export', project_dir: projectDir, output_path: finalPath, format: 'png',
      }, ctx);
    };

    const first = await approveAndExport('v1.png');
    expect(first.isError).not.toBe(true);
    expect(JSON.parse(first.content)).toMatchObject({ ok: true, output_path: finalPath });
    expect(first.content).not.toContain('<file-renamed>');

    // A later turn: same requested filename, source re-approved.
    fs.appendFileSync(path.join(projectDir, 'index.html'), '<!-- revised -->');
    const second = await approveAndExport('v2.png');
    expect(second.isError).not.toBe(true);

    const revisedPath = path.join(root, 'final', 'cover-2.png');
    // A renamed export appends the `<file-renamed>` signal after the JSON body.
    const [secondJson] = second.content.split('\n\n<file-renamed>');
    expect(JSON.parse(secondJson)).toMatchObject({ ok: true, output_path: revisedPath });
    expect(second.content).toContain('<file-renamed>');
    // The delivered v1 survives untouched alongside the revision.
    expect(fs.existsSync(finalPath)).toBe(true);
    expect(fs.existsSync(revisedPath)).toBe(true);
  });

  it('keeps a rejected candidate visible and advances after a real source repair', async () => {
    const tool = createImageStudioTool({
      userId: USER_ID,
      agentId: IMAGE_STUDIO_AGENT_ID,
      extraRoots: [root],
    });
    const ctx = { workingDir: root } as any;
    const passingScores = {
      intent_alignment: 92,
      composition: 88,
      craft: 86,
      text_legibility: 94,
      defect_freedom: 90,
      specificity: 84,
    };
    const firstEvidence = path.join(root, 'evidence', 'first.png');
    await tool.execute({
      op: 'project.snapshot',
      project_dir: projectDir,
      output_path: firstEvidence,
    }, ctx);
    const repair = await tool.execute({
      op: 'project.submit_design_review',
      project_dir: projectDir,
      evidence_path: firstEvidence,
      review_verdict: 'repair',
      review_scope: 'The exact candidate was reviewed at its delivery size.',
      review_findings: ['The title lacks sufficient contrast against the background.'],
      quality_scores: {
        intent_alignment: 84,
        composition: 82,
        craft: 68,
        text_legibility: 62,
        defect_freedom: 90,
        specificity: 78,
      },
    }, ctx);
    expect(JSON.parse(repair.content)).toMatchObject({
      ok: true,
      status: 'repair',
      next_action: 'repair_then_snapshot',
      current_candidate: {
        status: 'current_unapproved',
        path: firstEvidence,
        review_verdict: 'repair',
        review_findings: ['The title lacks sufficient contrast against the background.'],
      },
      recovery_context: {
        next_operation: 'repair_candidate_then_project.snapshot',
      },
    });

    const repeatedRepair = await tool.execute({
      op: 'project.submit_design_review',
      project_dir: projectDir,
      evidence_path: firstEvidence,
      review_verdict: 'repair',
      review_scope: 'Tried to rewrite the review without changing the evidence.',
      review_findings: ['The same title contrast issue remains.'],
      quality_scores: {
        intent_alignment: 84,
        composition: 82,
        craft: 68,
        text_legibility: 62,
        defect_freedom: 90,
        specificity: 78,
      },
    }, ctx);
    expect(JSON.parse(repeatedRepair.content)).toMatchObject({
      ok: false,
      error_code: 'E_IMAGE_REVIEW_REPAIR_REQUIRED',
    });

    const unchangedPass = await tool.execute({
      op: 'project.submit_design_review',
      project_dir: projectDir,
      evidence_path: firstEvidence,
      review_verdict: 'passed',
      review_scope: 'Attempted to approve the unchanged evidence.',
      review_findings: [],
      quality_scores: passingScores,
    }, ctx);
    expect(JSON.parse(unchangedPass.content)).toMatchObject({
      ok: false,
      error_code: 'E_IMAGE_REVIEW_REPAIR_REQUIRED',
      current_candidate: {
        path: firstEvidence,
        review_verdict: 'repair',
      },
    });

    const recapturedEvidence = path.join(root, 'evidence', 'recaptured.png');
    const recaptured = await tool.execute({
      op: 'project.snapshot',
      project_dir: projectDir,
      output_path: recapturedEvidence,
    }, ctx);
    expect(JSON.parse(recaptured.content)).toMatchObject({
      current_candidate: {
        path: recapturedEvidence,
        review_verdict: 'repair',
      },
      recovery_context: { next_operation: 'repair_candidate_then_project.snapshot' },
    });
    const recapturedPass = await tool.execute({
      op: 'project.submit_design_review',
      project_dir: projectDir,
      evidence_path: recapturedEvidence,
      review_verdict: 'passed',
      review_scope: 'Attempted to approve a fresh filename with identical evidence.',
      review_findings: [],
      quality_scores: passingScores,
    }, ctx);
    expect(JSON.parse(recapturedPass.content)).toMatchObject({
      ok: false,
      error_code: 'E_IMAGE_REVIEW_REPAIR_REQUIRED',
    });

    fs.appendFileSync(path.join(projectDir, 'index.html'), '<!-- no visible change -->');
    const sourceOnlyEvidence = path.join(root, 'evidence', 'source-only.png');
    const sourceOnly = await tool.execute({
      op: 'project.snapshot',
      project_dir: projectDir,
      output_path: sourceOnlyEvidence,
    }, ctx);
    expect(JSON.parse(sourceOnly.content)).toMatchObject({
      current_candidate: {
        path: sourceOnlyEvidence,
        review_verdict: 'repair',
      },
      recovery_context: { next_operation: 'repair_candidate_then_project.snapshot' },
    });

    fs.writeFileSync(
      path.join(projectDir, 'index.html'),
      '<!doctype html><html><body style="background:#fff;color:#111"><h1>A deliberate image</h1><svg></svg></body></html>',
    );
    electronImage.image = electronImage.changedImage;
    const repairedEvidence = path.join(root, 'evidence', 'repaired.png');
    const snapshot = await tool.execute({
      op: 'project.snapshot',
      project_dir: projectDir,
      output_path: repairedEvidence,
    }, ctx);
    expect(JSON.parse(snapshot.content)).toMatchObject({
      ok: true,
      current_candidate: {
        status: 'current_unapproved',
        path: repairedEvidence,
        evidence_current: true,
        review_verdict: null,
      },
      recovery_context: {
        next_operation: 'project.submit_design_review',
      },
    });
    const passed = await tool.execute({
      op: 'project.submit_design_review',
      project_dir: projectDir,
      evidence_path: repairedEvidence,
      review_verdict: 'passed',
      review_scope: 'Verified the repaired contrast and the unchanged required copy.',
      review_findings: [],
      quality_scores: passingScores,
    }, ctx);
    expect(JSON.parse(passed.content)).toMatchObject({
      current_candidate: { status: 'approved', path: repairedEvidence },
      recovery_context: { next_operation: 'project.export' },
    });
    await expect(tool.execute({
      op: 'project.export',
      project_dir: projectDir,
      output_path: path.join(root, 'final', 'repaired.png'),
    }, ctx)).resolves.toMatchObject({ isError: false });
  });

  it.each(['workflow.capabilities', 'workflow.run'])('rejects saved %s requests before contacting the configured host or writing output', async (op) => {
    vi.stubEnv('ORKAS_COMFYUI_BASE_URL', 'http://127.0.0.1:8188');
    const manifestPath = path.join(projectDir, 'image-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.route = 'generate';
    manifest.generation_budget.max_calls = 1;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const graph = JSON.stringify({ '9': { class_type: 'SaveImage', inputs: {} } });
    const workflowPath = path.join(projectDir, 'workflow.json');
    fs.writeFileSync(workflowPath, graph);

    const tool = createImageStudioTool({ userId: USER_ID, agentId: IMAGE_STUDIO_AGENT_ID, turnId: 'retired-workflow-turn' });
    const result = await tool.execute({
      op, project_dir: projectDir, workflow_engine: 'comfyui', workflow_path: 'workflow.json',
      image_request_id: 'saved-request', output_path: 'new.png',
    }, { workingDir: root } as any);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('op must be one of:');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(servicePreflight.estimate).not.toHaveBeenCalled();
    expect(imageProvider.generate).not.toHaveBeenCalled();
    expect(fs.existsSync(imageGenerationControlStatePath(USER_ID, projectDir))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'new.png'))).toBe(false);
    expect(fs.readFileSync(workflowPath, 'utf8')).toBe(graph);
  });
});


describe('image_studio fixed-page document journeys', () => {
  function book() {
    const file = path.join(projectDir, 'image-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.schema_version = 2;
    manifest.document = { pages: ['cover', 'detail'].map(id => ({ id, entry: `${id}.html`, required_copy: [id] })) };
    for (const id of ['cover', 'detail']) fs.writeFileSync(path.join(projectDir, `${id}.html`),
      `<!doctype html><html><body><h1>A deliberate image</h1><p>${id}</p><svg></svg></body></html>`);
    fs.writeFileSync(file, JSON.stringify(manifest));
  }
  it('discovers all pages without selecting one and refuses ambiguous writes without a network call', async () => {
    book(); const publish = vi.fn();
    const tool = createImageStudioTool({ userId: USER_ID, agentId: IMAGE_STUDIO_AGENT_ID, onOutputsPublished: publish });
    for (const op of ['project.status', 'project.inspect']) {
      const result = await tool.execute({ op, project_dir: projectDir }, { workingDir: root } as any);
      expect(result.isError, result.content).not.toBe(true);
      expect(JSON.parse(result.content).document.pages.map((page: any) => page.id)).toEqual(['cover', 'detail']);
      expect(result.images).toBeUndefined();
    }
    for (const op of ['project.snapshot', 'project.submit_design_review', 'project.export']) {
      const result = await tool.execute({ op, project_dir: projectDir, output_path: path.join(root, 'out.png') }, { workingDir: root } as any);
      expect(JSON.parse(result.content)).toMatchObject({ ok: false, error_code: 'E_IMAGE_DOCUMENT_PAGE_REQUIRED' });
    }
    const quote = await tool.execute({ op: 'generation.quote', project_dir: projectDir }, { workingDir: root } as any);
    expect(quote.isError).toBe(true);
    expect(quote.content).toContain('E_IMAGE_DOCUMENT_ROUTE');
    fs.unlinkSync(path.join(projectDir, 'detail.html'));
    const invalid = await tool.execute({ op: 'project.inspect', project_dir: projectDir }, { workingDir: root } as any);
    expect(invalid.isError).toBe(true);
    expect(JSON.parse(invalid.content).document.pages[1]).toMatchObject({
      id: 'detail', ok: false, next_operation: 'repair_project_then_project.snapshot',
    });
    expect(servicePreflight.estimate).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, 'out.png'))).toBe(false);
  });
  it('isolates page review state across turns and invalidates only the revised page', async () => {
    book(); const tool = createImageStudioTool({ userId: USER_ID, agentId: IMAGE_STUDIO_AGENT_ID });
    for (const page_id of ['cover', 'detail']) {
      const evidence_path = path.join(root, `${page_id}.png`);
      const captured = await tool.execute({ op: 'project.snapshot', project_dir: projectDir, page_id, output_path: evidence_path }, { workingDir: root } as any);
      expect(captured.isError, captured.content).not.toBe(true); expect(captured.images).toHaveLength(1);
      const reviewed = await tool.execute({ op: 'project.submit_design_review', project_dir: projectDir, page_id, evidence_path,
        review_verdict: 'passed', review_scope: 'Checked exact current page, hierarchy and legibility.', review_findings: [],
        quality_scores: { intent_alignment: 90, composition: 90, craft: 90, text_legibility: 90, defect_freedom: 90, specificity: 90 } }, { workingDir: root } as any);
      expect(reviewed.isError, reviewed.content).not.toBe(true);
    }
    expect(imageStudioStatePath({ userId: USER_ID }, projectDir, 'cover')).not.toBe(imageStudioStatePath({ userId: USER_ID }, projectDir, 'detail'));
    const later = createImageStudioTool({ userId: USER_ID, agentId: IMAGE_STUDIO_AGENT_ID, turnId: 'later-turn' });
    let inventory = JSON.parse((await later.execute({ op: 'project.status', project_dir: projectDir }, { workingDir: root } as any)).content).document;
    expect(inventory.ready_to_export).toBe(true);
    const detailState = imageStudioStatePath({ userId: USER_ID }, projectDir, 'detail');
    const previous = fs.readFileSync(detailState);
    fs.copyFileSync(imageStudioStatePath({ userId: USER_ID }, projectDir, 'cover'), detailState);
    const foreignState = JSON.parse((await later.execute({ op: 'project.status', project_dir: projectDir }, { workingDir: root } as any)).content).document;
    expect(foreignState.pages[1].evidence_current).toBe(false);
    fs.writeFileSync(detailState, previous);
    fs.appendFileSync(path.join(projectDir, 'detail.html'), '<!-- revised -->');
    inventory = JSON.parse((await later.execute({ op: 'project.status', project_dir: projectDir }, { workingDir: root } as any)).content).document;
    expect(inventory.pages.map((page: any) => page.review_current)).toEqual([true, false]);
    const reused = await later.execute({ op: 'project.export', project_dir: projectDir, page_id: 'cover', output_path: path.join(root, 'cover-final.png') }, { workingDir: root } as any);
    expect(reused.isError, reused.content).not.toBe(true); expect(JSON.parse(reused.content).format).toBe('png');
  });
  it('rejects unknown, malformed and single-page selectors while preserving the legacy state path', async () => {
    const tool = createImageStudioTool({ userId: USER_ID, agentId: IMAGE_STUDIO_AGENT_ID });
    const legacy = imageStudioStatePath({ userId: USER_ID }, projectDir);
    let result = await tool.execute({ op: 'project.inspect', project_dir: projectDir, page_id: 'cover' }, { workingDir: root } as any);
    expect(result.isError).toBe(true); expect(result.content).toContain('E_IMAGE_DOCUMENT_PAGE_UNEXPECTED');
    book();
    for (const page_id of ['missing', '../cover', '', 1]) {
      result = await tool.execute({ op: 'project.snapshot', project_dir: projectDir, page_id, output_path: path.join(root, 'bad.png') }, { workingDir: root } as any);
      expect(result.isError).toBe(true);
    }
    expect(imageStudioStatePath({ userId: USER_ID }, projectDir)).toBe(legacy);
    expect(fs.existsSync(path.join(root, 'bad.png'))).toBe(false);
  });
});

it('quotes the app-selected image service without changing the project or provider settings',async()=>{
 appMedia.route.mockResolvedValue('selected-image');const manifest=JSON.parse(fs.readFileSync(path.join(projectDir,'image-manifest.json'),'utf8'));manifest.route='generate';manifest.generation_budget.max_calls=2;fs.writeFileSync(path.join(projectDir,'image-manifest.json'),JSON.stringify(manifest));
 const result=await createImageStudioTool({userId:USER_ID,cid:'app-owned',agentId:IMAGE_STUDIO_AGENT_ID,extraRoots:[root]}).execute({op:'generation.quote',project_dir:projectDir,image_request_id:'hero-initial',size:'2048x2048',reference_count:1},{workingDir:root} as any);
 expect(result.isError).not.toBe(true);expect(servicePreflight.estimate).toHaveBeenCalledWith(expect.objectContaining({profileId:'selected-image'}),undefined);
});
