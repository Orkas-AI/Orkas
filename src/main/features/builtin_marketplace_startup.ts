import * as users from './users';
import * as builtinMarketplace from './builtin_marketplace';
import { createLogger } from '../logger';
import { maskId } from '../util/log-redact';
import type { BuiltinMarketplaceSeedResult } from './builtin_marketplace';

const log = createLogger('builtin-marketplace');

let inFlightUid = '';
let inFlight: Promise<BuiltinMarketplaceSeedResult | null> | null = null;

export interface SeedBuiltinMarketplaceForActiveUserOptions {
  reason: string;
  shouldContinue?: () => boolean;
  onChanged?: (result: BuiltinMarketplaceSeedResult) => void;
}

function _hasSeedChanges(result: BuiltinMarketplaceSeedResult): boolean {
  return !!(
    result.seeded_agents
    || result.seeded_skills
    || result.manifest_agents
    || result.manifest_skills
  );
}

function _activeUidOrNull(): string | null {
  try {
    return users.getActiveUserId();
  } catch {
    return null;
  }
}

export async function seedBuiltinMarketplaceForActiveUser(
  opts: SeedBuiltinMarketplaceForActiveUserOptions,
): Promise<BuiltinMarketplaceSeedResult | null> {
  const uid = _activeUidOrNull();
  if (!uid) {
    log.warn('skip builtin marketplace seed: no active user', { reason: opts.reason });
    return null;
  }

  if (inFlight && inFlightUid === uid) return inFlight;

  const shouldContinue = (): boolean => {
    if (opts.shouldContinue && !opts.shouldContinue()) return false;
    return _activeUidOrNull() === uid;
  };

  inFlightUid = uid;
  inFlight = (async () => {
    const result = await builtinMarketplace.seedBuiltinMarketplaceForUser(uid, { shouldContinue });
    if (_hasSeedChanges(result)) {
      log.info('seeded builtin marketplace for active user', {
        reason: opts.reason,
        uid: maskId(uid),
        ...result,
      });
      opts.onChanged?.(result);
    }
    return result;
  })().catch((err) => {
    log.warn('builtin marketplace seed for active user failed', {
      reason: opts.reason,
      uid: maskId(uid),
      error: (err as Error).message,
    });
    return null;
  }).finally(() => {
    if (inFlightUid === uid) {
      inFlightUid = '';
      inFlight = null;
    }
  });

  return inFlight;
}
