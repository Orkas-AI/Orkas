import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function loadMarketplaceRenderer(): any {
  const userErrorCode = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/user-error.js'),
    'utf8',
  );
  const code = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/marketplace.js'),
    'utf8',
  );
  const storage = new Map<string, string>();
  const monitorErrors: Array<{ action: string; data: Record<string, unknown> }> = [];
  const monitor = {
    error: (action: string, data: Record<string, unknown>) => { monitorErrors.push({ action, data }); },
  };
  const context: any = {
    console,
    clearTimeout: () => {},
    setTimeout: () => 0,
    localStorage: {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    },
    document: {
      hidden: false,
      addEventListener: () => {},
      getElementById: () => null,
      querySelectorAll: () => [],
    },
    window: {
      addEventListener: () => {},
      orkas: {
        invoke: async () => ({ list: [] }),
      },
      Monitor: monitor,
    },
    Monitor: monitor,
    _monitorErrors: monitorErrors,
    t: (key: string) => ({
      'marketplace.install_failed': 'Install failed: {reason}',
      'marketplace.install_failed_resource': 'Install failed: {kind}: {name}. {reason}',
      'marketplace.action_failed_retry_later': 'Marketplace is temporarily unavailable. Please try again later.',
      'marketplace.app_update_required': 'Requires Orkas {minimum} or newer (current {current}). Update Orkas, then install.',
      'marketplace.requires_app': 'Needs Orkas {version}+',
      'marketplace_request.kind_agent': 'Agent',
      'marketplace_request.kind_skill': 'Skill',
    } as Record<string, string>)[key] || key,
  };
  vm.createContext(context);
  vm.runInContext(userErrorCode, context, { filename: 'user-error.js' });
  vm.runInContext(code, context, { filename: 'marketplace.js' });
  return context;
}

describe('marketplace install error display', () => {
  it('hides the dev review status filter and clears any selected status', () => {
    const ctx = loadMarketplaceRenderer();
    ctx.isDevMode = () => true;
    vm.runInContext('_mpState = { status: "approved" }', ctx);
    const host = { style: {} as Record<string, string> };
    const panel = {
      querySelector: (selector: string) => (
        selector === '.marketplace-status-filter' ? host : null
      ),
    };

    ctx._mpRenderStatusSelect(panel);

    expect(ctx._mpShowReviewStatusUi()).toBe(false);
    expect(host.style.display).toBe('none');
    expect(vm.runInContext('_mpState.status', ctx)).toBe('');
  });

  it('uses the dependency skill name instead of the agent name for cascade failures', () => {
    const ctx = loadMarketplaceRenderer();
    const text = ctx._mpInstallFailedText(
      'agent',
      { id: 'agent-1', name: 'ResearchTutor' },
      {
        marketplaceKind: 'skill',
        marketplaceId: 'stale-skill-id',
        marketplaceName: 'missing-friendly-skill',
        marketplaceReason: 'not_found',
      },
    );

    expect(text).toBe('Install failed: Skill: missing-friendly-skill. not_found');
    expect(text).not.toContain('Skill: ResearchTutor');
    expect(text).not.toContain('stale-skill-id');
  });

  it('shows a localized update prompt for a min-app-version block, not a raw string', () => {
    const ctx = loadMarketplaceRenderer();
    const text = ctx._mpInstallFailedText(
      'agent',
      { id: 'agent-1', name: 'VideoStudio' },
      {
        marketplaceKind: 'agent',
        marketplaceAppUpdateRequired: true,
        marketplaceMinAppVersion: '1.6.0',
        marketplaceCurrentAppVersion: '1.5.1',
        message: 'requires Orkas >= 1.6.0; current 1.5.1',
      },
    );

    expect(text).toBe(
      'Install failed: Agent: VideoStudio. Requires Orkas 1.6.0 or newer (current 1.5.1). Update Orkas, then install.',
    );
    expect(text).not.toContain('requires Orkas >= 1.6.0');
  });

  it('gates the install button by client app version', () => {
    const ctx = loadMarketplaceRenderer();
    expect(ctx._mpCompareVersions('1.5.1', '1.6.0')).toBeLessThan(0);
    expect(ctx._mpCompareVersions('1.6.0', '1.6.0')).toBe(0);
    expect(ctx._mpCompareVersions('1.7.0', '1.6.0')).toBeGreaterThan(0);

    vm.runInContext('_mpState = { appVersion: "1.5.1" }', ctx);
    expect(ctx._mpItemAppCompatible({ min_app_version: '1.6.0' })).toBe(false);
    expect(ctx._mpItemAppCompatible({ min_app_version: '1.5.0' })).toBe(true);
    expect(ctx._mpItemAppCompatible({ min_app_version: '' })).toBe(true);

    vm.runInContext('_mpState = { appVersion: "" }', ctx);
    expect(ctx._mpItemAppCompatible({ min_app_version: '1.6.0' })).toBe(true);
  });

  it('maps transport failures to user-facing marketplace copy', () => {
    const ctx = loadMarketplaceRenderer();
    const text = ctx._mpInstallFailedText(
      'agent',
      { id: 'agent-1', name: 'ResearchTutor' },
      {
        message: 'marketplace:/marketplace/agents/detail timed out after 60s',
        code: ctx.window.USER_ERROR_CODE.NETWORK_TIMEOUT,
      },
    );

    expect(text).toBe('Install failed: Agent: ResearchTutor. Marketplace is temporarily unavailable. Please try again later.');
    expect(text).not.toContain('marketplace:/marketplace/agents/detail');
    expect(text).not.toContain('timed out after 60s');
  });

  it('does not send missing dependency skill telemetry in the open build', () => {
    const ctx = loadMarketplaceRenderer();
    ctx._mpTrackInstallFailure('agent', { id: 'agent-1', name: 'ResearchTutor' }, {
      marketplaceKind: 'skill',
      marketplaceId: 'stale-skill-id',
      marketplaceName: 'missing-friendly-skill',
      marketplaceReason: 'not_found',
    });

    expect(ctx._monitorErrors).toEqual([]);
  });

  it('does not report non-missing dependency failures as missing skills', () => {
    const ctx = loadMarketplaceRenderer();
    ctx._mpTrackInstallFailure('agent', { id: 'agent-1', name: 'ResearchTutor' }, {
      marketplaceKind: 'skill',
      marketplaceId: 'dep-skill',
      marketplaceName: 'draft-skill',
      marketplaceReason: 'status_not_approved:reviewing',
    });

    expect(ctx._monitorErrors).toEqual([]);
  });
});
