/**
 * Startup entry for the connectors feature. Called once from `main/index.ts` inside
 * `app.whenReady()` after the active uid is settled. Healthy instances reuse their persisted
 * tool schemas; only uncached, stale, or repair-needed rows connect during bootstrap. The first
 * real tool call reconnects a cached instance on demand.
 *
 * Process-quit hook calls `manager.shutdownAll()` so stdio subprocesses (MCP servers) exit
 * cleanly instead of becoming zombies — symmetrical to the cleanup that `local_agents/runner.ts`
 * runs for its own spawned CLIs.
 */
import { app } from 'electron';
import * as manager from './manager';
import { createLogger } from '../../logger';

const log = createLogger('connectors');

let _bootPromise: Promise<void> | null = null;
let _quitHookInstalled = false;

async function _doBootstrap(uid: string): Promise<void> {
  try {
    await manager.bootstrap(uid);
  } catch (err) {
    log.warn('connectors bootstrap failed', { error: (err as Error).message });
  }
}

function _installQuitHook(): void {
  if (_quitHookInstalled) return;
  _quitHookInstalled = true;
  app.on('before-quit', () => {
    manager.shutdownAll().catch((err) => {
      log.warn('connectors shutdownAll failed', { error: (err as Error).message });
    });
  });
}

export function bootstrap(uid: string): Promise<void> {
  _installQuitHook();
  if (!_bootPromise) _bootPromise = _doBootstrap(uid);
  return _bootPromise;
}
