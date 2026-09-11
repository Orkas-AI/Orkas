import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');

function declaration(marker: string) {
  const start = source.indexOf(marker);
  const end = source.indexOf('\n}', start);
  if (start < 0 || end < 0) throw new Error(`Missing renderer declaration: ${marker}`);
  return source.slice(start, end + 2) + ';';
}

function harness(invoke: ReturnType<typeof vi.fn>) {
  const host = { innerHTML: '', style: { display: '' }, querySelectorAll: () => [] };
  const apiFetch = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
  const uiAlert = vi.fn();
  const context: any = vm.createContext({
    window: { orkas: { invoke } },
    document: { getElementById: () => host },
    currentCid: 'main_chat',
    _chatAttachments: new Map(),
    _chatAttachmentOperations: new Map(),
    _chatAttachmentSendLocks: new Set(),
    _chatAttachmentRevisions: new Map(),
    _chatAttachHostIdFor: () => 'chips',
    _chatFileIconHtml: () => '',
    _convLog: { warn: vi.fn() },
    escapeHtml: (value: string) => value,
    t: (key: string) => key,
    URL,
    apiFetch,
    uiAlert,
  });
  const functions = [
    '_chatAttachList', '_chatAttachRevision', '_chatAttachMarkMutation',
    '_chatAttachBeginOperation', '_chatAttachHasPendingWork', '_chatAttachTryBeginSend',
    '_chatAttachSet', '_chatAttachRenderChips', '_chatMediaUrl', '_addReadyDraftAttachment',
  ].map(name => declaration(`function ${name}(`));
  for (const name of ['_chatAttachDeleteItemFile', '_chatAttachRemove']) {
    functions.push(declaration(`async function ${name}(`));
  }
  functions.push(declaration('window.attachKbFileToDraft ='));
  vm.runInContext(functions.join('\n'), context);
  return {
    attach: (cid = 'main_chat', afterNavigate = vi.fn()) => context.window.attachKbFileToDraft(
      'contexts.attachToDraft', { relPath: 'folder/note.md' }, cid, afterNavigate,
    ),
    names: (cid = 'main_chat') => context._chatAttachList(cid).map((item: any) => item.name),
    readyChips: () => (host.innerHTML.match(/class="chat-attach-chip"/g) || []).length,
    remove: (index: number) => context._chatAttachRemove('main_chat', index),
    beginSend: () => context._chatAttachTryBeginSend('main_chat'),
    apiFetch,
    uiAlert,
  };
}

const imported = { ok: true, info: { name: 'note.md', kind: 'text', bytes: 4, mtime: 1 } };

describe('Library attachment draft lifecycle', () => {
  it.each(['sequential', 'concurrent'])(
    'renders one removable attachment when repeated Library selections are %s',
    async (mode) => {
      // The storage owner returns the same stored name for identical pending bytes.
      // Main-process content deduplication is independently covered by chat_attachments.test.ts.
      const fixture = harness(vi.fn(async () => imported));
      if (mode === 'concurrent') await Promise.all([fixture.attach(), fixture.attach()]);
      else { await fixture.attach(); await fixture.attach(); }
      expect(fixture.names()).toEqual(['note.md']);
      expect(fixture.readyChips()).toBe(1);
      await fixture.remove(0);
      expect(fixture.names()).toEqual([]);
      expect(fixture.readyChips()).toBe(0);
      expect(fixture.apiFetch).toHaveBeenCalledOnce();
    },
  );

  it('keeps same-name selections in separate drafts and distinct stored names in one draft', async () => {
    const invoke = vi.fn(async () => imported);
    const fixture = harness(invoke);
    await fixture.attach();
    await fixture.attach('projchat-project-a');
    invoke.mockResolvedValueOnce({ ...imported, info: { ...imported.info, name: 'other.md' } });
    await fixture.attach();
    expect(fixture.names()).toEqual(['note.md', 'other.md']);
    expect(fixture.names('projchat-project-a')).toEqual(['note.md']);
  });

  it('leaves no ready chip after import failure and releases the draft for a successful retry', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ ok: false, error: 'file not found' })
      .mockResolvedValueOnce(imported);
    const fixture = harness(invoke);
    const navigate = vi.fn();
    await expect(fixture.attach('main_chat', navigate)).rejects.toThrow('file not found');
    expect(fixture.names()).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
    const finishSend = fixture.beginSend();
    expect(finishSend).toBeTypeOf('function');
    finishSend();
    await fixture.attach();
    expect(fixture.names()).toEqual(['note.md']);
  });

  it('blocks send until import completes and prevents an import during an active send', async () => {
    let resolve!: (value: typeof imported) => void;
    const invoke = vi.fn(() => new Promise<typeof imported>(done => { resolve = done; }));
    const fixture = harness(invoke);
    const pending = fixture.attach();
    expect(fixture.beginSend()).toBeNull();
    expect(fixture.names()).toEqual([]);
    resolve(imported);
    await pending;
    const finishSend = fixture.beginSend();
    expect(finishSend).toBeTypeOf('function');
    await expect(fixture.attach()).rejects.toThrow('chat.attach_send_in_progress');
    expect(invoke).toHaveBeenCalledOnce();
    finishSend();
    expect(fixture.names()).toEqual(['note.md']);
  });
});
