import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const productionCredits = vi.hoisted(() => ({
  estimate: vi.fn(),
}));

const electronImage = vi.hoisted(() => {
  const bitmap = Buffer.from([
    24, 32, 96, 255, 36, 48, 128, 255,
    220, 160, 48, 255, 245, 232, 190, 255,
  ]);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNkYPj/n4GBgYGJAQoAHgQCAW2l9mAAAAAASUVORK5CYII=', 'base64');
  const image = {
    getSize: () => ({ width: 2, height: 2 }),
    toBitmap: () => bitmap,
    toPNG: () => png,
    toJPEG: () => png,
    isEmpty: () => false,
  };
  return { image };
});

vi.mock('electron', () => ({
  session: {
    fromPartition: () => ({ webRequest: { onBeforeRequest: vi.fn() } }),
  },
  BrowserWindow: class BrowserWindow {
    webContents = {
      executeJavaScript: vi.fn(async () => true),
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
    const snapshotPayload = JSON.parse(snapshot.content);
    expect(snapshotPayload.inspection).toMatchObject({
      ok: true,
      route: 'compose',
      evidence_path: snapshotPath,
      image: { width: 2, height: 2 },
    });

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
    }, ctx);
    expect(review.isError).not.toBe(true);
    expect(JSON.parse(review.content)).toMatchObject({ ok: true, status: 'passed', next_action: 'project.export' });

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

  it('keeps a rejected candidate visible and advances after a real source repair', async () => {
    const tool = createImageStudioTool({
      userId: USER_ID,
      agentId: IMAGE_STUDIO_AGENT_ID,
      extraRoots: [root],
    });
    const ctx = { workingDir: root } as any;
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

    const unchangedPass = await tool.execute({
      op: 'project.submit_design_review',
      project_dir: projectDir,
      evidence_path: firstEvidence,
      review_verdict: 'passed',
      review_scope: 'Attempted to approve the unchanged evidence.',
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
    expect(JSON.parse(unchangedPass.content)).toMatchObject({
      ok: false,
      error_code: 'E_IMAGE_REVIEW_REPAIR_REQUIRED',
      current_candidate: {
        path: firstEvidence,
        review_verdict: 'repair',
      },
    });

    fs.writeFileSync(
      path.join(projectDir, 'index.html'),
      '<!doctype html><html><body style="background:#fff;color:#111"><h1>A deliberate image</h1><svg></svg></body></html>',
    );
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
      quality_scores: {
        intent_alignment: 92,
        composition: 88,
        craft: 86,
        text_legibility: 94,
        defect_freedom: 90,
        specificity: 84,
      },
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

  it('runs a host-configured workflow through the durable ImageStudio generation budget and reuses its request id', async () => {
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

    const tool = createImageStudioTool({ userId: USER_ID, agentId: IMAGE_STUDIO_AGENT_ID, extraRoots: [root] });
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
