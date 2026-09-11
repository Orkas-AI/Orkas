import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(__dirname, '../../src/renderer');

describe('external CLI Agent detail layout', () => {
  it('calculates success rate from completed runs and explicit execution errors only', () => {
    const source = fs.readFileSync(path.join(rendererRoot, 'modules/agents.js'), 'utf8');
    const match = source.match(/function _agentExecutionSuccessRate\(runtime\) \{[\s\S]*?\n\}/);
    expect(match).not.toBeNull();
    const successRate = vm.runInNewContext(`(${match?.[0]})`) as (runtime: Record<string, number>) => number;

    expect(successRate({
      attempts: 100,
      successes: 8,
      executionFailures: 2,
      failures: 70,
      errors: 20,
    })).toBe(80);
    expect(successRate({
      attempts: 12,
      successes: 0,
      executionFailures: 0,
      failures: 5,
      errors: 7,
    })).toBe(0);
  });

  it('keeps the requested detail-section order', () => {
    const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
    const sectionIds = [
      'agents-detail-intro-section',
      'agents-detail-stats-section',
      'agents-detail-runtime-section',
      'agents-detail-cli-settings-section',
      'agents-detail-project-dir-section',
    ];
    const positions = sectionIds.map(id => html.indexOf(`id="${id}"`));

    expect(positions.every(position => position > 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('shows only the controls on a healthy CLI runtime section', () => {
    const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
    const source = fs.readFileSync(path.join(rendererRoot, 'modules/agents.js'), 'utf8');
    const start = source.indexOf('async function _renderAgentDetailCliSettings');
    const end = source.indexOf('async function _renderAgentDetailProjectDir', start);
    const settings = source.slice(start, end);

    expect(html).not.toContain('data-i18n="agents.cli_settings_desc"');
    expect(settings).not.toContain("t('agents.cli_settings_scope')");
    expect(settings).toContain("const statusNote = info.status === 'ready'");
    expect(settings).toContain("info.status === 'partial'");
  });

  it('renders cached options immediately and refreshes once when detail is entered', () => {
    const source = fs.readFileSync(path.join(rendererRoot, 'modules/agents.js'), 'utf8');
    const enterStart = source.indexOf('async function _showAgentsDetailView');
    const enterEnd = source.indexOf('async function refreshSelectedAgentDetail', enterStart);
    const settingsStart = source.indexOf('async function _renderAgentDetailCliSettings');
    const settingsEnd = source.indexOf('async function _renderAgentDetailProjectDir', settingsStart);
    const settings = source.slice(settingsStart, settingsEnd);

    expect(source.slice(enterStart, enterEnd)).toContain(
      'selectAgent(agentId, { refreshCliOptions: true })',
    );
    expect(settings).toContain('_agentCliRuntimeOptionsCache.get(cacheKey)');
    expect(settings).toContain("_loadAgentCliRuntimeOptions(agent, { force: true })");
    expect(settings).toContain('if (!cachedInfo)');
    expect(settings).toContain("slot.innerHTML = `<div class=\"agents-detail-cli-loading\"");
  });

  it('shows the bound external CLI before asynchronous discovery completes', () => {
    const source = fs.readFileSync(path.join(rendererRoot, 'modules/agents.js'), 'utf8');
    const start = source.indexOf('async function _renderAgentDetailRuntime');
    const end = source.indexOf('function _agentCliRuntimeOptionsKey', start);
    const runtime = source.slice(start, end);
    const reveal = runtime.indexOf("section.style.display = ''");
    const initialMount = runtime.indexOf('_aiSelectMount(pendingMount');
    const discovery = runtime.indexOf('await loadLocalCliEntries()');

    expect(reveal).toBeGreaterThan(-1);
    expect(initialMount).toBeGreaterThan(reveal);
    expect(initialMount).toBeLessThan(discovery);
    expect(runtime).toContain("pendingTrigger.setAttribute('aria-busy', 'true')");
    expect(runtime).toContain('slot.dataset.runtimeKey !== runtimeKey');
  });

  it('ships concise runtime labels and the permission control', () => {
    const labels = {
      en: { section: 'Runtime settings', defaultOption: 'Default', aliasLatest: 'latest', permissionPath: 'AI Team >' },
      zh: { section: '运行设置', defaultOption: '默认', aliasLatest: '最新版', permissionPath: 'AI 团队 >' },
      ja: { section: '実行設定', defaultOption: 'デフォルト', aliasLatest: '最新版', permissionPath: 'AI チーム >' },
      pt: { section: 'Configurações de execução', defaultOption: 'Padrão', aliasLatest: 'mais recente', permissionPath: 'Equipe de IA >' },
    };

    for (const [locale, copy] of Object.entries(labels)) {
      const table = JSON.parse(
        fs.readFileSync(path.join(rendererRoot, `locales/${locale}.json`), 'utf8'),
      );
      expect(table['agents.label_cli_settings']).toBe(copy.section);
      expect(table['agents.cli_default']).toBe(copy.defaultOption);
      expect(table['agents.cli_model_alias_latest']).toBe(copy.aliasLatest);
      expect(table['agents.cli_model_alias_hint']).toBeTruthy();
      expect(table['agents.cli_model_recent']).toContain('{model}');
      expect(table['agents.cli_current_default']).toBeUndefined();
      expect(table['agents.cli_default_model_hint']).toBeUndefined();
      expect(table['agents.cli_default_thinking_hint']).toBeUndefined();
      expect(table['agents.cli_settings_desc']).toBeUndefined();
      expect(table['agents.cli_settings_scope']).toBeUndefined();
      expect(table['agents.cli_settings_loading']).toBeTruthy();
      expect(table['agents.cli_settings_unavailable']).toBeTruthy();
      expect(table['agents.cli_settings_partial']).toBeTruthy();
      expect(table['agents.cli_thinking_unsupported']).toBeTruthy();
      expect(table['agents.cli_permission']).toBeTruthy();
      expect(table['agents.cli_permission_inherit']).toBeTruthy();
      expect(table['agents.cli_permission_ask']).toBeTruthy();
      expect(table['agents.cli_permission_full_access']).toBeTruthy();
      expect(table['agents.cli_permission_full_access_warning']).toBeTruthy();
      expect(table['agents.cli_permission_mode_hint']).toContain('{agent}');
      expect(table['agents.cli_permission_mode_hint']).toContain(copy.permissionPath);
      expect(table['agents.cli_permission_prompt_title']).toBeTruthy();
    }

    const source = fs.readFileSync(path.join(rendererRoot, 'modules/agents.js'), 'utf8');
    const start = source.indexOf('async function _renderAgentDetailCliSettings');
    const end = source.indexOf('async function _renderAgentDetailProjectDir', start);
    const settings = source.slice(start, end);
    expect(settings).toContain("value: isDefault ? '' : id");
    expect(settings).toContain("hint: isDefault ? t('agents.cli_default') : ''");
    expect(settings).toContain("if (!modelOptions.some(option => option.value === ''))");
    // The inherit-default row names the model that choice runs today when the
    // CLI reports it, instead of a bare "Default" the user cannot act on.
    expect(settings).toContain("const resolvedDefault = String(info.default_model_resolved || '').trim()");
    expect(settings).toContain("? `${t('agents.cli_default')} · ${resolvedDefault}`");
    expect(settings).toContain("if (!thinkingOptions.some(option => option.value === ''))");
    expect(settings).toContain("thinkingOptions.unshift({ value: '', label: t('agents.cli_default') })");
    expect(settings).toContain('data-role="permission"');
    expect(settings).toContain("const hidePermissionControl = String(info.fixed_permission_policy || '') === 'full_access'");
    expect(settings).toContain("${hidePermissionControl ? '' : `<div class=\"agents-detail-cli-field\">");
    expect(settings).toContain('if (!hidePermissionControl)');
    expect(settings).toContain("await saveRuntime({ permission_policy: next })");
    expect(settings).toContain("next === 'full_access'");
    expect(settings).not.toContain('cli_current_default');
    expect(settings).not.toContain('cli_default_model_hint');
    expect(settings).not.toContain('cli_default_thinking_hint');
    // A model the CLI says takes no thinking level offers none, and stays
    // editable only while a value saved for another model is still set.
    expect(settings).toContain('const thinkingUnsupported = activeModel?.supports_thinking === false');
    expect(settings).toContain("thinkingOptions.push({ value: '', label: t('agents.cli_thinking_unsupported') })");
    expect(settings).toContain('(!info.can_select_thinking || thinkingUnsupported) && !currentThinking');
    expect(settings).toContain('_mergeAgentIntoCache(saved.agent)');
    expect(settings).not.toContain('_agentsCache = null');
  });
});
