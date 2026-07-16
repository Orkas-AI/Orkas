import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  approveVideoProductionGeneration,
  approveVideoProductionPlan,
  beginVideoProductionGeneration,
  finishVideoProductionGeneration,
  readVideoProductionControlState,
  readVideoProductionPlanIdentity,
  validateVideoProductionPlanApproval,
  videoProductionControlStatePath,
} from '../../../src/main/features/video_production_control';

let root = '';
let planPath = '';
let statePath = '';

function plan(): Record<string, unknown> {
  return {
    aspect: '9:16',
    total_target_sec: 5,
    language: 'zh',
    delivery_promise: { type: 'motion_led', source_required: false, motion_min_ratio: 1 },
    segments: [{
      id: 'shot-1',
      order: 1,
      role: 'hook',
      layer: 'primary',
      source: 'generate',
      target_sec: 5,
      spec: {
        media_kind: 'video',
        prompt: 'A red product rotates on a clean studio table',
        resolution: '720p',
        quality: 'balanced',
        generate_audio: false,
      },
    }],
    cost_estimate: { billable_generations: 1 },
  };
}

function writePlan(value = plan()): void {
  fs.writeFileSync(planPath, JSON.stringify(value, null, 2), 'utf8');
}

function request(): Record<string, unknown> {
  return {
    prompt: 'A red product rotates on a clean studio table',
    ratio: '9:16',
    duration: 5,
    resolution: '720p',
    quality: 'balanced',
    generate_audio: false,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-video-production-control-'));
  planPath = path.join(root, 'plan.json');
  statePath = path.join(root, 'state.json');
  writePlan();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('VideoStudio project production control', () => {
  it('uses the plan artifact, not conversation/project routing metadata, as state identity', () => {
    expect(videoProductionControlStatePath({ userId: 'u', projectId: 'project-a', planPath }))
      .toBe(videoProductionControlStatePath({ userId: 'u', projectId: 'project-b', planPath }));
  });

  it('keeps approval across runtime status updates but invalidates creative drift', async () => {
    const approved = await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' });
    const updated = plan();
    const segments = updated.segments as Array<Record<string, unknown>>;
    segments[0].status = 'done';
    segments[0].produced_path = 'assets/shot-1.mp4';
    writePlan(updated);
    expect((await validateVideoProductionPlanApproval({ statePath, planPath })).identity.signature)
      .toBe(approved.identity.signature);

    (segments[0].spec as Record<string, unknown>).prompt = 'A different unapproved scene';
    writePlan(updated);
    await expect(validateVideoProductionPlanApproval({ statePath, planPath }))
      .rejects.toThrow(/E_VIDEO_PRODUCTION_GATE_B_STALE/);
  });

  it('binds Gate C to exact intents and reuses one completed transaction', async () => {
    await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' });
    await approveVideoProductionGeneration({ statePath, planPath, turnId: 'turn-c' });
    const outputPath = path.join(root, 'shot-1.mp4');
    const begun = await beginVideoProductionGeneration({
      statePath,
      planPath,
      segmentId: 'shot-1',
      kind: 'video',
      outputPath,
      request: request(),
    });
    expect(begun.status).toBe('started');
    if (begun.status !== 'started') throw new Error('expected started transaction');
    fs.writeFileSync(outputPath, 'video-bytes');
    await finishVideoProductionGeneration({
      statePath,
      planPath,
      transactionId: begun.transaction.transaction_id,
      segmentId: 'shot-1',
      kind: 'video',
      ok: true,
      outputPath,
      providerTaskId: 'provider-task-1',
    });
    const reused = await beginVideoProductionGeneration({
      statePath,
      planPath,
      segmentId: 'shot-1',
      kind: 'video',
      outputPath,
      request: request(),
    });
    expect(reused.status).toBe('reused');
    expect(reused.transaction.provider_task_id).toBe('provider-task-1');
  });

  it('fails closed on an interrupted billable request', async () => {
    await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' });
    await approveVideoProductionGeneration({ statePath, planPath, turnId: 'turn-c' });
    const args = {
      statePath,
      planPath,
      segmentId: 'shot-1',
      kind: 'video' as const,
      outputPath: path.join(root, 'shot-1.mp4'),
      request: request(),
    };
    expect((await beginVideoProductionGeneration(args)).status).toBe('started');
    await expect(beginVideoProductionGeneration(args))
      .rejects.toThrow(/E_VIDEO_PRODUCTION_GENERATION_UNCERTAIN/);
  });

  it('requires a new path after reapproving an uncertain provider attempt', async () => {
    await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' });
    await approveVideoProductionGeneration({ statePath, planPath, turnId: 'turn-c-1' });
    const oldOutputPath = path.join(root, 'shot-1.mp4');
    const base = {
      statePath,
      planPath,
      segmentId: 'shot-1',
      kind: 'video' as const,
      request: request(),
    };
    expect((await beginVideoProductionGeneration({ ...base, outputPath: oldOutputPath })).status).toBe('started');
    await approveVideoProductionGeneration({ statePath, planPath, turnId: 'turn-c-2' });
    await expect(beginVideoProductionGeneration({ ...base, outputPath: oldOutputPath }))
      .rejects.toThrow(/E_VIDEO_PRODUCTION_OUTPUT_RESERVED_BY_UNCERTAIN_ATTEMPT/);
    const newOutputPath = path.join(root, 'shot-1-retry.mp4');
    expect((await beginVideoProductionGeneration({ ...base, outputPath: newOutputPath })).status).toBe('started');
    const state = await readVideoProductionControlState(statePath, planPath);
    expect(state.transaction_history).toHaveLength(1);
    expect(state.transaction_history[0].output_path).toBe(oldOutputPath);
  });

  it('serializes concurrent starts so only one billable request can dispatch', async () => {
    await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' });
    await approveVideoProductionGeneration({ statePath, planPath, turnId: 'turn-c' });
    const args = {
      statePath,
      planPath,
      segmentId: 'shot-1',
      kind: 'video' as const,
      outputPath: path.join(root, 'shot-1.mp4'),
      request: request(),
    };
    const results = await Promise.allSettled([
      beginVideoProductionGeneration(args),
      beginVideoProductionGeneration(args),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected' });
    if (rejected?.status === 'rejected') {
      expect(String(rejected.reason)).toMatch(/E_VIDEO_PRODUCTION_GENERATION_UNCERTAIN/);
    }
  });

  it('never overwrites an output that is not owned by its transaction', async () => {
    await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' });
    await approveVideoProductionGeneration({ statePath, planPath, turnId: 'turn-c' });
    const existingImageVariant = path.join(root, 'shot-1.png');
    fs.writeFileSync(existingImageVariant, 'foreign-output');
    await expect(beginVideoProductionGeneration({
      statePath,
      planPath,
      segmentId: 'shot-1',
      kind: 'video',
      outputPath: path.join(root, 'shot-1'),
      candidateOutputPaths: [existingImageVariant],
      request: request(),
    })).rejects.toThrow(/E_VIDEO_PRODUCTION_OUTPUT_COLLISION/);
  });

  it('does not mark provider success completed before the artifact exists', async () => {
    await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' });
    await approveVideoProductionGeneration({ statePath, planPath, turnId: 'turn-c' });
    const outputPath = path.join(root, 'missing.mp4');
    const begun = await beginVideoProductionGeneration({
      statePath,
      planPath,
      segmentId: 'shot-1',
      kind: 'video',
      outputPath,
      request: request(),
    });
    if (begun.status !== 'started') throw new Error('expected started transaction');
    await expect(finishVideoProductionGeneration({
      statePath,
      planPath,
      transactionId: begun.transaction.transaction_id,
      segmentId: 'shot-1',
      kind: 'video',
      ok: true,
      outputPath,
    })).rejects.toThrow(/E_VIDEO_PRODUCTION_GENERATION_ARTIFACT_MISSING/);
    expect((await readVideoProductionControlState(statePath, planPath)).transactions['video:shot-1'].status)
      .toBe('pending');
  });

  it('rejects provider settings or media kind that differ from the signed plan', async () => {
    await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' });
    await approveVideoProductionGeneration({ statePath, planPath, turnId: 'turn-c' });
    await expect(beginVideoProductionGeneration({
      statePath,
      planPath,
      segmentId: 'shot-1',
      kind: 'video',
      outputPath: path.join(root, 'shot-1.mp4'),
      request: { ...request(), resolution: '1080p' },
    })).rejects.toThrow(/E_VIDEO_PRODUCTION_GENERATION_SETTINGS_MISMATCH/);
    await expect(beginVideoProductionGeneration({
      statePath,
      planPath,
      segmentId: 'shot-1',
      kind: 'image',
      outputPath: path.join(root, 'shot-1.png'),
      request: { prompt: request().prompt },
    })).rejects.toThrow(/E_VIDEO_PRODUCTION_GENERATION_KIND_MISMATCH/);
    await expect(beginVideoProductionGeneration({
      statePath,
      planPath,
      segmentId: 'shot-1',
      kind: 'video',
      outputPath: path.join(root, 'shot-1.mp4'),
      request: { ...request(), reference_image_urls: ['https://example.invalid/unapproved.png'] },
    })).rejects.toThrow(/E_VIDEO_PRODUCTION_GENERATION_SETTINGS_MISMATCH/);
  });

  it('normalizes the exact generate intent from the signed EDL', async () => {
    const identity = await readVideoProductionPlanIdentity(planPath);
    expect(identity.generation_intents).toEqual([{
      segment_id: 'shot-1',
      kind: 'video',
      prompt: 'A red product rotates on a clean studio table',
      ratio: '9:16',
      duration: 5,
      resolution: '720p',
      quality: 'balanced',
      generate_audio: false,
    }]);
  });

  it('rejects incomplete native Gate B intents even if the agent skipped its script validator', async () => {
    const missingKind = plan();
    delete ((missingKind.segments as Array<Record<string, any>>)[0].spec as Record<string, unknown>).media_kind;
    writePlan(missingKind);
    await expect(approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' }))
      .rejects.toThrow(/E_VIDEO_PRODUCTION_GENERATE_INTENT_INVALID/);

    const badCost = plan();
    (badCost.cost_estimate as Record<string, unknown>).billable_generations = 0;
    writePlan(badCost);
    await expect(approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' }))
      .rejects.toThrow(/E_VIDEO_PRODUCTION_COST_COUNT_MISMATCH/);

    const missingCompositionBinding = plan();
    missingCompositionBinding.segments = [{
      id: 'compose-1',
      order: 1,
      role: 'hook',
      layer: 'primary',
      source: 'compose',
      target_sec: 5,
      spec: { kind: 'title-card' },
    }];
    missingCompositionBinding.cost_estimate = { billable_generations: 0 };
    writePlan(missingCompositionBinding);
    await expect(approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' }))
      .rejects.toThrow(/E_VIDEO_PRODUCTION_COMPOSITION_BINDING_REQUIRED/);
  });

  it('rejects provider-setting aliases and invalid operations at the native Gate B boundary', async () => {
    const aliasPlan = plan();
    const aliasSpec = (aliasPlan.segments as Array<Record<string, any>>)[0].spec as Record<string, unknown>;
    delete aliasSpec.generate_audio;
    aliasSpec.duration_sec = 5;
    aliasSpec.audio = false;
    writePlan(aliasPlan);
    await expect(approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' }))
      .rejects.toThrow(/E_VIDEO_PRODUCTION_GENERATE_SETTINGS_ALIAS/);

    const invalidOperationPlan = plan();
    ((invalidOperationPlan.segments as Array<Record<string, any>>)[0].spec as Record<string, unknown>).operation = 'text_to_video';
    writePlan(invalidOperationPlan);
    await expect(approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' }))
      .rejects.toThrow(/E_VIDEO_PRODUCTION_GENERATE_SETTINGS_INVALID/);
  });
});
