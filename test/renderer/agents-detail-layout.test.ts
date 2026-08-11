import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(__dirname, '../../src/renderer');

describe('external CLI Agent detail layout', () => {
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

  it('shows only the controls on a healthy model-selection section', () => {
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

  it('ships the concise model-selection label without retired explanatory copy', () => {
    const labels = {
      en: { section: 'Model selection', defaultOption: 'Default', aliasLatest: 'latest' },
      zh: { section: '模型选择', defaultOption: '默认', aliasLatest: '最新版' },
      ja: { section: 'モデル選択', defaultOption: 'デフォルト', aliasLatest: '最新版' },
      pt: { section: 'Seleção de modelo', defaultOption: 'Padrão', aliasLatest: 'mais recente' },
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
    }

    const source = fs.readFileSync(path.join(rendererRoot, 'modules/agents.js'), 'utf8');
    const start = source.indexOf('async function _renderAgentDetailCliSettings');
    const end = source.indexOf('async function _renderAgentDetailProjectDir', start);
    const settings = source.slice(start, end);
    expect(settings).toContain("value: isDefault ? '' : id");
    expect(settings).toContain("hint: isDefault ? t('agents.cli_default') : ''");
    expect(settings).toContain("if (!modelOptions.some(option => option.value === ''))");
    expect(settings).toContain("modelOptions.unshift({ value: '', label: t('agents.cli_default') })");
    expect(settings).toContain("if (!thinkingOptions.some(option => option.value === ''))");
    expect(settings).toContain("thinkingOptions.unshift({ value: '', label: t('agents.cli_default') })");
    expect(settings).not.toContain('cli_current_default');
    expect(settings).not.toContain('cli_default_model_hint');
    expect(settings).not.toContain('cli_default_thinking_hint');
    expect(settings).toContain('_mergeAgentIntoCache(saved.agent)');
    expect(settings).not.toContain('_agentsCache = null');
  });
});
