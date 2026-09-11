import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const windows: FakeBrowserWindow[] = [];

class FakeBrowserWindow {
  destroyed = false;
  webContents = {
    setUserAgent: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    executeJavaScript: vi.fn(async () => ({ href: 'https://example.test/', textChars: 0 })),
  };

  constructor() {
    windows.push(this);
  }

  loadURL(): Promise<void> {
    // A page can keep navigation pending indefinitely (long polling, a broken
    // service worker, or a response that never completes).
    return new Promise(() => {});
  }

  destroy(): void {
    this.destroyed = true;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

vi.mock('electron', () => ({
  app: {
    isReady: () => true,
    userAgentFallback: 'Mozilla/5.0 Electron/39.0 Orkas/1.7.0',
    getName: () => 'Orkas',
  },
  BrowserWindow: FakeBrowserWindow,
  session: {
    fromPartition: () => ({
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn(),
      removeAllListeners: vi.fn(),
      on: vi.fn(),
    }),
  },
}));

describe('web_fetch browser-rendered fallback', () => {
  beforeEach(() => {
    windows.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('bounds a navigation that never reaches its load event', async () => {
    const { renderWebFetchPage } = await import('../../../../src/main/model/core-agent/web-fetch-render');
    const pending = renderWebFetchPage('https://example.test/');
    await Promise.resolve();
    expect(windows).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(25_000);

    await expect(pending).resolves.toBeNull();
    expect(windows[0].destroyed).toBe(true);
  });
});
