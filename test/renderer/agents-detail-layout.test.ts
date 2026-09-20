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
      en: { section: 'Runtime settings', defaultOption: 'Default', permissionPath: 'AI Team >' },
      zh: { section: '运行设置', defaultOption: '默认', permissionPath: 'AI 团队 >' },
      ja: { section: '実行設定', defaultOption: 'デフォルト', permissionPath: 'AI チーム >' },
      pt: { section: 'Configurações de execução', defaultOption: 'Padrão', permissionPath: 'Equipe de IA >' },
    };

    for (const [locale, copy] of Object.entries(labels)) {
      const table = JSON.parse(
        fs.readFileSync(path.join(rendererRoot, `locales/${locale}.json`), 'utf8'),
      );
      expect(table['agents.label_cli_settings']).toBe(copy.section);
      expect(table['agents.cli_default']).toBe(copy.defaultOption);
      // An alias row names the concrete model it runs today, so no locale
      // keeps a "latest" placeholder the user cannot act on. The hint alone
      // still says the alias follows later Claude Code updates.
      expect(table['agents.cli_model_alias_latest']).toBeUndefined();
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
    // An alias label states the version the CLI reports for it now; the model
    // observed on the last run is the fallback for a CLI that reports none,
    // and a resolution that is unknown appends nothing rather than a placeholder.
    expect(settings).toContain("String(model?.resolved_model || '').trim()");
    expect(settings).toContain("|| (id === currentModel ? observedModelForCurrentSelection : '')");
    expect(settings).toContain(
      'label: resolvedModel && resolvedModel !== label ? `${label} · ${resolvedModel}` : label,',
    );
    expect(settings).not.toContain('cli_model_alias_latest');
    // The picker states the resolution of every listed row, so the separate
    // "recently used" note is left for a saved override the catalog omits.
    expect(settings).toContain(
      "const selectedModelIsListed = models.some(model => String(model?.id || '') === currentModel)",
    );
    expect(settings).toContain('&& !selectedModelIsListed');
    expect(settings).not.toContain('selectedModelIsAlias');
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

// The picker is what a user reads before pinning an Agent to a model, so the
// rows must name the model each choice runs rather than a placeholder that
// cannot be checked against a release note or a support thread. The option
// loop is run here directly so the assertions are the visible strings.
describe('external CLI Agent model picker labels', () => {
  const source = fs.readFileSync(path.join(rendererRoot, 'modules/agents.js'), 'utf8');

  function buildModelOptions(input: {
    models: Array<Record<string, unknown>>;
    defaultModelId?: string;
    currentModel?: string;
    observed?: string;
  }): Array<{ value: string; label: string; hint: string }> {
    const start = source.indexOf('  for (const model of models) {');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\n  }\n', start);
    expect(end).toBeGreaterThan(start);
    const loop = source.slice(start, end + 4);
    const context = vm.createContext({
      models: input.models,
      defaultModelId: input.defaultModelId || '',
      currentModel: input.currentModel || '',
      observedModelForCurrentSelection: input.observed || '',
      modelOptions: [] as Array<Record<string, string>>,
      seenModelIds: new Set<string>(),
      t: (key: string) => (key === 'agents.cli_default' ? 'Default' : key),
    });
    vm.runInContext(loop, context);
    return (context as any).modelOptions;
  }

  it('names the model version every row runs, alias or pinned', () => {
    const options = buildModelOptions({
      models: [
        { id: 'opus[1m]', label: 'Opus (1M context)', is_alias: true, resolved_model: 'claude-opus-5[1m]' },
        { id: 'sonnet', label: 'Sonnet', is_alias: true, resolved_model: 'claude-sonnet-5' },
        // A pinned id whose display name carries no version: "Fable" alone
        // leaves the user unable to tell which release it is.
        { id: 'claude-fable-5-1[1m]', label: 'Fable', resolved_model: 'claude-fable-5-1' },
        // A label that already is the model id must not repeat it.
        { id: 'gpt-x', label: 'gpt-x', resolved_model: 'gpt-x' },
      ],
    });
    expect(options.map(option => option.label)).toEqual([
      'Opus (1M context) · claude-opus-5[1m]',
      'Sonnet · claude-sonnet-5',
      'Fable · claude-fable-5-1',
      'gpt-x',
    ]);
    // The hint keeps saying the alias follows later Claude Code updates, so the
    // named version reads as "today's", not as a pin. A pinned row gets no
    // such hint even though it now names a version too.
    expect(options[0].hint).toBe('agents.cli_model_alias_hint');
    expect(options[2].hint).toBe('');
  });

  it('falls back to the model observed on the last run, and appends nothing when neither is known', () => {
    const [selected, other] = buildModelOptions({
      // A CLI build that answers no catalog resolution: only the run that
      // actually happened can name a version.
      models: [
        { id: 'opus', label: 'Opus', is_alias: true },
        { id: 'sonnet', label: 'Sonnet', is_alias: true },
      ],
      currentModel: 'opus',
      observed: 'claude-opus-5',
    });
    expect(selected.label).toBe('Opus · claude-opus-5');
    // The observation covers only what actually ran; another alias must not
    // borrow it, and no locale placeholder stands in for the unknown version.
    expect(other.label).toBe('Sonnet');
  });

  it('prefers the catalog resolution over a stale observation of the same alias', () => {
    const [option] = buildModelOptions({
      models: [{ id: 'opus', label: 'Opus', is_alias: true, resolved_model: 'claude-opus-5-2' }],
      currentModel: 'opus',
      observed: 'claude-opus-5',
    });
    expect(option.label).toBe('Opus · claude-opus-5-2');
  });

  it('keeps the default row naming the model that choice runs', () => {
    // The default doubles as "inherit the CLI default" and persists as an empty
    // override, so its own row must still say which model that is.
    const options = buildModelOptions({
      models: [
        { id: 'opus[1m]', label: 'Opus (1M context)', is_alias: true, resolved_model: 'claude-opus-5[1m]' },
      ],
      defaultModelId: 'opus[1m]',
    });
    expect(options).toEqual([{
      value: '',
      label: 'Opus (1M context) · claude-opus-5[1m]',
      hint: 'Default · agents.cli_model_alias_hint',
    }]);
  });
});
