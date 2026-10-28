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
    expect(mocks.appOn).not.toHaveBeenCalled();
  });

  it('lets the shutdown coordinator await connector transport exit', async () => {
    const feature = await import('../../../../src/main/features/connectors/bootstrap');
    await feature.bootstrap('account-a');
    let release!: () => void;
    mocks.shutdownAll.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    let done = false;
    const pending = feature.shutdown().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(mocks.shutdownAll).toHaveBeenCalledOnce();
    release();
    await pending;
    expect(done).toBe(true);
  });

  it('bounds a stalled connector close so process cleanup can finish shutdown', async () => {
    vi.useFakeTimers();
    try {
      const feature = await import('../../../../src/main/features/connectors/bootstrap');
      mocks.shutdownAll.mockImplementationOnce(() => new Promise<void>(() => {}));
      const pending = expect(feature.shutdown()).rejects.toThrow('Connector shutdown timed out');
      await vi.advanceTimersByTimeAsync(5_000);
      await pending;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
