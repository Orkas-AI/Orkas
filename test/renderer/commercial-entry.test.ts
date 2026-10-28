import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(path.resolve('src/renderer/modules/commercial-entry.js'), 'utf8');
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  isConnected = true;
  textContent = '';
  className = '';
  type = '';
  focus = vi.fn();
  events = new Map<string, () => unknown>();
  append(...children: Element[]) { this.children.push(...children); }
  appendChild(child: Element) { this.children.push(child); return child; }
  querySelector() { return null; }
  addEventListener(name: string, handler: () => unknown) { this.events.set(name, handler); }
  async click() { await this.events.get('click')?.(); }
}
function harness(language = 'en') {
  const focus = new Element();
  const invoke = vi.fn(async () => ({ ok: true }));
  const confirm = vi.fn(async () => false);
  const alert = vi.fn(async () => {});
  const table = JSON.parse(fs.readFileSync(path.resolve(`src/renderer/locales/${language}.json`), 'utf8'));
  const context = { window: { orkas: { invoke } } as any, currentCid: 'task', URL,
    document: { activeElement: focus, createElement: () => new Element() },
    getLang: () => language, t: (key: string) => table[key] || key, uiConfirm: confirm, uiAlert: alert };
  vm.runInNewContext(source, context);
  return { api: context.window.OrkasCommercialEntry, invoke, confirm, alert, focus, table };
}
describe('commercial entry actions', () => {
  it('cancels without opening a link and restores the invoking control', async () => {
    const h = harness();
    await h.api.show();
    expect(h.confirm).toHaveBeenCalledWith({ message: h.table['apps.commercial_required'],
      okLabel: h.table['apps.commercial_download'], cancelLabel: h.table['common.cancel'] });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.focus.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });
  it.each(['zh', 'zh-tw', 'en', 'fr', 'de', 'hi', 'id', 'it', 'ja', 'ko', 'pt', 'pt-pt', 'ru', 'es', 'es-419', 'th', 'tr', 'vi', 'ar'])('opens the official download page only after confirmation (%s)', async language => {
    const h = harness(language);
    h.confirm.mockResolvedValue(true);
    expect(h.invoke).not.toHaveBeenCalled();
    await h.api.show();
    const webLanguage = language.startsWith('zh') ? 'zh' : language.startsWith('pt') ? 'pt' : language === 'ja' ? 'ja' : 'en';
    expect(h.invoke).toHaveBeenCalledExactlyOnceWith('auth.openExternal', { url: `https://orkas.ai/download/?lang=${webLanguage}` });
    for (const key of ['apps.commercial_required', 'apps.commercial_download', 'apps.commercial_open_failed']) {
      expect(typeof h.table[key]).toBe('string'); expect(h.table[key].trim()).not.toBe('');
    }
  });
  it.each(['rejection', 'exception'])('keeps a failed opener recoverable without app operations: %s', async mode => {
    const h = harness(); h.confirm.mockResolvedValue(true);
    if (mode === 'exception') h.invoke.mockRejectedValueOnce(new Error('Fixture opener failure'));
    else h.invoke.mockResolvedValueOnce({ ok: false });
    await h.api.show();
    expect(h.alert).toHaveBeenCalledExactlyOnceWith(h.table['apps.commercial_open_failed']);
    await h.api.show();
    expect(h.invoke.mock.calls.map(call => call[0])).toEqual(['auth.openExternal', 'auth.openExternal']);
  });
  it('coalesces simultaneous entry actions into one standard dialog', async () => {
    const h = harness(); let finish!: (accepted: boolean) => void;
    h.confirm.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const a = h.api.show(), b = h.api.show();
    expect(a).toBe(b); expect(h.confirm).toHaveBeenCalledOnce();
    finish(false); await a; expect(h.invoke).not.toHaveBeenCalled();
  });
  it('recognizes only an explicit publication refusal receipt', () => {
    const h = harness();
    expect(h.api.isFailure({ok:false, code:'E_COMMERCIAL_REQUIRED', feature:'web_apps'})).toBe(true);
    for (const value of ['Publish requires commercial Orkas', null, {ok:true,code:'E_COMMERCIAL_REQUIRED',feature:'web_apps'},
      {ok:false,code:'E_COMMERCIAL_REQUIRED',feature:'other'}, {ok:false,code:'E_FAILED',feature:'web_apps'}]) expect(h.api.isFailure(value)).toBeFalsy();
  });
});
