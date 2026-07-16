import { describe, expect, it, vi } from 'vitest';

import {
  hardenedWebPreferences,
  installExternalNavigationGuard,
  safeExternalHttpUrl,
  safeExternalUserActionUrl,
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
