import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const renderer = path.join(__dirname, '../../src/renderer');
const source = readFileSync(path.join(renderer, 'modules/agents.js'), 'utf8');
const locales = Object.fromEntries(['en', 'zh'].map(locale => [locale,
  JSON.parse(readFileSync(path.join(renderer, `locales/${locale}.json`), 'utf8'))]));

function memoryAction(action: 'add' | 'edit' | 'remove', options: { locale?: 'en' | 'zh'; commander?: boolean } = {}) {
  const locale = options.locale || 'en';
  let click: ((event: any) => Promise<void>) | undefined;
  const alerts: string[] = [], warnings: any[] = [];
  const invoke = vi.fn<(channel: string, payload?: any) => Promise<any>>(async () => ({ ok: true }));
  const host = { querySelectorAll: (selector: string) => selector === `[data-agent-memory-${action}]` ? [{
    getAttribute: () => 'Synthetic saved fact',
    addEventListener: (_type: string, listener: any) => { click = listener; },
  }] : [] };
  const context: any = {
    console, setTimeout, clearTimeout,
    createLogger: () => ({ warn: (...args: any[]) => warnings.push(args), info() {}, error() {} }),
    document: { readyState: 'loading', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null },
    window: { addEventListener() {}, orkas: { invoke } },
    getLang: () => locale,
    t: (key: string) => locales[locale][key] || key,
    normalizeCatalogSource: (value: string) => value || '',
    uiPrompt: vi.fn(async () => 'Synthetic new fact'),
    uiConfirm: vi.fn(async () => true),
    uiAlert: (message: string) => { alerts.push(message); },
  };
  vm.createContext(context); vm.runInContext(source, context, { filename: 'agents.js' });
  const refresh = vi.fn(async () => {});
  context.loadAgents = refresh; context._refreshAgentDetail = vi.fn(async () => {});
  context.host = host; context.agent = { agent_id: options.commander ? 'commander' : 'fixture-agent', source: 'custom' };
  vm.runInContext('_wireAgentMemoryControls(host, agent)', context);
  if (!click) throw new Error('Memory action was not wired');
  return { context, invoke, alerts, warnings, refresh, run: () => click!({ preventDefault() {} }),
    failureText: locales[locale]['memory.error_generic'], fullText: locales[locale]['memory.error_full'] };
}

describe('Agent memory action outcomes', () => {
  it('has the shared recovery message in every registered locale', () => {
    const supported = vm.runInNewContext(readFileSync(path.join(renderer, 'modules/i18n.js'), 'utf8')
      + '; getSupportedLanguages()', { createLogger: () => ({ warn() {} }), window: {} }) as Array<{ code:string }>;
    expect(supported.length).toBeGreaterThan(0);
    for (const { code } of supported) {
      const table = JSON.parse(readFileSync(path.join(renderer, `locales/${code}.json`), 'utf8'));
      expect(typeof table['memory.error_generic'], code).toBe('string');
      expect(table['memory.error_generic'].trim(), code).not.toBe('');
      expect(table['memory.error_generic'], code).not.toBe('memory.error_generic');
    }
  });

  for (const action of ['add', 'edit', 'remove'] as const) {
    it.each([
      { locale:'en' as const, thrown:false }, { locale:'zh' as const, thrown:false },
      { locale:'en' as const, thrown:true }, { locale:'zh' as const, thrown:true },
    ])(`${action} hides raw errors ($locale, thrown=$thrown)`, async ({ locale, thrown }) => {
      const h = memoryAction(action, { locale });
      const marker = 'PRIVATE_AGENT_MEMORY_DIAGNOSTIC';
      h.invoke.mockImplementation(async () => { if (thrown) throw new Error(marker); return { ok: false, error: marker }; });
      await h.run();
      expect(h.alerts).toEqual([h.failureText]);
      expect(JSON.stringify([h.alerts, h.warnings])).not.toContain(marker);

    });

    it.each(['list', 'detail'])(`${action} preserves a successful write when %s refresh fails`, async phase => {
      const h = memoryAction(action);
      (phase === 'list' ? h.refresh : h.context._refreshAgentDetail).mockRejectedValue(new Error('PRIVATE_REFRESH_DIAGNOSTIC'));
      await h.run();
      expect(h.alerts).toEqual([]);

      expect(h.warnings).toEqual([['agent memory refresh failed', { error_code: 'refresh_failed' }]]);
    });

    it.each([null, undefined])(`${action} reports a missing IPC reply without refreshing (%s)`, async response => {
      const h = memoryAction(action); h.invoke.mockResolvedValue(response); await h.run();
      expect(h.alerts).toEqual([h.failureText]); expect(h.refresh).not.toHaveBeenCalled();

    });

    it(`${action} preserves the full-store message`, async () => {
      const h = memoryAction(action);
      h.invoke.mockResolvedValue({ ok: false, error: 'memory full: synthetic capacity refusal' } as any);
      await h.run();
      expect(h.alerts).toEqual([h.fullText]); expect(h.refresh).not.toHaveBeenCalled();
    });

    it.each([false, true])(`${action} preserves the ordinary IPC route (commander=%s)`, async commander => {
      const h = memoryAction(action, { commander }); await h.run();
      const operation = { add:'add', edit:'replace', remove:'remove' }[action];
      const channel = commander ? `memory.${operation}` : `agents.memory.${action === 'edit' ? 'update' : action}`;
      const content = action === 'remove' ? {} : { content:'Synthetic new fact' };
      const selector = action === 'add' ? {} : commander
        ? { oldText:'Synthetic saved fact' } : { old_text:'Synthetic saved fact' };
      const identity = commander ? { target:'agent', agentId:'commander' } : { agent_id:'fixture-agent' };
      expect(h.invoke).toHaveBeenCalledExactlyOnceWith(channel, { ...identity, ...content, ...selector });
      expect(h.alerts).toEqual([]); expect(h.refresh).toHaveBeenCalledOnce();

    });
  }

  it.each(['', '   ', 'Synthetic saved fact'])('does not submit an empty or unchanged edit (%s)', async text => {
    const h = memoryAction('edit'); h.context.uiPrompt.mockResolvedValue(text); await h.run();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('does not write when the prompt or deletion confirmation is cancelled', async () => {
    for (const action of ['add', 'edit', 'remove'] as const) {
      const h = memoryAction(action); h.context.uiPrompt.mockResolvedValue(null); h.context.uiConfirm.mockResolvedValue(false);
      await h.run(); expect(h.invoke).not.toHaveBeenCalled();
    }
  });
});
