import { afterEach, describe, expect, it, vi } from 'vitest';

const TEST_HOOK_NAMES = [
  'test-observer-a',
  'test-observer-b',
  'test-failure',
] as const;

async function loadHooks() {
  return import('../../../src/main/features/user-switch-hooks');
}

afterEach(async () => {
  const hooks = await loadHooks();
  for (const name of TEST_HOOK_NAMES) {
    hooks.registerUserSwitchHook(name, () => {});
  }
});

describe('user-switch safety hooks', () => {
  it('rejects unnamed and non-function registrations', async () => {
    const hooks = await loadHooks();
    expect(() => hooks.registerUserSwitchHook('', () => {})).toThrow('invalid user switch hook');
    expect(() => hooks.registerUserSwitchHook(
      'invalid',
      null as unknown as (previousUid: string, nextUid: string) => void,
    )).toThrow('invalid user switch hook');
  });

  it('does not run cleanup before the first activation or for the same account', async () => {
    const hooks = await loadHooks();
    const observer = vi.fn();
    hooks.registerUserSwitchHook('test-observer-a', observer);

    hooks.notifyUserSwitch('', 'account-a');
    hooks.notifyUserSwitch('account-a', 'account-a');

    expect(observer).not.toHaveBeenCalled();
  });

  it('runs every registered cleanup with the old and new account ids', async () => {
    const hooks = await loadHooks();
    const events: string[] = [];
    hooks.registerUserSwitchHook('test-observer-a', (previousUid, nextUid) => {
      events.push(`a:${previousUid}->${nextUid}`);
    });
    hooks.registerUserSwitchHook('test-observer-b', (previousUid, nextUid) => {
      events.push(`b:${previousUid}->${nextUid}`);
    });

    hooks.notifyUserSwitch('account-a', 'account-b');

    expect(events).toEqual([
      'a:account-a->account-b',
      'b:account-a->account-b',
    ]);
  });

  it('reports cleanup failure after giving the remaining hooks a chance to fail closed', async () => {
    const hooks = await loadHooks();
    const laterCleanup = vi.fn();
    hooks.registerUserSwitchHook('test-failure', () => {
      throw new Error('old account runtime stayed live');
    });
    hooks.registerUserSwitchHook('test-observer-b', laterCleanup);

    expect(() => hooks.notifyUserSwitch('account-a', 'account-b'))
      .toThrow(/user switch cleanup failed.*test-failure/);
    expect(laterCleanup).toHaveBeenCalledWith('account-a', 'account-b');
  });
});
