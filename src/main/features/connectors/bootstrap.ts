/**
 * Startup entry for the connectors feature. Called once from `main/index.ts` inside
 * `app.whenReady()` after the active uid is settled. Healthy instances reuse their persisted
 * tool schemas; only uncached, stale, or repair-needed rows connect during bootstrap. The first
 * real tool call reconnects a cached instance on demand.
 *
 * The shared app shutdown coordinator awaits `shutdown()` before installer
 * handoff; an asynchronous before-quit listener cannot delay Electron exit.
 */
import * as manager from './manager';
import { createLogger } from '../../logger';

const log = createLogger('connectors');

let _bootPromise: Promise<void> | null = null;
let _bootUid: string | null = null;

async function _doBootstrap(uid: string): Promise<void> {
  try {
    await manager.bootstrap(uid);
  } catch (err) {
    log.warn('connectors bootstrap failed', { error: (err as Error).message });
  }
}

export async function shutdown(): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      manager.shutdownAll(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Connector shutdown timed out')), 5_000);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export function bootstrap(uid: string): Promise<void> {
  if (!_bootPromise || _bootUid !== uid) {
    _bootUid = uid;
    _bootPromise = _doBootstrap(uid);
  }
  return _bootPromise;
}
