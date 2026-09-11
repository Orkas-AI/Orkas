/** Electron drops session cookies on restart. On macOS, its network sandbox
 * also prevents the native cookie database from opening at our per-user path
 * outside sessionData (temporary directories can hide this failure in tests).
 * Checkpoint unpartitioned cookies in main without widening sandbox access.
 * Keep an account-bound encrypted checkpoint without changing cookie expiry or
 * scope. Restore before allowing requests; mirror removals as well as updates.
 */
import * as fs from 'node:fs';
import type { Cookie, CookiesSetDetails, Session } from 'electron';
import { userWebAssistSessionCookiesFile } from '../paths';
import { writeTextAtomicSync } from '../storage';
import { encryptLocalSecret, decryptLocalSecret } from '../util/local-secret-store';
import { createLogger } from '../logger';

const log = createLogger('web-assist-session');
const sessions = new WeakMap<Session, Promise<void>>();
const flushers = new Set<() => Promise<void>>();

function cookieKey(cookie: Cookie): string {
  return JSON.stringify([cookie.domain, cookie.path, cookie.name]);
}

function canRestore(cookie: Cookie): boolean {
  return !!cookie && typeof cookie.domain === 'string'
    && typeof cookie.name === 'string' && typeof cookie.value === 'string'
    && typeof cookie.hostOnly === 'boolean'
    && (cookie.session === true || (cookie.session === false
      && typeof cookie.expirationDate === 'number' && Number.isFinite(cookie.expirationDate)
      && cookie.expirationDate > Date.now() / 1000));
}

function cookieDetails(cookie: Cookie): CookiesSetDetails {
  return {
    url: `${cookie.secure ? 'https' : 'http'}://${cookie.domain!.replace(/^\./u, '')}${cookie.path || '/'}`,
    name: cookie.name,
    value: cookie.value,
    // Passing a domain for host-only cookies widens their subdomain scope.
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    ...(!cookie.session ? { expirationDate: cookie.expirationDate } : {}),
  };
}

export function prepareWebAssistSession(userId: string, ses: Session): Promise<void> {
  const existing = sessions.get(ses);
  if (existing) return existing;
  const file = userWebAssistSessionCookiesFile(userId);
  const context = { namespace: 'web-assist', ownerId: userId, recordId: 'session-cookies' };
  const cookies = new Map<string, Cookie>();
  const revisions = new Map<string, number>();
  let revision = 0;
  let pending = Promise.resolve();
  const save = () => {
    try {
      writeTextAtomicSync(file, encryptLocalSecret(context, JSON.stringify({
        version: 1, cookies: [...cookies.values()],
      })), 'utf8', { mode: 0o600 });
    } catch {
      // Never leave an older login checkpoint available after a failed logout write.
      try { fs.rmSync(file, { force: true }); } catch { /* report the persistence failure below */ }
      log.warn('session cookie checkpoint failed');
    }
  };
  const ready = (async () => {
    let saved: Cookie[] = [];
    try {
      const payload = JSON.parse(decryptLocalSecret(context, fs.readFileSync(file, 'utf8')));
      if (payload.version !== 1 || !Array.isArray(payload.cookies)) throw new Error('invalid checkpoint');
      saved = payload.cookies;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('session cookie checkpoint unavailable');
    }
    // Native persistent cookies take precedence over an older session checkpoint.
    for (const cookie of saved) {
      if (!canRestore(cookie)) continue;
      try {
        const current = (await ses.cookies.get({ url: cookieDetails(cookie).url }))
          .find(candidate => cookieKey(candidate) === cookieKey(cookie));
        if (current) {
          if (canRestore(current)) cookies.set(cookieKey(current), current);
          continue;
        }
        await ses.cookies.set(cookieDetails(cookie));
        cookies.set(cookieKey(cookie), cookie);
      } catch {
        log.warn('session cookie restore failed');
      }
    }
    if (saved.length) save();
    ses.cookies.on('changed', (_event, cookie, _cause, removed) => {
      const key = cookieKey(cookie);
      const tracked = cookies.delete(key);
      if (tracked) save();
      const changedAt = ++revision;
      revisions.set(key, changedAt);
      pending = pending.then(async () => {
        if (revisions.get(key) !== changedAt) return;
        // Electron's changed event and get({}) omit partition keys. The URL
        // lookup returns only unpartitioned cookies; never turn a CHIPS cookie
        // into an unpartitioned login or overwrite its unpartitioned namesake.
        const current = (await ses.cookies.get({ url: cookieDetails(cookie).url }))
          .find(candidate => cookieKey(candidate) === key);
        if (revisions.get(key) !== changedAt) return;
        revisions.delete(key);
        cookies.delete(key);
        if (current && canRestore(current)) cookies.set(key, current);
        save();
      }).catch(() => {
        log.warn('session cookie checkpoint refresh failed');
      });
    });
  })().catch(() => {
    log.warn('session cookie initialization failed');
    // Do not navigate with an incomplete restore and silently replace login state.
    throw new Error('Browser session initialization failed');
  });
  sessions.set(ses, ready);
  flushers.add(async () => {
    await ready;
    // Cookie notifications can enqueue more work while a query is in flight.
    let drained: Promise<void>;
    do { drained = pending; await drained; } while (pending !== drained);
    ses.flushStorageData();
    await ses.cookies.flushStore();
  });
  return ready;
}

/** Used by both ordinary quit and update/relaunch through the shutdown coordinator. */
export async function flushWebAssistSessions(): Promise<void> {
  const results = await Promise.allSettled([...flushers].map(flush => flush()));
  if (results.some(result => result.status === 'rejected')) log.warn('browser session flush failed');
}
