import * as users from './users';
import * as builtinMarketplace from './builtin_marketplace';
import * as runtimeContentPublish from './runtime_content_publish';
import { createLogger } from '../logger';
import { maskId } from '../util/log-redact';
import type { BuiltinMarketplaceSeedResult } from './builtin_marketplace';

const log = createLogger('builtin-marketplace');

const inFlightByUid = new Map<string, Promise<BuiltinMarketplaceSeedResult>>();

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

export async function seedBuiltinMarketplaceForUser(
  uid: string,
  opts: { reason: string; shouldContinue?: () => boolean },
): Promise<BuiltinMarketplaceSeedResult> {
  const existing = inFlightByUid.get(uid);
  if (existing) return existing;

  const inFlight = builtinMarketplace.seedBuiltinMarketplaceForUser(uid, {
    shouldContinue: opts.shouldContinue,
    activationGuard: (activate) => runtimeContentPublish.withIdleRuntimePublish(uid, activate),
  }).finally(() => {
    if (inFlightByUid.get(uid) === inFlight) inFlightByUid.delete(uid);
  });
  inFlightByUid.set(uid, inFlight);
  return inFlight;
}

export async function seedBuiltinMarketplaceForActiveUser(
  opts: SeedBuiltinMarketplaceForActiveUserOptions,
): Promise<BuiltinMarketplaceSeedResult | null> {
  const uid = _activeUidOrNull();
  if (!uid) {
    log.warn('skip builtin marketplace seed: no active user', { reason: opts.reason });
    return null;
  }
  const existing = inFlightByUid.get(uid);
  if (existing) return existing;

  const shouldContinue = (): boolean => {
    if (opts.shouldContinue && !opts.shouldContinue()) return false;
    return _activeUidOrNull() === uid;
  };

  return (async () => {
    const result = await seedBuiltinMarketplaceForUser(uid, {
      reason: opts.reason,
      shouldContinue,
    });
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
  });
}
