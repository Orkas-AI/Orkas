import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const rendererRoot = path.resolve(__dirname, '../../src/renderer');

async function flushPromises() {
  await new Promise<void>(resolve => setImmediate(resolve));
}

function loadStatusHint() {
  const source = fs.readFileSync(path.join(rendererRoot, 'modules/local-agents.js'), 'utf8');
  const calls: Array<{ key: string; vars?: Record<string, unknown> }> = [];
  const windowObject: Record<string, unknown> = {};
  const context = vm.createContext({
    window: windowObject,
    createLogger: () => ({ warn() {} }),
    t: (key: string, vars?: Record<string, unknown>) => {
      calls.push({ key, vars });
      return key;
    },
  });
  vm.runInContext(source, context, { filename: 'local-agents.js' });
  return {
    hint: windowObject.getLocalCliUnavailableHint as (entry: Record<string, unknown> | undefined) => string,
    isCodingAgent: windowObject.cliIsCodingAgent as (cli: string) => boolean,
    calls,
  };
}

function loadExternalSelectorHarness() {
  const source = fs.readFileSync(path.join(rendererRoot, 'modules/local-agents.js'), 'utf8');
  let now = 1000;
  const monitorCalls: any[] = [];
  const availabilityStates: boolean[] = [];
  const monitor = {
    event: (name: string, payload: unknown) => monitorCalls.push(['event', name, payload]),
  };
  const pendingInvokes: Array<{
    channel: string;
    payload: unknown;
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  const invocations: Array<{ channel: string; payload: unknown }> = [];
  const trigger = { disabled: false };
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const mount = {
    classList: {
      toggle(name: string, enabled: boolean) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
      contains(name: string) { return classes.has(name); },
    },
    setAttribute(name: string, value: string) { attributes.set(name, value); },
    querySelector: () => trigger,
  };
  const status = { hidden: true };
  const warning = { hidden: true, textContent: '' };
  const selectState = {
    value: '',
    options: [] as Array<{ value: string; label: string }>,
    placeholder: '',
    onChange: (_value: string) => {},
  };
  const selectApi = {
    getValue: () => selectState.value,
    onChange: (fn: (value: string) => void) => { selectState.onChange = fn; },
    setOptions: (
      options: Array<{ value: string; label: string }>,
      config: { value?: string; placeholder?: string } = {},
    ) => {
      selectState.options = options;
      if (typeof config.value === 'string') selectState.value = config.value;
      if (typeof config.placeholder === 'string') selectState.placeholder = config.placeholder;
    },
    setValue: (value: string) => {
      selectState.value = selectState.options.some(option => option.value === value)
        ? value
        : '';
    },
  };
  const windowObject: Record<string, any> = {
    Monitor: monitor,
    setExternalAgentCreateAvailability: (available: boolean) => availabilityStates.push(available),
    orkas: {
      invoke: (channel: string, payload: unknown) => {
        invocations.push({ channel, payload });
        return new Promise((resolve, reject) => {
          pendingInvokes.push({ channel, payload, resolve, reject });
        });
      },
    },
  };
  const context = vm.createContext({
    window: windowObject,
    Monitor: monitor,
    document: {
      getElementById: (id: string) => {
        if (id === 'agent-modal-ext-cli-select') return mount;
        if (id === 'agent-modal-ext-cli-status') return status;
        if (id === 'agent-modal-ext-cli-warning') return warning;
        return null;
      },
    },
    createLogger: () => ({ warn() {} }),
    Date: { now: () => now },
    t: (key: string) => key,
    _aiSelectMount: (_mount: unknown, config: {
      options: Array<{ value: string; label: string }>;
      value: string;
      placeholder: string;
      onChange: (value: string) => void;
    }) => {
      selectState.options = config.options;
      selectState.value = config.value;
      selectState.placeholder = config.placeholder;
      selectState.onChange = config.onChange;
      return selectApi;
    },
  });
  vm.runInContext(source, context, { filename: 'local-agents.js' });
  const takePendingInvoke = (predicate?: (pending: {
    channel: string;
    payload: unknown;
  }) => boolean) => {
    const index = predicate ? pendingInvokes.findIndex(predicate) : 0;
    if (index < 0 || pendingInvokes.length === 0) {
      throw new Error('no matching localAgents invocation');
    }
    return pendingInvokes.splice(index, 1)[0];
  };
  return {
    availability: windowObject.getLocalCliAvailabilityState as () => 'none' | 'detecting' | 'available',
    load: windowObject.loadLocalCliEntries as (options?: { force?: boolean }) => Promise<unknown>,
    mount: windowObject.mountExternalCliSelect as (onChange?: (value: string | null) => void) => Promise<unknown>,
    resolveList: (value: unknown) => takePendingInvoke(
      pending => pending.channel === 'localAgents.list',
    ).resolve(value),
    rejectList: (reason?: unknown) => takePendingInvoke(
      pending => pending.channel === 'localAgents.list',
    ).reject(reason),
    resolveDetect: (type: string, value: unknown) => takePendingInvoke(
      pending => pending.channel === 'localAgents.detect'
        && (pending.payload as { type?: unknown })?.type === type,
    ).resolve(value),
    rejectDetect: (type: string, reason?: unknown) => takePendingInvoke(
      pending => pending.channel === 'localAgents.detect'
        && (pending.payload as { type?: unknown })?.type === type,
    ).reject(reason),
    advanceTime: (ms: number) => { now += ms; },
    select: (value: string) => { selectState.value = value; },
    choose: (value: string) => {
      selectState.value = value;
      selectState.onChange(value);
    },
    getInvokeCount: () => invocations.length,
    invocations,
    selectState,
    status,
    warning,
    trigger,
    classes,
    attributes,
    monitorCalls,
    availabilityStates,
  };
}

describe('external-agent unavailable status copy', () => {
  it('keeps registry failure reasons distinct', () => {
    const { hint, calls } = loadStatusHint();

    expect(hint({ error: 'not_found' })).toBe('agent.cli_not_found');
    expect(hint({ error: 'version_timeout' })).toBe('agent.cli_version_timeout');
    expect(hint({ error: 'version_unknown' })).toBe('agent.cli_version_unknown');
    expect(hint({ error: 'version_too_old', version: '0.9.0' })).toBe('agent.cli_version_too_old');
    expect(calls.at(-1)).toEqual({
      key: 'agent.cli_version_too_old',
      vars: { version: '0.9.0' },
    });
  });

  it('limits project-directory controls to Claude Code and Codex', () => {
    const { isCodingAgent } = loadStatusHint();

    expect(isCodingAgent('claude')).toBe(true);
    expect(isCodingAgent('codex')).toBe(true);
    expect(isCodingAgent('openclaw')).toBe(false);
    expect(isCodingAgent('opencode')).toBe(false);
    expect(isCodingAgent('hermes')).toBe(false);
  });

  it('ships recovery and detection messages in every renderer locale', () => {
    const detectingCopy = {
      en: 'Detecting…',
      zh: '识别中…',
      ja: '検出中…',
      pt: 'Detectando…',
    };
    const emptyCopy = {
      en: 'Not installed',
      zh: '未安装',
      ja: '未インストール',
      pt: 'Não instalado',
    };
    const prerequisiteCopy = {
      en: 'Supports Claude Code, Codex, OpenClaw, OpenCode, and Hermes. Install and configure one to connect.',
      zh: '快速接入已安装的智能体，支持 Claude Code、Codex、OpenClaw、OpenCode 和 Hermes。',
      ja: 'Claude Code、Codex、OpenClaw、OpenCode、Hermes に対応しています。インストールして設定すると接続できます。',
      pt: 'Compatível com Claude Code, Codex, OpenClaw, OpenCode e Hermes. Instale e configure um deles para conectar.',
    };
    for (const locale of ['en', 'zh', 'ja', 'pt']) {
      const table = JSON.parse(fs.readFileSync(path.join(rendererRoot, `locales/${locale}.json`), 'utf8'));
      expect(table['agent.cli_not_found']).toBeTruthy();
      expect(table['agent.cli_version_timeout']).toBeTruthy();
      expect(table['agent.cli_version_unknown']).toBeTruthy();
      expect(table['agent.cli_version_too_old']).toContain('{version}');
      expect(table['agent_modal.ext_cli_detecting']).toBe(
        detectingCopy[locale as keyof typeof detectingCopy],
      );
      expect(table['agent_modal.ext_cli_updating']).toBeTruthy();
      expect(table['agent_modal.ext_cli_empty']).toBe(
        emptyCopy[locale as keyof typeof emptyCopy],
      );
      expect(table['agent_modal.ext_cli_unavailable']).toBeTruthy();
      expect(table['agent_modal.ext_cli_status_not_found']).toBeTruthy();
      expect(table['agent_modal.ext_cli_status_version_timeout']).toBeTruthy();
      expect(table['agent_modal.ext_cli_status_version_unknown']).toBeTruthy();
      expect(table['agent_modal.ext_cli_status_version_too_old']).toContain('{version}');
      expect(table['agent_modal.ext_cli_prerequisite_title']).toBeUndefined();
      expect(table['agent_modal.ext_cli_prerequisite_body']).toBe(
        prerequisiteCopy[locale as keyof typeof prerequisiteCopy],
      );
      expect(table['agent_modal.ext_cli_none']).toBeUndefined();
    }
  });

  it('keeps the installation prerequisite bordered and lightweight, and the live detection status accessible', () => {
    const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
    const prerequisiteStart = html.indexOf('class="agent-cli-prerequisite"');
    const prerequisiteMarkup = html.slice(prerequisiteStart, prerequisiteStart + 300);
    expect(prerequisiteStart).toBeGreaterThan(0);
    expect(prerequisiteMarkup).toContain('role="note"');
    expect(prerequisiteMarkup).toContain('data-i18n="agent_modal.ext_cli_prerequisite_body"');
    expect(prerequisiteMarkup).not.toContain('data-ui-icon');
    expect(prerequisiteMarkup).not.toContain('<strong');
    expect(prerequisiteMarkup).not.toContain('agent_modal.ext_cli_prerequisite_title');

    const css = fs.readFileSync(path.join(rendererRoot, 'style.css'), 'utf8');
    const prerequisiteStyleStart = css.indexOf('.agent-cli-prerequisite {');
    const prerequisiteStyle = css.slice(prerequisiteStyleStart, prerequisiteStyleStart + 300);
    expect(prerequisiteStyleStart).toBeGreaterThan(0);
    expect(prerequisiteStyle).toContain('color: var(--text-2);');
    expect(prerequisiteStyle).toContain('font-size: 13px;');
    expect(prerequisiteStyle).toContain('border: 1px solid var(--border-strong);');

    const start = html.indexOf('id="agent-modal-ext-cli-status"');
    const statusMarkup = html.slice(start, start + 500);

    expect(start).toBeGreaterThan(0);
    expect(statusMarkup).toContain('role="status"');
    expect(statusMarkup).toContain('aria-live="polite"');
    expect(statusMarkup).toContain('data-i18n="agent_modal.ext_cli_updating"');
    const warningStart = html.indexOf('id="agent-modal-ext-cli-warning"');
    const warningMarkup = html.slice(warningStart, warningStart + 300);
    expect(warningStart).toBeGreaterThan(0);
    expect(warningMarkup).toContain('role="status"');
    expect(warningMarkup).toContain('aria-live="polite"');
  });

  it('shows path hits before version validation finishes', async () => {
    const harness = loadExternalSelectorHarness();
    const selected: Array<string | null> = [];
    const pending = harness.mount((value) => selected.push(value));

    expect(harness.getInvokeCount()).toBe(1);
    expect(harness.availability()).toBe('detecting');
    expect(harness.selectState.placeholder).toBe('agent_modal.ext_cli_detecting');
    expect(harness.status.hidden).toBe(true);
    expect(harness.trigger.disabled).toBe(true);
    expect(harness.classes.has('is-detecting')).toBe(true);
    expect(harness.attributes.get('aria-busy')).toBe('true');
    expect(harness.invocations[0]).toEqual({
      channel: 'localAgents.list',
      payload: { force: true, validate: false },
    });

    harness.resolveList({
      entries: [{
        type: 'codex',
        available: true,
        version: null,
        validation: 'pending',
      }],
    });
    await flushPromises();

    expect(harness.getInvokeCount()).toBe(2);
    expect(harness.invocations[1]).toEqual({
      channel: 'localAgents.detect',
      payload: { type: 'codex' },
    });
    expect(harness.status.hidden).toBe(false);
    expect(harness.trigger.disabled).toBe(false);
    expect(harness.selectState.options).toEqual([
      { value: 'codex', label: 'Codex' },
    ]);
    expect(harness.selectState.value).toBe('codex');
    expect(selected).toEqual(['codex']);
    expect(harness.availability()).toBe('available');

    harness.resolveDetect('codex', {
      entry: { type: 'codex', available: true, version: '0.146.0' },
    });
    await pending;

    expect(harness.status.hidden).toBe(true);
    expect(harness.trigger.disabled).toBe(false);
    expect(harness.classes.has('is-detecting')).toBe(false);
    expect(harness.attributes.get('aria-busy')).toBe('false');
    expect(harness.selectState.options.map(option => option.value)).toEqual([
      'codex',
    ]);
    expect(harness.selectState.value).toBe('codex');
    expect(harness.selectState.options).toEqual([
      { value: 'codex', label: 'Codex (0.146.0)' },
    ]);
    expect(selected).toEqual(['codex']);
    expect(harness.availability()).toBe('available');
    expect(harness.monitorCalls).toEqual([
      ['event', 'external_cli_detect_result', {
        result: 'success',
        available_count: 1,
        not_found_count: 0,
        version_too_old_count: 0,
        version_timeout_count: 0,
        version_unknown_count: 0,
        available_types: 'codex',
        not_found_types: '',
        version_too_old_types: '',
        version_timeout_types: '',
        version_unknown_types: '',
        duration_ms: 0,
      }],
    ]);
  });

  it('reports unavailable CLI reasons as one aggregate detection result', async () => {
    const harness = loadExternalSelectorHarness();
    const pending = harness.mount();
    harness.advanceTime(40);
    harness.resolveList({
      entries: [
        { type: 'claude', available: false, error: 'not_found' },
        { type: 'codex', available: false, error: 'not_found' },
        { type: 'opencode', available: false, error: 'version_unknown' },
        { type: 'openclaw', available: false, error: 'version_too_old', version: '1.0.0' },
        { type: 'hermes', available: false, error: 'version_timeout' },
      ],
    });
    await pending;

    expect(harness.monitorCalls).toEqual([
      ['event', 'external_cli_detect_result', {
        result: 'success',
        available_count: 0,
        not_found_count: 2,
        version_too_old_count: 1,
        version_timeout_count: 1,
        version_unknown_count: 1,
        available_types: '',
        not_found_types: 'claude,codex',
        version_too_old_types: 'openclaw',
        version_timeout_types: 'hermes',
        version_unknown_types: 'opencode',
        duration_ms: 40,
      }],
    ]);
    expect(harness.selectState.placeholder).toBe('agent_modal.ext_cli_unavailable');
    expect(harness.selectState.value).toBe('');
    expect(harness.selectState.options).toEqual([
      {
        value: 'claude',
        label: 'ClaudeCode',
        hint: 'agent_modal.ext_cli_status_not_found',
        disabled: true,
      },
      {
        value: 'codex',
        label: 'Codex',
        hint: 'agent_modal.ext_cli_status_not_found',
        disabled: true,
      },
      {
        value: 'opencode',
        label: 'OpenCode',
        hint: 'agent_modal.ext_cli_status_version_unknown',
        iconName: 'warning',
        disabled: true,
      },
      {
        value: 'openclaw',
        label: 'OpenClaw (1.0.0)',
        hint: 'agent_modal.ext_cli_status_version_too_old',
        iconName: 'warning',
        disabled: true,
      },
      {
        value: 'hermes',
        label: 'Hermes',
        hint: 'agent_modal.ext_cli_status_version_timeout',
        iconName: 'warning',
        disabled: true,
      },
    ]);
    expect(harness.trigger.disabled).toBe(false);
    expect(harness.availabilityStates.at(-1)).toBe(false);
  });

  it('keeps successful discovery cached without a renderer expiry', async () => {
    const harness = loadExternalSelectorHarness();
    const first = harness.load();
    harness.resolveList({
      entries: [{ type: 'codex', available: true, version: '0.146.0' }],
    });
    await first;
    harness.advanceTime(86_400_000);

    const cached = await harness.load();

    expect(harness.getInvokeCount()).toBe(1);
    expect(cached).toEqual([
      { type: 'codex', available: true, version: '0.146.0' },
    ]);
  });

  it('refreshes on every cached panel entry, including an empty result', async () => {
    const harness = loadExternalSelectorHarness();
    const first = harness.mount();
    harness.resolveList({ entries: [] });
    await first;
    expect(harness.availability()).toBe('none');

    const refresh = harness.mount();

    expect(harness.getInvokeCount()).toBe(2);
    expect(harness.availability()).toBe('none');
    expect(harness.status.hidden).toBe(false);
    expect(harness.selectState.options).toEqual([]);
    expect(harness.selectState.placeholder).toBe('agent_modal.ext_cli_empty');
    expect(harness.classes.has('is-empty')).toBe(true);
    expect(harness.trigger.disabled).toBe(true);
    expect(harness.invocations[1]).toEqual({
      channel: 'localAgents.list',
      payload: { force: true, validate: false },
    });

    harness.resolveList({ entries: [] });
    await refresh;
    expect(harness.status.hidden).toBe(true);
  });

  it('coalesces concurrent mounts in both discovery phases', async () => {
    const harness = loadExternalSelectorHarness();
    const first = harness.mount();
    const second = harness.mount();

    expect(harness.getInvokeCount()).toBe(1);
    expect(harness.status.hidden).toBe(true);
    harness.resolveList({
      entries: [{ type: 'claude', available: true, version: null, validation: 'pending' }],
    });
    await flushPromises();

    expect(harness.getInvokeCount()).toBe(2);
    expect(harness.invocations[1]).toEqual({
      channel: 'localAgents.detect',
      payload: { type: 'claude' },
    });
    harness.resolveDetect('claude', {
      entry: { type: 'claude', available: true, version: '2.1.148' },
    });
    await Promise.all([first, second]);

    expect(harness.getInvokeCount()).toBe(2);
    expect(harness.selectState.options.map(option => option.value)).toEqual([
      'claude',
    ]);
    expect(harness.selectState.value).toBe('claude');
    expect(harness.monitorCalls.filter(
      ([kind, name]) => kind === 'event' && name === 'external_cli_detect_result',
    )).toHaveLength(1);
  });

  it('keeps one telemetry owner when another mount starts during version validation', async () => {
    const harness = loadExternalSelectorHarness();
    const first = harness.mount();
    harness.resolveList({
      entries: [{ type: 'codex', available: true, version: null, validation: 'pending' }],
    });
    await flushPromises();
    expect(harness.getInvokeCount()).toBe(2);

    const second = harness.mount();
    expect(harness.getInvokeCount()).toBe(3);
    harness.resolveList({
      entries: [{ type: 'codex', available: true, version: null, validation: 'pending' }],
    });
    await flushPromises();
    harness.resolveDetect('codex', {
      entry: { type: 'codex', available: true, version: '0.146.0' },
    });
    await Promise.all([first, second]);

    expect(harness.monitorCalls.filter(
      ([kind, name]) => kind === 'event' && name === 'external_cli_detect_result',
    )).toHaveLength(1);
  });

  it('shows cached options immediately, resets to the first CLI, and marks the title updating', async () => {
    const harness = loadExternalSelectorHarness();
    const selected: Array<string | null> = [];
    const first = harness.mount((value) => selected.push(value));
    harness.resolveList({
      entries: [
        { type: 'codex', available: true, version: null, validation: 'pending' },
        { type: 'claude', available: true, version: null, validation: 'pending' },
      ],
    });
    await flushPromises();
    expect(harness.getInvokeCount()).toBe(3);
    harness.resolveDetect('codex', {
      entry: { type: 'codex', available: true, version: '0.146.0' },
    });
    harness.resolveDetect('claude', {
      entry: { type: 'claude', available: true, version: '2.1.148' },
    });
    await first;
    harness.select('claude');

    const refresh = harness.mount((value) => selected.push(value));
    expect(harness.getInvokeCount()).toBe(4);
    expect(harness.status.hidden).toBe(false);
    expect(harness.trigger.disabled).toBe(false);
    expect(harness.selectState.value).toBe('codex');
    expect(harness.selectState.options.map(option => option.value)).toEqual([
      'codex',
      'claude',
    ]);
    expect(harness.invocations[3]).toEqual({
      channel: 'localAgents.list',
      payload: { force: true, validate: false },
    });

    harness.resolveList({
      entries: [
        { type: 'claude', available: true, version: null, validation: 'pending' },
        { type: 'codex', available: true, version: null, validation: 'pending' },
      ],
    });
    await flushPromises();
    expect(harness.getInvokeCount()).toBe(6);
    expect(harness.selectState.options).toEqual([
      { value: 'claude', label: 'ClaudeCode (2.1.148)' },
      { value: 'codex', label: 'Codex (0.146.0)' },
    ]);
    harness.resolveDetect('claude', {
      entry: { type: 'claude', available: true, version: '2.1.148' },
    });
    harness.resolveDetect('codex', {
      entry: { type: 'codex', available: true, version: '0.147.0' },
    });
    await refresh;

    expect(harness.status.hidden).toBe(true);
    expect(harness.selectState.value).toBe('codex');
    expect(harness.selectState.options.map(option => option.value)).toEqual([
      'claude',
      'codex',
    ]);
    expect(selected).toEqual(['codex', 'codex']);
  });

  it('retains cached options when a background refresh fails', async () => {
    const harness = loadExternalSelectorHarness();
    const first = harness.mount();
    harness.resolveList({
      entries: [{ type: 'codex', available: true, version: null, validation: 'pending' }],
    });
    await flushPromises();
    harness.resolveDetect('codex', {
      entry: { type: 'codex', available: true, version: '0.146.0' },
    });
    await first;

    const refresh = harness.mount();
    expect(harness.status.hidden).toBe(false);
    expect(harness.trigger.disabled).toBe(false);
    harness.rejectList(new Error('IPC unavailable'));
    await flushPromises();
    harness.rejectList(new Error('IPC unavailable'));
    await refresh;

    expect(harness.status.hidden).toBe(true);
    expect(harness.trigger.disabled).toBe(false);
    expect(harness.selectState.options.map(option => option.value)).toEqual([
      'codex',
    ]);
  });

  it('does not turn a cold discovery failure into cache', async () => {
    const harness = loadExternalSelectorHarness();
    const first = harness.mount();
    harness.rejectList(new Error('IPC unavailable'));
    await flushPromises();
    harness.rejectList(new Error('IPC unavailable'));
    await first;
    expect(harness.monitorCalls).toEqual([
      ['event', 'external_cli_detect_result', {
        result: 'failure',
        available_count: 0,
        not_found_count: 0,
        version_too_old_count: 0,
        version_timeout_count: 0,
        version_unknown_count: 0,
        available_types: '',
        not_found_types: '',
        version_too_old_types: '',
        version_timeout_types: '',
        version_unknown_types: '',
        duration_ms: 0,
        error_code: 'invoke_failed',
      }],
    ]);

    const retry = harness.mount();

    expect(harness.getInvokeCount()).toBe(3);
    expect(harness.status.hidden).toBe(true);
    expect(harness.selectState.placeholder).toBe('agent_modal.ext_cli_detecting');
    expect(harness.trigger.disabled).toBe(true);

    harness.resolveList({
      entries: [{ type: 'codex', available: true, version: null, validation: 'pending' }],
    });
    await flushPromises();
    harness.resolveDetect('codex', {
      entry: { type: 'codex', available: true, version: '0.146.0' },
    });
    await retry;
  });

  it('selects the next available CLI when refresh removes the cached selection', async () => {
    const harness = loadExternalSelectorHarness();
    const selected: Array<string | null> = [];
    const first = harness.mount((value) => selected.push(value));
    harness.resolveList({
      entries: [{ type: 'codex', available: true, version: null, validation: 'pending' }],
    });
    await flushPromises();
    harness.resolveDetect('codex', {
      entry: { type: 'codex', available: true, version: '0.146.0' },
    });
    await first;

    const refresh = harness.mount((value) => selected.push(value));
    harness.resolveList({
      entries: [{ type: 'claude', available: true, version: null, validation: 'pending' }],
    });
    await flushPromises();
    harness.resolveDetect('claude', {
      entry: { type: 'claude', available: true, version: '2.1.148' },
    });
    await refresh;

    expect(harness.selectState.options.map(option => option.value)).toEqual(['claude']);
    expect(harness.selectState.value).toBe('claude');
    expect(selected.at(-1)).toBe('claude');
  });

  it('renders each CLI result immediately without waiting for slower probes', async () => {
    const harness = loadExternalSelectorHarness();
    const selected: Array<string | null> = [];
    const pending = harness.mount((value) => selected.push(value));
    harness.resolveList({
      entries: [
        { type: 'codex', available: true, version: null, validation: 'pending' },
        { type: 'claude', available: true, version: null, validation: 'pending' },
      ],
    });
    await flushPromises();

    expect(harness.getInvokeCount()).toBe(3);
    expect(harness.selectState.value).toBe('codex');
    harness.resolveDetect('codex', {
      entry: {
        type: 'codex',
        available: false,
        version: '0.139.0',
        error: 'version_too_old',
      },
    });
    await flushPromises();

    expect(harness.selectState.options).toEqual([
      {
        value: 'codex',
        label: 'Codex (0.139.0)',
        hint: 'agent_modal.ext_cli_status_version_too_old',
        iconName: 'warning',
        disabled: true,
      },
      { value: 'claude', label: 'ClaudeCode' },
    ]);
    expect(harness.selectState.value).toBe('claude');
    expect(harness.status.hidden).toBe(false);
    expect(harness.classes.has('is-detecting')).toBe(true);

    harness.resolveDetect('claude', {
      entry: { type: 'claude', available: true, version: '2.1.148' },
    });
    await pending;

    expect(harness.selectState.options[1]).toEqual({
      value: 'claude',
      label: 'ClaudeCode (2.1.148)',
    });
    expect(harness.status.hidden).toBe(true);
    expect(harness.warning.hidden).toBe(true);
    expect(harness.warning.textContent).toBe('');
    expect(selected).toEqual(['codex', 'claude']);
  });

  it('keeps a cached outdated CLI disabled while the same binary is revalidated', async () => {
    const harness = loadExternalSelectorHarness();
    const first = harness.mount();
    harness.resolveList({
      entries: [{
        type: 'codex',
        path: '/cli/codex',
        available: true,
        version: null,
        validation: 'pending',
      }],
    });
    await flushPromises();
    harness.resolveDetect('codex', {
      entry: {
        type: 'codex',
        path: '/cli/codex',
        available: false,
        version: '0.139.0',
        error: 'version_too_old',
      },
    });
    await first;

    const refresh = harness.mount();
    harness.resolveList({
      entries: [{
        type: 'codex',
        path: '/cli/codex',
        available: true,
        version: null,
        validation: 'pending',
      }],
    });
    await flushPromises();

    expect(harness.warning.hidden).toBe(true);
    expect(harness.warning.textContent).toBe('');
    expect(harness.selectState.value).toBe('');
    expect(harness.selectState.options).toEqual([{
      value: 'codex',
      label: 'Codex (0.139.0)',
      hint: 'agent_modal.ext_cli_status_version_too_old',
      iconName: 'warning',
      disabled: true,
    }]);

    harness.resolveDetect('codex', {
      entry: {
        type: 'codex',
        path: '/cli/codex',
        available: false,
        version: '0.139.0',
        error: 'version_too_old',
      },
    });
    await refresh;
  });
});
