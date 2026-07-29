import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appOn: vi.fn(),
  bootstrap: vi.fn(async () => {}),
  shutdownAll: vi.fn(async () => {}),
}));

vi.mock('electron', () => ({
  app: { on: mocks.appOn },
}));

vi.mock('../../../../src/main/features/connectors/manager', () => ({
  bootstrap: (...args: unknown[]) => mocks.bootstrap(...args),
  shutdownAll: (...args: unknown[]) => mocks.shutdownAll(...args),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('connectors bootstrap lifecycle', () => {
  it('deduplicates one account boot but starts a fresh bootstrap after an account change', async () => {
    const feature = await import('../../../../src/main/features/connectors/bootstrap');

    const first = feature.bootstrap('account-a');
    const duplicate = feature.bootstrap('account-a');
    expect(duplicate).toBe(first);
    await Promise.all([first, duplicate]);
    expect(mocks.bootstrap).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrap).toHaveBeenNthCalledWith(1, 'account-a');

    await feature.bootstrap('account-b');
    expect(mocks.bootstrap).toHaveBeenCalledTimes(2);
    expect(mocks.bootstrap).toHaveBeenNthCalledWith(2, 'account-b');
    expect(mocks.appOn).toHaveBeenCalledTimes(1);
  });

  it('closes connector transports from the single process quit hook', async () => {
    const feature = await import('../../../../src/main/features/connectors/bootstrap');
    await feature.bootstrap('account-a');
    const beforeQuit = mocks.appOn.mock.calls.find(([event]) => event === 'before-quit')?.[1];
    expect(beforeQuit).toBeTypeOf('function');

    beforeQuit();
    await vi.waitFor(() => expect(mocks.shutdownAll).toHaveBeenCalledTimes(1));
  });
});
