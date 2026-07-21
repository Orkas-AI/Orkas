import { afterEach, describe, expect, it } from 'vitest';
import {
  withMarketplaceCacheLock,
  withMarketplaceInstallLock,
} from '../../../src/main/features/marketplace_locks';
import {
  macosTccSensitivePath,
  macosTccWorkspaceBlockedPath,
} from '../../../src/main/util/macos-tcc';

describe('platform foundations', () => {
  afterEach(() => {
    delete process.env.ORKAS_TCC_GUARD_FORCE;
  });

  it('serializes identical marketplace operations but isolates scope and item keys', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = withMarketplaceInstallLock('u', 'skill', 's', async () => {
      order.push('first:start');
      await gate;
      order.push('first:end');
    });
    const second = withMarketplaceInstallLock('u', 'skill', 's', async () => {
      order.push('second');
    });
    const independent = withMarketplaceCacheLock('u', 'skill', 's', async () => {
      order.push('cache');
    });
    await independent;
    expect(order).toEqual(['first:start', 'cache']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'cache', 'first:end', 'second']);
  });

  it.runIf(process.platform === 'darwin')('blocks protected macOS roots and recursive ancestors without prefix false positives', () => {
    process.env.ORKAS_TCC_GUARD_FORCE = '1';
    const home = process.env.HOME || '';
    expect(macosTccSensitivePath(`${home}/Documents/project`)?.reason).toBe('documents');
    expect(macosTccSensitivePath(`${home}/Doc`)?.reason).toBeUndefined();
    expect(macosTccWorkspaceBlockedPath(home)?.reason).toBe('home');
    expect(macosTccWorkspaceBlockedPath('/tmp')).toBeNull();
    expect(macosTccSensitivePath('relative/path')).toBeNull();
  });
});
