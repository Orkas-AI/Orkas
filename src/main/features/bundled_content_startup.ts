import { createLogger } from '../logger';
import { maskId } from '../util/log-redact';
import * as systemSkills from './system_skills';
import * as builtinMarketplaceStartup from './builtin_marketplace_startup';
import type { BuiltinMarketplaceSeedResult } from './builtin_marketplace';
import type { SystemSkillReconcileResult } from './system_skills';

const log = createLogger('bundled-content');

export interface SyncBundledContentOptions {
  reason: string;
  shouldContinue?: () => boolean;
  onMarketplaceChanged?: (result: BuiltinMarketplaceSeedResult) => void;
}

export interface SyncBundledContentResult {
  system_skills: SystemSkillReconcileResult[];
  marketplace: BuiltinMarketplaceSeedResult | null;
  failed: Array<'system_skills' | 'marketplace'>;
}

const inFlightByUid = new Map<string, Promise<SyncBundledContentResult>>();

function _hasMarketplaceChanges(result: BuiltinMarketplaceSeedResult | null): boolean {
  return !!result && !!(
    result.seeded_agents
    || result.seeded_skills
    || result.manifest_agents
    || result.manifest_skills
  );
}

function _canContinue(opts: SyncBundledContentOptions): boolean {
  if (!opts.shouldContinue) return true;
  try {
    return opts.shouldContinue();
  } catch (err) {
    log.warn('bundled content context check failed', {
      reason: opts.reason,
      error: (err as Error).message,
    });
    return false;
  }
}

async function _syncBundledContentForUser(
  uid: string,
  opts: SyncBundledContentOptions,
): Promise<SyncBundledContentResult> {
  const startedAt = Date.now();
  const result: SyncBundledContentResult = {
    system_skills: [],
    marketplace: null,
    failed: [],
  };

  if (!_canContinue(opts)) return result;
  try {
    // This startup boundary is fail-open. Retrying a local filesystem error
    // here would extend first-window latency; later account/startup triggers
    // can retry without making a user task wait.
    result.system_skills = await systemSkills.reconcileAllForUserWithRetry(uid, {
      retries: 0,
      reason: opts.reason,
      shouldContinue: opts.shouldContinue,
    });
    if (result.system_skills.some((row) => (
      row.action === 'failed'
      || row.action === 'invalid_manifest'
      || row.action === 'missing_source'
    ))) {
      result.failed.push('system_skills');
    }
  } catch (err) {
    result.failed.push('system_skills');
    log.warn('bundled System Skill sync failed', {
      reason: opts.reason,
      uid: maskId(uid),
      error: (err as Error).message,
    });
  }

  if (!_canContinue(opts)) return result;
  try {
    result.marketplace = await builtinMarketplaceStartup.seedBuiltinMarketplaceForUser(uid, {
      reason: opts.reason,
      shouldContinue: opts.shouldContinue,
    });
  } catch (err) {
    result.failed.push('marketplace');
    log.warn('bundled Marketplace content sync failed', {
      reason: opts.reason,
      uid: maskId(uid),
      error: (err as Error).message,
    });
  }

  log.info('bundled content sync completed', {
    reason: opts.reason,
    uid: maskId(uid),
    ms: Date.now() - startedAt,
    system_skill_changes: result.system_skills.filter((row) => (
      row.action === 'created' || row.action === 'updated' || row.action === 'deleted'
    )).length,
    seeded_agents: result.marketplace?.seeded_agents || 0,
    seeded_skills: result.marketplace?.seeded_skills || 0,
    failures: result.failed,
  });
  return result;
}

/**
 * Publish the packaged System Skills and bundled Marketplace Agents/Skills
 * for one local user. Calls for the same uid share one filesystem pass. The
 * function always resolves so this local repair boundary cannot hold the app
 * or a later user task in a failed state.
 */
export async function syncBundledContentForUser(
  uid: string,
  opts: SyncBundledContentOptions,
): Promise<SyncBundledContentResult> {
  const existing = inFlightByUid.get(uid);
  const inFlight = existing || _syncBundledContentForUser(uid, opts).finally(() => {
    if (inFlightByUid.get(uid) === inFlight) inFlightByUid.delete(uid);
  });
  if (!existing) inFlightByUid.set(uid, inFlight);

  const result = await inFlight;
  if (_hasMarketplaceChanges(result.marketplace) && opts.onMarketplaceChanged) {
    try {
      opts.onMarketplaceChanged(result.marketplace!);
    } catch (err) {
      log.warn('bundled Marketplace change notification failed', {
        reason: opts.reason,
        uid: maskId(uid),
        error: (err as Error).message,
      });
    }
  }
  return result;
}
