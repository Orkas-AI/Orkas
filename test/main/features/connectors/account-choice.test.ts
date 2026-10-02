import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const user = vi.hoisted(() => ({ id: 'account-choice-user' }));
vi.mock('../../../../src/main/features/users', () => ({ getActiveUserId: () => user.id }));
vi.mock('../../../../src/main/features/config', () => ({ getLanguageForUser: () => 'en' }));
import { _setBroadcastForTest, requestAccountChoice, respondAccountChoice } from '../../../../src/main/features/connectors/account-choice';
import { notifyUserSwitch } from '../../../../src/main/features/user-switch-hooks';

let events: Array<{ channel: string; payload: any }>;
let controller: AbortController;
const uid = 'account-choice-user';
const choices = [{ id: '123', label: 'Shop A' }, { id: '456', label: 'Shop B' }];
beforeEach(() => {
  user.id = uid;
  events = [];
  controller = new AbortController();
  _setBroadcastForTest((channel, payload) => { events.push({ channel, payload }); return true; });
});
afterEach(() => { controller.abort(); _setBroadcastForTest(); vi.useRealTimers(); });

describe('authorization account choice', () => {
  it('accepts one offered account from its owner and rejects forged, foreign or replayed answers', async () => {
    const flow = requestAccountChoice(uid, 'tiktok-shop', choices, controller.signal);
    const info = events[0].payload;
    expect(info).toMatchObject({ choices, title: 'Choose the account to connect' });
    expect(respondAccountChoice('other-user', info.request_id, '123')).toBe(false);
    expect(respondAccountChoice(uid, info.request_id, '789')).toBe(false);
    expect(respondAccountChoice(uid, info.request_id, '456')).toBe(true);
    await expect(flow).resolves.toBe('456');
    expect(respondAccountChoice(uid, info.request_id, '123')).toBe(false);
    expect(events.at(-1)?.channel).toBe('connectors:account-choice-cancelled');
  });

  it.each(['decline', 'abort', 'timeout', 'switch'] as const)('dismisses %s and makes any later answer ineffective', async mode => {
    vi.useFakeTimers();
    const flow = requestAccountChoice(uid, 'tiktok-shop', choices, controller.signal);
    const rejected = expect(flow).rejects.toMatchObject({ code: 'user_cancelled' });
    const id = events[0].payload.request_id;
    if (mode === 'decline') respondAccountChoice(uid, id, null);
    if (mode === 'abort') controller.abort();
    if (mode === 'timeout') await vi.advanceTimersByTimeAsync(600_000);
    if (mode === 'switch') { notifyUserSwitch(uid, 'other-user'); user.id = 'other-user'; }
    await rejected;
    expect(events.at(-1)).toEqual({ channel: 'connectors:account-choice-cancelled', payload: { request_id: id } });
    expect(respondAccountChoice(uid, id, '123')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails closed without a renderer or active owner and never forwards extra provider properties', async () => {
    _setBroadcastForTest(() => false);
    await expect(requestAccountChoice(uid, 'tiktok-shop', choices, controller.signal)).rejects.toMatchObject({ code: 'user_cancelled' });
    await expect(requestAccountChoice('other-user', 'tiktok-shop', choices, controller.signal)).rejects.toMatchObject({ code: 'user_cancelled' });
    _setBroadcastForTest((channel, payload) => { events.push({ channel, payload }); return true; });
    const flow = requestAccountChoice(uid, 'tiktok-shop', [{ ...choices[0], access_token: 'private' } as any], controller.signal);
    expect(JSON.stringify(events)).not.toContain('private');
    respondAccountChoice(uid, events[0].payload.request_id, '123');
    await expect(flow).resolves.toBe('123');
  });

  it('rejects missing, ambiguous, unbounded or malformed account choices before presenting a dialog', async () => {
    for (const invalid of [[], [choices[0], choices[0]], [{ id: '../123', label: 'Shop' }],
      [{ id: '123', label: 'x'.repeat(201) }], Array.from({ length: 101 }, (_, i) => ({ id: String(i + 1), label: 'Shop' }))]) {
      await expect(requestAccountChoice(uid, 'tiktok-shop', invalid, controller.signal)).rejects.toThrow('Invalid authorized');
    }
    expect(events).toEqual([]);
  });
});
