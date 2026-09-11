import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type { Cookie, Session } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { prepareWebAssistSession, flushWebAssistSessions } from '../../../src/main/features/web_assist_session';
import { userWebAssistSessionCookiesFile } from '../../../src/main/paths';
import { encryptLocalSecret, decryptLocalSecret } from '../../../src/main/util/local-secret-store';
import { writeTextAtomicSync } from '../../../src/main/storage';

const warnings = vi.hoisted(() => vi.fn());
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ warn: warnings }) }));

const login: Cookie = {
  name: '__Host-login', value: 'fixture-secret', domain: 'example.test', path: '/',
  session: true, secure: true, httpOnly: true, hostOnly: true, sameSite: 'lax',
};
const context = (userId: string) => ({ namespace: 'web-assist', ownerId: userId, recordId: 'session-cookies' });
function fakeSession(current: Cookie[] = []) {
  let rows = [...current];
  const cookies = Object.assign(new EventEmitter(), {
    get: vi.fn(async () => rows), set: vi.fn(async () => {}), flushStore: vi.fn(async () => {}),
  });
  const emit = cookies.emit.bind(cookies);
  cookies.emit = (event: string | symbol, ...args: any[]) => {
    if (event === 'changed') {
      const [, cookie, , removed] = args;
      rows = rows.filter(row => !(row.domain === cookie.domain && row.path === cookie.path && row.name === cookie.name));
      if (!removed) rows.push(cookie);
    }
    return emit(event, ...args);
  };
  const ses = { cookies, flushStorageData: vi.fn() };
  return { ...ses, native: ses as unknown as Session };
}
function checkpoint(userId: string): Cookie[] {
  return JSON.parse(decryptLocalSecret(context(userId), fs.readFileSync(userWebAssistSessionCookiesFile(userId), 'utf8'))).cookies;
}

describe('browser login continuity', () => {
  it('restores host-only and domain logins with original security scope and no manufactured expiry', async () => {
    const first = fakeSession();
    await prepareWebAssistSession('restore', first.native);
    first.cookies.emit('changed', {}, login, 'explicit', false);
    first.cookies.emit('changed', {}, { ...login, name: 'domain-login', domain: '.example.test', hostOnly: false }, 'explicit', false);
    await flushWebAssistSessions();
    const file = userWebAssistSessionCookiesFile('restore');
    expect(fs.readFileSync(file, 'utf8')).not.toContain(login.value);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const restarted = fakeSession();
    await prepareWebAssistSession('restore', restarted.native);
    expect(restarted.cookies.set.mock.calls).toEqual([
      [{ url: 'https://example.test/', name: '__Host-login', value: 'fixture-secret', path: '/', secure: true, httpOnly: true, sameSite: 'lax' }],
      [{ url: 'https://example.test/', name: 'domain-login', value: 'fixture-secret', domain: '.example.test', path: '/', secure: true, httpOnly: true, sameSite: 'lax' }],
    ]);
    await prepareWebAssistSession('restore', restarted.native);
    expect(restarted.cookies.set).toHaveBeenCalledTimes(2);
    await flushWebAssistSessions();
    expect(restarted.cookies.flushStore).toHaveBeenCalled();
  });

  it('records cookie rotation and logout so neither an old login nor a removed login returns', async () => {
    const first = fakeSession();
    await prepareWebAssistSession('logout', first.native);
    first.cookies.emit('changed', {}, login, 'explicit', false);
    first.cookies.emit('changed', {}, login, 'overwrite', true);
    first.cookies.emit('changed', {}, { ...login, value: 'rotated' }, 'explicit', false);
    await flushWebAssistSessions();
    expect(checkpoint('logout')).toEqual([{ ...login, value: 'rotated' }]);
    first.cookies.emit('changed', {}, { ...login, value: 'rotated' }, 'explicit', true);
    await flushWebAssistSessions();
    const restarted = fakeSession();
    await prepareWebAssistSession('logout', restarted.native);
    expect(restarted.cookies.set).not.toHaveBeenCalled();
    expect(checkpoint('logout')).toEqual([]);
  });

  it('does not replace newer native credentials with a stale checkpoint and saves the current login', async () => {
    const first = fakeSession();
    await prepareWebAssistSession('native', first.native);
    first.cookies.emit('changed', {}, login, 'explicit', false);
    await flushWebAssistSessions();
    const persistent = { ...login, session: false, expirationDate: 2_000_000_000, value: 'new-native-login' };
    const restarted = fakeSession([persistent]);
    await prepareWebAssistSession('native', restarted.native);
    expect(restarted.cookies.set).not.toHaveBeenCalled();
    expect(checkpoint('native')).toEqual([persistent]);
    restarted.cookies.emit('changed', {}, persistent, 'explicit', false);
    await flushWebAssistSessions();
    expect(checkpoint('native')).toEqual([persistent]);
  });

  it('restores expiring login cookies with their original expiry when the native store is unavailable', async () => {
    const first = fakeSession();
    await prepareWebAssistSession('expiring', first.native);
    const persistent = { ...login, session: false, expirationDate: 2_000_000_000 };
    first.cookies.emit('changed', {}, persistent, 'explicit', false);
    await flushWebAssistSessions();
    const restarted = fakeSession();
    await prepareWebAssistSession('expiring', restarted.native);
    expect(restarted.cookies.set).toHaveBeenCalledExactlyOnceWith({
      url: 'https://example.test/', name: '__Host-login', value: 'fixture-secret',
      path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: 2_000_000_000,
    });
    restarted.cookies.emit('changed', {}, persistent, 'explicit', true);
    await flushWebAssistSessions();
    const loggedOut = fakeSession();
    await prepareWebAssistSession('expiring', loggedOut.native);
    expect(loggedOut.cookies.set).not.toHaveBeenCalled();
  });

  it('never revives expired cookies or converts malformed persistent credentials into session logins', async () => {
    writeTextAtomicSync(userWebAssistSessionCookiesFile('expired'), encryptLocalSecret(context('expired'), JSON.stringify({
      version: 1, cookies: [
        { ...login, session: false, expirationDate: 1 },
        { ...login, name: 'missing-expiry', session: false },
        { ...login, name: 'invalid-expiry', session: false, expirationDate: '2000000000' },
        { ...login, name: 'valid-session' },
      ],
    })));
    const restarted = fakeSession();
    await prepareWebAssistSession('expired', restarted.native);
    expect(restarted.cookies.set).toHaveBeenCalledTimes(1);
    expect(restarted.cookies.set).toHaveBeenCalledWith(expect.objectContaining({ name: 'valid-session' }));
    expect(checkpoint('expired')).toEqual([{ ...login, name: 'valid-session' }]);
  });

  it('rejects another account checkpoint and recovers from corruption through a fresh login', async () => {
    const first = fakeSession();
    await prepareWebAssistSession('alice', first.native);
    first.cookies.emit('changed', {}, login, 'explicit', false);
    await flushWebAssistSessions();
    writeTextAtomicSync(userWebAssistSessionCookiesFile('bob'), fs.readFileSync(userWebAssistSessionCookiesFile('alice'), 'utf8'));
    warnings.mockClear();
    const bob = fakeSession();
    await prepareWebAssistSession('bob', bob.native);
    expect(bob.cookies.set).not.toHaveBeenCalled();
    expect(warnings).toHaveBeenCalledExactlyOnceWith('session cookie checkpoint unavailable');
    bob.cookies.emit('changed', {}, { ...login, value: 'bob-login' }, 'explicit', false);
    await flushWebAssistSessions();
    expect(checkpoint('bob')).toEqual([{ ...login, value: 'bob-login' }]);
    expect(checkpoint('alice')).toEqual([login]);
    writeTextAtomicSync(userWebAssistSessionCookiesFile('corrupt'), 'damaged ciphertext');
    const corrupt = fakeSession();
    await prepareWebAssistSession('corrupt', corrupt.native);
    expect(corrupt.cookies.set).not.toHaveBeenCalled();
    corrupt.cookies.emit('changed', {}, login, 'explicit', false);
    await flushWebAssistSessions();
    expect(checkpoint('corrupt')).toEqual([login]);
  });

  it('continues restoring valid logins when one cookie is rejected and removes the rejected checkpoint entry', async () => {
    writeTextAtomicSync(userWebAssistSessionCookiesFile('rejected'), encryptLocalSecret(context('rejected'), JSON.stringify({
      version: 1, cookies: [login, { ...login, name: 'valid-login' }],
    })));
    const ses = fakeSession();
    ses.cookies.set.mockRejectedValueOnce(new Error('fixture rejection'));
    warnings.mockClear();
    await prepareWebAssistSession('rejected', ses.native);
    expect(warnings).toHaveBeenCalledExactlyOnceWith('session cookie restore failed');
    expect(checkpoint('rejected')).toEqual([{ ...login, name: 'valid-login' }]);
  });

  it('does not persist a partitioned cookie omitted by the unpartitioned URL lookup', async () => {
    const ses = fakeSession();
    await prepareWebAssistSession('partitioned', ses.native);
    ses.cookies.get.mockResolvedValue([]);
    ses.cookies.emit('changed', {}, login, 'explicit', false);
    await flushWebAssistSessions();
    expect(checkpoint('partitioned')).toEqual([]);
    const restarted = fakeSession();
    await prepareWebAssistSession('partitioned', restarted.native);
    expect(restarted.cookies.set).not.toHaveBeenCalled();
  });

  it('does not revive a logged-out cookie when an older lookup resolves after logout', async () => {
    const ses = fakeSession();
    await prepareWebAssistSession('inflight', ses.native);
    let resolve!: (cookies: Cookie[]) => void;
    ses.cookies.get.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    ses.cookies.emit('changed', {}, login, 'explicit', false);
    await Promise.resolve();
    ses.cookies.emit('changed', {}, login, 'explicit', true);
    resolve([login]);
    await flushWebAssistSessions();
    expect(checkpoint('inflight')).toEqual([]);
  });
});
