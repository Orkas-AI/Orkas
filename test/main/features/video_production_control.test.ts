import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  approveVideoProductionGeneration,
  approveVideoProductionPlan,
  recordVideoProductionNarrationLine,
  recordVideoProductionPreviewGoAhead,
  videoProductionNarrationLineIdentity,
  videoProductionControlSummary,
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

  it('keeps approval across catalog refreshes but invalidates stable voice intent changes', async () => {
    const approvedPlan = plan();
    approvedPlan.schema_version = 1;
    approvedPlan.tracks = {
      narration: {
        synthesis: {
          route_ref: 'managed:orkas-voice',
          voice_ref: 'managed:orkas-voice:voice:vivi',
          display_name: 'Vivi',
          provider_model: 'catalog-v1',
          language: 'zh-CN',
          speed: 0.95,
        },
        segments: [{ text: '一句旁白', start_sec: 0, target_sec: 5 }],
      },
    };
    writePlan(approvedPlan);
    const approved = await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' });

    const refreshed = structuredClone(approvedPlan);
    refreshed.schema_version = 2;
    const synthesis = ((refreshed.tracks as any).narration.synthesis) as Record<string, unknown>;
    synthesis.display_name = 'vivi 2.0';
    synthesis.provider_model = 'catalog-v2';
    synthesis._catalog = { revision: 12 };
    (refreshed.segments as Array<Record<string, unknown>>)[0]._runtime = {
      worker: 'worker-2',
      attempt_count: 2,
    };
    writePlan(refreshed);
    expect((await validateVideoProductionPlanApproval({ statePath, planPath })).identity.signature)
      .toBe(approved.identity.signature);

    synthesis.voice_ref = 'managed:orkas-voice:voice:other';
    writePlan(refreshed);
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

  it('retains provider task evidence when generation completed but delivery failed', async () => {
    await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' });
    await approveVideoProductionGeneration({ statePath, planPath, turnId: 'turn-c' });
    const begun = await beginVideoProductionGeneration({
      statePath,
      planPath,
      segmentId: 'shot-1',
      kind: 'video',
      outputPath: path.join(root, 'shot-1.mp4'),
      request: request(),
    });
    if (begun.status !== 'started') throw new Error('expected started transaction');

    const failed = await finishVideoProductionGeneration({
      statePath,
      planPath,
      transactionId: begun.transaction.transaction_id,
      segmentId: 'shot-1',
      kind: 'video',
      ok: false,
      errorCode: 'DELIVERY_ERROR',
      providerTaskId: 'provider-task-delivered',
    });

    expect(failed).toMatchObject({
      status: 'failed',
      error_code: 'DELIVERY_ERROR',
      provider_task_id: 'provider-task-delivered',
    });
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

  it('keeps the signed identity stable across delivery runtime records', async () => {
    // The assembler records what it produced back into the plan — per-segment
    // produced_path and the delivered final under the reserved `_runtime`
    // envelope. Those are execution facts, not creative decisions: if either
    // write re-opened Gate B, recording a delivery would invalidate the very
    // approval it delivered under (the 2026-08-06 run hit exactly that stale
    // loop and stopped writing records at all, leaving the review surface
    // claiming a delivered video was never started).
    const before = (await readVideoProductionPlanIdentity(planPath)).signature;
    const delivered = plan();
    (delivered.segments as Array<Record<string, unknown>>)[0].produced_path = 'project/assets/shot-1.mp4';
    (delivered.segments as Array<Record<string, unknown>>)[0].status = 'done';
    delivered._runtime = { render: { final_path: 'project/render/video.mp4' } };
    writePlan(delivered);
    expect((await readVideoProductionPlanIdentity(planPath)).signature).toBe(before);

    // Negative control: a creative field still re-signs.
    const creative = plan();
    ((creative.segments as Array<Record<string, unknown>>)[0].spec as Record<string, unknown>).prompt = 'A blue product rotates';
    writePlan(creative);
    expect((await readVideoProductionPlanIdentity(planPath)).signature).not.toBe(before);
  });

  it('keeps the production preview go-ahead for narration-only amendments', async () => {
    // The production preview is a silent visual artifact. Re-signing only its
    // narration used to delete the production-level go-ahead, so the first
    // child draft stopped and asked the user to review unchanged frames again.
    const narrated = plan();
    narrated.tracks = {
      narration: {
        synthesis: {
          route_ref: 'managed:orkas-voice',
          voice_ref: 'managed:orkas-voice:voice:vivi',
          language: 'zh-CN',
          speed: 1,
        },
        segments: [{ text: '第一版旁白', start_sec: 0, target_sec: 5 }],
      },
    };
    writePlan(narrated);
    const approved = await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' });
    await recordVideoProductionPreviewGoAhead({
      statePath,
      planPath,
      planSignature: approved.identity.signature,
      visualSignature: 'a'.repeat(64),
      turnId: 'turn-preview-reply',
    });

    const narrationAmendment = JSON.parse(JSON.stringify(narrated)) as Record<string, any>;
    narrationAmendment.tracks.narration.synthesis.voice_ref = 'managed:orkas-voice:voice:nova';
    narrationAmendment.tracks.narration.synthesis.speed = 1.1;
    narrationAmendment.tracks.narration.segments[0].text = '修改后的旁白';
    writePlan(narrationAmendment);
    const reapproved = await approveVideoProductionPlan({
      statePath,
      planPath,
      turnId: 'turn-narration-amendment',
    });
    expect(reapproved.identity.signature).not.toBe(approved.identity.signature);
    expect(reapproved.identity.visual_signature).toBe(approved.identity.visual_signature);
    expect(reapproved.state.preview_go_ahead).toMatchObject({
      plan_signature: reapproved.identity.signature,
      visual_signature: 'a'.repeat(64),
      turn_id: 'turn-preview-reply',
    });

    // Negative control: a true visual intent change gets a new visual
    // signature and clears the old go-ahead.
    const visualAmendment = JSON.parse(JSON.stringify(narrationAmendment)) as Record<string, any>;
    visualAmendment.segments[0].spec.prompt = 'A blue product rotates on a clean studio table';
    writePlan(visualAmendment);
    const visuallyReapproved = await approveVideoProductionPlan({
      statePath,
      planPath,
      turnId: 'turn-visual-amendment',
    });
    expect(visuallyReapproved.identity.visual_signature).not.toBe(reapproved.identity.visual_signature);
    expect(visuallyReapproved.state.preview_go_ahead).toBeUndefined();
  });

  it('inherits Gate B across the narration shortening it demands, and only that', async () => {
    // A line measured 10.8s against a 5s window, beyond the new 0-10s band. stage-assemble
    // instructs exactly one repair — shorten the line in project/plan.json —
    // and narration text is signed intent, so the edit re-signed the plan and
    // validateVideoProductionPlanApproval deleted the user's approval: the run
    // stopped to ask "confirm the production plan" for a change the host
    // itself required. The single-composition route already inherits across
    // this repair; the EDL route now recognizes the same one.
    const narrated = (texts: string[]) => {
      const value = plan();
      value.tracks = {
        narration: {
          synthesis: {
            route_ref: 'managed:orkas-voice',
            voice_ref: 'managed:orkas-voice:voice:vivi',
            display_name: 'vivi 2.0',
            language: 'zh-CN',
            speed: 1,
          },
          segments: texts.map((text, index) => ({ text, start_sec: index * 5, target_sec: 5 })),
        },
      };
      return value;
    };
    writePlan(narrated(['接下来我们现在就来非常详细地介绍这款产品最值得关注的三个核心优势以及它们带来的实际价值', '第二句旁白']));
    const approved = await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' });
    expect(approved.state.plan_approval?.narration_fit_basis?.line_texts)
      .toEqual(['接下来我们现在就来非常详细地介绍这款产品最值得关注的三个核心优势以及它们带来的实际价值', '第二句旁白']);
    await recordVideoProductionNarrationLine({
      statePath,
      planPath,
      planSignature: approved.identity.signature,
      line: {
        segment_index: 0,
        path: path.join(root, 'measured-overrun.mp3'),
        measured_duration_sec: 10.8,
        backend: 'mock-tts',
        language: 'zh-CN',
        speed: 1,
      },
      identity: {
        text: '接下来我们现在就来非常详细地介绍这款产品最值得关注的三个核心优势以及它们带来的实际价值',
        routeRef: 'managed:orkas-voice',
        voiceRef: 'managed:orkas-voice:voice:vivi',
        language: 'zh-CN',
        speed: 1,
      },
    });
    // The user's go-ahead and generation approval exist before the repair.
    await approveVideoProductionGeneration({ statePath, planPath, turnId: 'turn-c' });
    const goAheadSeed = await readVideoProductionControlState(statePath, planPath);
    expect(goAheadSeed.generation_approval).toBeTruthy();

    // The approved first line measured beyond its five-second window. A first
    // bounded deletion is still estimated over budget, but it remains the same
    // repair episode and must not create another user confirmation.
    writePlan(narrated(['接下来我们现在来非常详细地介绍这款产品最值得关注的三个核心优势以及它们带来的实际价值', '第二句旁白']));
    const pendingRepair = await validateVideoProductionPlanApproval({ statePath, planPath });
    expect(pendingRepair.state.plan_approval).toMatchObject({
      signature: pendingRepair.identity.signature,
      turn_id: 'turn-b',
      inheritance_reason: 'measured_narration_fit_repair',
    });
    expect(pendingRepair.state.generation_approval?.plan_signature).toBe(pendingRepair.identity.signature);

    // Removing the rest of the bounded filler makes the line fit. It still
    // continues under the original approval rather than asking again.
    writePlan(narrated(['接下来我们来详细地介绍这款产品最值得关注的三个核心优势以及它们带来的实际价值', '第二句旁白']));
    const inherited = await validateVideoProductionPlanApproval({ statePath, planPath });
    expect(inherited.state.plan_approval).toMatchObject({
      signature: inherited.identity.signature,
      turn_id: 'turn-b',
      inheritance_reason: 'measured_narration_fit_repair',
    });
    expect(inherited.state.generation_approval?.plan_signature).toBe(inherited.identity.signature);
    expect(inherited.state.plan_approval?.narration_fit_basis?.line_texts)
      .toEqual(['接下来我们来详细地介绍这款产品最值得关注的三个核心优势以及它们带来的实际价值', '第二句旁白']);

    // Negative controls: anything beyond a shorten is a content change the
    // user must see, and it keeps the stale path.
    const stale = async () => {
      await expect(validateVideoProductionPlanApproval({ statePath, planPath }))
        .rejects.toThrow('E_VIDEO_PRODUCTION_GATE_B_STALE');
      expect((await readVideoProductionControlState(statePath, planPath)).plan_approval)
        .toBeUndefined();
      // Re-approve so the next control starts from a signed plan.
      await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b2' });
    };
    // Longer line.
    writePlan(narrated(['接下来我们现在反而写得更加详细而且明显更长了一些', '第二句旁白']));
    await stale();
    // Emptied line.
    writePlan(narrated(['', '第二句旁白']));
    await stale();
    // Shorter line AND a non-narration change.
    const mixed = narrated(['接下来介绍三个核心优势', '第二句旁白']);
    ((mixed.segments as Array<Record<string, unknown>>)[0].spec as Record<string, unknown>).prompt = 'A blue product rotates';
    writePlan(mixed);
    await stale();
    // Line count change.
    writePlan(narrated(['一句']));
    await stale();
    // An approval recorded before the basis existed cannot prove the repair.
    writePlan(narrated(['一句', '二句']));
    await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b3' });
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    delete raw.plan_approval.narration_fit_basis;
    fs.writeFileSync(statePath, JSON.stringify(raw), 'utf8');
    writePlan(narrated(['短', '二句']));
    await expect(validateVideoProductionPlanApproval({ statePath, planPath }))
      .rejects.toThrow('E_VIDEO_PRODUCTION_GATE_B_STALE');
  });

  it('does not inherit Gate B across a shorter semantic rewrite without a measured fit failure', async () => {
    // A fit repair is authorization to solve a measured timing problem, not a
    // general license to replace approved narration with any shorter string.
    // Keep every non-narration field and timing window identical so the only
    // changed variable is the meaning of the approved line.
    const narrated = (text: string) => {
      const value = plan();
      value.language = 'en';
      value.tracks = {
        narration: {
          synthesis: {
            route_ref: 'managed:orkas-voice',
            voice_ref: 'managed:orkas-voice:voice:vivi',
            language: 'en',
            speed: 1,
          },
          segments: [{ text, start_sec: 0, target_sec: 5 }],
        },
      };
      return value;
    };

    writePlan(narrated('The medicine is safe for children'));
    const semanticApproved = await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-plan-approved' });
    await recordVideoProductionNarrationLine({
      statePath,
      planPath,
      planSignature: semanticApproved.identity.signature,
      line: {
        segment_index: 0,
        path: path.join(root, 'stale-other-line.mp3'),
        measured_duration_sec: 9,
        backend: 'mock-tts',
        language: 'en',
        speed: 1,
      },
      identity: {
        text: 'A different historical narration line',
        routeRef: 'managed:orkas-voice',
        voiceRef: 'managed:orkas-voice:voice:vivi',
        language: 'en',
        speed: 1,
      },
    });
    await approveVideoProductionGeneration({ statePath, planPath, turnId: 'turn-generation-approved' });

    // Shorter in characters, but semantically opposite. A stale measurement
    // exists at this index, but its line identity does not match the approved
    // text and therefore cannot authorize this rewrite.
    writePlan(narrated('The medicine kills children'));
    await validateVideoProductionPlanApproval({ statePath, planPath }).catch(() => undefined);

    // Do not prescribe how the host recovers: it may retain the old approval,
    // expose a bounded repair state, or invalidate it. The user-level invariant
    // is only that this unrelated rewrite never becomes the current authorized
    // plan and never inherits the current billable-generation authorization.
    const identity = await readVideoProductionPlanIdentity(planPath);
    const state = await readVideoProductionControlState(statePath, planPath);
    expect(state.plan_approval?.signature).not.toBe(identity.signature);
    expect(state.generation_approval?.plan_signature).not.toBe(identity.signature);

    // A valid repair closes the timing problem; it is not an open-ended
    // authorization for more shortening. This approved line has a matching
    // measured overrun, and the first bounded deletion brings it inside.
    writePlan(narrated('Today we carefully introduce three core benefits of this product with clear practical examples'));
    const overrunApproved = await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-overrun-approved' });
    await recordVideoProductionNarrationLine({
      statePath,
      planPath,
      planSignature: overrunApproved.identity.signature,
      line: {
        segment_index: 0,
        path: path.join(root, 'english-overrun.mp3'),
        measured_duration_sec: 10.8,
        backend: 'mock-tts',
        language: 'en',
        speed: 1,
      },
      identity: {
        text: 'Today we carefully introduce three core benefits of this product with clear practical examples',
        routeRef: 'managed:orkas-voice',
        voiceRef: 'managed:orkas-voice:voice:vivi',
        language: 'en',
        speed: 1,
      },
    });
    await approveVideoProductionGeneration({ statePath, planPath, turnId: 'turn-overrun-generation' });
    writePlan(narrated('Today we introduce three core benefits of this product with practical examples'));
    const repaired = await validateVideoProductionPlanApproval({ statePath, planPath });
    expect(repaired.state.plan_approval).toMatchObject({
      turn_id: 'turn-overrun-approved',
      inheritance_reason: 'measured_narration_fit_repair',
    });
    expect(repaired.state.generation_approval?.plan_signature).toBe(repaired.identity.signature);

    // The repaired line now fits. A further deletion has no current overrun
    // to solve, so it cannot continue riding the original authorization.
    writePlan(narrated('Today we introduce three core benefits of this product with examples'));
    await validateVideoProductionPlanApproval({ statePath, planPath }).catch(() => undefined);
    const afterSecondRewriteIdentity = await readVideoProductionPlanIdentity(planPath);
    const afterSecondRewrite = await readVideoProductionControlState(statePath, planPath);
    expect(afterSecondRewrite.plan_approval?.signature).not.toBe(afterSecondRewriteIdentity.signature);
    expect(afterSecondRewrite.generation_approval?.plan_signature).not.toBe(afterSecondRewriteIdentity.signature);
  });

  it('does not let one measured repair carry an untouched line retime', async () => {
    const narrated = (lines: Array<{ text: string; start: number; target: number }>) => {
      const value = plan();
      value.tracks = {
        narration: {
          synthesis: {
            route_ref: 'managed:orkas-voice',
            voice_ref: 'managed:orkas-voice:voice:vivi',
            language: 'zh-CN',
            speed: 1,
          },
          segments: lines.map((line) => ({
            text: line.text,
            start_sec: line.start,
            target_sec: line.target,
          })),
        },
      };
      return value;
    };
    const approvedLines = [
      { text: '接下来我们现在就来详细介绍这款产品的三个核心优势', start: 0, target: 5 },
      { text: '第二句保持原样', start: 5, target: 5 },
    ];
    writePlan(narrated(approvedLines));
    const approved = await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' });
    await recordVideoProductionNarrationLine({
      statePath,
      planPath,
      planSignature: approved.identity.signature,
      line: {
        segment_index: 0,
        path: path.join(root, 'line-0-overrun.mp3'),
        measured_duration_sec: 10.8,
        backend: 'mock-tts',
        language: 'zh-CN',
        speed: 1,
      },
      identity: {
        text: approvedLines[0].text,
        routeRef: 'managed:orkas-voice',
        voiceRef: 'managed:orkas-voice:voice:vivi',
        language: 'zh-CN',
        speed: 1,
      },
    });

    // Line 0 has a valid bounded repair. Line 1 has no text repair at all, so
    // moving its window is an independent plan change and cannot piggyback on
    // line 0's measured timing evidence.
    writePlan(narrated([
      { text: '接下来我们来详细介绍这款产品的三个核心优势', start: 0, target: 4.8 },
      { text: '第二句保持原样', start: 4.8, target: 5.2 },
    ]));
    await expect(validateVideoProductionPlanApproval({ statePath, planPath }))
      .rejects.toThrow(/line 1 changed its window without shortening that line/);
    const identity = await readVideoProductionPlanIdentity(planPath);
    const state = await readVideoProductionControlState(statePath, planPath);
    expect(state.plan_approval?.signature).not.toBe(identity.signature);
  });

  it('does not treat a broadly rewritten shorter line as a fit repair', async () => {
    const narrated = (text: string) => {
      const value = plan();
      value.language = 'en';
      value.tracks = {
        narration: {
          synthesis: {
            route_ref: 'managed:orkas-voice',
            voice_ref: 'managed:orkas-voice:voice:vivi',
            language: 'en',
            speed: 1,
          },
          segments: [{ text, start_sec: 0, target_sec: 5 }],
        },
      };
      return value;
    };
    const approvedText = 'Today we carefully introduce three core benefits of this product with clear practical examples';
    writePlan(narrated(approvedText));
    const approved = await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' });
    await recordVideoProductionNarrationLine({
      statePath,
      planPath,
      planSignature: approved.identity.signature,
      line: {
        segment_index: 0,
        path: path.join(root, 'matching-overrun.mp3'),
        measured_duration_sec: 10.8,
        backend: 'mock-tts',
        language: 'en',
        speed: 1,
      },
      identity: {
        text: approvedText,
        routeRef: 'managed:orkas-voice',
        voiceRef: 'managed:orkas-voice:voice:vivi',
        language: 'en',
        speed: 1,
      },
    });
    await approveVideoProductionGeneration({ statePath, planPath, turnId: 'turn-c' });

    // The timing fact is genuine and matches this exact approved line, but a
    // replacement sentence is not the bounded filler deletion the host asked
    // for. The observable contract is authorization, not the edit-distance
    // helper: neither Gate B nor the billable Gate C may move to this plan.
    writePlan(narrated('Buy it now for instant results'));
    await expect(validateVideoProductionPlanApproval({ statePath, planPath }))
      .rejects.toThrow(/rewrote 100% of its words, past the 15% a timing repair may change/);
    const identity = await readVideoProductionPlanIdentity(planPath);
    const state = await readVideoProductionControlState(statePath, planPath);
    expect(state.plan_approval?.signature).not.toBe(identity.signature);
    expect(state.generation_approval?.plan_signature).not.toBe(identity.signature);
  });

  it('covers the real fit repair — shortened lines pull their windows with them', async () => {
    // 2026-08-08 evening run: four over-budget lines, the model shortened
    // them AND retimed start_sec/target_sec (a shorten that leaves the old
    // windows is not a repair — the mix would hold dead air where the words
    // used to be). The first coverage rule demanded byte-identical windows,
    // so the honest repair was refused mid-synthesis, the approval destroyed,
    // eight of nine generate_speech calls failed on GATE_B_REQUIRED, and the
    // user was re-asked to confirm — the exact harm the rule exists to stop.
    const narrated = (lines: Array<{ text: string; start: number; target: number }>) => {
      const value = plan();
      value.tracks = {
        narration: {
          synthesis: {
            route_ref: 'managed:orkas-voice',
            voice_ref: 'managed:orkas-voice:voice:vivi',
            display_name: 'vivi 2.0',
            language: 'zh-CN',
            speed: 1,
          },
          segments: lines.map((line) => ({ text: line.text, start_sec: line.start, target_sec: line.target })),
        },
      };
      return value;
    };
    writePlan(narrated([
      { text: '第一句旁白现在稍微有一点长需要压缩', start: 0, target: 5 },
      { text: '第二句旁白现在也稍微超了一些', start: 5, target: 5.8 },
    ]));
    const approved = await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' });
    const selection = {
      routeRef: 'managed:orkas-voice',
      voiceRef: 'managed:orkas-voice:voice:vivi',
      language: 'zh-CN',
      speed: 1,
    };
    await Promise.all([
      recordVideoProductionNarrationLine({
        statePath,
        planPath,
        planSignature: approved.identity.signature,
        line: {
          segment_index: 0,
          path: path.join(root, 'line-0.mp3'),
          measured_duration_sec: 10.8,
          backend: 'mock-tts',
          language: 'zh-CN',
          speed: 1,
        },
        identity: { text: '第一句旁白现在稍微有一点长需要压缩', ...selection },
      }),
      recordVideoProductionNarrationLine({
        statePath,
        planPath,
        planSignature: approved.identity.signature,
        line: {
          segment_index: 1,
          path: path.join(root, 'line-1.mp3'),
          measured_duration_sec: 11.2,
          backend: 'mock-tts',
          language: 'zh-CN',
          speed: 1,
        },
        identity: { text: '第二句旁白现在也稍微超了一些', ...selection },
      }),
    ]);

    // Both measured overruns receive bounded filler deletion, and their
    // windows move with them. This must continue under the original approval.
    writePlan(narrated([
      { text: '第一句旁白稍微有一点长需要压缩', start: 0, target: 4.8 },
      { text: '第二句旁白也稍微超了一些', start: 4.8, target: 5.5 },
    ]));
    const inherited = await validateVideoProductionPlanApproval({ statePath, planPath });
    expect(inherited.state.plan_approval).toMatchObject({
      turn_id: 'turn-b',
      inheritance_reason: 'measured_narration_fit_repair',
    });

    // A refusal now says WHICH criterion failed and keeps the evidence: the
    // first version threw a bare "stale" and deleted the basis in the same
    // motion, so the incident could not even be diagnosed afterwards.
    writePlan(narrated([
      { text: '第一句旁白现在反而变得更加详细而且明显更长了一点', start: 0, target: 4.8 },
      { text: '第二句旁白也稍微超了一些', start: 4.8, target: 5.5 },
    ]));
    await expect(validateVideoProductionPlanApproval({ statePath, planPath }))
      .rejects.toThrow(/E_VIDEO_PRODUCTION_GATE_B_STALE.*grew from/);
    const invalidated = await readVideoProductionControlState(statePath, planPath);
    expect(invalidated.plan_approval).toBeUndefined();
    expect(invalidated.gate_b_invalidation).toMatchObject({
      reason: 'line_lengthened',
      approved_turn_id: 'turn-b',
    });
    expect(invalidated.gate_b_invalidation?.narration_fit_basis?.line_texts)
      .toEqual(['第一句旁白稍微有一点长需要压缩', '第二句旁白也稍微超了一些']);
    // The stale error tells the model the record exists; production.status is
    // the model's only read surface, so the summary has to actually carry it
    // — recorded without a reader, the recovery path saw nothing (2026-08-09
    // review). Bounded: reason, detail, turn, and the line COUNT, never the
    // texts.
    const staleSummary = videoProductionControlSummary(
      await readVideoProductionPlanIdentity(planPath),
      invalidated,
    ) as { gate_b_invalidation?: Record<string, unknown> };
    expect(staleSummary.gate_b_invalidation).toMatchObject({
      reason: 'line_lengthened',
      approved_turn_id: 'turn-b',
      judged_narration_lines: 2,
    });
    expect(JSON.stringify(staleSummary)).not.toContain('第一句旁白稍微有一点长需要压缩');
    // The next real approval clears the diagnostic record.
    await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b2' });
    const reapprovedState = await readVideoProductionControlState(statePath, planPath);
    expect(reapprovedState.gate_b_invalidation).toBeUndefined();
    expect((videoProductionControlSummary(
      await readVideoProductionPlanIdentity(planPath),
      reapprovedState,
    ) as { gate_b_invalidation?: unknown }).gate_b_invalidation).toBeUndefined();

    // A basis recorded before window tracking keeps its exact old meaning:
    // an evidenced text-only fit repair inherits, a retimed window cannot be
    // proven against the missing approved windows and does not.
    writePlan(narrated([
      { text: '接下来我们现在就来详细介绍这款产品的三个核心优势', start: 0, target: 5 },
      { text: '第二句旁白', start: 5, target: 5.8 },
    ]));
    await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b3' });
    await recordVideoProductionNarrationLine({
      statePath,
      planPath,
      planSignature: (await readVideoProductionPlanIdentity(planPath)).signature,
      line: {
        segment_index: 0,
        path: path.join(root, 'legacy-overrun.mp3'),
        measured_duration_sec: 10.8,
        backend: 'mock-tts',
        language: 'zh-CN',
        speed: 1,
      },
      identity: {
        text: '接下来我们现在就来详细介绍这款产品的三个核心优势',
        ...selection,
      },
    });
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    delete raw.plan_approval.narration_fit_basis.line_windows;
    fs.writeFileSync(statePath, JSON.stringify(raw), 'utf8');
    writePlan(narrated([
      { text: '接下来我们来详细介绍这款产品的三个核心优势', start: 0, target: 5 },
      { text: '第二句旁白', start: 5, target: 5.8 },
    ]));
    expect((await validateVideoProductionPlanApproval({ statePath, planPath }))
      .state.plan_approval?.inheritance_reason).toBe('measured_narration_fit_repair');
    const raw2 = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    delete raw2.plan_approval.narration_fit_basis.line_windows;
    fs.writeFileSync(statePath, JSON.stringify(raw2), 'utf8');
    writePlan(narrated([
      { text: '接下来我们来详细介绍这款产品的三个核心优势', start: 0, target: 4.8 },
      { text: '第二句旁白', start: 4.8, target: 5.8 },
    ]));
    await expect(validateVideoProductionPlanApproval({ statePath, planPath }))
      .rejects.toThrow(/predates window tracking/);
  });

  it('authorizes the repair for a line the synthesis warning already called over', async () => {
    // 2026-08-10 AUTO run, closing line: a 6.125s window, 6.84s of audio.
    // generate_speech reported `over` (ratio 1.12), the model shortened the
    // line — the exact bounded repair this inheritance exists for — and the
    // authorization refused it for having "no matching measured overrun",
    // because it judged the SAME measurement against the estimate band, whose
    // five-second floor accepts 1.13s–11.13s for that window. The model
    // reverted its correct fix and `mix` truncated the closing words 0.72s
    // into the delivered video. The warning and the authorization now read one
    // measurement one way.
    const narrated = (lines: Array<{ text: string; start: number; target: number }>) => {
      const value = plan();
      value.tracks = {
        narration: {
          synthesis: {
            route_ref: 'managed:orkas-voice',
            voice_ref: 'managed:orkas-voice:voice:vivi',
            display_name: 'vivi 2.0',
            language: 'zh-CN',
            speed: 1,
          },
          segments: lines.map((line) => ({ text: line.text, start_sec: line.start, target_sec: line.target })),
        },
      };
      return value;
    };
    const approvedText = '如果你想把 AI 从聊天工具升级成协作团队，试试 Orkas。';
    writePlan(narrated([{ text: approvedText, start: 53.875, target: 6.125 }]));
    const approved = await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-cta' });
    await recordVideoProductionNarrationLine({
      statePath,
      planPath,
      planSignature: approved.identity.signature,
      line: {
        segment_index: 0,
        path: path.join(root, 'narration-07.mp3'),
        measured_duration_sec: 6.84,
        backend: 'mock-tts',
        language: 'zh-CN',
        speed: 1,
      },
      identity: {
        text: approvedText,
        routeRef: 'managed:orkas-voice',
        voiceRef: 'managed:orkas-voice:voice:vivi',
        language: 'zh-CN',
        speed: 1,
      },
    });

    // A trim proportional to the 12% overrun inherits the approval.
    writePlan(narrated([{ text: '想把 AI 从聊天工具升级成协作团队，试试 Orkas。', start: 53.875, target: 6.125 }]));
    const inherited = await validateVideoProductionPlanApproval({ statePath, planPath });
    expect(inherited.state.plan_approval).toMatchObject({
      turn_id: 'turn-cta',
      inheritance_reason: 'measured_narration_fit_repair',
    });

    // The run's actual edit cut 38% of the words. That is a rewrite and still
    // does not inherit — but the refusal now carries the budget it broke, so
    // the answer is a smaller trim rather than the audio trim that truncated
    // the delivered video.
    writePlan(narrated([{ text: approvedText, start: 53.875, target: 6.125 }]));
    await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-cta-wide' });
    await recordVideoProductionNarrationLine({
      statePath,
      planPath,
      planSignature: (await readVideoProductionPlanIdentity(planPath)).signature,
      line: {
        segment_index: 0,
        path: path.join(root, 'narration-07-wide.mp3'),
        measured_duration_sec: 6.84,
        backend: 'mock-tts',
        language: 'zh-CN',
        speed: 1,
      },
      identity: {
        text: approvedText,
        routeRef: 'managed:orkas-voice',
        voiceRef: 'managed:orkas-voice:voice:vivi',
        language: 'zh-CN',
        speed: 1,
      },
    });
    writePlan(narrated([{ text: '想把 AI 升级成协作团队，试试 Orkas。', start: 53.875, target: 6.125 }]));
    await expect(validateVideoProductionPlanApproval({ statePath, planPath }))
      .rejects.toThrow(/rewrote 31% of its words, past the 15% a timing repair may change/);

    // The band stays wide enough that ordinary editorial slack is not an
    // overrun: 6.3s in the same window is inside 1.05 and earns no repair.
    writePlan(narrated([{ text: approvedText, start: 53.875, target: 6.125 }]));
    await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-cta2' });
    await recordVideoProductionNarrationLine({
      statePath,
      planPath,
      planSignature: (await readVideoProductionPlanIdentity(planPath)).signature,
      line: {
        segment_index: 0,
        path: path.join(root, 'narration-07-b.mp3'),
        measured_duration_sec: 6.3,
        backend: 'mock-tts',
        language: 'zh-CN',
        speed: 1,
      },
      identity: {
        text: approvedText,
        routeRef: 'managed:orkas-voice',
        voiceRef: 'managed:orkas-voice:voice:vivi',
        language: 'zh-CN',
        speed: 1,
      },
    });
    writePlan(narrated([{ text: '想把 AI 升级成协作团队，试试 Orkas。', start: 53.875, target: 6.125 }]));
    await expect(validateVideoProductionPlanApproval({ statePath, planPath }))
      .rejects.toThrow(/E_VIDEO_PRODUCTION_GATE_B_STALE/);
  });

  it('keeps a produced narration line while its own identity survives the plan', async () => {
    // The assembled route's narration is paid, parent-owned, and per line.
    // Validity has to be per line too: the first version expired records on
    // the whole plan signature, and the very first amendment (2026-08-08, one
    // line shortened to fit its window) wiped the record of four untouched
    // lines whose paid audio shipped in the delivered video unchanged. A
    // record now carries its line's own identity; re-signing the plan leaves
    // records alone, and the reader counts a line only while the current plan
    // still holds that identity.
    await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' });
    const line = async (index: number, take = 1) => recordVideoProductionNarrationLine({
      statePath,
      planPath,
      planSignature: (await readVideoProductionPlanIdentity(planPath)).signature,
      line: {
        segment_index: index,
        path: `project/audio/narration-0${index}-take${take}.mp3`,
        measured_duration_sec: 3,
        backend: 'orkas-voice',
        language: 'zh',
        speed: 1,
      },
      identity: {
        text: `第 ${index} 句台词`,
        routeRef: 'managed:orkas-voice',
        voiceRef: 'managed:orkas-voice:voice:vivi',
        language: 'zh',
        speed: 1,
      },
    });
    await line(0);
    const twoLines = await line(1);
    expect(Object.keys(twoLines.narration_lines || {})).toEqual(['0', '1']);
    expect(twoLines.narration_lines?.['0'].line_identity)
      .toBe(videoProductionNarrationLineIdentity({
        text: '第 0 句台词',
        routeRef: 'managed:orkas-voice',
        voiceRef: 'managed:orkas-voice:voice:vivi',
        language: 'zh',
        speed: 1,
      }));

    // Re-voicing one line replaces it: the record names the file that will
    // actually be mixed, and a superseded take is not a second line.
    const revoiced = await line(1, 2);
    expect(Object.keys(revoiced.narration_lines || {})).toEqual(['0', '1']);
    expect(revoiced.narration_lines?.['1'].path).toBe('project/audio/narration-01-take2.mp3');

    // An amendment re-signs the plan. The records survive — invalidation is
    // the reader's per-line identity check, not a wipe at approval.
    const amended = plan();
    ((amended.segments as Array<Record<string, unknown>>)[0].spec as Record<string, unknown>).prompt = 'A blue product rotates';
    writePlan(amended);
    const reapproved = await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b2' });
    expect(Object.keys(reapproved.state.narration_lines || {})).toEqual(['0', '1']);

    // The identity is exactly the approved intent: text, voice selection,
    // language, speed. Whitespace trim is normalization, not a new line.
    const base = {
      text: 'x', routeRef: 'r', voiceRef: 'v', language: 'zh', speed: 1,
    };
    expect(videoProductionNarrationLineIdentity({ ...base, text: ' x ' }))
      .toBe(videoProductionNarrationLineIdentity(base));
    expect(videoProductionNarrationLineIdentity({ ...base }))
      .toBe(videoProductionNarrationLineIdentity({ ...base }));
    for (const change of [
      { text: 'y' }, { routeRef: 'r2' }, { voiceRef: 'v2' }, { language: 'en' }, { speed: 1.2 },
    ]) {
      expect(videoProductionNarrationLineIdentity({ ...base, ...change }))
        .not.toBe(videoProductionNarrationLineIdentity(base));
    }
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

  it('enforces the intelligent semantic-edit contract at the native Gate B boundary', async () => {
    const semanticEdit = plan();
    const segment = (semanticEdit.segments as Array<Record<string, any>>)[0];
    const spec = segment.spec as Record<string, unknown>;
    spec.operation = 'edit';
    spec.prompt = 'Remove the sign while preserving the subject, camera motion, timing, and original audio.';
    spec.reference_video_paths = ['references/source.mp4'];
    writePlan(semanticEdit);
    await expect(approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' }))
      .rejects.toThrow(/E_VIDEO_PRODUCTION_SEMANTIC_EDIT_STRATEGY_REQUIRED/);

    semanticEdit.edit_strategy = {
      mode: 'semantic',
      objectives: ['Remove the sign.'],
      decision_signals: ['vision', 'semantic_model'],
      preserve: ['subject', 'camera motion', 'timing', 'original audio'],
      may_change: ['sign'],
    };
    semanticEdit.references = [{
      id: 'source-video',
      media_type: 'video',
      source: 'references/source.mp4',
      intent: 'edit',
      roles: ['content', 'motion', 'timing', 'audio'],
      required: true,
      preserve: ['subject', 'camera motion', 'timing', 'original audio'],
      may_change: ['sign'],
      target_segment_ids: ['shot-1'],
      temporal_anchors: [{ source_start_sec: 0, source_end_sec: 5, target_segment_id: 'shot-1' }],
    }];
    writePlan(semanticEdit);
    const approved = await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' });
    expect(approved.identity.generation_intents[0]).toMatchObject({
      operation: 'edit',
      reference_video_paths: ['references/source.mp4'],
    });
  });

  it('drops legacy review fields on read and keeps the signed plan and paid work usable', async () => {
    // The per-segment approval ledger was removed. A state file written by an
    // older build still carries it, and the survival contract is exact: the
    // signed plan and completed paid transactions stay valid, the removed
    // fields disappear rather than round-tripping back to disk.
    await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b' });
    await approveVideoProductionGeneration({ statePath, planPath, turnId: 'turn-c' });
    const written = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    written.review_ledger = {
      schema_version: 1,
      entries: { 'shot-1': { plan_intent_signature: 'a'.repeat(64), preview_signature: 'b'.repeat(64), approved_at: 'then', approved_turn_id: 'turn-x', approval_scope: 'aggregate' } },
    };
    written.review_offer = {
      ledger_signature: 'c'.repeat(64),
      segments: [{ segment_id: 'shot-1', plan_intent_signature: 'a'.repeat(64), visual_signature: 'b'.repeat(64) }],
      offered_at: 'then',
      offered_turn_id: 'turn-x',
    };
    fs.writeFileSync(statePath, JSON.stringify(written), 'utf8');

    const state = await readVideoProductionControlState(statePath, planPath);
    expect((state as Record<string, unknown>).review_ledger).toBeUndefined();
    expect((state as Record<string, unknown>).review_offer).toBeUndefined();
    // The decisions that still exist survive the stripping.
    const current = await validateVideoProductionPlanApproval({ statePath, planPath });
    expect(current.state.plan_approval?.signature).toBe(current.identity.signature);
    expect(current.state.generation_approval?.plan_signature).toBe(current.identity.signature);
    // And a later write does not resurrect the removed fields.
    await approveVideoProductionPlan({ statePath, planPath, turnId: 'turn-b2' });
    const rewritten = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(rewritten.review_ledger).toBeUndefined();
    expect(rewritten.review_offer).toBeUndefined();
  });

  it('reports segment work state from facts alone: captured drives renderable', async () => {
    // The whole review status is now three facts per segment and one derived
    // bit. No state input: nothing the host stores may change whether a
    // production is assemblable — only what is on disk right now.
    const { videoProductionReviewStatus } = await import(
      '../../../src/main/features/video_production_control'
    );
    const identity = await readVideoProductionPlanIdentity(planPath);

    const missing = videoProductionReviewStatus({ identity, facts: [] });
    expect(missing.uncaptured_segment_ids).toEqual(['shot-1']);
    expect(missing.renderable).toBe(false);

    const captured = videoProductionReviewStatus({
      identity,
      facts: [{ segment_id: 'shot-1', visual_signature: 'd'.repeat(64), captured: true }],
    });
    expect(captured.uncaptured_segment_ids).toEqual([]);
    expect(captured.renderable).toBe(true);
    expect(captured.segments[0]).toMatchObject({
      segment_id: 'shot-1',
      visual_signature: 'd'.repeat(64),
      captured: true,
    });
    // A fact for a segment the plan does not name is ignored, and a fact
    // claiming captured with no signature still counts as captured=false at
    // the caller — the status layer itself only mirrors what it was handed.
    const foreign = videoProductionReviewStatus({
      identity,
      facts: [{ segment_id: 'ghost', visual_signature: 'e'.repeat(64), captured: true }],
    });
    expect(foreign.segments.map((segment) => segment.segment_id)).toEqual(['shot-1']);
    expect(foreign.renderable).toBe(false);
  });
});
