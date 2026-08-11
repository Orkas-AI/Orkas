import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  beginImageStudioGeneration,
  finishImageStudioGeneration,
  readImageGenerationControlState,
  summarizeImageGenerationBudget,
} from '../../../src/main/features/image_production_control';

let root = '';
let statePath = '';

function writeManifest(route: 'compose' | 'hybrid' | 'generate', maxCalls: number): void {
  fs.writeFileSync(path.join(root, 'image-manifest.json'), JSON.stringify({
    schema_version: 1,
    route,
    canvas: { width: 1024, height: 1024 },
    brief: { purpose: 'Campaign image', audience: 'Customers', required_copy: [], must_include: [], must_avoid: [] },
    art_direction: {
      subject_world: 'A physical product studio',
      one_job: 'Show the hero product',
      visual_tradition: 'Editorial still life',
      composition: 'Centered object with asymmetric negative space',
      signature_device: 'A single cut-paper halo',
      typography: 'No raster typography',
      color_light_material: 'Soft daylight, warm paper, cobalt accent',
    },
    generation_budget: { max_calls: maxCalls },
  }, null, 2));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-image-generation-control-'));
  statePath = path.join(root, '.host', 'generation.json');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('ImageStudio generation control', () => {
  it('hard-blocks image generation on COMPOSE', async () => {
    writeManifest('compose', 0);
    await expect(beginImageStudioGeneration({
      stateAbsPath: statePath,
      projectDirAbs: root,
      requestId: 'hero-1',
      outputAbsPath: path.join(root, 'hero.png'),
      turnId: 'turn-1',
    })).rejects.toThrow('E_IMAGE_GENERATION_BUDGET_EXHAUSTED');
  });

  it('persists HYBRID one-call budget and reuses a completed request id within one turn', async () => {
    writeManifest('hybrid', 1);
    const begun = await beginImageStudioGeneration({
      stateAbsPath: statePath,
      projectDirAbs: root,
      requestId: 'hero-1',
      outputAbsPath: path.join(root, 'hero.png'),
      turnId: 'turn-1',
    });
    expect(begun.status).toBe('started');
    fs.writeFileSync(path.join(root, 'hero.png'), 'generated image placeholder');
    await finishImageStudioGeneration({
      stateAbsPath: statePath,
      transactionId: begun.transaction.transaction_id,
      ok: true,
      outputPath: path.join(root, 'hero.png'),
    });

    const reused = await beginImageStudioGeneration({
      stateAbsPath: statePath,
      projectDirAbs: root,
      requestId: 'hero-1',
      outputAbsPath: path.join(root, 'hero.png'),
      turnId: 'turn-1',
    });
    expect(reused.status).toBe('reused');

    await expect(beginImageStudioGeneration({
      stateAbsPath: statePath,
      projectDirAbs: root,
      requestId: 'hero-2',
      outputAbsPath: path.join(root, 'hero-2.png'),
      turnId: 'turn-1',
    })).rejects.toThrow('E_IMAGE_GENERATION_BUDGET_EXHAUSTED');

    await expect(beginImageStudioGeneration({
      stateAbsPath: statePath,
      projectDirAbs: root,
      requestId: 'hero-1',
      outputAbsPath: path.join(root, 'hero-next-turn.png'),
      turnId: 'turn-2',
    })).resolves.toMatchObject({
      status: 'started',
      callCount: 1,
      transaction: { request_id: 'hero-1', turn_id: 'turn-2' },
    });
  });

  it('serializes parallel admission so a one-call budget cannot be raced', async () => {
    writeManifest('hybrid', 1);
    const outcomes = await Promise.allSettled([
      beginImageStudioGeneration({
        stateAbsPath: statePath,
        projectDirAbs: root,
        requestId: 'parallel-a',
        outputAbsPath: path.join(root, 'parallel-a.png'),
        turnId: 'turn-1',
      }),
      beginImageStudioGeneration({
        stateAbsPath: statePath,
        projectDirAbs: root,
        requestId: 'parallel-b',
        outputAbsPath: path.join(root, 'parallel-b.png'),
        turnId: 'turn-1',
      }),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(String(rejected?.reason)).toContain('E_IMAGE_GENERATION_BUDGET_EXHAUSTED');
  });

  it('records a definite pre-dispatch failure without consuming the generation budget', async () => {
    writeManifest('hybrid', 1);
    const first = await beginImageStudioGeneration({
      stateAbsPath: statePath,
      projectDirAbs: root,
      requestId: 'invalid-workflow',
      outputAbsPath: path.join(root, 'invalid.png'),
      turnId: 'turn-1',
    });
    await finishImageStudioGeneration({
      stateAbsPath: statePath,
      transactionId: first.transaction.transaction_id,
      ok: false,
      errorCode: 'E_IMAGE_WORKFLOW_INPUT',
      countsTowardBudget: false,
    });

    const state = await readImageGenerationControlState(statePath);
    expect(summarizeImageGenerationBudget(state, 1, 'turn-1')).toMatchObject({
      attempts_recorded: 1,
      calls_started: 0,
      calls_remaining: 1,
      pre_dispatch_failures: 1,
    });
    await expect(beginImageStudioGeneration({
      stateAbsPath: statePath,
      projectDirAbs: root,
      requestId: 'repaired-workflow',
      outputAbsPath: path.join(root, 'repaired.png'),
      turnId: 'turn-1',
    })).resolves.toMatchObject({ status: 'started', callCount: 1, maxCalls: 1 });
    await expect(beginImageStudioGeneration({
      stateAbsPath: statePath,
      projectDirAbs: root,
      requestId: 'invalid-workflow',
      outputAbsPath: path.join(root, 'invalid-retry.png'),
      turnId: 'turn-1',
    })).rejects.toThrow('E_IMAGE_GENERATION_REQUEST_ALREADY_USED');
  });

  it('does not charge legacy unscoped attempts to a later named user turn', async () => {
    writeManifest('hybrid', 1);
    const legacy = await beginImageStudioGeneration({
      stateAbsPath: statePath,
      projectDirAbs: root,
      requestId: 'legacy-failed',
      outputAbsPath: path.join(root, 'legacy.png'),
    });
    await finishImageStudioGeneration({
      stateAbsPath: statePath,
      transactionId: legacy.transaction.transaction_id,
      ok: false,
      errorCode: 'PROVIDER_API_ERROR',
    });

    const stateBefore = await readImageGenerationControlState(statePath);
    expect(summarizeImageGenerationBudget(stateBefore, 1)).toMatchObject({
      attempts_recorded: 1,
      calls_started: 1,
      calls_remaining: 0,
    });
    expect(summarizeImageGenerationBudget(stateBefore, 1, 'new-turn')).toMatchObject({
      attempts_recorded: 0,
      calls_started: 0,
      calls_remaining: 1,
    });

    await expect(beginImageStudioGeneration({
      stateAbsPath: statePath,
      projectDirAbs: root,
      requestId: 'legacy-failed',
      outputAbsPath: path.join(root, 'new-turn.png'),
      turnId: 'new-turn',
    })).resolves.toMatchObject({
      status: 'started',
      transaction: { request_id: 'legacy-failed', turn_id: 'new-turn' },
      callCount: 1,
    });
  });
});
