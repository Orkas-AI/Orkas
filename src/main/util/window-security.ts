import type { WebPreferences } from 'electron';

/**
 * Security baseline for every BrowserWindow we create. Callers may add
 * functional preferences (preload, session, plugins, etc.), but cannot
 * override the four isolation controls through the overrides object.
 */
export function hardenedWebPreferences(overrides: Partial<WebPreferences> = {}): WebPreferences {
  return {
    ...overrides,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
  };
}

/** Return a normalized external-browser URL, or null for unsafe input. */
export function safeExternalHttpUrl(raw: unknown): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

interface NavigationEvent {
  preventDefault(): void;
}

interface GuardedWebContents {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
  on(event: 'will-navigate', handler: (event: NavigationEvent, url: string) => void): void;
}

/**
 * Keep the application renderer on its original local document. HTTP(S)
 * destinations are handed to the OS browser; every in-app navigation,
 * including file/data/javascript/custom schemes, is denied.
 */
export function installExternalNavigationGuard(
  webContents: GuardedWebContents,
  openExternal: (url: string) => Promise<unknown>,
  warn: (error: unknown) => void = () => {},
): void {
  const open = (raw: unknown): void => {
    const url = safeExternalHttpUrl(raw);
    if (!url) return;
    Promise.resolve()
      .then(() => openExternal(url))
      .catch((error) => warn(error));
  };

  webContents.setWindowOpenHandler(({ url }) => {
    open(url);
    return { action: 'deny' };
  });

  webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    open(url);
  });
}
