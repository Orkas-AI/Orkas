/**
 * Synchronous account-switch safety hooks.
 *
 * Account activation changes credential and filesystem roots synchronously,
 * so security-sensitive runtimes must invalidate old-user state before that
 * swap. A global-symbol map keeps one hook per subsystem across dual TS/CJS
 * loaders and lets test/module reloads replace stale registrations.
 */

export type UserSwitchHook = (previousUid: string, nextUid: string) => void;

export class UserSwitchCleanupError extends Error {
  readonly failedHooks: readonly string[];

  constructor(failedHooks: string[]) {
    super(`user switch cleanup failed: ${failedHooks.join(', ')}`);
    this.name = 'UserSwitchCleanupError';
    this.failedHooks = [...failedHooks];
  }
}

const REGISTRY_KEY = Symbol.for('orkas.user-switch-hooks.v1');
const globalState = globalThis as typeof globalThis & {
  [REGISTRY_KEY]?: Map<string, UserSwitchHook>;
};
const hooks = globalState[REGISTRY_KEY] || new Map<string, UserSwitchHook>();
globalState[REGISTRY_KEY] = hooks;

export function registerUserSwitchHook(name: string, hook: UserSwitchHook): void {
  if (!name || typeof hook !== 'function') throw new Error('invalid user switch hook');
  hooks.set(name, hook);
}

export function notifyUserSwitch(previousUid: string, nextUid: string): void {
  if (!previousUid || previousUid === nextUid) return;
  const failedHooks: string[] = [];
  for (const [name, hook] of hooks) {
    try { hook(previousUid, nextUid); }
    catch { failedHooks.push(name); }
  }
  if (failedHooks.length > 0) {
    // Every subsystem gets a chance to invalidate old-user state, but a
    // failure must stop activation before filesystem and credential roots
    // move to the next account.
    throw new UserSwitchCleanupError(failedHooks);
  }
}
