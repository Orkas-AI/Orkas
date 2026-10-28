import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { LOCALES } from '../../src/main/i18n';

const root = path.resolve(__dirname, '../../src/renderer');
const utilities = ts.createSourceFile('utils.js', fs.readFileSync(path.join(root, 'modules/utils.js'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const escapeHtml = utilities.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'escapeHtml');
if (!escapeHtml) throw new Error('shared HTML escaping boundary missing');
const agents = ts.createSourceFile('agents.js', fs.readFileSync(path.join(root, 'modules/agents.js'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const upgradeCallbacks: ts.Expression[] = [];
function findUpgradeCallback(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(agents) === 'window.addEventListener'
    && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'local-cli-upgraded') upgradeCallbacks.push(node.arguments[1]);
  ts.forEachChild(node, findUpgradeCallback);
}
findUpgradeCallback(agents);
if (upgradeCallbacks.length !== 1) throw new Error('CLI upgrade detail callback missing or duplicated');

function upgradeHarness() {
  let respond!: (value: any) => void;
  let finishEntries!: () => void;
  const warn = vi.fn();
  const context: any = {
    window: { orkas: { invoke: vi.fn(() => new Promise(resolve => { respond = resolve; })) } },
    _agentsLog: { warn }, _selectedAgent: { id: 'one' },
    _agentCliRuntimeOptionsCache: new Map([['codex', {}]]), _agentCliRuntimeSnapshots: new Map([['codex', {}]]),
    loadLocalCliEntries: vi.fn(() => new Promise<void>(resolve => { finishEntries = resolve; })),
    _renderAgentDetailRuntime: vi.fn(), _renderAgentDetailCliSettings: vi.fn(), renderCliAccountUsage: vi.fn(),
  };
  vm.runInNewContext(`this.onUpgrade = ${upgradeCallbacks[0].getText(agents)};`, context);
  return { context, warn, respond: (value: any) => respond(value), finishEntries: () => finishEntries() };
}
function harness() {
  const section = { hidden: true };
  const slot = { innerHTML: '', querySelector: () => null };
  const pending: Array<(v: any) => void> = [];
  const failures: Array<(error: Error) => void> = [];
  const warn = vi.fn();
  const calls: any[] = [];
  const context = vm.createContext({
    document: { getElementById: (id: string) => id.endsWith('-section') ? section : slot },
    window: { orkas: { invoke: (...args: any[]) => { calls.push(args); return new Promise((r, reject) => { pending.push(r); failures.push(reject); }); } } },
    createLogger: () => ({ warn }),
    getLang: () => 'en',
    t: (key: string, vars: any = {}) => key + JSON.stringify(vars),
    Date, Intl,
  });
  vm.runInContext(escapeHtml.getText(utilities), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'modules/cli-account-usage.js'), 'utf8'), context);
  return { section, slot, pending, failures, warn, calls, render: (agent: any, options?: any) => context.renderCliAccountUsage(agent, options) };
}
const agent = (id: string, cli = 'codex') => ({ agent_id: id, runtime: { kind: 'cli', cli } });
const reply = (remaining: number) => ({ usage: { status: 'ready', checked_at: 1900000000000, windows: [
  { label: '<img>', minutes: 300, remaining_percent: remaining, resets_at: 1900000000000 },
] } });

describe('CLI account allowance detail', () => {
  it('shows only quota and reset details and rechecks when details are rendered again', async () => {
    const h = harness(); const render = h.render(agent('one'));
    expect(h.slot.innerHTML).toContain('common.loading');
    h.pending.shift()!(reply(83)); await render;
    expect(h.slot.innerHTML).toContain('83%');
    expect(h.slot.innerHTML).toContain('agents.cli_usage_resets');
    expect(h.slot.innerHTML).toContain('&lt;img&gt;');
    expect(h.slot.innerHTML).not.toContain('<img>');
    expect(h.slot.innerHTML).not.toContain('agents.cli_usage_shared');
    expect(h.slot.innerHTML).not.toContain('agents.cli_usage_checked');
    expect(h.slot.innerHTML).not.toContain('<button');
    const reopened = h.render(agent('one'));
    expect(h.calls[1]).toEqual(['localAgents.accountUsage', { agent_id: 'one', force: false }]);
    h.pending.shift()!({ usage: { status: 'unavailable', windows: [] } }); await reopened;
    expect(h.slot.innerHTML).toContain('agents.cli_usage_unavailable');
    expect(h.slot.innerHTML).not.toContain('83%');
  });

  it('ignores a late response after switching agents or leaving CLI details', async () => {
    const h = harness(); const first = h.render(agent('one')); const second = h.render(agent('two', 'claude'));
    h.pending[1](reply(20)); await second;
    h.pending[0](reply(99)); await first;
    expect(h.slot.innerHTML).toContain('20%'); expect(h.slot.innerHTML).not.toContain('99%');
    const third = h.render(agent('three'));
    await h.render({ agent_id: 'ordinary', runtime: { kind: 'in_process' } });
    h.pending[2](reply(50)); await third;
    expect(h.section.hidden).toBe(true); expect(h.slot.innerHTML).toBe('');
  });

  it('localizes all visible quota states in every registered locale', () => {
    for (const { code } of LOCALES) {
      const table = JSON.parse(fs.readFileSync(path.join(root, 'locales', code + '.json'), 'utf8'));
      for (const key of ['title', 'unavailable', 'unsupported', 'resets', 'hours', 'days', 'window']) {
        expect(table['agents.cli_usage_' + key], code + ':' + key).toBeTruthy();
      }
      expect(table['agents.cli_usage_shared']).toBeUndefined();
      expect(table['agents.cli_usage_checked']).toBeUndefined();
      if (code === 'zh') expect(table['agents.cli_usage_title']).toBe('剩余额度');
    }
  });

  it('logs a rejected IPC safely while keeping the unavailable recovery state', async () => {
    const h = harness();
    const render = h.render(agent('one'));
    h.failures[0](new Error('private-account /private/fixture/token.txt'));
    await render;
    expect(h.slot.innerHTML).toContain('agents.cli_usage_unavailable');
    expect(h.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain('private');
  });

  it('escapes provider labels in both text and quoted progress attributes', async () => {
    const h = harness();
    const pending = h.render(agent('quoted-label'));
    const response = reply(83);
    response.usage.windows[0].label = '" onpointerenter="capture" <img>&\'';
    h.pending[0](response);
    await pending;
    const escaped = '&quot; onpointerenter=&quot;capture&quot; &lt;img&gt;&amp;&#039;';
    expect(h.slot.innerHTML).toContain(escaped);
    const attribute = h.slot.innerHTML.match(/aria-label="([^"]*)"/);
    expect(attribute?.[1]).toContain(escaped);
    expect(h.slot.innerHTML).not.toContain('aria-label="" onpointerenter=');
    expect(h.slot.innerHTML).not.toContain('<img>');
  });

  it.each([[0, '0%'], [100, '100%'], [12.34, '12.3%']])('preserves known %s percent allowance', async (remaining, displayed) => {
    const h = harness();
    const pending = h.render(agent('percentage'));
    h.pending[0](reply(remaining as number));
    await pending;
    expect(h.slot.innerHTML).toContain(displayed as string);
    expect(h.slot.innerHTML).not.toContain('agents.cli_usage_unavailable');
  });

  it('hides unsupported runtimes without probing their account', async () => {
    const h = harness();
    await h.render(agent('unsupported-cli', 'other'));
    expect(h.section.hidden).toBe(true);
    expect(h.slot.innerHTML).toBe('');
    expect(h.calls).toEqual([]);
  });

  it('forces a post-upgrade recheck and shows unsupported access without inventing quota', async () => {
    const h = harness();
    const pending = h.render(agent('upgrade'), { force: true });
    expect(h.calls).toEqual([['localAgents.accountUsage', { agent_id: 'upgrade', force: true }]]);
    h.pending[0]({ usage: { status: 'unsupported', windows: [] } });
    await pending;
    expect(h.section.hidden).toBe(false);
    expect(h.slot.innerHTML).toContain('agents.cli_usage_unsupported');
    expect(h.slot.innerHTML).not.toContain('<progress');
  });

  it('diagnoses a rejected upgrade refresh without exposing account details', async () => {
    const h = upgradeHarness();
    h.context.window.orkas.invoke.mockRejectedValueOnce(new Error('private-account private-project.md'));
    await h.context.onUpgrade({ detail: { type: 'codex' } });
    expect(h.warn).toHaveBeenCalledExactlyOnceWith('CLI account details refresh unavailable');
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain('private');
    expect(h.context.renderCliAccountUsage).not.toHaveBeenCalled();
  });

  it.each(['matching', 'other-cli', 'changed-agent', 'changed-during-runtime-refresh'])(
    'keeps the actual upgrade event scoped to the %s detail state', async mode => {
      const h = upgradeHarness();
      const pending = h.context.onUpgrade({ detail: { type: 'codex' } });
      expect(h.context.window.orkas.invoke).toHaveBeenCalledExactlyOnceWith('agents.get', { agent_id: 'one' });
      if (mode === 'changed-agent') h.context._selectedAgent = { id: 'two' };
      const updated = agent('one', mode === 'other-cli' ? 'claude' : 'codex');
      h.respond({ agent: updated });
      if (mode === 'matching' || mode === 'changed-during-runtime-refresh') {
        await vi.waitFor(() => expect(h.context.loadLocalCliEntries).toHaveBeenCalledExactlyOnceWith({ force: true }));
        if (mode === 'changed-during-runtime-refresh') h.context._selectedAgent = { id: 'two' };
        h.finishEntries();
      }
      await pending;
      if (mode === 'matching') {
        expect(h.context.renderCliAccountUsage).toHaveBeenCalledExactlyOnceWith(updated, { force: true });
        expect(h.context._renderAgentDetailRuntime).toHaveBeenCalledExactlyOnceWith(updated);
        expect(h.context._renderAgentDetailCliSettings).toHaveBeenCalledExactlyOnceWith(updated, { refresh: true });
      } else expect(h.context.renderCliAccountUsage).not.toHaveBeenCalled();
      expect(h.context._agentCliRuntimeOptionsCache.size).toBe(0);
      expect(h.context._agentCliRuntimeSnapshots.size).toBe(0);
      expect(h.warn).not.toHaveBeenCalled();
    },
  );

  it('does not probe an account when no details are selected during an upgrade', async () => {
    const h = upgradeHarness();
    h.context._selectedAgent = null;
    await h.context.onUpgrade({ detail: { type: 'codex' } });
    expect(h.context.window.orkas.invoke).not.toHaveBeenCalled();
    expect(h.context.renderCliAccountUsage).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
  });
});
