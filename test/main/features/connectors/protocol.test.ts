import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
  const listeners = new Map<string, (...args: any[]) => unknown>();
  const window = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
  return {
    listeners,
    window,
    app: {
      isPackaged: true,
      isReady: vi.fn(() => true),
      setAsDefaultProtocolClient: vi.fn(() => true),
      isDefaultProtocolClient: vi.fn(() => true),
      on: vi.fn((event: string, listener: (...args: any[]) => unknown) => listeners.set(event, listener)),
    },
  };
});

const connectorMock = vi.hoisted(() => ({
  handleCallbackUrl: vi.fn(async () => undefined),
  handleDcrCallbackUrl: vi.fn(async () => undefined),
}));

vi.mock('electron', () => ({
  app: electronMock.app,
  BrowserWindow: { getAllWindows: () => [electronMock.window] },
}));

vi.mock('../../../../src/main/features/connectors/index', () => connectorMock);

describe('connector callback protocol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronMock.listeners.clear();
    electronMock.app.isReady.mockReturnValue(true);
  });

  it('accepts only connector OAuth callbacks', async () => {
    const { _test } = await import('../../../../src/main/features/connectors/protocol');

    expect(_test.connectorCallbackKind('orkas://connectors/oauth/callback?exchange_code=x')).toBe('server');
    expect(_test.connectorCallbackKind('orkas://connectors/oauth/dcr-callback?exchange_code=x')).toBe('dcr');
    expect(_test.connectorCallbackKind(`orkas://${'auth'}/callback?code=x`)).toBeNull();
    expect(_test.connectorCallbackKind('https://orkas.ai/connectors/oauth/callback')).toBeNull();
  });

  it('registers before readiness and dispatches both callback kinds to the running app', async () => {
    const protocol = await import('../../../../src/main/features/connectors/protocol');
    protocol.registerConnectorProtocol();

    expect(electronMock.app.setAsDefaultProtocolClient).toHaveBeenCalledWith('orkas');
    const openUrl = electronMock.listeners.get('open-url');
    expect(openUrl).toBeTypeOf('function');
    const preventDefault = vi.fn();

    await openUrl?.({ preventDefault }, 'orkas://connectors/oauth/callback?exchange_code=one');
    await vi.waitFor(() => expect(connectorMock.handleCallbackUrl).toHaveBeenCalledTimes(1));
    await openUrl?.({ preventDefault }, 'orkas://connectors/oauth/dcr-callback?exchange_code=two');
    await vi.waitFor(() => expect(connectorMock.handleDcrCallbackUrl).toHaveBeenCalledTimes(1));

    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(electronMock.window.restore).toHaveBeenCalled();
    expect(electronMock.window.focus).toHaveBeenCalled();
  });

  it('does not intercept stripped account-login links', async () => {
    const protocol = await import('../../../../src/main/features/connectors/protocol');
    protocol.registerConnectorProtocol();
    const openUrl = electronMock.listeners.get('open-url');
    const preventDefault = vi.fn();

    await openUrl?.({ preventDefault }, `orkas://${'auth'}/callback?exchange_code=account`);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(connectorMock.handleCallbackUrl).not.toHaveBeenCalled();
    expect(connectorMock.handleDcrCallbackUrl).not.toHaveBeenCalled();
  });
});
