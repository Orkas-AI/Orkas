import { describe, expect, it } from 'vitest';

import { projectVideoApprovalIntent } from '../../../src/main/features/video_approval_identity';

describe('video approval intent projection', () => {
  it('separates execution and catalog metadata from stable production intent', () => {
    const approved = {
      schema_version: 1,
      title: 'Approved title',
      segments: [{
        id: 's1',
        prompt: 'Approved visual',
        status: 'pending',
        produced_path: '',
        _runtime: { worker: 'a', heartbeat: 1 },
      }],
      narration: {
        route_ref: 'managed:voice',
        voice_ref: 'managed:voice:vivi',
        display_name: 'Vivi',
        provider_model: 'provider-v1',
        language: 'zh-CN',
        speed: 0.95,
        _catalog: { revision: 1 },
      },
    };
    const refreshed = {
      ...approved,
      schema_version: 2,
      segments: [{
        ...(approved.segments[0]),
        status: 'completed',
        produced_path: '/relocated/output.mp4',
        provider_task_id: 'task-2',
        updated_at: '2026-07-28T20:00:00.000Z',
        _runtime: { worker: 'b', heartbeat: 99 },
      }],
      narration: {
        ...approved.narration,
        display_name: 'vivi 2.0',
        provider_model: 'provider-v2',
        _catalog: { revision: 42 },
      },
    };

    expect(projectVideoApprovalIntent(refreshed, {
      excludeRootKeys: ['schema_version'],
    })).toEqual(projectVideoApprovalIntent(approved, {
      excludeRootKeys: ['schema_version'],
    }));
  });

  it.each([
    ['voice reference', (value: any) => { value.narration.voice_ref = 'managed:voice:other'; }],
    ['narration language', (value: any) => { value.narration.language = 'ja-JP'; }],
    ['narration speed', (value: any) => { value.narration.speed = 1.1; }],
    ['creative content', (value: any) => { value.segments[0].prompt = 'Changed visual'; }],
    ['unknown unclassified field', (value: any) => { value.future_intent = 'must be reviewed'; }],
  ])('keeps %s fail-closed as approved intent', (_label, mutate) => {
    const approved = {
      segments: [{ id: 's1', prompt: 'Approved visual' }],
      narration: {
        route_ref: 'managed:voice',
        voice_ref: 'managed:voice:vivi',
        display_name: 'Vivi',
        language: 'zh-CN',
        speed: 0.95,
      },
    };
    const changed = structuredClone(approved) as Record<string, unknown>;
    mutate(changed);

    expect(projectVideoApprovalIntent(changed))
      .not.toEqual(projectVideoApprovalIntent(approved));
  });

  it('does not globally ignore display_name outside a stable catalog selection', () => {
    const approved = { character: { display_name: 'Alice', role: 'host' } };
    const changed = { character: { display_name: 'Bob', role: 'host' } };
    expect(projectVideoApprovalIntent(changed))
      .not.toEqual(projectVideoApprovalIntent(approved));
  });
});
