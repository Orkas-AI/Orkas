import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(path.join(__dirname, '../../src/renderer/modules/project-detail.js'), 'utf8');
const start = source.indexOf('function _renderProjectAgentCards(items) {');
const end = source.indexOf('function _bindProjectAgentCards()', start);
if (start < 0 || end < 0) throw new Error('project Agent card renderer missing');
const projectMeta = { project: {} };
const renderCards = vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
  _byDisplayName: (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name),
  _projectDetailMeta: projectMeta,
  currentUserId: 'member',
  _projectDetailPid: 'project',
  escapeHtml: (value: string) => value,
  t: (key: string) => key,
  _projectUiIconHtml: (name: string) => `<svg data-icon="${name}"></svg>`,
});

describe('ordinary project Agent controls', () => {
  it('omits privacy locks for every Agent in an ordinary project', () => {
      for (const agent of [
        { source: 'custom', shared_with_members: false, runtime: { kind: 'in_process' } },
        { source: 'custom', shared_with_members: false, runtime: { kind: 'cli' } },
        { source: 'marketplace', seed_source: 'platform', shared_with_members: true },
        { source: 'builtin' },
      ]) {
        const html = renderCards([{ agent_id: 'agent', name: 'Agent', ...agent }]);
        expect(html).not.toContain('data-icon="lock"');
        expect(html).not.toContain('project-agent-row-sharing');
        expect(html).toContain('data-project-agent-run');
        expect(html).toContain('data-project-agent-remove');
      }
  });

});

// Rows are parsed from the production markup so the click handlers see the
// same data attributes the renderer emits.
function rowHarness(project: Record<string, unknown>, agentDetails: any[]) {
  const cards: any[] = [];
  const list: any = {
    style: {}, html: '',
    set innerHTML(html: string) {
      this.html = html;
      cards.length = 0;
      for (const [tag] of html.matchAll(/<div class="project-agent-row[^>]*>/g)) {
        const attr = (name: string) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
        const handlers: Record<string, (event: any) => Promise<void>> = {};
        const dataset: Record<string, string> = { projectAgentId: attr('data-project-agent-id') || '' };
        const unavailable = attr('data-project-agent-unavailable');
        if (unavailable) dataset.projectAgentUnavailable = unavailable;
        cards.push({ dataset, handlers, querySelector: () => null,
          addEventListener: (event: string, fn: any) => { handlers[event] = fn; } });
      }
    },
    querySelectorAll: () => cards,
  };
  const context: any = {
    createLogger: () => ({ warn: vi.fn(), debug: vi.fn() }),
    document: { readyState: 'loading', addEventListener: vi.fn(),
      getElementById: (id: string) => id === 'project-agents-list' ? list : null },
    window: { addEventListener: vi.fn(), orkas: { invoke: vi.fn() } },
    currentUserId: 'member', escapeHtml: (value: unknown) => String(value ?? ''), t: (key: string) => key,
    _byDisplayName: () => 0, uiToast: vi.fn(), openAgentDetail: vi.fn(async () => true),
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context._projectUiIconHtml = () => '';
  context.meta = { project, agentDetails };
  vm.runInContext("_projectDetailPid = 'project'; _projectDetailMeta = meta", context);
  context._renderProjectAgents();
  return { context, cards, html: () => list.html };
}

describe('unavailable project Agent rows', () => {
  const ordinary = {};
  const placeholder = { agent_id: 'deleted01', name: '', source: 'custom', enabled: false, unavailable: true };

  it('names a deleted Agent in an ordinary project as unavailable and keeps it removable', () => {
    const { html } = rowHarness(ordinary, [placeholder]);
    expect(html()).toContain('project.bindings.unavailable');
    expect(html()).toMatch(/data-project-agent-run[^>]*disabled/);
    expect(html()).toContain('data-project-agent-remove');
    expect(html()).not.toContain('data-project-agent-unshare');
  });

  it.each([
    ['an ordinary project', ordinary, placeholder, 'project.bindings.unavailable_remove_hint'],
  ])('explains a click on an unavailable row in %s instead of opening a missing detail page', async (_label, project, agent, message) => {
    const { context, cards } = rowHarness(project, [agent]);
    await cards[0].handlers.click({});
    await cards[0].handlers.keydown({ key: 'Enter', preventDefault: vi.fn(), target: {} });
    expect(context.openAgentDetail).not.toHaveBeenCalled();
    expect(context.uiToast.mock.calls).toEqual([[message], [message]]);
  });

  it('still opens the detail page for an available Agent', async () => {
    const { context, cards } = rowHarness(ordinary, [{ agent_id: 'live01', name: 'Live', source: 'custom' }]);
    await cards[0].handlers.click({});
    expect(context.openAgentDetail).toHaveBeenCalledWith('live01');
    expect(context.uiToast).not.toHaveBeenCalled();
  });
});
