import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ api: vi.fn(), load: vi.fn(), warn: vi.fn(), uid: 'preload-user' }));
vi.mock('../../../src/main/features/auth', () => ({ getChatPreloadApi: mocks.api }));
vi.mock('../../../src/main/features/users', () => ({ getActiveUserId: () => mocks.uid }));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: mocks.warn }) }));
vi.mock('../../../src/main/model/core-agent/api-preload', () => ({ preloadModelApi: mocks.load }));

import * as boot from '../../../src/main/util/boot_init';
import { scheduleChatApiPreload } from '../../../src/main/features/model-api-preload';

beforeEach(() => {
  vi.useFakeTimers();
  boot._resetForTests();
  mocks.uid = 'preload-user';
  mocks.api.mockReset().mockResolvedValue('anthropic-messages');
  mocks.load.mockReset().mockResolvedValue(true);
  mocks.warn.mockReset();
});
afterEach(() => { boot._resetForTests(); vi.useRealTimers(); });

describe('post-startup model API preparation', () => {
  it('returns immediately, waits until after startup, and loads only the selected API', async () => {
    const ready = vi.fn(async () => true);
    const task = scheduleChatApiPreload(ready);
    expect(ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_999);
    expect(mocks.load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await task.promise;
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith('anthropic-messages', expect.any(Function));
  });
  it('never forces loading through continuing user input or an active conversation', async () => {
    let busy = true;
    boot.configureBootAdmission({ isRuntimeBusy: () => busy });
    const task = scheduleChatApiPreload(async () => true);
    await vi.advanceTimersByTimeAsync(130_000);
    expect(mocks.api).not.toHaveBeenCalled();
    busy = false;
    for (let i = 0; i < 130; i++) {
      boot.noteBootUserActivity();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(mocks.api).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    await task.promise;
    expect(mocks.load).toHaveBeenCalledOnce();
  });
  it.each(['not-ready', 'no-model', 'cancel', 'account-switch', 'new-input'])(
    'does no speculative loading for %s', async (state) => {
      if (state === 'no-model') mocks.api.mockResolvedValue(null);
      if (state === 'account-switch' || state === 'new-input') mocks.api.mockImplementation(async () => {
        if (state === 'account-switch') mocks.uid = 'other-user';
        else boot.noteBootUserActivity();
        return 'anthropic-messages';
      });
      const task = scheduleChatApiPreload(async () => state !== 'not-ready');
      if (state === 'cancel') task.cancel();
      await vi.advanceTimersByTimeAsync(6_000);
      await task.promise;
      expect(mocks.load).not.toHaveBeenCalled();
    },
  );
  it('contains a preload failure and leaves later independent work usable', async () => {
    mocks.load.mockRejectedValueOnce(new Error('fixture import unavailable'));
    const task = scheduleChatApiPreload(async () => true);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(task.promise).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledOnce();
    const later = scheduleChatApiPreload(async () => true);
    await vi.advanceTimersByTimeAsync(6_000);
    await later.promise;
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });
  it.each(['input', 'conversation', 'account', 'exit'])('stops subsequent batches when %s takes priority', async (reason) => {
    let busy = false;
    boot.configureBootAdmission({ isRuntimeBusy: () => busy });
    mocks.load.mockImplementation(async (_api, shouldContinue) => {
      expect(shouldContinue()).toBe(true);
      if (reason === 'input') boot.noteBootUserActivity();
      if (reason === 'conversation') busy = true;
      if (reason === 'account') mocks.uid = 'other';
      if (reason === 'exit') boot.stopBootWork();
      expect(shouldContinue()).toBe(false);
      return false;
    });
    const task = scheduleChatApiPreload(async () => true);
    await vi.advanceTimersByTimeAsync(6_000);
    await task.promise;
    expect(mocks.load).toHaveBeenCalledOnce();
  });
});
