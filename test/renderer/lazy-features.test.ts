import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function loadFeatureLoader(onAppend?: (script: any, context: any) => void) {
  const appended: any[] = [];
  const telemetry = {
    events: [] as Array<{ action: string; data: Record<string, unknown> }>,
    errors: [] as Array<{ action: string; data: Record<string, unknown> }>,
  };
  const context: any = {
    Map,
    Promise,
    Error,
    Object,
    String,
    window: {
      Monitor: {
        event(action: string, data: Record<string, unknown>) {
          telemetry.events.push({ action, data });
        },
        error(action: string, data: Record<string, unknown>) {
          telemetry.errors.push({ action, data });
        },
      },
    },
    document: {
      createElement: () => ({ dataset: {} }),
      head: {
        appendChild(script: any) {
          appended.push(script);
          if (onAppend) onAppend(script, context);
          else script.onload();
        },
      },
      documentElement: { appendChild() {} },
    },
  };
  context.window.window = context.window;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/lazy-features.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'lazy-features.js' });
  return { context, appended, telemetry };
}

describe('renderer lazy feature loader', () => {
  it('loads the Settings bundle in declared classic-script order and shares concurrent work', async () => {
    const { context, appended, telemetry } = loadFeatureLoader();

    const first = context.loadRendererFeature('settings');
    const second = context.loadRendererFeature('settings');
    expect(second).toBe(first);
    await first;

    expect(appended.map((script) => script.src)).toEqual([
      './modules/settings.js',
      './modules/memory.js',
    ]);
    expect(appended.every((script) => script.async === false)).toBe(true);
    expect(telemetry.events).toEqual([]);
    expect(telemetry.errors).toEqual([]);
  });

  it('does not fail marketplace loading when the optional dev enhancer is absent', async () => {
    const { context, appended, telemetry } = loadFeatureLoader((script) => {
      if (script.src.endsWith('marketplace_dev.js')) script.onerror();
      else script.onload();
    });

    await expect(context.loadRendererFeature('marketplace')).resolves.toBeUndefined();
    expect(appended.map((script) => script.src)).toEqual([
      './modules/semver.js',
      './modules/marketplace.js',
    ]);
    expect(telemetry.events).toEqual([]);
    expect(telemetry.errors).toEqual([]);
  });

  it('loads public Agent and Skill surfaces without private publishing modules', async () => {
    const agents = loadFeatureLoader();
    await agents.context.loadRendererFeature('agents');
    expect(agents.appended.map((script) => script.src)).toEqual([
      './modules/semver.js',
      './modules/marketplace.js',
    ]);

    const skills = loadFeatureLoader();
    await skills.context.loadRendererFeature('skills');
    expect(skills.appended.map((script) => script.src)).toEqual([
      './modules/semver.js',
      './modules/marketplace.js',
      './modules/skills.js',
      './modules/skills-bindings.js',
    ]);
  });

  it('keeps direct Agent and Skill entry working in the open-source build', async () => {
    const agents = loadFeatureLoader();
    await expect(agents.context.loadRendererFeature('agents')).resolves.toBeUndefined();

    const skills = loadFeatureLoader();
    await expect(skills.context.loadRendererFeature('skills')).resolves.toBeUndefined();
  });

  it('retries a required script while reusing scripts that already loaded', async () => {
    let contextAttempts = 0;
    const { context, appended, telemetry } = loadFeatureLoader((script) => {
      if (script.src.endsWith('contexts.js') && contextAttempts++ === 0) script.onerror();
      else script.onload();
    });

    await expect(context.loadRendererFeature('contexts')).rejects.toThrow('contexts.js');
    await expect(context.loadRendererFeature('contexts')).resolves.toBeUndefined();
    expect(appended.map((script) => script.src)).toEqual([
      './modules/library-transfer.js',
      './modules/contexts.js',
      './modules/contexts.js',
      './modules/kb-picker.js',
    ]);
    expect(telemetry.events).toEqual([]);
    expect(telemetry.errors).toEqual([]);
  });

  it('collapses unknown feature names before reporting a bounded failure', async () => {
    const { context, telemetry } = loadFeatureLoader();

    await expect(context.loadRendererFeature('private-feature-name')).rejects.toThrow('unknown renderer feature');

    expect(telemetry.events).toEqual([]);
    expect(telemetry.errors).toEqual([]);
  });

  it('keeps tab-only project, Library, apps, and devtools scripts out of the eager HTML', async () => {
    const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
    for (const script of [
      'library-transfer.js',
      'project-detail.js',
      'contexts.js',
      'kb-picker.js',
      'saved-apps.js',
      'skills.js',
      'auto.js',
    ]) {
      expect(html).not.toContain(`<script src="./modules/${script}"></script>`);
    }

    const { context, appended } = loadFeatureLoader();
    await context.loadRendererFeature('contexts');
    expect(appended.map((script) => script.src)).toEqual([
      './modules/library-transfer.js',
      './modules/contexts.js',
      './modules/kb-picker.js',
    ]);
  });

  it('keeps automation out of the base project entry and loads it on demand', async () => {
    const { context, appended } = loadFeatureLoader();
    await context.loadRendererFeature('project');
    expect(appended.map((script) => script.src)).toEqual([
      './modules/library-transfer.js',
      './modules/project-detail.js',
    ]);

    await context.loadRendererFeature('auto');

    expect(appended.map((script) => script.src)).toEqual([
      './modules/library-transfer.js',
      './modules/project-detail.js',
      './modules/auto.js',
    ]);
  });

  it('opens the recipient picker before loading tab-specific catalogs', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/agents.js'), 'utf8');
    const start = source.indexOf('async function _openAgentPicker');
    const end = source.indexOf('\nfunction _closeAgentPicker', start);
    const openBody = source.slice(start, end);
    const tabLoaderStart = source.indexOf('function _ensureAgentPickerTabData');
    const tabLoaderEnd = source.indexOf('\nfunction _moveAgentPickerTab', tabLoaderStart);
    const tabLoader = source.slice(tabLoaderStart, tabLoaderEnd);

    expect(openBody).toContain("_setAgentPickerTab('agents'");
    expect(openBody).toContain('_positionPopoverAboveOrBelow(picker, anchorBtn)');
    expect(openBody.indexOf('_refreshAgentPickerProjectContext(anchorBtn.id)')).toBeLessThan(
      openBody.indexOf("_setAgentPickerTab('agents'"),
    );
    expect(openBody).not.toContain("featureLoader('skills')");
    expect(openBody).not.toContain('loadSkills(true)');
    expect(openBody).not.toContain('loadConnectors()');
    expect(tabLoader).toContain("normalized === 'skills'");
    expect(tabLoader).toContain("await loader('skills')");
    expect(tabLoader).toContain('await loadSkills(false)');
    expect(tabLoader).toContain("normalized === 'connectors'");
    expect(tabLoader).toContain('const joined = existing.then');
    expect(source).toContain('let _pickerProjectContextSeq = 0');
    expect(source).toContain('refreshSeq === _pickerProjectContextSeq');
  });

  it('shows a retryable error instead of leaving a failed lazy view blank', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/boot.js'), 'utf8');
    const start = source.indexOf('function _loadViewFeature');
    const end = source.indexOf('\nfunction _restoreLastView', start);
    const lazyBoundary = source.slice(start, end);

    expect(lazyBoundary).toContain('_showLazyFeatureError(feature, view, err, run)');
    expect(lazyBoundary).toContain("banner.className = 'lazy-feature-error'");
    expect(lazyBoundary).toContain("t('chat.retry_btn')");
    expect(lazyBoundary).toContain('_loadViewFeature(feature, view, run)');
  });

  it('bridges the first Skills create click while its lazy bindings load', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/state.js'), 'utf8');
    const start = source.indexOf("document.getElementById('create-skill-btn')");
    const end = source.indexOf("document.getElementById('agents-more-btn')", start);
    const handler = source.slice(start, end);

    expect(handler).toContain("load('skills')");
    expect(handler).toContain("typeof openSkillModal === 'function'");
    expect(handler).toContain("currentView !== 'skills'");
    expect(handler).toContain('openSkillModal()');
  });

  it('primes the cached project shell before deferring the project feature', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/boot.js'), 'utf8');
    const projectBranch = source.slice(source.indexOf("} else if (view === 'project')"));

    expect(projectBranch.indexOf('primeProjectDetailShell')).toBeGreaterThanOrEqual(0);
    expect(projectBranch.indexOf('primeProjectDetailShell')).toBeLessThan(
      projectBranch.indexOf("_deferSidebarNavWork('project-tab-load'"),
    );
  });

  it('upgrades the Agent startup summary once without force-refreshing every tab visit', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/boot.js'), 'utf8');
    const start = source.indexOf("} else if (view === 'agents')");
    const end = source.indexOf("} else if (view === 'skills')", start);
    const branch = source.slice(start, end);

    expect(branch).toContain("_loadViewFeature('agents', 'agents'");
    expect(branch.indexOf("_loadViewFeature('agents', 'agents'")).toBeLessThan(
      branch.indexOf('renderAgentsList(_agentsCache)'),
    );
    expect(branch).toContain('const needsFullListing');
    expect(branch).toContain('loadAgents(false)');
    expect(branch).not.toContain('loadAgents(forceRefresh)');
  });

  it('opens one Agent detail without refreshing the complete Agent list first', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/agents.js'), 'utf8');
    const start = source.indexOf('async function _showAgentsDetailView');
    const end = source.indexOf('async function refreshSelectedAgentDetail', start);
    const detailOpen = source.slice(start, end);

    expect(detailOpen).toContain('await selectAgent(agentId, { refreshCliOptions: true })');
    expect(detailOpen).not.toContain('loadAgents(true)');
  });

  it('does not probe local CLI runtimes until the External selector is opened', () => {
    const localAgents = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/local-agents.js'), 'utf8');
    const agents = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/agents.js'), 'utf8');
    const switchStart = agents.indexOf('function _switchAgentTab');
    const switchEnd = agents.indexOf('window._switchAgentTab', switchStart);
    const openStart = agents.indexOf('function openAgentModal');
    const openEnd = agents.indexOf('window.openAgentModal', openStart);

    expect(localAgents).not.toContain('setTimeout(() => { loadLocalCliEntries');
    expect(localAgents).toContain('async function mountExternalCliSelect');
    expect(localAgents).toContain('_findInstalledLocalCliEntries()');
    expect(localAgents).toContain('_validateInstalledLocalCliEntries(');
    expect(localAgents).toContain("window.orkas.invoke('localAgents.detect', { type })");
    expect(localAgents).not.toContain('LOCAL_CLI_RENDERER_CACHE_TTL_MS');
    expect(agents.slice(switchStart, switchEnd)).toContain("if (tab === 'external'");
    expect(agents.slice(switchStart, switchEnd)).toContain('mountExternalCliSelect');
    expect(agents.slice(openStart, openEnd)).not.toContain('mountExternalCliSelect');
  });

  it('shares cached local CLI discovery with an Agent detail selector', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/agents.js'), 'utf8');
    const start = source.indexOf('async function _renderAgentDetailRuntime');
    const end = source.indexOf('async function _renderAgentDetailCliSettings', start);
    const runtimeSelector = source.slice(start, end);

    expect(runtimeSelector).toContain('loadLocalCliEntries()');
    expect(runtimeSelector).not.toContain('loadLocalCliEntries({ force: true })');
    expect(runtimeSelector).toContain('const currentEntry = entries.find');
    expect(runtimeSelector).toContain('window.getLocalCliUnavailableHint(currentEntry)');
    expect(runtimeSelector).not.toContain("hint: t('agent.cli_missing')");
  });

  it('loads Agent-scoped CLI model and thinking settings from main IPC', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/agents.js'), 'utf8');
    const start = source.indexOf('function _loadAgentCliRuntimeOptions');
    const end = source.indexOf('async function _renderAgentDetailProjectDir', start);
    const settings = source.slice(start, end);

    expect(settings).toContain("window.orkas.invoke('localAgents.runtimeOptions'");
    expect(settings).toContain('model_override');
    expect(settings).toContain('thinking_level');
    expect(settings).toContain('updates: { runtime: nextRuntime }');
  });

});
