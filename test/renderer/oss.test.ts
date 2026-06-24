import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

// oss.js is a classic renderer script (globals, no exports). We load it into a
// Node VM with a fake DOM + the renderer globals it depends on, the same way
// category-tabs.test.ts exercises agents.js / skills.js.

class FakeClassList {
  classes = new Set<string>();
  add(c: string) { this.classes.add(c); }
  remove(c: string) { this.classes.delete(c); }
  contains(c: string) { return this.classes.has(c); }
}

class FakeInput {
  value = '';
  focused = false;
  classList = new FakeClassList();
  style: Record<string, string> = {};
  events: string[] = [];
  dataset: Record<string, string> = {};
  selection: [number, number] | null = null;
  focus() { this.focused = true; }
  setSelectionRange(a: number, b: number) { this.selection = [a, b]; }
  dispatchEvent(e: any) { this.events.push(e?.type || 'event'); return true; }
  addEventListener() {}
  querySelectorAll() { return []; }
}

interface LoadOpts {
  invoke?: (channel: string, payload?: unknown) => Promise<any>;
  lang?: string;
}

function loadOss(opts: LoadOpts = {}) {
  const elements = new Map<string, FakeInput>();
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new FakeInput());
    return elements.get(id)!;
  };
  let invokeCount = 0;
  const invokeCalls: Array<{ channel: string; payload: any }> = [];
  const calls = { setView: [] as string[], setRecipient: [] as any[], openMarketplace: [] as string[] };

  const context: any = {
    console,
    setTimeout,
    Event: class { type: string; constructor(t: string) { this.type = t; } },
    createLogger: () => ({ warn() {}, error() {}, info() {} }),
    document: {
      getElementById: (id: string) => el(id),
      addEventListener: () => {},
      querySelectorAll: () => [],
    },
    window: {
      addEventListener: () => {},
      dispatchEvent: () => true,
    } as any,
    escapeHtml: (s: unknown) => String(s ?? ''),
    uiIconHtml: () => '<svg></svg>',
    getLang: () => opts.lang || 'zh',
    pickLocalizedName: (c: any) => c?.name_zh || c?.name_en || c?.code || '',
    t: (key: string) => {
      if (key === 'oss.prompt') return 'Use {name} ({url}) to help me with: [describe your task here]. Install from {url} if {name} is not present.';
      if (key === 'oss.office_prompt') return 'OfficeCLI is built in. Use built-in Office tools for: [describe your task here].';
      if (key === 'oss.install_prompt') return 'Please install the open-source project {name} ({url}) for me.';
      if (key === 'oss.office_install_prompt') return 'OfficeCLI is already built in as Office tools. Briefly explain what it can do.';
      return key;
    },
    setView: (v: string) => { calls.setView.push(v); },
    setChatRecipient: (target: string, next: any) => { calls.setRecipient.push({ target, next }); },
    openMarketplace: (tab: string) => { calls.openMarketplace.push(tab); },
  };
  context.window.orkas = {
    invoke: opts.invoke || (async (channel: string) => {
      if (channel === 'marketplace.getListingsCache') return { entries: {} };
      if (channel === 'marketplace.mergeListingsCache') return { ok: true };
      return { list: [], categories: [] };
    }),
  };
  // wrap default invoke to count
  const baseInvoke = context.window.orkas.invoke;
  context.window.orkas.invoke = async (...a: any[]) => {
    invokeCount++;
    invokeCalls.push({ channel: a[0], payload: a[1] });
    return baseInvoke(...a);
  };

  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/oss.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'oss.js' });
  return { context, el, calls, invokeCount: () => invokeCount, invokeCalls };
}

describe('oss.js', () => {
  it('prefillCommander writes the task, focuses, sets the Commander recipient, and does NOT send', () => {
    const { context, el, calls } = loadOss();
    context.prefillCommander('帮我做一段产品开场动画');
    const input = el('new-chat-input');
    expect(input.value).toBe('帮我做一段产品开场动画');
    expect(input.focused).toBe(true);
    expect(input.events).toContain('input');           // triggers autoGrow, not a send
    expect(input.classList.contains('is-prefilled')).toBe(true);
    expect(calls.setView).toContain('new-chat');
    expect(calls.setRecipient[0]).toEqual({ target: 'new-chat', next: { kind: 'commander' } });
  });

  it('prefillCommander ignores empty input', () => {
    const { context, calls } = loadOss();
    context.prefillCommander('');
    expect(calls.setView).toEqual([]);
  });

  it('loadOssCatalog uses bundled cache first, then refreshes without duplicate calls', async () => {
    const payload = {
      list: [{ id: 'x', name: 'X', task_zh: 't', task_en: 't', category: 'anim', driver: 'cli', stars: 10 }],
      categories: [{ code: 'anim', name_zh: '动画', name_en: 'Animation' }],
    };
    const { context, invokeCalls } = loadOss({
      invoke: async (channel) => {
        if (channel === 'marketplace.getListingsCache') return { entries: {} };
        if (channel === 'marketplace.mergeListingsCache') return { ok: true };
        return payload;
      },
    });
    const a = await context.loadOssCatalog();
    const b = await context.loadOssCatalog();
    expect(a.projects).toHaveLength(1);
    expect(a.categories).toHaveLength(1);
    expect(b.projects).toHaveLength(1);
    const listCalls = invokeCalls.filter((c) => c.channel === 'marketplace.listProjects');
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0].payload).toEqual({ local_only: true });
    expect(listCalls[1].payload).toEqual({});
  });

  it('loadOssCatalog returns disk cache first and refreshes once in the background', async () => {
    const cachedProject = { id: 'cached', name: 'Cached', task_zh: '旧', task_en: 'old', category: 'anim', driver: 'cli' };
    const freshPayload = {
      source: 'server',
      list: [{ id: 'fresh', name: 'Fresh', task_zh: '新', task_en: 'new', category: 'anim', driver: 'cli' }],
      categories: [{ code: 'anim', name_zh: '动画', name_en: 'Animation' }],
      total: 1,
    };
    let resolveList: (value: unknown) => void = () => {};
    const listPromise = new Promise((resolve) => { resolveList = resolve; });
    const { context, invokeCalls } = loadOss({
      invoke: async (channel) => {
        if (channel === 'marketplace.getListingsCache') {
          return {
            entries: {
              'project|home|||': { items: [cachedProject], categories: [], total: 1, ts: Date.now() },
            },
          };
        }
        if (channel === 'marketplace.mergeListingsCache') return { ok: true };
        return listPromise;
      },
    });

    const a = await context.loadOssCatalog({ homeOnly: true });
    const b = await context.loadOssCatalog({ homeOnly: true });

    expect(a.projects.map((p: any) => p.id)).toEqual(['cached']);
    expect(b.projects.map((p: any) => p.id)).toEqual(['cached']);
    expect(invokeCalls.filter((c) => c.channel === 'marketplace.listProjects')).toHaveLength(1);

    resolveList(freshPayload);
    await listPromise;
    await Promise.resolve();
    const c = await context.loadOssCatalog({ homeOnly: true, revalidate: false });
    expect(c.projects.map((p: any) => p.id)).toEqual(['fresh']);
  });

  it('loadOssCatalog stores bundled fallback as stale cache', async () => {
    const { context, invokeCalls } = loadOss({
      invoke: async (channel) => {
        if (channel === 'marketplace.getListingsCache') return { entries: {} };
        if (channel === 'marketplace.mergeListingsCache') return { ok: true };
        return {
          source: 'bundled',
          stale: true,
          list: [{ id: 'bundled', name: 'Bundled', task_zh: '本地', task_en: 'local', category: 'anim', driver: 'cli' }],
          categories: [],
          total: 1,
        };
      },
    });

    await context.loadOssCatalog({ homeOnly: true });

    const merge = invokeCalls.find((c) => c.channel === 'marketplace.mergeListingsCache');
    expect(merge?.payload.entries['project|home|||'].ts).toBe(0);
  });

  it('loadOssCatalog does not replace real cache with bundled fallback', async () => {
    const cachedProject = { id: 'server-cached', name: 'Server Cached', task_zh: '缓存', task_en: 'cached', category: 'anim', driver: 'cli' };
    const { context } = loadOss({
      invoke: async (channel) => {
        if (channel === 'marketplace.getListingsCache') {
          return {
            entries: {
              'project|home|||': { items: [cachedProject], categories: [], total: 1, ts: Date.now() },
            },
          };
        }
        if (channel === 'marketplace.mergeListingsCache') return { ok: true };
        return {
          source: 'bundled',
          stale: true,
          list: [{ id: 'bundled', name: 'Bundled', task_zh: '本地', task_en: 'local', category: 'anim', driver: 'cli' }],
          categories: [],
          total: 1,
        };
      },
    });

    await context.loadOssCatalog({ homeOnly: true });
    await Promise.resolve();
    const current = await context.loadOssCatalog({ homeOnly: true, revalidate: false });

    expect(current.projects.map((p: any) => p.id)).toEqual(['server-cached']);
  });

  it('homepage cold-start refreshes once per renderer boot even when the cached entry is fresh', async () => {
    // Behavior contract: a just-launched OSS project must reach users on their
    // next app open, so cold-start has NO staleness gate — it always does one
    // background refresh per boot, even when the cached entry is brand new.
    const cachedProject = { id: 'warm', name: 'Warm', task_zh: '缓存', task_en: 'cached', category: 'anim', driver: 'cli' };
    let resolveList: (value: unknown) => void = () => {};
    const listPromise = new Promise((resolve) => { resolveList = resolve; });
    const { context, invokeCalls } = loadOss({
      invoke: async (channel) => {
        if (channel === 'marketplace.getListingsCache') {
          return {
            entries: {
              'project|home|||': { items: [cachedProject], categories: [], total: 1, ts: Date.now() },
            },
          };
        }
        if (channel === 'marketplace.mergeListingsCache') return { ok: true };
        return listPromise;
      },
    });

    // Cached entry paints immediately...
    const data = await context.loadOssCatalog({ homeOnly: true, revalidate: 'cold-start' });
    expect(data.projects.map((p: any) => p.id)).toEqual(['warm']);
    // ...but a background refresh still fires this boot despite the fresh cache.
    expect(invokeCalls.filter((c) => c.channel === 'marketplace.listProjects')).toHaveLength(1);

    resolveList({
      source: 'server',
      list: [{ id: 'fresh', name: 'Fresh', task_zh: '新', task_en: 'new', category: 'anim', driver: 'cli' }],
      categories: [],
      total: 1,
    });
    await listPromise;
    await Promise.resolve();
    const current = await context.loadOssCatalog({ homeOnly: true, revalidate: false });
    expect(current.projects.map((p: any) => p.id)).toEqual(['fresh']);
  });

  it('homepage cold-start policy refreshes at most once per renderer boot', async () => {
    const cachedProject = { id: 'old', name: 'Old', task_zh: '旧', task_en: 'old', category: 'anim', driver: 'cli' };
    let resolveList: (value: unknown) => void = () => {};
    const listPromise = new Promise((resolve) => { resolveList = resolve; });
    const { context, invokeCalls } = loadOss({
      invoke: async (channel) => {
        if (channel === 'marketplace.getListingsCache') {
          return {
            entries: {
              'project|home|||': { items: [cachedProject], categories: [], total: 1, ts: Date.now() },
            },
          };
        }
        if (channel === 'marketplace.mergeListingsCache') return { ok: true };
        return listPromise;
      },
    });

    await context.loadOssCatalog({ homeOnly: true, revalidate: 'cold-start' });
    await context.loadOssCatalog({ homeOnly: true, revalidate: 'cold-start' });

    expect(invokeCalls.filter((c) => c.channel === 'marketplace.listProjects')).toHaveLength(1);
    resolveList({
      source: 'server',
      list: [{ id: 'fresh', name: 'Fresh', task_zh: '新', task_en: 'new', category: 'anim', driver: 'cli' }],
      categories: [],
      total: 1,
    });
    await listPromise;
    await Promise.resolve();
    const current = await context.loadOssCatalog({ homeOnly: true, revalidate: false });
    expect(current.projects.map((p: any) => p.id)).toEqual(['fresh']);
  });

  it('loadOssCatalog passes home/search/category options through to Server', async () => {
    const { context, invokeCalls } = loadOss({
      invoke: async (channel) => {
        if (channel === 'marketplace.getListingsCache') return { entries: {} };
        if (channel === 'marketplace.mergeListingsCache') return { ok: true };
        return { list: [], categories: [] };
      },
    });
    await context.loadOssCatalog({ homeOnly: true });
    await context.loadOssCatalog({ category: 'rag', q: 'llama', size: 100 });
    const listCalls = invokeCalls.filter((c) => c.channel === 'marketplace.listProjects');
    expect(listCalls.map((c) => c.payload)).toEqual([
      { home_only: true, local_only: true },
      { home_only: true },
      { category: 'rag', q: 'llama', size: 100, local_only: true },
      { category: 'rag', q: 'llama', size: 100 },
    ]);
  });

  it('ossGithubUrl derives the repo page', () => {
    const { context } = loadOss();
    expect(context.ossGithubUrl({ repo: 'hugohe3/ppt-master' })).toBe('https://github.com/hugohe3/ppt-master');
    expect(context.ossGithubUrl({ repo: '' })).toBe('');
  });

  it('ossPromptFor names the project + url and leaves the task blank', () => {
    const { context } = loadOss();
    const prompt = context.ossPromptFor({ name: 'PPT-Master', repo: 'hugohe3/ppt-master' });
    expect(prompt).toContain('PPT-Master');
    expect(prompt).toContain('https://github.com/hugohe3/ppt-master');
    expect(prompt).toMatch(/\[[^\]]+\]/); // a blank task placeholder remains
  });

  it('ossPromptFor tells OfficeCLI to use built-in Office tools', () => {
    const { context } = loadOss();
    const prompt = context.ossPromptFor({ id: 'OfficeCLI', name: 'OfficeCLI', repo: 'iOfficeAI/OfficeCLI' });
    expect(prompt).toContain('OfficeCLI is built in');
    expect(prompt).toContain('built-in Office tools');
    expect(prompt).not.toContain('https://github.com/iOfficeAI/OfficeCLI');
    expect(prompt).not.toContain('create_docx');
    expect(prompt.toLowerCase()).not.toContain('install');
    expect(prompt).toMatch(/\[[^\]]+\]/);
  });

  it('ossInstallPromptFor is an install request with no blank task slot', () => {
    const { context } = loadOss();
    const prompt = context.ossInstallPromptFor({ name: 'PPT-Master', repo: 'hugohe3/ppt-master' });
    expect(prompt).toContain('PPT-Master');
    expect(prompt).toContain('https://github.com/hugohe3/ppt-master');
    expect(prompt.toLowerCase()).toContain('install');
    expect(prompt).not.toMatch(/\[[^\]]*\]/); // no task placeholder — nothing to fill in
  });

  it('ossInstallPromptFor explains bundled OfficeCLI instead of installing it', () => {
    const { context } = loadOss();
    const prompt = context.ossInstallPromptFor({ id: 'OfficeCLI', name: 'OfficeCLI', repo: 'iOfficeAI/OfficeCLI' });
    expect(prompt).toContain('OfficeCLI is already built in as Office tools');
    expect(prompt).not.toContain('https://github.com/iOfficeAI/OfficeCLI');
    expect(prompt.toLowerCase()).not.toContain('install');
    expect(prompt).not.toMatch(/\[[^\]]*\]/);
  });

  it('prefillCommander selects the [...] placeholder so the user types over it', () => {
    const { context, el } = loadOss();
    const prompt = context.ossPromptFor({ name: 'X', repo: 'o/x' });
    context.prefillCommander(prompt);
    const input = el('new-chat-input');
    const m = prompt.match(/\[[^\]]*\]/)!;
    expect(input.selection).toEqual([m.index, m.index! + m[0].length]);
  });

  it('ossTaskFor / ossDescFor pick the active language', () => {
    const zh = loadOss({ lang: 'zh' }).context;
    const en = loadOss({ lang: 'en' }).context;
    const p = { task_zh: '中文', task_en: 'english', description_zh: '描述', description_en: 'desc' };
    expect(zh.ossTaskFor(p)).toBe('中文');
    expect(en.ossTaskFor(p)).toBe('english');
    expect(zh.ossDescFor(p)).toBe('描述');
    expect(en.ossDescFor(p)).toBe('desc');
  });

  it('maps the slides category to the presentation icon', () => {
    const { context } = loadOss();
    expect(context.ossIconFor('slides')).toBe('presentation');
  });
});
