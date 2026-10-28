import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { LOCALES } from '../../src/main/i18n';
import { conversationRemovalSource } from './conversation-cache-test-source';

const conversationSource = readFileSync(resolve(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
const parsedConversation = ts.createSourceFile('conversation.js', conversationSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const manageResultSource = parsedConversation.statements.filter(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === '_logConversationManageResult')
  .map(node => node.getText(parsedConversation)).join('\n');

function harness() {
  const listeners: Record<string, any> = {};
  const back = { hidden: true, addEventListener: (_type: string, fn: any) => { listeners.back = fn; } };
  const body = { innerHTML: '', addEventListener: (type: string, fn: any) => { listeners[type] = fn; }, querySelector: () => null };
  const picker = { setOptions: vi.fn(), setAriaLabel: vi.fn(), close() {}, onChange(fn: any) { this.change = fn; }, change: null as any };
  const rows = [{ cid: 'one', title: '<unsafe title>', activeAt: '2020-01-01T00:00:00Z', projectId: null, selectable: true },
    { cid: 'two', title: 'Second', activeAt: '2020-01-02T00:00:00Z', projectId: null, selectable: true }];
  const invoke = vi.fn(async (channel: string, _payload?: any) => !channel.endsWith('remove')
    ? { ok: true, token: 'receipt', total: 2, selectableTotal: 2, rows, entries: rows, treeTotal: 2, treeNextOffset: null, listTotal: 2, nextOffset: null }
    : { ok: true, status: 'deleted' });
  const store = new Map<string, string>();
  const refresh = vi.fn(); const forgot = vi.fn();
  const manageLog = { info: vi.fn(), warn: vi.fn() };
  const messages = JSON.parse(readFileSync(resolve(__dirname, '../../src/renderer/locales/en.json'), 'utf8'));
  const scope: any = { _convLog: manageLog, currentUserId: 'u1', currentCid: '', conversations: [], currentView: 'settings',
    window: { orkas: { invoke }, TaskUnread: { list: () => [], isUnread: () => false },
      addEventListener() {}, initRecycleBin: refresh },
    document: { getElementById: (id: string) => id === 'settings-task-cleanup-body' ? body : id === 'chat-cleanup-back' ? back : {},
      querySelector: () => null },
    localStorage: { get length() { return store.size; }, key: (i: number) => [...store.keys()][i], getItem: (key: string) => store.get(key) ?? null },
    t: (key: string, vars: any = {}) => Object.entries(vars).reduce((text, [k, v]) => text.replaceAll(`{${k}}`, String(v)), messages[key] || key),
    escapeHtml: (v: string) => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    _aiSelectMount: () => picker, _forgetConvLocal: forgot, _chatAttachClear: vi.fn(), loadConversations: refresh, setView: vi.fn(),
    _composerHoldsUnsentInput: () => false, _chatAttachList: () => [],
    _clearConversationInlineRenameState: vi.fn(), renderConversationList: vi.fn(),
    createLogger: () => ({ warn: vi.fn() }), setTimeout, clearTimeout, Date,
  };
  vm.runInNewContext(`let _conversationRemovalRevision = 0;
    let _conversationRemovalRenderPending = false;
    const _conversationProjectPages = new Map();
    const _unprojectedConversationPage = { total: 0, nextOffset: null };
    ${conversationRemovalSource}\n${manageResultSource}\n` + readFileSync(resolve(__dirname, '../../src/renderer/modules/task-cleanup.js'), 'utf8'), scope);
  const click = async (action: string, projectId = '') => listeners.click({ preventDefault: vi.fn(), target: { closest: () => ({ dataset: { cleanupAction: action, cleanupOwner: projectId } }) } });
  const check = async (cid: string | null, checked: boolean, projectId = '') => listeners.change({ target: {
    checked, getAttribute: (name: string) => name === 'data-cleanup-cid' ? cid : name === 'data-cleanup-project' ? projectId : null, hasAttribute: (name: string) => name === 'data-cleanup-all' && !cid && !projectId,
  } });
  return { scope, body, back, invoke, store, picker, refresh, forgot, click, check, manageLog,
    show: () => scope.window.initTaskCleanup() };
}
describe('inline history cleanup', () => {
  it('reports a fresh remaining count without extending the confirmed selection to later arrivals', async () => {
    const h = harness(); const original = h.invoke.getMockImplementation()!;
    let previews = 0;
    h.invoke.mockImplementation(async (channel, payload) => {
      const response = await original(channel, payload);
      if (channel.endsWith('preview') && ++previews > 1) return { ...response, total: 1, selectableTotal: 1,
        entries: [{ cid: 'later-arrival', title: 'Later arrival', selectable: true }], treeTotal: 1 };
      return response;
    });
    await h.show(); await h.check(null, true); await h.click('prepare'); await h.click('confirm');
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('remove')).map(([, p]: any) => p.cid)).toEqual(['one', 'two']);
    expect(h.body.innerHTML).toContain('Recycled 2 · Skipped 0 · Failed 0');
    expect(h.body.innerHTML).toContain('Still matching: 1. Review and select again to continue.');
    expect(h.body.innerHTML).toContain('Clean up (0)');
  });
  it.each([undefined, 'busy', 'unknown'])('opens a task with blocking state %s without selecting or deleting it', async blocked => {
    const h = harness();
    const original = h.invoke.getMockImplementation()!;
    h.invoke.mockImplementation(async (channel, payload) => {
      const response = await original(channel, payload);
      if (response.entries) response.entries = response.entries.map(row => ({ ...row, selectable: !blocked, blocked }));
      return response;
    });
    await h.show(); await h.click('view');
    expect(h.body.innerHTML).toContain('data-cleanup-action="open" data-cleanup-owner="one"');
    await h.click('open', 'one');
    expect(h.scope.setView).toHaveBeenCalledExactlyOnceWith('conversation', 'one');
    expect(h.body.innerHTML).toContain('Clean up (0)');
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('remove'))).toHaveLength(0);
  });
  it('returns to the existing cleanup selection and only offers Back for its originating conversation', async () => {
    const h = harness();
    h.scope.setView.mockImplementation((view, cid, opts = {}) => {
      const preserve = h.scope.window.TaskCleanupNavigation?.beforeNavigate(view, cid, opts);
      h.scope.currentView = view; h.scope.currentCid = view === 'conversation' ? cid : null;
      if (view === 'settings' && !preserve) h.show();
    });
    await h.show(); await h.click('view'); await h.check('one', true);
    const previewCount = h.invoke.mock.calls.filter(([c]) => c.endsWith('preview')).length;
    await h.click('open', 'one');
    expect(h.back.hidden).toBe(false);
    h.scope.window.TaskCleanupNavigation.back();
    expect(h.scope.currentView).toBe('settings');
    expect(h.body.innerHTML).toContain('Clean up (1)');
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('preview'))).toHaveLength(previewCount);
    expect(h.back.hidden).toBe(true);
    await h.click('open', 'one');
    h.scope.setView('conversation', 'two');
    expect(h.back.hidden).toBe(true);
    h.scope.window.TaskCleanupNavigation.back();
    expect(h.scope.currentCid).toBe('two');
  });
  it('does not return another account to the previous cleanup receipt', async () => {
    const h = harness(); await h.show(); await h.click('view'); await h.click('open', 'one');
    h.scope.currentView = 'conversation'; h.scope.currentCid = 'one'; h.scope.currentUserId = 'other';
    h.scope.setView.mockClear();
    h.scope.window.TaskCleanupNavigation.back();
    expect(h.scope.setView).not.toHaveBeenCalled();
    expect(h.back.hidden).toBe(true);
  });
  it('rejects unknown or cross-account destinations and keeps confirmation in place', async () => {
    const h = harness(); await h.show(); await h.click('view');
    for (const cid of ['missing', '../one', 'https://example.com', 'javascript:alert(1)']) await h.click('open', cid);
    await h.check('one', true); await h.click('prepare'); await h.click('open', 'one');
    expect(h.scope.setView).not.toHaveBeenCalled();
    await h.click('cancel'); h.scope.currentUserId = 'other'; await h.click('open', 'one');
    expect(h.scope.setView).not.toHaveBeenCalled();
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('remove'))).toHaveLength(0);
  });
  it('lets users select active history and discloses automatic stopping before cleanup', async () => {
    const h = harness(); const original = h.invoke.getMockImplementation()!;
    h.invoke.mockImplementation(async (channel, payload) => {
      const response = await original(channel, payload);
      if (response.entries) response.entries = response.entries.map(row => ({ ...row, blocked: 'busy' }));
      return response;
    });
    await h.show(); await h.click('view');
    expect(h.body.innerHTML).not.toContain('Stops on cleanup');
    await h.check('one', true); await h.click('prepare');
    expect(h.body.innerHTML).toContain('Running tasks are stopped automatically before cleanup.');
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('remove'))).toHaveLength(0);
    await h.click('confirm');
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('remove')).map(([, p]: any) => p.cid)).toEqual(['one']);
  });
  it('logs the aggregate failure while preserving partial success and retry ownership', async () => {
    const h = harness(); const original = h.invoke.getMockImplementation()!;
    let fail = true;
    h.invoke.mockImplementation(async (channel, payload) => {
      if (channel.endsWith('remove') && payload.cid === 'two' && fail) throw new Error('synthetic-private-cleanup-marker');
      return original(channel, payload);
    });
    await h.show(); await h.check(null, true); await h.click('prepare'); await h.click('confirm');
    expect(h.body.innerHTML).toContain('Recycled 1 · Skipped 0 · Failed 1');
    expect(h.forgot.mock.calls.map(([cid]) => cid)).toEqual(['one']);
    expect(h.manageLog.warn).toHaveBeenCalledExactlyOnceWith('conversation management result', {
      action: 'delete', result: 'failure', duration_ms: expect.any(Number), error_code: 'delete_failed',
    });
    expect(h.manageLog.info).not.toHaveBeenCalled();
    expect(JSON.stringify(h.manageLog.warn.mock.calls)).not.toContain('synthetic-private-cleanup-marker');
    fail = false; await h.click('retry');
    expect(h.invoke.mock.calls.filter(([channel]) => channel.endsWith('remove')).map(([, payload]: any) => payload.cid)).toEqual(['one', 'two', 'two']);
    expect(h.forgot.mock.calls.map(([cid]) => cid)).toEqual(['one', 'two']);
    expect(h.manageLog.warn).toHaveBeenCalledTimes(1);
    expect(h.manageLog.info).toHaveBeenCalledExactlyOnceWith('conversation management result', {
      action: 'delete', result: 'success', duration_ms: expect.any(Number),
    });
  });
  it('logs a failed cleanup page without attempting removals or exposing its error detail', async () => {
    const h = harness(); const original = h.invoke.getMockImplementation()!;
    h.invoke.mockImplementation(async (channel, payload) => {
      if (channel.endsWith('page')) throw new Error('synthetic-private-page-marker');
      return original(channel, payload);
    });
    await h.show(); await h.check('one', true); await h.click('prepare'); await h.click('confirm');
    expect(h.invoke.mock.calls.filter(([channel]) => channel.endsWith('remove'))).toHaveLength(0);
    expect(h.forgot).not.toHaveBeenCalled();
    expect(h.body.innerHTML).toContain('role="alert"');
    expect(h.body.innerHTML).toContain('Recycled 0 · Skipped 0 · Failed 0');
    expect(h.body.innerHTML).not.toContain('synthetic-private-page-marker');
    expect(h.manageLog.warn).toHaveBeenCalledExactlyOnceWith('conversation management result', {
      action: 'delete', result: 'failure', duration_ms: expect.any(Number), error_code: 'delete_failed',
    });
    expect(h.manageLog.info).not.toHaveBeenCalled();
  });
  it('retries only failed tasks after a partial success', async () => {
    const h = harness(); await h.show(); await h.check(null, true);
    const original = h.invoke.getMockImplementation()!;
    let fail = true;
    h.invoke.mockImplementation(async (channel, payload) => {
      if (channel.endsWith('remove') && payload.cid === 'two' && fail) throw new Error('backup unavailable');
      return original(channel, payload);
    });
    await h.click('prepare'); await h.click('confirm');
    expect(h.body.innerHTML).toContain('Recycled 1 · Skipped 0 · Failed 1');
    fail = false; await h.click('retry');
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('remove')).map(([, p]: any) => p.cid)).toEqual(['one', 'two', 'two']);
    expect(h.forgot.mock.calls.map(([cid]) => cid)).toEqual(['one', 'two']);
  });
  it.each([false, true])('removes completed tasks from selection after partial success (project=%s)', async project => {
    const h = harness();
    const original = h.invoke.getMockImplementation()!;
    h.invoke.mockImplementation(async (channel, payload) => {
      if (channel.endsWith('remove') && payload.cid === 'two') throw new Error('backup unavailable');
      const response = await original(channel, payload);
      if (project && response.rows) {
        response.rows = response.rows.map(row => ({ ...row, projectId: 'p1' }));
        response.entries = [{ type: 'project', projectId: 'p1', title: 'Project', total: 2, selectableTotal: 2 }] as any;
      }
      return response;
    });
    await h.show(); await h.click('view');
    if (project) await h.click('project', 'p1');
    await h.check(null, true); await h.click('prepare'); await h.click('confirm');
    expect(h.body.innerHTML).toContain('Recycled 1 · Skipped 0 · Failed 1');
    expect(h.body.innerHTML).toContain('Clean up (1)');
    expect(h.body.innerHTML).toContain('Select all (1)');
    expect(h.body.innerHTML).not.toContain('data-cleanup-cid="one"');
    expect(h.body.innerHTML).toContain('data-cleanup-cid="two"');
    if (project) expect(h.body.innerHTML).toContain('>1 / 1<');
    // Re-reading a frozen page and selecting all must not resurrect a deletion.
    await h.click('previous', project ? 'p1' : '');
    await h.check(null, false); await h.check(null, true);
    expect(h.body.innerHTML).not.toContain('data-cleanup-cid="one"');
    expect(h.body.innerHTML).toContain('Clean up (1)');
    await h.click('prepare'); await h.click('confirm');
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('remove')).map(([, p]: any) => p.cid)).toEqual(['one', 'two', 'two']);
  });
  it('retains selection across pages and executes the frozen receipt once per selected task', async () => {
    const h = harness();
    const rows = Array.from({ length: 25 }, (_, n) => ({ cid: `task_${n}`, title: `Task ${n}`, activeAt: '2020-01-01', projectId: null, selectable: true }));
    h.invoke.mockImplementation(async (channel, payload) => channel.endsWith('remove')
      ? { ok: true, status: 'deleted' } as any
      : { ok: true, token: 'frozen', total: 25, selectableTotal: 25, treeTotal: 25, treeNextOffset: 20, listTotal: 25, entries: rows.slice(payload.offset || 0, (payload.offset || 0) + 20), rows: rows.slice(payload.offset || 0, (payload.offset || 0) + 20), nextOffset: payload.offset === 20 ? null : 20 });
    await h.show(); await h.check(null, true); await h.click('view'); await h.check('task_0', false);
    await h.click('next'); expect(h.body.innerHTML).toContain('Task 24');
    await h.check('task_24', false); await h.click('previous');
    expect(h.body.innerHTML).toContain('Clean up (23)');
    await h.click('prepare'); await h.click('confirm');
    const removals = h.invoke.mock.calls.filter(([c]) => c.endsWith('remove')).map(([, p]: any) => p);
    expect(removals.map(p => p.cid)).toEqual(rows.slice(1, 24).map(row => row.cid));
    expect(removals.every(p => p.token === 'frozen')).toBe(true);
  });
  it('deselects all without fetching every page and cleans only a subsequent individual selection', async () => {
    const h = harness(); await h.show(); await h.check(null, true); await h.check(null, false);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    await h.check('two', true); await h.click('prepare'); await h.click('confirm');
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('remove')).map(([, p]: any) => p.cid)).toEqual(['two']);
  });
  it('stops between tasks and prevents duplicate confirmation while an item is being deleted', async () => {
    const h = harness(); await h.show(); await h.check(null, true);
    const original = h.invoke.getMockImplementation()!;
    let finish!: (value: any) => void;
    h.invoke.mockImplementation((channel, payload) => channel.endsWith('remove')
      ? new Promise(resolve => { finish = resolve; }) : original(channel, payload));
    await h.click('prepare'); const pending = h.click('confirm');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(h.body.innerHTML).toContain('Cleaning 0 / 2');
    expect(h.body.innerHTML.match(/role="status"/g)).toHaveLength(1);
    expect(h.body.innerHTML).not.toContain('Recycled ');
    await h.click('confirm'); await h.click('stop');
    expect(h.body.innerHTML.match(/role="status"/g)).toHaveLength(1);
    finish({ ok: true, status: 'deleted' }); await pending;
    expect(h.body.innerHTML).toContain('Recycled 1 · Skipped 0 · Failed 0');
    expect(h.body.innerHTML).not.toContain('Cleaning ');
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('remove'))).toHaveLength(1);
    expect(h.forgot).toHaveBeenCalledWith('one');
  });
  it('shows a preview, confirms inline, cancels without deleting and escapes titles', async () => {
    const h = harness(); await h.show(); await h.check(null, true);
    expect(h.invoke.mock.calls[0][0]).toBe('conversations.cleanup.preview');
    expect(h.body.innerHTML).toContain('2');
    await h.click('view'); expect(h.body.innerHTML).toContain('&lt;unsafe title>');
    await h.click('prepare'); expect(h.body.innerHTML).toContain('data-cleanup-action="confirm"');
    expect(h.body.innerHTML.match(/class="settings-row"/g)).toHaveLength(1);
    expect(h.body.innerHTML).not.toContain('data-cleanup-action="prepare"');
    await h.click('cancel'); expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.body.innerHTML).not.toContain('data-cleanup-action="confirm"');
  });
  it('cleans the selected snapshot and refreshes the recycle bin', async () => {
    const h = harness(); await h.show(); await h.check(null, true); await h.click('prepare'); await h.click('confirm');
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('remove')).map(([, p]: any) => p.cid)).toEqual(['one', 'two']);
    expect(h.forgot).toHaveBeenCalledWith('one'); expect(h.refresh).toHaveBeenCalled();
    expect(h.scope._chatAttachClear.mock.calls).toEqual([['one'], ['two']]);
  });
  it('removes each deleted task from sidebar data before the next deletion finishes', async () => {
    const h = harness();
    h.scope.conversations = [{ conversation_id: 'one' }, { conversation_id: 'two' }];
    const original = h.invoke.getMockImplementation()!;
    let release!: (value: any) => void;
    h.invoke.mockImplementation((channel, payload) => channel.endsWith('remove') && payload.cid === 'two'
      ? new Promise(resolve => { release = resolve; }) : original(channel, payload));
    await h.show(); await h.check(null, true); await h.click('prepare');
    const pending = h.click('confirm');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const during = h.scope.conversations.map((row: any) => row.conversation_id);
    release({ ok: true, status: 'skipped' }); await pending;
    expect(during).toEqual(['two']);
    expect(h.scope.conversations.map((row: any) => row.conversation_id)).toEqual(['two']);
  });
  it('allows unread tasks and labels stored drafts instead of excluding them', async () => {
    const h = harness(); h.store.set('draft_other', JSON.stringify({ text: 'Keep me' })); await h.show(); await h.check(null, true);
    expect((h.invoke.mock.calls[0] as any)[1].draftIds).toContain('other');
    await h.click('prepare'); h.scope.window.TaskUnread.isUnread = (cid: string) => cid === 'two';
    await h.click('confirm');
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('remove')).map(([, p]: any) => p.cid)).toEqual(['one', 'two']);
  });
  it('keeps failures visible and never reports a malformed response as success', async () => {
    const h = harness(); await h.show(); await h.check(null, true);
    const original = h.invoke.getMockImplementation()!;
    h.invoke.mockImplementation(async (channel: string, payload: any) => channel.endsWith('remove') ? { ok: true } as any : original(channel, payload));
    await h.click('prepare'); await h.click('confirm');
    expect(h.forgot).not.toHaveBeenCalled(); expect(h.body.innerHTML).toContain('2');
    expect(h.body.innerHTML).toContain('data-cleanup-action="retry"');
  });
  it('does not execute a previous account selection after an account switch', async () => {
    const h = harness(); await h.show(); await h.check(null, true); await h.click('prepare'); h.scope.currentUserId = 'u2';
    await h.click('confirm');
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('remove'))).toHaveLength(0);
  });
  it('distinguishes a failed scan from an empty result and provides retry', async () => {
    const h = harness(); h.invoke.mockRejectedValueOnce(new Error('private path'));
    await h.show(); await h.check(null, true); expect(h.body.innerHTML).toContain('data-cleanup-action="refresh"');
    expect(h.body.innerHTML).not.toContain('private path');
    expect(h.body.innerHTML).not.toContain('data-cleanup-action="prepare"');
  });

  it('starts at 30 days with no selection and offers every requested age', async () => {
    const h = harness(); await h.show();
    expect(h.invoke.mock.calls[0][1].days).toBe(30);
    expect(h.body.innerHTML).toContain('Clean up (0)');
    expect(h.body.innerHTML.match(/class="settings-row"/g)).toHaveLength(1);
    expect(h.body.innerHTML).not.toContain('Selected tasks:');
    expect(h.picker.setOptions.mock.calls.at(-1)?.[0].map((o: any) => o.value)).toEqual(['7', '14', '30', '60', '90', '180']);
    await h.click('prepare'); await h.click('confirm');
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('remove'))).toHaveLength(0);
  });
  it('clears the old selection when changing age and deletes only from the new preview', async () => {
    const h = harness(); const original = h.invoke.getMockImplementation()!;
    h.invoke.mockImplementation(async (channel, payload) => {
      if ((channel.endsWith('preview') && payload.days === 14)
          || (channel.endsWith('page') && payload.token === 'fourteen-day-receipt')) {
        const rows = [{ cid: 'new-scope', title: 'New filter result', activeAt: '2020-01-01', projectId: null, selectable: true }];
        return { ok: true, token: 'fourteen-day-receipt', total: 1, selectableTotal: 1, rows, entries: rows,
          treeTotal: 1, treeNextOffset: null, listTotal: 1, nextOffset: null };
      }
      return original(channel, payload);
    });
    await h.show(); await h.click('view'); await h.check('one', true);
    expect(h.body.innerHTML).toContain('Clean up (1)');
    h.picker.change('14');
    await vi.waitFor(() => expect(h.body.innerHTML).toContain('New filter result'));
    expect(h.body.innerHTML).toContain('Clean up (0)');
    expect(h.body.innerHTML).not.toContain('data-cleanup-cid="one"');
    await h.click('prepare'); await h.click('confirm');
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('remove'))).toHaveLength(0);
    await h.check('new-scope', true); await h.click('prepare'); await h.click('confirm');
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('remove')).map(([, payload]) => payload))
      .toEqual([{ expectedUserId: 'u1', token: 'fourteen-day-receipt', cid: 'new-scope' }]);
  });
  it('selects a whole collapsed project across pages while leaving root tasks alone', async () => {
    const h = harness();
    const rows = Array.from({ length: 25 }, (_, n) => ({ cid: 'child_' + n, title: 'Child ' + n, projectId: 'p1', selectable: true, activeAt: '2020-01-01' }));
    const personal = { cid: 'personal', title: 'Personal', projectId: null, selectable: true, activeAt: '2020-01-01' };
    const group = { type: 'project', projectId: 'p1', title: 'Local project', shared: false, total: 25, selectableTotal: 25 };
    h.invoke.mockImplementation(async (channel, payload) => {
      if (channel.endsWith('remove')) return { ok: true, status: 'deleted' } as any;
      const all = payload.projectId ? rows : [...rows, personal];
      const offset = payload.offset || 0;
      return { ok: true, token: 'receipt', total: 26, selectableTotal: 26, entries: [group, personal], treeTotal: 2, treeNextOffset: null,
        rows: all.slice(offset, offset + 20), listTotal: all.length, nextOffset: offset + 20 < all.length ? offset + 20 : null } as any;
    });
    await h.show(); await h.click('view');
    expect(h.body.innerHTML).toContain('Personal');
    expect(h.body.innerHTML).toContain('data-ui-icon="folder"');
    expect(h.body.innerHTML).not.toContain('data-cleanup-project=""');
    await h.check(null, true, 'p1');
    expect(h.body.innerHTML).toContain('Clean up (25)');
    await h.click('prepare'); await h.click('confirm');
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('remove')).map(([, p]: any) => p.cid)).toEqual(rows.map(r => r.cid));
  });
  it('keeps partial project selection across child pages and collapse, excluding unavailable tasks', async () => {
    const h = harness();
    const rows = Array.from({ length: 25 }, (_, n) => ({ cid: 'child_' + n, title: 'Child ' + n,
      projectId: 'p1', selectable: n !== 0, activeAt: '2020-01-01', ...(n === 0 ? { blocked: 'unknown' } : {}) }));
    const group = { type: 'project', projectId: 'p1', title: 'Project', shared: false, total: 25, selectableTotal: 24 };
    h.invoke.mockImplementation(async (channel, payload) => {
      if (channel.endsWith('remove')) return { ok: true, status: 'deleted' } as any;
      const offset = payload.offset || 0;
      return { ok: true, token: 'receipt', total: 25, selectableTotal: 24, entries: [group], treeTotal: 1,
        treeNextOffset: null, rows: rows.slice(offset, offset + 20), listTotal: 25, nextOffset: offset + 20 < 25 ? offset + 20 : null } as any;
    });
    await h.show(); await h.click('view'); await h.click('project', 'p1');
    expect(h.body.innerHTML).toContain('Unavailable');
    await h.check(null, true, 'p1'); await h.check('child_1', false);
    expect(h.body.innerHTML).toContain('data-cleanup-project="p1" aria-label="Project" data-cleanup-mixed');
    await h.click('next', 'p1'); await h.check('child_24', false);
    expect(h.body.innerHTML).toContain('Clean up (22)');
    await h.click('project', 'p1'); expect(h.body.innerHTML).not.toContain('Child 24');
    await h.click('project', 'p1'); expect(h.body.innerHTML).toContain('Child 24');
    await h.click('prepare'); await h.click('confirm');
    expect(h.invoke.mock.calls.filter(([c]) => c.endsWith('remove')).map(([, p]: any) => p.cid)).toEqual(rows.slice(2, 24).map(r => r.cid));
  });
  it('translates every cleanup key in every supported locale', () => {
    const en = JSON.parse(readFileSync(resolve(__dirname, '../../src/renderer/locales/en.json'), 'utf8'));
    const keys = Object.keys(en).filter(key => key.startsWith('settings.cleanup.'));
    expect(keys.length).toBeGreaterThan(10);
    for (const { code } of LOCALES) {
      const messages = JSON.parse(readFileSync(resolve(__dirname, `../../src/renderer/locales/${code}.json`), 'utf8'));
      for (const key of keys) expect(messages[key], `${code}: ${key}`).toBeTruthy();
    }
  });
});
