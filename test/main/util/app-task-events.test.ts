import { expect, it } from 'vitest';
import { captureAppTaskEvent, appTaskInteractions, takeAppTaskInteraction, clearAppTaskEvents } from '../../../src/main/util/app-task-events';

it('keeps app approvals private, app/account scoped and consumes only the matching request', () => {
  const cid = `app_${'a'.repeat(64)}_once_${'b'.repeat(32)}`;
  expect(captureAppTaskEvent('u1', 'bash:permission', { cid, request_id: 'approval-1', command: 'reviewed command' })).toBe(true);
  expect(appTaskInteractions('u2', cid)).toEqual([]);
  expect(appTaskInteractions('u1', cid + 'x')).toEqual([]);
  expect(takeAppTaskInteraction('u2', cid, 'approval-1')).toBeNull();
  expect(appTaskInteractions('u1', cid)).toMatchObject([{ id: 'approval-1', kind: 'bash:permission', payload: { command: 'reviewed command' } }]);
  expect(appTaskInteractions('u1', cid)[0].payload).not.toHaveProperty('cid');
  expect(takeAppTaskInteraction('u1', cid, 'approval-1')?.kind).toBe('bash:permission');
  clearAppTaskEvents('u1', cid);
});

it('removes stale prompts on cancellation and leaves normal conversations to their current renderer', () => {
  const cid = `app_${'a'.repeat(64)}_retain_${'c'.repeat(32)}`;
  expect(captureAppTaskEvent('u1', 'bash:permission', { cid: 'ordinary', request_id: 'normal' })).toBe(false);
  captureAppTaskEvent('u1', 'local-agent:permission', { cid, request_id: 'cli-1' });
  expect(captureAppTaskEvent('u1', 'local-agent:permission_cancelled', { request_ids: ['cli-1'] })).toBe(true);
  expect(appTaskInteractions('u1', cid)).toEqual([]);
  expect(takeAppTaskInteraction('u1', cid, 'cli-1')).toBeNull();
  clearAppTaskEvents('u1', cid);
});

it('does not swallow another conversation cancellation when a batch also contains an app prompt', () => {
  const cid = `app_${'a'.repeat(64)}_once_${'d'.repeat(32)}`;
  captureAppTaskEvent('u1', 'bash:permission', { cid, request_id: 'app-cancel' });
  const batch = { request_ids: ['app-cancel', 'normal-cancel'] };
  expect(captureAppTaskEvent('u1', 'bash:permission_cancelled', batch)).toBe(false);
  expect(batch.request_ids).toEqual(['normal-cancel']);
  expect(appTaskInteractions('u1', cid)).toEqual([]);
});

it('keeps overflow approvals private without displacing existing pending prompts', () => {
  const cid = `app_${'a'.repeat(64)}_once_${'e'.repeat(32)}`;
  try {
    for (let i = 0; i < 16; i++) captureAppTaskEvent('overflow-user', 'bash:permission', { cid, request_id: `approval-${i}` });
    expect(captureAppTaskEvent('overflow-user', 'bash:permission', { cid, request_id: 'overflow' })).toBe(true);
    expect(appTaskInteractions('overflow-user', cid)).toHaveLength(16);
    expect(appTaskInteractions('overflow-user', cid)[0].id).toBe('approval-0');
  } finally { clearAppTaskEvents('overflow-user', cid); }
});
