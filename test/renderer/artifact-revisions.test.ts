import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';
import { MiniDocument } from './helpers/mini-dom';

it('refreshes one card for corrections across streamed events and history while keeping independent apps and chats separate', () => {
  const document = new MiniDocument();
  const open = vi.fn();
  const context: any = { document, CSS: { escape: (value: string) => value },
    MutationObserver: class { observe() {} },
    window: { addEventListener() {}, OrkasWebAppHost: { open, release: vi.fn() },
      orkas: { invoke: async () => ({ ok: true, status: 'ok', appType: 'local' }) } } };
  context.globalThis = context.window;
  vm.createContext(context);
  for (const module of ['artifact-security', 'chat-artifact']) vm.runInContext(
    readFileSync(path.resolve(__dirname, `../../src/renderer/modules/${module}.js`), 'utf8'), context);
  const bubble = () => { const node = document.createElement('div'); document.body.appendChild(node); return node; };
  const first = bubble(), next = bubble();
  const conversation = readFileSync(path.resolve(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
  Object.assign(context, { _normalizeCreatedAgents: () => false, _normalizeCreatedSkills: () => false,
    _processItemsHaveRenderableLine: () => false, _isInterruptedAssistantMessage: () => false });
  vm.runInContext(conversation.slice(conversation.indexOf('function _messageRecordHasMountedSidecars('),
    conversation.indexOf('\nfunction _processItemsHaveRenderableLine(')), context);
  const mount = (host: any, revision: number, title = 'Chat', id = 'one', cid = 'chat') =>
    context.window.mountMessageArtifacts(host, [{ id, title, revision, agent_id: 'builder' }], cid);
  mount(first, 1); mount(first, 1);
  expect(open).toHaveBeenCalledTimes(1);
  mount(next, 2, 'Corrected');
  expect(document.querySelectorAll('.chat-artifact-card')).toHaveLength(1);
  expect(first.querySelector('iframe')!.dataset.artifactId).toBe('one');
  expect(first.querySelector('.chat-artifact-title')!.textContent).toBe('Corrected');
  expect(context._messageRecordHasMountedSidecars({ artifacts: [{ id: 'one' }] }, next, { cid: 'chat' })).toBe(true);
  expect(context._messageRecordHasMountedSidecars({ artifacts: [{ id: 'one' }] }, next, { cid: 'foreign' })).toBe(false);
  expect(open).toHaveBeenCalledTimes(2);
  mount(next, 1, 'Old'); mount(next, 2, 'Corrected');
  expect(open).toHaveBeenCalledTimes(2);
  expect(first.querySelector('.chat-artifact-title')!.textContent).toBe('Corrected');
  mount(next, 1, 'Chat', 'two'); mount(bubble(), 1, 'Chat', 'one', 'other-chat');
  expect(document.querySelectorAll('.chat-artifact-card')).toHaveLength(3);
  expect(open).toHaveBeenCalledTimes(4);
});
