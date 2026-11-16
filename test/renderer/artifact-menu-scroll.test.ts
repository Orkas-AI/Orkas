import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';
import { MiniDocument, MiniEvent } from './helpers/mini-dom';

it('keeps a stationary card menu usable and dismisses it when its anchor moves or Escape is pressed', async () => {
  const document = new MiniDocument();
  const listeners = new Map<string, Array<() => void>>();
  const context: any = { document, innerWidth: 1280, innerHeight: 800,
    MutationObserver: class { observe() {} },
    window: { innerWidth: 1280, innerHeight: 800,
      addEventListener(name: string, handler: () => void) { listeners.set(name, [...(listeners.get(name) || []), handler]); },
      OrkasWebAppHost: { open: vi.fn(), release: vi.fn() },
      orkas: { invoke: async () => ({ ok: true, status: 'ok', appType: 'local' }) } } };
  context.globalThis = context.window;
  vm.createContext(context);
  for (const name of ['artifact-security', 'chat-artifact']) vm.runInContext(
    readFileSync(path.resolve(__dirname, '../../src/renderer/modules/' + name + '.js'), 'utf8'), context);
  const host = document.createElement('div'); document.body.appendChild(host);
  context.window.renderChatArtifact(host, { cid: 'chat', artifactId: 'one', title: 'App', agentId: 'commander' });
  const button = host.querySelector('.chat-artifact-more')!;
  let top = 10;
  button.getBoundingClientRect = () => ({ top, left: 10, right: 32, bottom: top + 22, width: 22, height: 22 });
  const open = async () => { button.click(); for (let i = 0; i < 8; i++) await Promise.resolve(); };
  await open();
  const menu = document.querySelector('.chat-artifact-menu')!;
  expect(menu.style.display).not.toBe('none');
  for (const listener of listeners.get('scroll') || []) listener();
  expect(menu.style.display).not.toBe('none');
  expect(menu.querySelector('[data-action="reload"]')!.textContent).toBe('Reload');
  top += 1;
  for (const listener of listeners.get('scroll') || []) listener();
  expect(menu.style.display).toBe('none');
  await open();
  expect(menu.style.display).not.toBe('none');
  document.body.dispatchEvent(new MiniEvent('keydown', { key: 'Escape' }));
  expect(menu.style.display).toBe('none');
});
