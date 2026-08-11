import { describe, expect, it, vi } from 'vitest';

import {
  hardenedWebPreferences,
  installExternalNavigationGuard,
  installOfflineHtmlPreviewNavigationGuard,
  isOfflineHtmlPreviewUrl,
  OFFLINE_HTML_PREVIEW_CSP,
  safeExternalHttpUrl,
  safeExternalUserActionUrl,
  withOfflineHtmlPreviewPolicy,
} from '../../../src/main/util/window-security';

describe('window security baseline', () => {
  it('cannot be weakened by caller overrides', () => {
    const prefs = hardenedWebPreferences({
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
      webSecurity: false,
      plugins: true,
    });
    expect(prefs).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      plugins: true,
    });
  });

  it('accepts only credential-free HTTP(S) URLs', () => {
    expect(safeExternalHttpUrl('https://example.test/docs?q=1')).toBe('https://example.test/docs?q=1');
    expect(safeExternalHttpUrl('http://example.test:9000/path')).toBe('http://example.test:9000/path');
    for (const value of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,boom',
      'chat-app://cid/a/b/index.html',
      'https://user:pass@example.test/',
      'https://example.test/\nfile:///etc/passwd',
      'https://',
      '',
    ]) {
      expect(safeExternalHttpUrl(value), value).toBeNull();
    }
  });

  it('strictly validates user-clicked mail, phone, and XMPP links', () => {
    for (const value of [
      'https://example.test/docs?q=1',
      'mailto:alice@example.com',
      'mailto:alice@example.com?subject=Hello',
      'tel:+86-13800138000',
      'sms:+8613800138000',
      'callto:+1 (555) 0100',
      'xmpp:alice@example.com',
    ]) {
      expect(safeExternalUserActionUrl(value), value).toBe(value);
    }

    for (const value of [
      'mailto:not-an-address',
      'mailto:alice@example.com?subject=Hello%0AInjected',
      'mailto:alice@example.com?attach=/etc/passwd',
      'tel:$(open evil)',
      'sms:+123?body=hello',
      'xmpp:alice@example.com?message',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'chat-app://cid/a/b/index.html',
      'kb-file://kb/private.pdf',
      'blob:https://example.test/id',
    ]) {
      expect(safeExternalUserActionUrl(value), value).toBeNull();
    }
  });

  it('denies every window.open and opens only safe URLs externally', async () => {
    let openHandler!: (details: { url: string }) => { action: 'deny' };
    let navigateHandler!: (event: { preventDefault(): void }, url: string) => void;
    const webContents = {
      setWindowOpenHandler: vi.fn((handler) => { openHandler = handler; }),
      on: vi.fn((_event, handler) => { navigateHandler = handler; }),
    };
    const openExternal = vi.fn(async () => undefined);
    installExternalNavigationGuard(webContents, openExternal);

    expect(openHandler({ url: 'https://example.test/a' })).toEqual({ action: 'deny' });
    expect(openHandler({ url: 'mailto:alice@example.test' })).toEqual({ action: 'deny' });
    expect(openHandler({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' });
    await Promise.resolve();
    await Promise.resolve();
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('https://example.test/a');

    const externalEvent = { preventDefault: vi.fn() };
    navigateHandler(externalEvent, 'https://example.test/b');
    const localEvent = { preventDefault: vi.fn() };
    navigateHandler(localEvent, 'file:///tmp/other.html');
    expect(externalEvent.preventDefault).toHaveBeenCalledOnce();
    expect(localEvent.preventDefault).toHaveBeenCalledOnce();
    await Promise.resolve();
    await Promise.resolve();
    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(openExternal).toHaveBeenLastCalledWith('https://example.test/b');
  });

  it('reports shell failures without allowing the navigation', async () => {
    let openHandler!: (details: { url: string }) => { action: 'deny' };
    const webContents = {
      setWindowOpenHandler: (handler: typeof openHandler) => { openHandler = handler; },
      on: vi.fn(),
    };
    const failure = new Error('shell failed');
    const warn = vi.fn();
    installExternalNavigationGuard(webContents, async () => { throw failure; }, warn);
    expect(openHandler({ url: 'https://example.test/' })).toEqual({ action: 'deny' });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(failure));
  });
});

describe('offline local HTML preview policy', () => {
  it('preserves the streamed response while allowing inline code and denying network egress', async () => {
    const original = new Response('preview body', {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
        'Content-Range': 'bytes 0-11/12',
        'Content-Type': 'text/html',
      },
    });

    const secured = withOfflineHtmlPreviewPolicy(original);

    expect(secured.status).toBe(206);
    expect(secured.statusText).toBe('Partial Content');
    expect(secured.headers.get('Accept-Ranges')).toBe('bytes');
    expect(secured.headers.get('Cache-Control')).toBe('no-cache');
    expect(secured.headers.get('Content-Range')).toBe('bytes 0-11/12');
    expect(secured.headers.get('Content-Type')).toBe('text/html');
    expect(secured.headers.get('Content-Security-Policy')).toBe(OFFLINE_HTML_PREVIEW_CSP);
    expect(OFFLINE_HTML_PREVIEW_CSP).toContain("script-src 'unsafe-inline'");
    expect(OFFLINE_HTML_PREVIEW_CSP).toContain("connect-src 'none'");
    expect(OFFLINE_HTML_PREVIEW_CSP).toContain('img-src chat-media://local data: blob:');
    expect(OFFLINE_HTML_PREVIEW_CSP).toContain("frame-src 'none'");
    expect(secured.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(secured.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await secured.text()).toBe('preview body');
  });

  it.each([
    'chat-media://local/Users/test/preview.html',
    'chat-media://local/C:/Users/test/preview.HTM?v=2#slide',
    'chat-media://local/Users/test/preview%2Ehtml',
  ])('recognizes the validated local HTML route: %s', (url) => {
    expect(isOfflineHtmlPreviewUrl(url)).toBe(true);
  });

  it.each([
    'chat-media://cid/conversation/preview.html',
    'chat-media://local/Users/test/preview.html.png',
    'chat-media://local/Users/test/preview.xhtml',
    'https://example.test/preview.html',
    'data:text/html,preview',
    'chat-media://local/Users/test/%E0%A4%A.html',
  ])('rejects route look-alikes: %s', (url) => {
    expect(isOfflineHtmlPreviewUrl(url)).toBe(false);
  });

  it('blocks an HTML subframe from navigating off the local protocol', () => {
    let navigate!: (event: {
      preventDefault(): void;
      url: string;
      isMainFrame: boolean;
      frame?: { url: string } | null;
      initiator?: { url: string } | null;
    }) => void;
    installOfflineHtmlPreviewNavigationGuard({
      on: (_event, handler) => { navigate = handler; },
    });

    const remote = {
      preventDefault: vi.fn(),
      url: 'https://example.test/collect?private=value',
      isMainFrame: false,
      frame: { url: 'chat-media://local/Users/test/preview.html' },
    };
    navigate(remote);
    expect(remote.preventDefault).toHaveBeenCalledOnce();

    const fetchLikeDataNavigation = {
      preventDefault: vi.fn(),
      url: 'data:text/html,escape',
      isMainFrame: false,
      initiator: { url: 'chat-media://local/Users/test/preview.htm?v=2' },
    };
    navigate(fetchLikeDataNavigation);
    expect(fetchLikeDataNavigation.preventDefault).toHaveBeenCalledOnce();
  });

  it('allows initial/non-preview navigation and validated local follow-up documents', () => {
    let navigate!: (event: {
      preventDefault(): void;
      url: string;
      isMainFrame: boolean;
      frame?: { url: string } | null;
      initiator?: { url: string } | null;
    }) => void;
    installOfflineHtmlPreviewNavigationGuard({
      on: (_event, handler) => { navigate = handler; },
    });

    const initial = {
      preventDefault: vi.fn(),
      url: 'chat-media://local/Users/test/preview.html',
      isMainFrame: false,
      frame: { url: 'about:blank' },
      initiator: { url: 'file:///renderer/index.html' },
    };
    navigate(initial);
    expect(initial.preventDefault).not.toHaveBeenCalled();

    const localFollowUp = {
      preventDefault: vi.fn(),
      url: 'chat-media://local/Users/test/second.html',
      isMainFrame: false,
      frame: { url: 'chat-media://local/Users/test/preview.html' },
    };
    navigate(localFollowUp);
    expect(localFollowUp.preventDefault).not.toHaveBeenCalled();

    const ordinaryFrame = {
      preventDefault: vi.fn(),
      url: 'https://example.test/',
      isMainFrame: false,
      frame: { url: 'chat-app://cid/a/b/index.html' },
    };
    navigate(ordinaryFrame);
    expect(ordinaryFrame.preventDefault).not.toHaveBeenCalled();
  });
});
