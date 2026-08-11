import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

const productionCredits = vi.hoisted(() => ({
  estimate: vi.fn(),
}));

const electronImage = vi.hoisted(() => {
  const makeImage = (bitmap: Buffer, png: Buffer) => ({
    getSize: () => ({ width: 2, height: 2 }),
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
    webContents = {
      executeJavaScript: vi.fn(async () => electronImage.requiredCopyLayouts),
      capturePage: vi.fn(async () => electronImage.image),
    };
    loadURL = vi.fn(async () => undefined);
    destroy = vi.fn();
  },
  nativeImage: {
    createFromPath: () => electronImage.image,
  },
}));

vi.mock('../../../../src/main/features/permissions', () => ({
  getLocalExecGranted: () => true,
}));

vi.mock('../../../../src/main/features/image_production_credits', () => ({
  estimateImageProductionCredits: (...args: unknown[]) => productionCredits.estimate(...args),
}));

import { createImageStudioTool } from '../../../../src/main/model/core-agent/image-studio-tool';

const IMAGE_STUDIO_AGENT_ID = '814b61b027f0';
const USER_ID = 'u-image-studio';
let root = '';
let projectDir = '';
let previousComfyBaseUrl: string | undefined;

beforeEach(() => {
  electronImage.image = electronImage.baseImage;
  electronImage.requiredCopyLayouts = [];
  previousComfyBaseUrl = process.env.ORKAS_COMFYUI_BASE_URL;
  delete process.env.ORKAS_COMFYUI_BASE_URL;
  productionCredits.estimate.mockReset();
  productionCredits.estimate.mockResolvedValue({
    expected_credits_milli: 22_000,
    required_credits_milli: 22_000,
    available_credits_milli: 100_000,
    sufficient: true,
    fallback_fully_covered: true,
    orkas_credit_estimate_exact: true,
    externally_billed_segment_ids: [],
    managed_fallback_segment_ids: [],
    unavailable_segment_ids: [],
    segments: [{ segment_id: 'hero-initial', billing_mode: 'managed' }],
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
  if (previousComfyBaseUrl === undefined) delete process.env.ORKAS_COMFYUI_BASE_URL;
  else process.env.ORKAS_COMFYUI_BASE_URL = previousComfyBaseUrl;
  fs.rmSync(root, { recursive: true, force: true });
  if (process.env.ORKAS_WORKSPACE_ROOT) {
    fs.rmSync(path.join(process.env.ORKAS_WORKSPACE_ROOT, USER_ID, 'local', 'image_studio'), { recursive: true, force: true });
  }
});

describe('image_studio tool', () => {
  it('directly executes structural project inspection for its owner', async () => {
    const tool = createImageStudioTool({ userId: USER_ID, agentId: IMAGE_STUDIO_AGENT_ID, extraRoots: [root] });
    const result = await tool.execute({ op: 'project.inspect', project_dir: projectDir }, { workingDir: root } as any);
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('"signature"');
    expect(result.content).toContain('"route": "compose"');
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
    expect(JSON.parse(result.content)).toMatchObject({ ok: false });
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
            path: snapshotPath, width: 2, height: 2,
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
    expect(attachedCandidatePixels).toEqual(candidatePixels);
    expect(attachedReferencePixels).toEqual(referencePixels);
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
      'workflow.capabilities',
      'workflow.run',
    ]);
    expect((tool.inputSchema as any).properties.operations).toBeUndefined();
    expect((tool.inputSchema as any).properties.composite_layers).toBeUndefined();
    expect((tool.inputSchema as any).properties.review_verdict.description)
      .toContain('same call as review_scope, review_findings, and the complete quality_scores object');
    expect((tool.inputSchema as any).properties.review_verdict.description)
      .toContain('One submission is allowed per exact evidence');
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
    expect(productionCredits.estimate).toHaveBeenCalledWith({
      requestId: 'hero-initial',
      size: '2048x2048',
      referenceCount: 1,
    }, undefined);
    expect(JSON.parse(result.content)).toMatchObject({
      ok: true,
      op: 'generation.quote',
      source: 'local_provider_configuration',
      generation: { calls_started: 0, max_calls: 2, calls_remaining: 2 },
      credit_quote: { expected_credits_milli: 22_000, sufficient: true },
    });
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
      image: { width: 2, height: 2 },
    });
    expect(snapshotPayload.visual_evidence).toMatchObject({
      attached: true,
      role: 'candidate',
      path: snapshotPath,
      width: 2,
      height: 2,
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
    expect(modelPixels).toEqual(evidencePixels);

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
    expect(JSON.parse(exported.content)).toMatchObject({ ok: true, output_path: finalPath, image: { width: 2, height: 2 } });
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
      current_candidate: {
        status: 'current_unapproved',
        path: firstEvidence,
        review_verdict: 'repair',
        review_findings: ['The title lacks sufficient contrast against the background.'],
      },
      recovery_context: {
        next_operation: 'repair_candidate_then_reinspect',
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
      recovery_context: { next_operation: 'repair_candidate_then_reinspect' },
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
      recovery_context: { next_operation: 'repair_candidate_then_reinspect' },
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

  it('runs a host-configured workflow through the current-turn budget, reuses its request id, and resets on the next turn', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, 'image-manifest.json'), 'utf8'));
    manifest.route = 'generate';
    manifest.generation_budget.max_calls = 1;
    fs.writeFileSync(path.join(projectDir, 'image-manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(projectDir, 'workflow.json'), JSON.stringify({
      workflow: { '9': { class_type: 'SaveImage', inputs: {} } },
      output_node_id: '9',
    }));
    process.env.ORKAS_COMFYUI_BASE_URL = 'http://127.0.0.1:8188';
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    let fetchCalls = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      fetchCalls += 1;
      if (url.endsWith('/prompt')) return new Response(JSON.stringify({ prompt_id: 'tool-prompt-1' }), { status: 200 });
      if (url.endsWith('/history/tool-prompt-1')) return new Response(JSON.stringify({
        'tool-prompt-1': { status: { completed: true, status_str: 'success' }, outputs: { '9': { images: [{ filename: 'tool.png', subfolder: '', type: 'output' }] } } },
      }), { status: 200 });
      if (url.includes('/view?')) return new Response(png, { status: 200 });
      throw new Error(`unexpected URL ${url}`);
    });

    const tool = createImageStudioTool({
      userId: USER_ID,
      turnId: 'workflow-turn-1',
      agentId: IMAGE_STUDIO_AGENT_ID,
      extraRoots: [root],
    });
    const preDispatchFailure = await tool.execute({
      op: 'workflow.run',
      project_dir: projectDir,
      workflow_engine: 'comfyui',
      workflow_path: 'workflow.json',
      output_path: 'invalid-timeout.png',
      image_request_id: 'invalid-timeout',
      timeout_ms: 999,
    }, { workingDir: root } as any);
    expect(JSON.parse(preDispatchFailure.content)).toMatchObject({
      ok: false,
      status: 'failed',
      generation: {
        attempts_recorded: 1,
        calls_started: 0,
        calls_remaining: 1,
        pre_dispatch_failures: 1,
      },
    });

    const first = await tool.execute({
      op: 'workflow.run',
      project_dir: projectDir,
      workflow_engine: 'comfyui',
      workflow_path: 'workflow.json',
      output_path: 'generated.png',
      image_request_id: 'hero-initial',
      timeout_ms: 5_000,
    }, { workingDir: root } as any);
    expect(first.isError).not.toBe(true);
    expect(first.content).toContain('"generation_calls": 1');
    expect(first.content).toContain('"calls_started": 1');
    expect(fs.existsSync(path.join(projectDir, 'generated.png'))).toBe(true);

    const generatedPath = path.join(projectDir, 'generated.png');
    const inspected = await tool.execute({
      op: 'project.inspect',
      project_dir: projectDir,
      input_path: generatedPath,
    }, { workingDir: root } as any);
    expect(inspected.isError).not.toBe(true);
    expect(inspected.images).toHaveLength(1);
    expect(inspected.images![0]).toMatchObject({ analysisMode: 'quality_review' });
    expect(JSON.parse(inspected.content)).toMatchObject({
      visual_evidence: {
        attached: true,
        analysis_mode: 'quality_review',
        role: 'candidate',
        path: generatedPath,
        policy: 'attached_only_after_deterministic_inspection_passed',
      },
    });
    await tool.execute({
      op: 'project.submit_design_review',
      project_dir: projectDir,
      evidence_path: generatedPath,
      review_verdict: 'repair',
      review_scope: 'Reviewed the generated candidate and its delivery constraints.',
      review_findings: ['The subject crop needs a more stable focal balance.'],
      quality_scores: {
        intent_alignment: 82,
        composition: 64,
        craft: 78,
        text_legibility: 90,
        defect_freedom: 84,
        specificity: 76,
      },
    }, { workingDir: root } as any);
    const exhausted = await tool.execute({
      op: 'generation.quote',
      project_dir: projectDir,
      image_request_id: 'hero-repair',
    }, { workingDir: root } as any);
    expect(JSON.parse(exhausted.content)).toMatchObject({
      ok: false,
      error_code: 'E_IMAGE_GENERATION_BUDGET_EXHAUSTED',
      current_candidate: {
        status: 'current_unapproved',
        path: generatedPath,
        review_findings: ['The subject crop needs a more stable focal balance.'],
      },
      recovery_context: {
        generation: {
          calls_started: 1,
          calls_remaining: 0,
          budget_exhausted: true,
        },
      },
    });

    const nextTurnTool = createImageStudioTool({
      userId: USER_ID,
      turnId: 'workflow-turn-2',
      agentId: IMAGE_STUDIO_AGENT_ID,
      extraRoots: [root],
    });
    const nextTurnStatus = await nextTurnTool.execute({
      op: 'project.status',
      project_dir: projectDir,
    }, { workingDir: root } as any);
    expect(JSON.parse(nextTurnStatus.content)).toMatchObject({
      generation: {
        attempts_recorded: 0,
        calls_started: 0,
        calls_remaining: 1,
      },
      recovery_context: {
        generation: {
          calls_started: 0,
          calls_remaining: 1,
          budget_exhausted: false,
        },
      },
    });
    const nextTurnQuote = await nextTurnTool.execute({
      op: 'generation.quote',
      project_dir: projectDir,
      image_request_id: 'hero-initial',
    }, { workingDir: root } as any);
    expect(JSON.parse(nextTurnQuote.content)).toMatchObject({
      ok: true,
      generation: {
        calls_started: 0,
        calls_remaining: 1,
        max_calls: 1,
      },
    });

    const reused = await tool.execute({
      op: 'workflow.run',
      project_dir: projectDir,
      workflow_engine: 'comfyui',
      workflow_path: 'workflow.json',
      output_path: 'generated.png',
      image_request_id: 'hero-initial',
    }, { workingDir: root } as any);
    expect(reused.isError).not.toBe(true);
    expect(reused.content).toContain('"reused": true');
    expect(fetchCalls).toBe(3);
  });

  it('keeps an uncertain dispatched workflow counted and blocks a duplicate call', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, 'image-manifest.json'), 'utf8'));
    manifest.route = 'generate';
    manifest.generation_budget.max_calls = 1;
    fs.writeFileSync(path.join(projectDir, 'image-manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(projectDir, 'workflow.json'), JSON.stringify({
      workflow: { '9': { class_type: 'SaveImage', inputs: {} } },
      output_node_id: '9',
    }));
    process.env.ORKAS_COMFYUI_BASE_URL = 'http://127.0.0.1:8188';
    vi.stubGlobal('fetch', async () => {
      throw new Error('synthetic connection loss after submit may have reached the host');
    });
    const tool = createImageStudioTool({
      userId: USER_ID,
      turnId: 'uncertain-turn-1',
      agentId: IMAGE_STUDIO_AGENT_ID,
      extraRoots: [root],
    });
    const ctx = { workingDir: root } as any;

    const uncertain = await tool.execute({
      op: 'workflow.run',
      project_dir: projectDir,
      workflow_engine: 'comfyui',
      workflow_path: 'workflow.json',
      output_path: 'uncertain.png',
      image_request_id: 'uncertain-call',
    }, ctx);
    expect(JSON.parse(uncertain.content)).toMatchObject({
      ok: false,
      status: 'pending_uncertain',
      generation: {
        attempts_recorded: 1,
        calls_started: 1,
        calls_remaining: 0,
        pending: 1,
        pre_dispatch_failures: 0,
      },
    });

    const duplicate = await tool.execute({
      op: 'workflow.run',
      project_dir: projectDir,
      workflow_engine: 'comfyui',
      workflow_path: 'workflow.json',
      output_path: 'duplicate.png',
      image_request_id: 'duplicate-call',
    }, ctx);
    expect(JSON.parse(duplicate.content)).toMatchObject({
      ok: false,
      error_code: 'E_IMAGE_GENERATION_BUDGET_EXHAUSTED',
      recovery_context: {
        generation: {
          calls_started: 1,
          calls_remaining: 0,
          budget_exhausted: true,
        },
      },
    });
  });
});
