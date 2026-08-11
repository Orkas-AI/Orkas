import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const marketplaceSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/marketplace.js'),
  'utf8',
);

function loadMarketplaceRenderer(): any {
  const userErrorCode = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/user-error.js'),
    'utf8',
  );
  const semverCode = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/semver.js'),
    'utf8',
  );
  const storage = new Map<string, string>();
  const monitorEvents: Array<{ action: string; data: Record<string, unknown> }> = [];
  const monitor = {
    event: (action: string, data: Record<string, unknown>) => { monitorEvents.push({ action, data }); },
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
    _monitorEvents: monitorEvents,
    t: (key: string) => ({
      'marketplace.install_failed': 'Install failed: {reason}',
      'marketplace.install_failed_resource': 'Install failed: {kind}: {name}. {reason}',
      'marketplace.action_failed_retry_later': 'Marketplace is temporarily unavailable. Please try again later.',
      'marketplace.app_update_required': 'Requires Orkas {minimum} or newer (current {current}). Update Orkas, then install.',
      'marketplace.account_changed': 'The active account changed. Reopen Marketplace and try again.',
      'marketplace.requires_app': 'Needs Orkas {version}+',
      'marketplace.version': 'v{version}',
      'marketplace.install': 'Install',
      'marketplace.installing': 'Installing',
      'marketplace.update': 'Update',
      'marketplace.updating': 'Updating',
      'marketplace.installed': 'Installed',
      'marketplace_request.kind_agent': 'Agent',
      'marketplace_request.kind_skill': 'Skill',
    } as Record<string, string>)[key] || key,
  };
  vm.createContext(context);
  vm.runInContext(semverCode, context, { filename: 'semver.js' });
  vm.runInContext(userErrorCode, context, { filename: 'user-error.js' });
  vm.runInContext(marketplaceSource, context, { filename: 'marketplace.js' });
  return context;
}

describe('marketplace install error display', () => {
  it('keeps the origin tab selected and returns directly to New Task for nested marketplace entry', () => {
    const ctx = loadMarketplaceRenderer();
    const selected = new Set<string>();
    const newTaskButton = {
      classList: { add: (name: string) => selected.add(name) },
    };
    const panel = {
      classList: { contains: (name: string) => name === 'active' },
      querySelector: () => null,
    };
    ctx.document.getElementById = (id: string) => {
      if (id === 'panel-marketplace') return panel;
      if (id === 'new-chat-btn') return newTaskButton;
      return null;
    };
    const views: string[] = [];
    ctx.currentView = 'new-chat';
    ctx.setView = (view: string) => views.push(view);
    vm.runInContext(`
      _mpInitReconcileWatch = () => {};
      _mpBindPanel = () => {};
      _mpShowGridView = () => {};
      _mpRender = () => {};
      _mpLoadAll = () => Promise.resolve();
      _mpLoadOss = () => Promise.resolve();
    `, ctx);

    ctx.openMarketplace('oss', { returnView: 'new-chat', preserveReturnTab: true });
    ctx.closeMarketplace();

    expect(selected.has('active')).toBe(true);
    expect(views).toEqual(['marketplace', 'new-chat']);
  });

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

    // A declared minimum fails closed until the PC provides its current version.
    vm.runInContext('_mpState = { appVersion: "" }', ctx);
    expect(ctx._mpItemAppCompatible({ kind: 'agent', min_app_version: '1.6.0' })).toBe(false);
    expect(ctx._mpItemAppCompatible({ kind: 'skill', min_app_version: '1.6.0' })).toBe(false);
    expect(ctx._mpItemAppCompatible({ min_app_version: '' })).toBe(true);
  });

  it('offers a marketplace update only for a strictly higher resource version', () => {
    const ctx = loadMarketplaceRenderer();
    const local = { version: '1.2.0', published_at: 100, updated_at: 100 };

    expect(ctx._mpMarketplaceItemIsNewer({
      version: '1.2.1', published_at: 50, updated_at: 50,
    }, local)).toBe(true);
    expect(ctx._mpMarketplaceItemIsNewer({
      version: '1.2.0', published_at: 200, updated_at: 200,
    }, local)).toBe(false);
    expect(ctx._mpMarketplaceItemIsNewer({
      version: '1.1.9', published_at: 300, updated_at: 300,
    }, local)).toBe(false);
  });

  it('disables an installed update when the remote resource requires a newer app', () => {
    const ctx = loadMarketplaceRenderer();
    ctx.escapeHtml = (value: unknown) => String(value ?? '');
    ctx.pickDesc = () => '';
    ctx.renderAvatarHtml = () => '';
    ctx.testState = {
      tab: 'agent',
      appVersion: '1.6.2',
      installing: new Set(),
      installedAgentIds: new Set(['content-writer']),
      installedAgentMeta: new Map([['content-writer', { version: '1.0.23' }]]),
      installedSkillIds: new Set(),
      installedSkillMeta: new Map(),
    };
    vm.runInContext('_mpState = testState', ctx);

    const html = ctx._mpCardHtml({
      id: 'content-writer',
      name: 'ContentWriter',
      version: '1.0.24',
      min_app_version: '1.7.0',
    }, 'en');

    expect(html).toContain('Needs Orkas 1.7.0+');
    expect(html).toContain('disabled');
    expect(html).not.toContain('>Update</button>');
  });

  it('keeps an installed resource manageable when no update is available', () => {
    const ctx = loadMarketplaceRenderer();
    ctx.escapeHtml = (value: unknown) => String(value ?? '');
    ctx.pickDesc = () => '';
    ctx.renderAvatarHtml = () => '';
    ctx.testState = {
      tab: 'agent',
      appVersion: '1.6.2',
      installing: new Set(),
      installedAgentIds: new Set(['content-writer']),
      installedAgentMeta: new Map([['content-writer', { version: '1.0.24' }]]),
      installedSkillIds: new Set(),
      installedSkillMeta: new Map(),
    };
    vm.runInContext('_mpState = testState', ctx);

    const html = ctx._mpCardHtml({
      id: 'content-writer',
      name: 'ContentWriter',
      version: '1.0.24',
      min_app_version: '1.7.0',
    }, 'en');

    expect(html).toContain('>Installed</button>');
    expect(html).not.toContain('Needs Orkas 1.7.0+');
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

  it('does not expose missing dependency skill telemetry in the open build', () => {
    const ctx = loadMarketplaceRenderer();

    expect(ctx._mpTrackInstallFailure).toBeUndefined();
    expect(ctx._monitorEvents).toEqual([]);
  });

  it('does not promote raw failure text into the error-code dimension', () => {
    const ctx = loadMarketplaceRenderer();
    expect(ctx._mpActionErrorCode({
      message: 'failed to install /Users/test/secret-skill for alice@example.test',
    })).toBe('operation_failed');
    expect(ctx._mpActionErrorCode({
      marketplaceReason: 'new_dynamic_backend_code',
    })).toBe('operation_failed');
    expect(ctx._mpActionErrorCode({
      marketplaceReason: 'requires Orkas >= 1.7.0',
      marketplaceAppUpdateRequired: true,
    })).toBe('app_update_required');
  });

  it('uses persistence as the success boundary and keeps refresh presentation-only', () => {
    const installStart = marketplaceSource.indexOf('async function _mpInstall(');
    const uninstallStart = marketplaceSource.indexOf('async function _mpUninstall(');
    const normalInstall = marketplaceSource.indexOf('const installed = await invokeInstall(false);', installStart);
    const normalSuccess = marketplaceSource.indexOf("trackResult('success');", normalInstall);
    const normalState = marketplaceSource.indexOf('_mpApplyInstalledState(kind, item, installed);', normalInstall);
    const normalRefresh = marketplaceSource.indexOf('await _mpRefreshAfterAction(kind);', normalInstall);
    const uninstallInvoke = marketplaceSource.indexOf("window.orkas.invoke(channel, { id })", uninstallStart);
    const uninstallSuccess = marketplaceSource.indexOf("trackResult('success');", uninstallInvoke);
    const uninstallState = marketplaceSource.indexOf('_mpApplyUninstalledState(kind, id);', uninstallInvoke);
    const uninstallRefresh = marketplaceSource.indexOf('await _mpRefreshAfterAction(kind);', uninstallInvoke);

    expect(normalInstall).toBeGreaterThan(installStart);
    expect(normalInstall).toBeLessThan(normalSuccess);
    expect(normalSuccess).toBeLessThan(normalState);
    expect(normalSuccess).toBeLessThan(normalRefresh);
    expect(uninstallInvoke).toBeGreaterThan(uninstallStart);
    expect(uninstallInvoke).toBeLessThan(uninstallSuccess);
    expect(uninstallSuccess).toBeLessThan(uninstallState);
    expect(uninstallSuccess).toBeLessThan(uninstallRefresh);
  });

});
