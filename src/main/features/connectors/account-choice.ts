/** Account selection during authorization. Credentials never cross this boundary. */
import { randomBytes } from 'node:crypto';
import { t } from '../../i18n';
import { getLanguageForUser } from '../config';
import { getActiveUserId } from '../users';
import { registerUserSwitchHook } from '../user-switch-hooks';

export interface AccountChoice { id: string; label: string }
interface Pending {
  uid: string;
  ids: Set<string>;
  finish: (id: string | null) => void;
}
const pending = new Map<string, Pending>();
let broadcastOverride: ((channel: string, payload: unknown) => boolean) | undefined;
export function _setBroadcastForTest(fn?: typeof broadcastOverride): void { broadcastOverride = fn; }
function broadcast(channel: string, payload: unknown): boolean {
  if (broadcastOverride) return broadcastOverride(channel, payload);
  try {
    const ipc = require('../../ipc') as typeof import('../../ipc');
    return ipc.broadcastToRenderer(channel, payload);
  } catch { return false; }
}
const cancelled = () => Object.assign(new Error('Authorization cancelled'), { code: 'user_cancelled' });

export function requestAccountChoice(uid: string, catalogId: string, choices: AccountChoice[], signal: AbortSignal): Promise<string> {
  if (signal.aborted || uid !== getActiveUserId()) return Promise.reject(cancelled());
  if (!choices.length || choices.length > 100 || new Set(choices.map(choice => choice.id)).size !== choices.length
      || choices.some(choice => !/^[1-9][0-9]{0,24}$/.test(choice.id)
        || typeof choice.label !== 'string' || !choice.label || choice.label.length > 200)) {
    return Promise.reject(new Error('Invalid authorized account choices'));
  }
  const requestId = randomBytes(16).toString('hex');
  const lang = getLanguageForUser(uid);
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const abort = () => finish(null);
    const finish = (id: string | null) => {
      if (!pending.delete(requestId)) return;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      broadcast('connectors:account-choice-cancelled', { request_id: requestId });
      if (id === null) reject(cancelled()); else resolve(id);
    };
    timer = setTimeout(abort, 10 * 60 * 1000);
    timer.unref?.();
    pending.set(requestId, { uid, ids: new Set(choices.map(choice => choice.id)), finish });
    signal.addEventListener('abort', abort, { once: true });
    const shown = broadcast('connectors:account-choice', {
      request_id: requestId, catalog_id: catalogId,
      title: t('connectors.account_choice.title', {}, lang),
      message: t('connectors.account_choice.message', {}, lang),
      choices: choices.map(({ id, label }) => ({ id, label })),
    });
    if (!shown) finish(null);
  });
}

export function respondAccountChoice(uid: string, requestId: string, id: string | null): boolean {
  const request = pending.get(requestId);
  if (!request || request.uid !== uid || uid !== getActiveUserId() || (id !== null && !request.ids.has(id))) return false;
  request.finish(id);
  return true;
}

registerUserSwitchHook('connector-account-choice', previousUid => {
  for (const request of pending.values()) if (request.uid === previousUid) request.finish(null);
});
