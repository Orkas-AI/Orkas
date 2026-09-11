import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

const warnings = vi.hoisted(() => vi.fn());
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ warn: warnings }) }));
import { browserProxyConfig, prepareBrowserProxy } from '../../../src/main/util/browser-proxy';

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('embedded browser launch proxy policy', () => {
  it('leaves system/PAC configuration untouched when no explicit launch proxy exists', () => {
    const setProxy = vi.fn();
    const policy = prepareBrowserProxy({ setProxy }, { NO_PROXY: 'example.com' });
    expect(policy.ready).toBeUndefined();
    expect(setProxy).not.toHaveBeenCalled();
  });

  it.each([
    [{ HTTP_PROXY: 'http://proxy.test:8080' }, 'http=http://proxy.test:8080;https=http://proxy.test:8080'],
    [{ HTTPS_PROXY: 'https://secure.test:443' }, 'http=direct://;https=https://secure.test'],
    [{ HTTP_PROXY: 'http://http.test:80', HTTPS_PROXY: 'https://https.test:8443', ALL_PROXY: 'socks5://unused:1080' }, 'http=http://http.test;https=https://https.test:8443'],
    [{ all_proxy: 'socks5h://[::1]:1080' }, 'http=socks5://[::1]:1080;https=socks5://[::1]:1080'],
  ])('uses the same per-scheme launch precedence without a direct failure fallback: %j', (env, rules) => {
    const { config } = browserProxyConfig(env);
    expect(config?.mode).toBe('fixed_servers');
    expect(config?.proxyRules).toBe(rules);
    expect(config?.proxyRules).not.toContain(',direct://');
  });

  it('preserves local bypasses plus exact host, subdomain, port and IPv6 exceptions', () => {
    const { config } = browserProxyConfig({ HTTP_PROXY: 'http://proxy.test', NO_PROXY: 'example.com,.internal.test:8443,[2001:db8::1],10.0.0.1' });
    expect(config?.proxyBypassRules?.split(',')).toEqual([
      'example.com', '.example.com', 'internal.test:8443', '.internal.test:8443', '[2001:db8::1]', '10.0.0.1',
      'localhost', '.localhost', '127.0.0.1', '[::1]', 'local', '.local',
    ]);
    expect(browserProxyConfig({ HTTP_PROXY: 'http://proxy.test', NO_PROXY: '*' }).config?.proxyBypassRules).toContain('*');
  });

  it('holds requests until Chromium has applied the proxy', async () => {
    let applied!: () => void;
    const setProxy = vi.fn(() => new Promise<void>(resolve => { applied = resolve; }));
    const policy = prepareBrowserProxy({ setProxy }, { HTTP_PROXY: 'http://proxy.test' });
    const released = vi.fn();
    void policy.ready!.then(released);
    await Promise.resolve();
    expect(released).not.toHaveBeenCalled();
    applied();
    expect(await policy.ready).toBe(true);
    expect(released).toHaveBeenCalledWith(true);
    expect(warnings).not.toHaveBeenCalled();
  });

  it.each([
    { HTTP_PROXY: 'http://secret:private@proxy.test/bad-path' },
    { ALL_PROXY: 'socks5://secret:private@proxy.test:1080' },
    { HTTPS_PROXY: 'not-a-proxy' },
    { HTTP_PROXY: 'direct://' },
    { HTTP_PROXY: 'http://proxy.test,direct' },
    { HTTP_PROXY: 'http://proxy.test;https=direct' },
    { HTTP_PROXY: 'http://proxy.test', NO_PROXY: 'example.com;*' },
    { HTTP_PROXY: 'http://a:b@proxy.test', HTTPS_PROXY: 'http://c:d@proxy.test' },
  ])('blocks malformed/unsupported configuration without disclosing credentials: %j', async env => {
    const setProxy = vi.fn();
    expect(await prepareBrowserProxy({ setProxy }, env).ready).toBe(false);
    expect(setProxy).not.toHaveBeenCalled();
    expect(warnings).toHaveBeenCalledExactlyOnceWith('browser proxy configuration is invalid; browser requests remain blocked');
  });

  it('fails closed when Chromium rejects or never completes proxy setup', async () => {
    vi.useFakeTimers();
    const rejected = prepareBrowserProxy({ setProxy: vi.fn().mockRejectedValue(new Error('private provider error')) }, { HTTP_PROXY: 'http://proxy.test' });
    expect(await rejected.ready).toBe(false);
    const stalled = prepareBrowserProxy({ setProxy: () => new Promise(() => {}) }, { HTTP_PROXY: 'http://proxy.test' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await stalled.ready).toBe(false);
    expect(warnings.mock.calls).toEqual(Array(2).fill(['browser proxy setup failed; browser requests remain blocked']));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('answers only matching proxy challenges, never origin login, and cancels rejected credentials', async () => {
    const setProxy = vi.fn().mockResolvedValue(undefined);
    const policy = prepareBrowserProxy({ setProxy }, { HTTPS_PROXY: 'http://fixture:pass%40word@proxy.test:8080' });
    expect(await policy.ready).toBe(true);
    for (const secret of ['fixture', 'pass@word', 'pass%40word']) {
      expect(JSON.stringify(setProxy.mock.calls)).not.toContain(secret);
    }
    const contents = new EventEmitter();
    policy.attach(contents as WebContents);
    const preventDefault = vi.fn();
    const callback = vi.fn();
    const challenge = (isProxy: boolean, host = 'proxy.test', firstAuthAttempt = true) => {
      contents.emit('login', { preventDefault }, { firstAuthAttempt }, { isProxy, host, port: 8080 }, callback);
    };
    challenge(false);
    challenge(true, 'other.test');
    expect(callback).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    challenge(true);
    expect(callback).toHaveBeenLastCalledWith('fixture', 'pass@word');
    challenge(true, 'proxy.test', false);
    expect(callback).toHaveBeenLastCalledWith();
  });
});
