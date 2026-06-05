import { Mutex } from 'async-mutex';

type MarketplaceKind = 'agent' | 'skill';
type MarketplaceLockScope = 'install' | 'cache';

const _locks = new Map<string, Mutex>();

function _lock(scope: MarketplaceLockScope, uid: string, kind: MarketplaceKind, id: string): Mutex {
  const key = `${scope}:${uid}:${kind}:${id}`;
  let lock = _locks.get(key);
  if (!lock) {
    lock = new Mutex();
    _locks.set(key, lock);
  }
  return lock;
}

export async function withMarketplaceInstallLock<T>(
  uid: string,
  kind: MarketplaceKind,
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  return _lock('install', uid, kind, id).runExclusive(fn);
}

export async function withMarketplaceCacheLock<T>(
  uid: string,
  kind: MarketplaceKind,
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  return _lock('cache', uid, kind, id).runExclusive(fn);
}
