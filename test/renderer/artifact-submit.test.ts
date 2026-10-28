import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

function setup(failOpen = false) {
  const listeners = new Map<string, Function[]>();
  const frames: any[] = [];
  function element(tag = 'div'): any {
    const events = new Map<string, Function[]>();
    const e: any = { tagName: tag, dataset: {}, style: {}, children: [], isConnected: true,
      classList: { contains: () => false }, addEventListener(t: string, fn: Function) { events.set(t, [...(events.get(t) || []), fn]); },
      dispatchEvent(ev: any) { for (const fn of events.get(ev.type) || []) fn(ev); return !ev.defaultPrevented; },
      removeAttribute(k: string) { delete this[k]; },
      remove() { this.parentNode.children = this.parentNode.children.filter((c: any) => c !== this); },
      insertBefore(child: any) { this.appendChild(child); }, querySelector: () => null,
      setAttribute(k: string, v: string) { this[k] = v; }, getAttribute(k: string) { return this[k]; },
      appendChild(child: any) { this.children.push(child); child.parentNode = this; } };
    e.cloneNode = () => Object.assign(element(tag), { dataset: { ...e.dataset }, style: { ...e.style }, className: e.className });
    e.replaceChild = (next: any, previous: any) => {
      e.children[e.children.indexOf(previous)] = next; next.parentNode = e;
      previous.parentNode = null; previous.isConnected = false;
    };
    if (tag === 'iframe') { e.contentWindow = {}; frames.push(e); }
    return e;
  }
  const invoke = vi.fn(async channel => channel === 'webApps.open'
    ? failOpen ? { ok: false, error: 'Could not open' } : { ok: true, token: 'a'.repeat(32), url: 'chat-app://app-fixture/index.html', sdkVersion: 1 }
    : channel === 'webApps.canSubmitArtifact' ? { ok: true, allowed: true } : {});
  const send = vi.fn(async () => ({}));
  const alert = vi.fn();
  const context: any = { URL, uiAlert: alert, CustomEvent: class { type: string; detail: any; defaultPrevented = false; cancelable: boolean; constructor(type: string, options: any = {}) { this.type = type; this.detail = options.detail; this.cancelable = options.cancelable; } preventDefault() { if (this.cancelable) this.defaultPrevented = true; } }, currentCid: 'source-chat', sendInCurrentConversation: send,
    document: { createElement: element, querySelectorAll: () => frames, documentElement: {} },
    MutationObserver: class { observe() {} },
    window: { orkas: { invoke }, addEventListener(type: string, fn: Function) {
      listeners.set(type, [...(listeners.get(type) || []), fn]);
    } } };
  context.globalThis = context.window;
  vm.createContext(context);
  for (const name of ['artifact-security', 'commercial-entry', 'web-app-host', 'chat-artifact'])
    vm.runInContext(readFileSync(path.resolve(__dirname, `../../src/renderer/modules/${name}.js`), 'utf8'), context);
  context.window.renderChatArtifact(element(), { cid: 'source-chat', artifactId: 'artifact', agentId: 'commander', title: 'Form' });
  const frame = frames[0];
  const event = (payload: unknown = { answer: 'ready' }) => ({ source: frame.contentWindow, origin: 'chat-app://app-fixture',
    data: { __orkasArtifact: true, type: 'submit', payload, cid: 'attacker-chat', agentId: 'attacker' } });
  const dispatch = async (ev = event()) => { for (const fn of listeners.get('message') || []) await fn(ev); };
  return { context, frame, invoke, send, event, dispatch, alert, element, frames };
}

it('submits a local SDK result through the owning chat and ignores caller-supplied routing', async () => {
  const h = setup(); await vi.waitFor(() => expect(h.frame.src).toBe('chat-app://app-fixture/index.html'));
  await h.dispatch();
  expect(h.send).toHaveBeenCalledOnce();
  expect(h.send.mock.calls[0][0]).toContain('"answer":"ready"');
  expect(h.send.mock.calls[0][0]).not.toContain('attacker');
  h.invoke.mockResolvedValueOnce({ ok: true, allowed: false });
  await h.dispatch(); expect(h.send).toHaveBeenCalledOnce();
  await h.dispatch({ ...h.event(), origin: 'https://external.invalid' });
  expect(h.send).toHaveBeenCalledOnce();
});

it.each(['chat-switch', 'frame-replaced', 'frame-removed', 'artifact-rebound'])(
  'discards an in-flight SDK submission after %s without sending to the new target', async change => {
    const h = setup(); await vi.waitFor(() => expect(h.frame.src).toBe('chat-app://app-fixture/index.html'));
    let release!: (value: any) => void;
    h.invoke.mockImplementationOnce(async () => new Promise(resolve => { release = resolve; }));
    const pending = h.dispatch(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    if (change === 'chat-switch') h.context.currentCid = 'another-chat';
    if (change === 'frame-removed') h.frame.isConnected = false;
    if (change === 'artifact-rebound') h.frame.dataset.artifactId = 'another-artifact';
    if (change === 'frame-replaced') h.context.window.OrkasWebAppHost.attach(h.frame,
      { token: 'b'.repeat(32), url: 'chat-app://app-new/index.html', sdkVersion: 1 });
    expect(release).toBeTypeOf('function'); release({ ok: true, allowed: true });
    await pending; expect(h.send).not.toHaveBeenCalled();
  });


it('keeps automatic failures in each card and retries only the selected card', async () => {
  const h = setup(true);
  h.context.window.renderChatArtifact(h.element(), { cid: 'source-chat', artifactId: 'second' });
  await vi.waitFor(() => expect(h.frames.every(f => f._orkasUnavailablePanel)).toBe(true));
  expect(h.alert).not.toHaveBeenCalled();
  const retry = h.frame._orkasUnavailablePanel.children.flatMap((c: any) => c.children).find((c: any) => c.tagName === 'button');
  expect(retry).toBeDefined();
  h.invoke.mockImplementation(async channel => channel === 'webApps.open'
    ? { ok: true, token: 'a'.repeat(32), url: 'chat-app://app-fixture/index.html' } : {});
  retry.dispatchEvent({ type: 'click' });
  await vi.waitFor(() => expect(h.frames.at(-1).src).toBe('chat-app://app-fixture/index.html'));
  expect(h.frames.at(-1)._orkasUnavailablePanel).toBeFalsy();
  expect(h.frames[1]._orkasUnavailablePanel).toBeTruthy();
});

it('keeps explicit viewer feedback and ignores removed frames', async () => {
  const h = setup(); await vi.waitFor(() => expect(h.frame.src).toBeTruthy());
  h.invoke.mockResolvedValue({ ok: false, error: 'Could not open' });
  const viewer = h.element('iframe');
  await h.context.window.OrkasWebAppHost.open(viewer, {});
  expect(h.alert).toHaveBeenCalledTimes(1);
  viewer.isConnected = false;
  await h.context.window.OrkasWebAppHost.open(viewer, {});
  expect(h.alert).toHaveBeenCalledTimes(1);
});
