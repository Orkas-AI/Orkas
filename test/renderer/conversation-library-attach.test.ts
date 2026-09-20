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
  const warn = vi.fn(), event = vi.fn(), error = vi.fn(), focus = vi.fn(), consume = vi.fn();
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
    _convLog: { warn },
    _targetFromPickerAnchor: () => 'conversation', _resolveActiveProjectId: () => '',
    _libraryPickerDraftCidFor: () => 'main_chat', _libraryPickerInputIdForTarget: () => 'input',
    _agentsTrackEvent: event, _agentsTrackError: error,
    _consumeAtKeyChar: consume, _focusInput: focus,
    escapeHtml: (value: string) => value,
    t: (key: string, data?: { reason?: string }) => data?.reason || key,
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
  const picker = readFileSync(path.join(__dirname, '../../src/renderer/modules/agents.js'), 'utf8');
  const pickerStart = picker.indexOf('async function _triggerLibraryFile(');
  const pickerEnd = picker.indexOf('\n}', pickerStart);
  if (pickerStart < 0 || pickerEnd < 0) throw new Error('Missing Library picker');
  vm.runInContext(picker.slice(pickerStart, pickerEnd + 2), context);
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
    warn, event, error, focus, consume,
    select: (scope: string) => context._triggerLibraryFile({
      libraryRel: 'PRIVATE_FILE_PATH', libraryScope: scope, projectId: scope === 'project' ? 'project-test' : '',
    }, 'picker'),
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

  it.each([
    ['ipc_request', () => { throw new Error('private-file-marker'); }, false],
    ['source_resolve', async () => ({ ok: false, error: 'private-file-marker', failure_stage: 'source_resolve', failure_kind: 'permission_denied' }), false],
    ['navigation', async () => imported, true],
  ])('retains the safe %s stage and releases the draft for retry', async (stage, operation, navigationFails) => {
    const invoke = vi.fn(operation as any);
    const fixture = harness(invoke);
    const navigate = navigationFails ? () => { throw new Error('private-file-marker'); } : vi.fn();
    await expect(fixture.attach('main_chat', navigate)).rejects.toMatchObject({ failure_stage: stage });
    expect(fixture.names()).toEqual([]);
    const release = fixture.beginSend();
    expect(release).toBeTypeOf('function');
    release();
    invoke.mockResolvedValue(imported);
    await fixture.attach();
    expect(fixture.names()).toEqual(['note.md']);
  });

  it.each([
    ['global', 'source_resolve', 'not_found', 'source_resolve', 'not_found'],
    ['project', 'source_resolve', 'permission_denied', 'source_resolve', 'permission_denied'],
    ['global', 'attachment_import', 'disk_full', 'attachment_import', 'disk_full'],
    ['project', 'attachment_import', 'operation_failed', 'attachment_import', 'operation_failed'],
    ['global', 'PRIVATE_STAGE', 'PRIVATE_KIND', 'ipc_request', 'operation_failed'],
  ])('preserves %s/%s/%s through IPC, local logging and picker events before recovery', async (scope, stage, kind, expectedStage, expectedKind) => {
    const invoke = vi.fn().mockResolvedValueOnce({
      ok: false, error: 'PRIVATE_ERROR_TEXT', failure_stage: stage, failure_kind: kind,
    }).mockResolvedValue(imported);
    const fixture = harness(invoke);
    await fixture.select(scope);
    expect(invoke).toHaveBeenCalledWith(scope === 'project' ? 'projects.files.attachToDraft' : 'contexts.attachToDraft', expect.objectContaining({ cid: 'main_chat' }));
    expect(fixture.names()).toEqual([]);
    expect(fixture.readyChips()).toBe(0);
    expect(fixture.focus).not.toHaveBeenCalled();
    expect(fixture.consume).not.toHaveBeenCalled();
    expect(fixture.uiAlert).toHaveBeenCalledExactlyOnceWith('PRIVATE_ERROR_TEXT');
    const diagnosis = { failure_stage: expectedStage, failure_kind: expectedKind };
    expect(fixture.warn).toHaveBeenCalledExactlyOnceWith('library attachment failed', diagnosis);
    expect(fixture.event).toHaveBeenCalledExactlyOnceWith('chat_library_attach_result', expect.objectContaining({
      ...diagnosis, result: 'failure', scope, telemetry_version: 3,
    }));
    expect(fixture.error).toHaveBeenCalledExactlyOnceWith('chat_library_attach', expect.objectContaining({
      ...diagnosis, error_type: 'operation', error_message: 'library_attach_failed', telemetry_version: 3,
    }));
    expect(JSON.stringify([fixture.warn.mock.calls, fixture.event.mock.calls, fixture.error.mock.calls])).not.toContain('PRIVATE_');
    const release = fixture.beginSend();
    expect(release).toBeTypeOf('function');
    release();
    await fixture.select(scope);
    expect(fixture.names()).toEqual(['note.md']);
    expect(fixture.readyChips()).toBe(1);
    expect(fixture.event).toHaveBeenLastCalledWith('chat_library_attach_result', expect.objectContaining({ result: 'success', scope }));
    expect(fixture.event).toHaveBeenCalledTimes(2);
    expect(fixture.error).toHaveBeenCalledTimes(1);
    expect(fixture.warn).toHaveBeenCalledTimes(1);
    expect(fixture.focus).toHaveBeenCalledOnce();
    expect(fixture.consume).toHaveBeenCalledOnce();
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
