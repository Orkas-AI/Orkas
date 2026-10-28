import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const root = join(__dirname, '../../src/renderer/modules');
function owner(file: string, name: string) {
  const source = ts.createSourceFile(file, readFileSync(join(root, file + '.js'), 'utf8'), ts.ScriptTarget.Latest, true);
  const owners = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (owners.length !== 1) throw new Error('Expected one complete transfer owner');
  return owners[0].getText(source);
}

function parent(kind: 'contexts' | 'project-detail') {
  let options: any;
  const drafts = new Map([['note.md', { dirty: true, content: 'Current project draft' }]]);
  const selected = new Set(['note.md']);
  const refresh = vi.fn(async () => undefined), clear = vi.fn(), rename = vi.fn();
  const context: any = { currentUserId: 'first',
    window: { LibraryTransfer: { confirmUnsaved: vi.fn(async () => true), open: vi.fn(async value => { options = value; }) } },
    _ctxProjectId: 'p1', _ctxScopeGeneration: 1, _ctxOperations: 0, _ctxOpenSeq: 0, _ctxDrafts: drafts,
    _ctxActive: { id: 'note.md' }, _ctxMveController: null, _ctxSelected: selected, _ctxSelectionAnchor: 'note.md',
    _ctxSetOperation: vi.fn(), openCtxFile: vi.fn(), _applyCtxPathChange: rename, _clearCtxViewer: clear, loadContexts: refresh,
    _projectDetailPid: 'p1', _projectLibraryScopeGeneration: 1, _projectLibraryDrafts: drafts, _projectLibrarySelected: selected,
    _projectLibrarySelectionAnchor: 'note.md', _projectLibraryActiveName: 'note.md', _projectLibraryMveController: null,
    _showProjectTextViewer: vi.fn(), _applyProjectLibraryPathChange: rename, _clearProjectLibraryViewer: clear, loadProjectDetail: refresh,
  };
  vm.createContext(context);
  const name = kind === 'contexts' ? '_openCtxTransfer' : '_openProjectLibraryTransfer';
  vm.runInContext(owner(kind, name), context);
  const result = (mode = 'move', same = false) => ({ mode, destination: same ? { scope: 'project', projectId: 'p1', dir: 'archive' } : { scope: 'global', dir: '' },
    results: [{ ok: true, source: 'note.md', destination: 'archive/note.md' }, { ok: false, source: 'failed.md', error: 'target_exists' }] });
  return { context, drafts, selected, refresh, clear, rename,
    open: () => context[name](['note.md'], 'row'), complete: (mode?: string, same?: boolean) => options.onComplete(result(mode, same)) };
}

describe.each(['contexts', 'project-detail'] as const)('%s transfer completion ownership', kind => {
  it('rechecks ownership after draft confirmation resolves', async () => {
    const h = parent(kind);
    h.context.window.LibraryTransfer.confirmUnsaved.mockImplementation(async () => { h.context.currentUserId = 'second'; return true; });
    await h.open(); expect(h.context.window.LibraryTransfer.open).not.toHaveBeenCalled();
  });
  it.each(['project', 'account', 'generation'])('preserves a new view and its same-path draft after %s changes', async change => {
    const h = parent(kind); await h.open();
    if (change === 'project') { h.context._ctxProjectId = 'p2'; h.context._projectDetailPid = 'p2'; }
    if (change === 'account') h.context.currentUserId = 'second';
    if (change === 'generation') { h.context._ctxScopeGeneration++; h.context._projectLibraryScopeGeneration++; }
    await h.complete();
    expect(h.drafts.get('note.md')).toEqual({ dirty: true, content: 'Current project draft' });
    expect([...h.selected]).toEqual(['note.md']); expect(h.clear).not.toHaveBeenCalled();
    expect(h.rename).not.toHaveBeenCalled(); expect(h.refresh).not.toHaveBeenCalled();
  });
  it('still clears only successful moved drafts in the original view', async () => {
    const h = parent(kind); h.drafts.set('failed.md', { dirty: true, content: 'Keep failed draft' });
    await h.open(); await h.complete();
    expect(h.drafts.has('note.md')).toBe(false); expect(h.drafts.has('failed.md')).toBe(true);
    expect(h.clear).toHaveBeenCalledOnce(); expect(h.refresh).toHaveBeenCalledOnce(); expect(h.selected.size).toBe(0);
  });
  it('renames in-place move state and preserves copied drafts', async () => {
    const h = parent(kind); await h.open(); await h.complete('move', true);
    expect(h.rename).toHaveBeenCalledExactlyOnceWith('note.md', 'archive/note.md', 'archive');
    h.refresh.mockClear(); h.rename.mockClear(); await h.complete('copy');
    expect(h.drafts.has('note.md')).toBe(true); expect(h.clear).not.toHaveBeenCalled(); expect(h.rename).not.toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalledOnce();
  });
});

it('actual project navigation invalidates a transfer even after returning to the same project', async () => {
  let options: any;
  const context: any = { currentUserId: 'first', composerBindOwner: vi.fn(),
    createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
    document: { readyState: 'loading', addEventListener: vi.fn() },
    window: { addEventListener: vi.fn(), LibraryTransfer: { confirmUnsaved: async () => true, open: async (value: any) => { options = value; } } },
  };
  vm.createContext(context); vm.runInContext(readFileSync(join(root, 'project-detail.js'), 'utf8'), context);
  for (const name of ['_closeProjectDriverHint', '_clearProjectLibraryViewer', '_setProjectDetailBusy', '_renderProjectDetailEmpty']) context[name] = vi.fn();
  vm.runInContext("_projectDetailPid = 'p1'", context);
  await context._openProjectLibraryTransfer(['note.md'], 'row');
  // Exercise the production navigation owner, not just a test-only counter.
  await context.loadProjectDetail('');
  vm.runInContext("_projectDetailPid = 'p1'; _projectLibraryDrafts.set('note.md', { content: 'New visit draft', dirty: true }); _projectLibrarySelected.add('note.md')", context);
  await options.onComplete({ mode: 'move', destination: { scope: 'global' }, results: [{ ok: true, source: 'note.md' }] });
  expect(vm.runInContext("_projectLibraryDrafts.get('note.md').content", context)).toBe('New visit draft');
  expect(vm.runInContext("_projectLibrarySelected.has('note.md')", context)).toBe(true);
});

function unsaved() {
  let active = 'folder/a.md'; let current = true;
  const save = vi.fn(async () => true), confirm = vi.fn(async () => true), alert = vi.fn();
  const controller = { isDirty: () => true, save };
  const drafts = new Map([['folder/a.md', { dirty: true }], ['folder/b.md', { dirty: true }],
    ['folder/clean.md', { dirty: false }], ['folderish/other.md', { dirty: true }]]);
  const context: any = { uiConfirm: confirm, uiAlert: alert, t: String };
  vm.createContext(context); vm.runInContext(readFileSync(join(root, 'library-transfer.js'), 'utf8'), context);
  const openFile = vi.fn(async (rel: string) => { active = rel; });
  const args = { paths: ['folder'], drafts, getActivePath: () => active, getController: () => controller, openFile, isCurrent: () => current };
  return { context, confirm, alert, save, drafts, args, openFile, setCurrent: (value: boolean) => { current = value; },
    run: () => context.LibraryTransfer.confirmUnsaved(args) };
}
describe('actual LibraryTransfer.confirmUnsaved contract', () => {
  it('saves only selected dirty descendants, including the active controller, without duplicate saves', async () => {
    const h = unsaved(); expect(await h.run()).toBe(true);
    expect(h.save).toHaveBeenCalledTimes(2); expect(h.openFile).toHaveBeenCalledExactlyOnceWith('folder/b.md');
    expect(h.drafts.size).toBe(4); expect(h.alert).not.toHaveBeenCalled();
  });
  it('does not prompt for clean unrelated drafts', async () => {
    const h = unsaved(); h.args.paths = ['absent']; expect(await h.run()).toBe(true); expect(h.confirm).not.toHaveBeenCalled();
  });
  it('includes an active dirty controller that has no cached draft', async () => {
    const h = unsaved(); h.drafts.clear(); expect(await h.run()).toBe(true);
    expect(h.save).toHaveBeenCalledOnce(); expect(h.openFile).not.toHaveBeenCalled();
  });
  it('rejects an already obsolete scope without prompting', async () => {
    const h = unsaved(); h.setCurrent(false); expect(await h.run()).toBe(false);
    expect(h.confirm).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled();
  });
  it.each(['controller', 'path'])('does not save a missing or mismatched %s after opening', async missing => {
    const h = unsaved();
    if (missing === 'controller') (h.args as any).getController = () => null;
    else h.args.getActivePath = () => 'unrelated.md';
    expect(await h.run()).toBe(false); expect(h.save).not.toHaveBeenCalled(); expect(h.drafts.size).toBe(4);
  });
  it('discard authorizes the transfer without deleting drafts before a successful move', async () => {
    const h = unsaved(); h.confirm.mockResolvedValue(false); expect(await h.run()).toBe(true);
    expect(h.save).not.toHaveBeenCalled(); expect(h.drafts.size).toBe(4);
  });
  it('does not continue when Save fails and permits a later retry', async () => {
    const h = unsaved(); h.save.mockResolvedValueOnce(false); expect(await h.run()).toBe(false);
    expect(h.save).toHaveBeenCalledOnce(); expect(await h.run()).toBe(true);
  });
  it.each(['prompt', 'open', 'save'])('stops after ownership changes during %s', async boundary => {
    const h = unsaved();
    if (boundary === 'prompt') h.confirm.mockImplementation(async () => { h.setCurrent(false); return true; });
    if (boundary === 'open') h.openFile.mockImplementation(async () => { h.setCurrent(false); });
    if (boundary === 'save') h.save.mockImplementation(async () => { h.setCurrent(false); return true; });
    expect(await h.run()).toBe(false); expect(h.drafts.size).toBe(4); expect(h.alert).not.toHaveBeenCalled();
  });
  it('rejects reentrant confirmation and releases the guard after exceptions', async () => {
    const h = unsaved(); let release!: (value: boolean) => void;
    h.confirm.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = h.run(); expect(await h.run()).toBe(false); release(true); await first;
    h.save.mockRejectedValueOnce(new Error('synthetic save failure')); expect(await h.run()).toBe(false);
    expect(h.alert).toHaveBeenCalledExactlyOnceWith('contexts.save_failed'); expect(await h.run()).toBe(true);
  });
});

const { _transferFailureDetails } = require('../../src/renderer/modules/library-transfer.js');
describe('closed transfer diagnostic vocabulary', () => {
  it.each(['E_PRIVATE_CUSTOMER_CONTENT', 'E_UNKNOWN', 'private detail', { code: 'E_PRIVATE_CUSTOMER_CONTENT' }])('does not accept arbitrary code-shaped content %j', value => {
    expect(_transferFailureDetails(value)).toEqual({ error_code: 'transfer_failed', error_type: 'operation' });
  });
  it.each(['E_IPC_REQUEST', 'E_IPC_SENDER', 'E_NOT_LOGGED_IN', 'E_STORAGE_FULL', 'E_NETWORK_TIMEOUT', 'E_NETWORK_UNAVAILABLE', 'E_BAD_RESPONSE', 'E_SERVER_UNAVAILABLE'])('preserves actual stable IPC code %s', code => {
    expect(_transferFailureDetails({ code })).toEqual({ error_code: code, error_type: 'operation' });
  });
});
