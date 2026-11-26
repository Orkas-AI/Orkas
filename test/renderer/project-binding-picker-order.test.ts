import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(path.join(__dirname, '../../src/renderer/modules/project-detail.js'), 'utf8');

describe('project binding picker order', () => {
  it('keeps custom agents first and natural name order within each source when browsing and searching', async () => {
    const agents = [
      { agent_id: 'platform10', source: 'marketplace', name: 'A Agent 10' },
      { agent_id: 'custom10', source: 'custom', name: 'Z Agent 10' },
      { agent_id: 'platform2', source: 'marketplace', name: 'a Agent 2' },
      { agent_id: 'custom2', source: 'custom', name: 'z Agent 2' },
    ].map(agent => ({ ...agent, description_en: 'Matching description' }));
    const inputHandlers: Record<string, () => void> = {};
    const search = {
      value: '', focus() {},
      addEventListener: (event: string, handler: () => void) => { inputHandlers[event] = handler; },
    };
    const list = { innerHTML: '', querySelectorAll: () => [] };
    const empty = { textContent: '', style: { display: '' } };
    const overlay = {
      innerHTML: '',
      querySelector: (selector: string) => ({
        '#project-binding-picker-list': list,
        '#project-binding-picker-empty': empty,
        '#project-binding-picker-search-input': search,
      })[selector] ?? null,
    };
    const warn = vi.fn();
    const context = vm.createContext({
      createLogger: () => ({ warn }),
      window: { addEventListener() {}, orkas: { invoke: async () => ({ ok: true, agents }) } },
      document: {
        readyState: 'loading', addEventListener() {}, getElementById: () => null,
        createElement: () => overlay, body: { appendChild() {} },
      },
      escapeHtml: (value: unknown) => String(value ?? ''),
      pickDesc: (item: { description_en: string }) => item.description_en,
      t: (key: string) => key,
      setTimeout: (callback: () => void) => callback(),
    });
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    await context._openAddPicker();
    const visibleIds = () => [...list.innerHTML.matchAll(/data-id="([^"]+)"/g)].map(match => match[1]);
    const expected = ['custom2', 'custom10', 'platform2', 'platform10'];
    expect(visibleIds()).toEqual(expected);

    for (const query of ['Agent', ' matching ', 'no results', 'Agent 2', '']) {
      search.value = query;
      inputHandlers.input();
      expect(visibleIds()).toEqual(query === 'no results' ? []
        : query === 'Agent 2' ? ['custom2', 'platform2'] : expected);
      expect(empty.style.display).toBe(query === 'no results' ? '' : 'none');
    }
    expect(warn).not.toHaveBeenCalled();
  });

  // Built-in Agents are already available in every project (2026-11-23): the
  // picker still shows them so users find VideoStudio, but greyed, with the
  // reason in words and without an Add control.
  it('shows built-in Agents after the addable ones, greyed with their availability and no Add control', async () => {
    const agents = [
      { agent_id: 'builtin-video', source: 'marketplace', name: 'VideoStudio', builtin: true },
      { agent_id: 'platform1', source: 'marketplace', name: 'Platform Agent' },
      { agent_id: 'custom1', source: 'custom', name: 'Custom Agent' },
    ].map(agent => ({ ...agent, description_en: 'Description' }));
    const list = { innerHTML: '', querySelectorAll: () => [] };
    const empty = { textContent: '', style: { display: '' } };
    const search = { value: '', focus() {}, addEventListener() {} };
    const overlay = {
      innerHTML: '',
      querySelector: (selector: string) => ({
        '#project-binding-picker-list': list,
        '#project-binding-picker-empty': empty,
        '#project-binding-picker-search-input': search,
      })[selector] ?? null,
    };
    const context = vm.createContext({
      createLogger: () => ({ warn() {} }),
      window: { addEventListener() {}, orkas: { invoke: async () => ({ ok: true, agents }) } },
      document: {
        readyState: 'loading', addEventListener() {}, getElementById: () => null,
        createElement: () => overlay, body: { appendChild() {} },
      },
      escapeHtml: (value: unknown) => String(value ?? ''),
      pickDesc: (item: { description_en: string }) => item.description_en,
      t: (key: string) => key,
      setTimeout: (callback: () => void) => callback(),
    });
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    await context._openAddPicker();
    const rows = [...list.innerHTML.matchAll(/<div class="project-binding-picker-item[^"]*"[^>]*data-id="([^"]+)"[\s\S]*?(?=<div class="project-binding-picker-item|$)/g)]
      .map(match => ({ id: match[1], html: match[0] }));
    expect(rows.map(row => row.id)).toEqual(['custom1', 'platform1', 'builtin-video']);
    const builtin = rows.find(row => row.id === 'builtin-video')!;
    expect(builtin.html).toContain('is-disabled');
    expect(builtin.html).toContain('aria-disabled="true"');
    expect(builtin.html).toContain('project.bindings.builtin_available_short');
    expect(builtin.html).not.toContain('data-action="pick"');
    for (const id of ['custom1', 'platform1']) {
      const row = rows.find(entry => entry.id === id)!;
      expect(row.html).toContain('data-action="pick"');
      expect(row.html).not.toContain('is-disabled');
    }
  });
});
