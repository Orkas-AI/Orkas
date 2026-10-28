import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// A full memory store refuses new entries and the current model consolidates
// it. The memory views only tell the user that state; they never ask the user
// to delete or edit entries to make room.
const rendererRoot = path.join(__dirname, '../../src/renderer');
const memorySource = fs.readFileSync(path.join(rendererRoot, 'modules/memory.js'), 'utf8');
const projectSource = fs.readFileSync(path.join(rendererRoot, 'modules/project-detail.js'), 'utf8');
const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
const localeDir = path.join(rendererRoot, 'locales');
const locales = Object.fromEntries(fs.readdirSync(localeDir).filter((f) => f.endsWith('.json')).map((f) => [
  f.replace(/\.json$/, ''),
  JSON.parse(fs.readFileSync(path.join(localeDir, f), 'utf8')),
]));

function memoryContext() {
  const context = vm.createContext({
    console, Date, Map, Set,
    createLogger: () => ({ info() {}, warn() {}, error() {} }),
    document: { readyState: 'loading', addEventListener() {}, getElementById() { return null; }, querySelector() { return null; } },
    window: { addEventListener() {}, orkas: { invoke: vi.fn() } },
    escapeHtml: (value: string) => String(value),
    setTimeout, clearTimeout,
    t: (key: string) => key,
  });
  vm.runInContext(memorySource, context, { filename: 'memory.js' });
  return context;
}

const scope = { key: 'shared', kind: 'shared', title: 'Shared', sub: 'sub', icon: 'sparkles' };
const usage = (full: boolean) => ({ current: 10, limit: 2500, entries_current: 1, entries_limit: 16, full });

describe('memory page full notice', () => {
  it('shows the full notice as status text only when the store is full', () => {
    const context = memoryContext();
    context.scope = scope;
    context.full = { entries: ['fact'], usage: usage(true) };
    context.room = { entries: ['fact'], usage: usage(false) };
    const fullHtml = vm.runInContext('_memRenderSection(scope, full)', context) as string;
    const roomHtml = vm.runInContext('_memRenderSection(scope, room)', context) as string;
    expect(fullHtml).toMatch(/role="status"[^>]*>memory\.full_notice</);
    expect(fullHtml).toContain('memory-usage is-warn');
    expect(roomHtml).not.toContain('memory.full_notice');
  });

  it('maps a refused add to the full message rather than a generic retry', () => {
    const context = memoryContext();
    expect(vm.runInContext("_memErrorToText('memory full: the shared store would hold 17/16 entries')", context))
      .toBe('memory.error_full');
    expect(vm.runInContext("_memFailureDetails({ error: 'memory full: the shared store would hold 17/16 entries' }).error_code", context))
      .toBe('memory_full');
    expect(vm.runInContext("_memErrorToText('something else')", context)).toBe('memory.error_generic');
  });
});

describe('project memory full notice', () => {
  function projectContext(realLogger = false) {
    const records: any[] = [];
    const timers: Array<() => void> = [];
    const nodes: Record<string, any> = {
      'project-memory-list': { innerHTML: '', style: {}, appendChild() {} },
      'project-memory-empty': { style: {} },
      'project-memory-count': { textContent: '' },
      'project-memory-section-head': { hidden: false },
      'project-memory-full': { hidden: true },
    };
    const alerts: string[] = [];
    const context = vm.createContext({
      console,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: {
        readyState: 'loading', addEventListener() {},
        getElementById: (id: string) => nodes[id] || null,
        querySelector: () => null,
        createElement: () => ({ appendChild() {}, className: '', dataset: {}, style: {}, textContent: '', setAttribute() {}, addEventListener() {} }),
      },
      window: { addEventListener() {}, orkas: { invoke: async () => ({ ok: true }) } },
      uiAlert: (text: string) => { alerts.push(text); },
      escapeHtml: (value: string) => value,
      t: (key: string) => key,
      setTimeout, clearTimeout,
    });
    if (realLogger) {
      delete context.createLogger;
      context.console = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
      context.window.orkas.log = (record: any) => records.push(record);
      context.setTimeout = (callback: () => void) => { timers.push(callback); return timers.length; };
      vm.runInContext(fs.readFileSync(path.join(rendererRoot, 'modules/logger.js'), 'utf8'), context, { filename: 'logger.js' });
    }
    vm.runInContext(projectSource, context, { filename: 'project-detail.js' });
    return { context, nodes, alerts, records, flushLogs() {
      for (let index = 0; timers.length && index < 32; index++) timers.shift()!();
      expect(timers).toHaveLength(0);
    } };
  }

  it('toggles the notice from the store usage', () => {
    const { context, nodes } = projectContext();
    vm.runInContext("_projectMemory = ['a']; _projectMemoryFull = true; _renderProjectMemoryList()", context);
    expect(nodes['project-memory-full'].hidden).toBe(false);
    vm.runInContext('_projectMemoryFull = false; _renderProjectMemoryList()', context);
    expect(nodes['project-memory-full'].hidden).toBe(true);
  });

  it.each([
    ['read', 'load project memory failed', 'ipc', 'memory_ipc_invoke_failed'],
    ['mutate', 'project memory mutate failed', 'ipc', 'memory_ipc_invoke_failed'],
    ['refresh', 'refresh project memory after mutation failed', 'runtime', 'memory_operation_failed'],
  ])('keeps the %s failure private through the real logger bridge', async (phase, message, type, code) => {
    const { context, records, alerts, flushLogs } = projectContext(true);
    const marker = 'PRIVATE_MEMORY_DIAGNOSTIC_MARKER';
    context.currentUserId = 'account-fixture';
    vm.runInContext("_projectDetailPid = 'project-fixture'", context);
    if (phase === 'refresh') {
      vm.runInContext(`window.orkas.invoke = async () => ({ ok:true, entries:['fixture'], usage:{full:false} });
        _renderProjectMemoryList = () => { throw new Error(${JSON.stringify(marker)}); }`, context);
    } else {
      vm.runInContext(`window.orkas.invoke = async () => { throw new Error(${JSON.stringify(marker)}); }`, context);
    }
    const outcome = await vm.runInContext(phase === 'read' ? "_loadProjectMemory('project-fixture')"
      : "_mutateProjectMemory('memory.add', { content:'fixture' })", context);
    flushLogs();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ level: 'warn', message });
    expect(JSON.stringify(records)).not.toContain(marker);
    expect(records[0].data).toEqual([{ error_type: type, error_code: code }]);
    if (phase === 'mutate') { expect(outcome.ok).toBe(false); expect(alerts).toEqual(['project.memory.failed']); }
    if (phase === 'refresh') { expect(outcome).toEqual({ ok:true, failure:null }); expect(alerts).toHaveLength(0); }
  });

  it('classifies a refused add as full', () => {
    const { context } = projectContext();
    expect(vm.runInContext("_projectMemoryFailure({ error: 'memory full: the project store would hold 17/16 entries' }).error_code", context))
      .toBe('memory_full');
  });

  it('places a localized status notice in the project memory panel', () => {
    const notice = html.match(/<p\b[^>]*\bid="project-memory-full"[^>]*>/)?.[0];
    expect(notice).toBeDefined();
    expect(notice).toMatch(/\srole="status"(?:\s|>)/);
    expect(notice).toMatch(/\shidden(?:\s|>)/);
    expect(notice).toMatch(/\sdata-i18n="memory\.full_notice"(?:\s|>)/);
  });
});

describe('agent memory full message', () => {
  it('shows the localized full message instead of the model-facing refusal text', () => {
    const source = fs.readFileSync(path.join(rendererRoot, 'modules/agents.js'), 'utf8');
    const match = source.match(/function _agentMemoryFailureText\(res, fallback\) \{[\s\S]*?\n\}/);
    expect(match).not.toBeNull();
    const text = vm.runInNewContext(`(${match?.[0]})`, { t: (key: string) => key }) as (res: any, fallback: string) => string;
    const refused = { ok: false, error: 'memory full: the agent store would hold 17/16 entries. Consolidate it first: merge related entries with replace or remove outdated ones, then retry.' };
    expect(text(refused, 'fallback')).toBe('memory.error_full');
    expect(text({ ok: false, error: 'old_text not found' }, 'fallback')).toBe('fallback');
    expect(text(null, 'fallback')).toBe('fallback');
    // Every agent-memory add/edit failure goes through the helper.
    expect(source).not.toMatch(/uiAlert\(\(res && res\.error\) \|\| _agentLabel\('agents\.memory_update_failed'/);
  });
});

describe('full-memory copy', () => {
  it('exists in every locale and never asks the user to delete or edit entries', () => {
    const forbidden = /\b(delete|remove|edit)\b|删除|修改|編集|削除/i;
    for (const [locale, table] of Object.entries(locales)) {
      for (const key of ['memory.full_notice', 'memory.error_full']) {
        expect(typeof table[key], `${locale} ${key}`).toBe('string');
        expect(table[key].trim(), `${locale} ${key}`).not.toBe('');
        expect(table[key], `${locale} ${key}`).not.toBe(key);
      }
      if (locale === 'en' || locale === 'zh' || locale === 'ja') {
        expect(`${table['memory.full_notice']} ${table['memory.error_full']}`, locale).not.toMatch(forbidden);
      }
    }
  });
});
