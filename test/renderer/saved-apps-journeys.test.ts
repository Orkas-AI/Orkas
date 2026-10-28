// My Apps card journeys through the shipped panel markup, real shared dialogs
// and saved-apps.js. Each case starts from what the user sees (cards, menu,
// dialogs, composer) and asserts the visible result plus the IPC side effects
// that must or must not happen. Locale strings are the product copy contract.
import { describe, expect, it, vi } from 'vitest';
import { deferred, flush, loadAppsRenderer, type Invoke } from './helpers/apps-renderer';

const savedAt = '2026-05-01T08:00:00.000Z';
const budget = { id: 'app-budget', title: 'Budget', appType: 'local', savedAt };

function apps(list: any[], extra: Invoke = () => { throw new Error('unexpected IPC'); }): Invoke {
  return (channel, payload) => (channel === 'savedApps.list' ? { apps: list } : extra(channel, payload));
}

async function openPanel(invoke: Invoke, lang: 'zh' | 'en' = 'zh') {
  const h = loadAppsRenderer({ invoke, lang });
  await h.window.loadSavedApps(true);
  return h;
}

describe('My Apps list refresh', () => {
  it.each(['rejected', 'refused', 'malformed'] as const)('keeps visible apps on a %s refresh and accepts a later confirmed empty list', async failure => {
    let result: any = { apps: [budget] };
    const h = await openPanel(() => {
      if (result instanceof Error) throw result;
      return result;
    });
    result = failure === 'rejected' ? new Error('/private/app-state')
      : failure === 'refused' ? { ok: false, error: '/private/app-state' } : {};
    await h.window.loadSavedApps(true);
    expect(h.cards()).toEqual(['app-budget']);
    expect(h.warnings).toHaveLength(1);
    expect(JSON.stringify(h.warnings)).not.toContain('/private/app-state');
    result = { apps: [] };
    await h.window.loadSavedApps(true);
    expect(h.cards()).toEqual([]);
  });

  it('ignores an older listing that completes after a newer deletion refresh', async () => {
    const old = deferred();
    let result: any = { apps: [budget] };
    const h = await openPanel(() => result);
    result = old.promise;
    const loading = h.window.loadSavedApps(true);
    result = { apps: [] };
    await h.window.loadSavedApps(true);
    old.resolve({ apps: [budget] });
    await loading;
    expect(h.cards()).toEqual([]);
  });
});

describe('My Apps publication entry', () => {
  it.each(['local', 'web', 'cloud'])('keeps a %s app and its draft when publication guidance is cancelled', async appType => {
    const h = await openPanel(apps([{ id: 'app-weather', title: 'Weather', appType, savedAt }]));
    h.card('app-weather')!.querySelector('[data-app-more]')!.click();
    expect(h.$('.app-row-menu [data-action="publish"]')!.textContent).toBe('发布');
    h.press('Escape');
    await h.chooseMenuAction('app-weather', 'publish');
    const [dialog] = h.openDialogs();
    expect(h.dialogText(dialog)).toBe(h.context.t('apps.commercial_required'));
    expect(h.channels()).toEqual(['savedApps.list']);
    dialog.querySelector('[data-act="cancel"]')!.click(); await flush();
    expect(h.openDialogs()).toHaveLength(0); expect(h.cards()).toEqual(['app-weather']);
    expect(h.warnings).toEqual([]);
  });
});

describe('My Apps deletion', () => {
  it.each([
    ['zh', '删除「Budget」及其本地记录和私有文件？数据无法恢复。', '删除', '取消'],
    ['en', 'Delete "Budget" and its local records and private files? Data cannot be recovered.', 'Delete', 'Cancel'],
  ] as const)('names the app and its unrecoverable local data in %s, and Escape keeps the app', async (lang, message, danger, cancel) => {
    const h = await openPanel(apps([budget]), lang);
    await h.chooseMenuAction('app-budget', 'delete');

    const [dialog] = h.openDialogs();
    expect(h.dialogText(dialog)).toBe(message);
    expect(dialog.querySelector('[data-act="ok"]')!.textContent).toBe(danger);
    expect(h.document.activeElement).toBe(dialog.querySelector('[data-act="cancel"]'));
    expect(h.document.activeElement!.textContent).toBe(cancel);

    h.press('Escape');
    await flush();
    expect(h.openDialogs()).toHaveLength(0);
    expect(h.channels()).toEqual(['savedApps.list']);
    expect(h.cards()).toEqual(['app-budget']);
    expect(h.warnings).toEqual([]);
  });

  it('removes the card only after the deletion is confirmed and succeeds', async () => {
    let stored = [budget];
    const h = await openPanel(channel => {
      if (channel === 'savedApps.list') return { apps: stored };
      if (channel === 'savedApps.delete') { stored = []; return { ok: true }; }
      throw new Error('unexpected IPC');
    });
    await h.chooseMenuAction('app-budget', 'delete');
    h.openDialogs()[0].querySelector('[data-act="ok"]')!.click();
    await flush();

    expect(h.invoke).toHaveBeenCalledWith('savedApps.delete', { appId: 'app-budget' });
    expect(h.cards()).toEqual([]);
    expect(h.openDialogs()).toHaveLength(0);
  });

  it('keeps the card and tells the user deletion failed when the deletion request is rejected', async () => {
    const h = await openPanel(apps([budget], channel => {
      if (channel === 'savedApps.delete') return Promise.reject(new Error('delete interrupted'));
      throw new Error('unexpected IPC');
    }));
    await h.chooseMenuAction('app-budget', 'delete');
    h.openDialogs()[0].querySelector('[data-act="ok"]')!.click();
    await flush();

    expect(h.channels()).toEqual(['savedApps.list', 'savedApps.delete']);
    expect(h.cards()).toEqual(['app-budget']);
    const dialogs = h.openDialogs();
    expect(dialogs).toHaveLength(1);
    expect(h.dialogText(dialogs[0]).startsWith('删除失败')).toBe(true);
    expect(JSON.stringify(h.warnings)).not.toContain('delete interrupted');
  });
});

describe('My Apps edit', () => {
  it('opens the new edit task with the exact source-attachment prompt and saves it as the draft', async () => {
    const drafts: Array<[string, string]> = [];
    const h = await openPanel(apps([budget], channel => {
      if (channel !== 'savedApps.openForEditing') throw new Error('unexpected IPC');
      return { ok: true, title: 'X', sourceFileName: 'app-source.md',
        conversation: { conversation_id: 'edit-task', title: 'X', created_at: savedAt, updated_at: savedAt } };
    }));
    const input = h.document.getElementById('chat-input')!;
    Object.assign(h.context, {
      conversations: [], renderConversationList: vi.fn(), setView: vi.fn(),
      _saveDraft: (cid: string) => drafts.push([cid, input.value]),
    });
    await h.chooseMenuAction('app-budget', 'edit');

    expect(h.invoke).toHaveBeenCalledWith('savedApps.openForEditing', { appId: 'app-budget' });
    expect(h.context.setView).toHaveBeenCalledWith('conversation', 'edit-task', { skipLoad: true });
    expect(input.value).toBe('请修改交互应用「X」，源码见附件「app-source.md」：');
    expect(drafts).toEqual([['edit-task', '请修改交互应用「X」，源码见附件「app-source.md」：']]);
    expect(h.warnings).toEqual([]);
  });
});

describe('My Apps unified creation', () => {
  it.each(['cancel', 'escape', 'backdrop'])('retains the idea after %s without creating a task', async dismissal => {
    const h = await openPanel(apps([]));
    h.$('#apps-create-btn')!.click();
    const panel = h.$('.apps-create-overlay')!;
    h.input(panel.querySelector('textarea')!, '  Family meals\n购物清单 <b>raw</b>  ');
    if (dismissal === 'cancel') panel.querySelector('[data-create-cancel]')!.click();
    else if (dismissal === 'escape') h.press('Escape');
    else panel.click();
    expect(h.$('.apps-create-overlay')).toBeNull();
    h.$('#apps-create-btn')!.click();
    expect(h.$('.apps-create-overlay textarea')!.value).toBe('  Family meals\n购物清单 <b>raw</b>  ');
    expect(h.$('[data-app-type]')).toBeNull();
    expect(h.$('[data-create-submit]')!.disabled).toBe(false);
    expect(h.channels()).toEqual(['savedApps.list']);
  });

  it.each([true, false])('account reset discards the draft with the dialog open=%s', async open => {
    const h = await openPanel(apps([]));
    h.$('#apps-create-btn')!.click();
    h.input(h.$('.apps-create-overlay textarea')!, 'Private account idea');
    if (!open) h.$('[data-create-cancel]')!.click();
    await h.window.loadSavedApps(true, { reset: true });
    expect(h.$('.apps-create-overlay')).toBeNull();
    h.$('#apps-create-btn')!.click();
    expect(h.$('.apps-create-overlay textarea')!.value).toBe('');
    expect(h.$('[data-create-submit]')!.disabled).toBe(true);
  });

  it('creates an app without asking for a runtime type', async () => {
    const accepted = deferred();
    const h = await openPanel(apps([], channel => {
      if (channel !== 'conversations.create') throw new Error('unexpected IPC');
      return { ok: true, conversation: { conversation_id: 'create-task', title: 'Habit tracker', created_at: savedAt, updated_at: savedAt } };
    }));
    Object.assign(h.context, {
      ensureModelConfigured: () => true, _autoTitle: (text: string) => text, conversations: [],
      renderConversationList: vi.fn(), setView: vi.fn(), _restoreDraft: vi.fn(), setChatRecipient: vi.fn(),
      _rememberSentComposerSnapshot: vi.fn(),
      sendInConversation: vi.fn(async (_cid: string, _text: string, _extra: unknown, options: any) => { options.onAccepted(); accepted.resolve(null); }),
    });
    h.$('#apps-create-btn')!.click();
    const overlay = h.$('.apps-create-overlay')!;
    expect(overlay.querySelector('[data-app-type]')).toBeNull();
    h.input(overlay.querySelector('#apps-create-idea')!, 'Habit tracker');
    overlay.querySelector('[data-create-submit]')!.click();
    await accepted.promise; await flush();

    expect(h.invoke.mock.calls.filter(call => call[0] === 'conversations.create')).toEqual([
      ['conversations.create', { title: 'Habit tracker', assistance: { kind: 'app_creation', appType: 'local' } }],
    ]);
    expect(h.context.sendInConversation).toHaveBeenCalledOnce();
    expect(h.$('.apps-create-overlay')).toBeNull();
    h.$('#apps-create-btn')!.click();
    expect(h.$('.apps-create-overlay textarea')!.value).toBe('');
    expect(h.$('[data-app-type]')).toBeNull();
  });
});

describe('My Apps saved time', () => {
  // Product copy (docs/test/my-apps-regression.md): just now / same-day HH:mm / an older calendar date.
  it.each([
    ['zh', ['保存于 刚刚', '保存于 08:05', '保存于 13:21', '保存于 2026-06-01']],
    ['en', ['Saved just now', 'Saved 08:05', 'Saved 13:21', 'Saved 2026-06-01']],
  ] as const)('shows %s card times as just now, a same-day clock time, or the saved date', async (lang, expected) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 5, 10, 15, 30, 0));
      const at = (...parts: number[]) => new Date(...(parts as [number, number, number, number, number])).toISOString();
      const list = [
        { id: 'a-now', title: 'Now', appType: 'local', savedAt: at(2026, 5, 10, 15, 29, 40) },
        { id: 'b-morning', title: 'Morning', appType: 'local', savedAt: at(2026, 5, 10, 8, 5) },
        { id: 'c-noon', title: 'Noon', appType: 'local', savedAt: at(2026, 5, 10, 13, 21) },
        { id: 'd-old', title: 'Old', appType: 'local', savedAt: at(2026, 5, 1, 9, 0) },
      ];
      const h = await openPanel(apps(list), lang);
      expect(h.cards()).toEqual(['a-now', 'b-morning', 'c-noon', 'd-old']);
      expect(list.map(app => h.card(app.id)!.querySelector('.app-card-time')!.textContent)).toEqual(expected);
    } finally { vi.useRealTimers(); }
  });
});

describe('My Apps failure alerts', () => {
  const privateDetail = '/Users/test/Library/Application Support/Orkas/data/u1/cloud/saved_apps/app-budget/index.html: ENOENT';
  it.each([
    ['zh', 'rejected', '无法打开应用'],
    ['zh', 'refused', '无法打开应用'],
    ['en', 'rejected', 'Could not open the app'],
    ['en', 'refused', 'Could not open the app'],
  ] as const)('%s open failure (%s) shows only the localized action copy, never the private error text', async (lang, mode, copy) => {
    const h = await openPanel(apps([budget], channel => {
      if (channel !== 'savedApps.openInApp') throw new Error('unexpected IPC');
      return mode === 'rejected' ? Promise.reject(new Error(privateDetail)) : { ok: false, error: privateDetail };
    }), lang);
    h.card('app-budget')!.click();
    await flush();

    const dialogs = h.openDialogs();
    expect(dialogs).toHaveLength(1);
    expect(h.dialogText(dialogs[0])).toBe(copy);
    expect(JSON.stringify(h.warnings)).not.toContain('/Users/');
    expect(h.cards()).toEqual(['app-budget']);
  });
});

 it('shows old local and web apps together and offers publishing for both', async () => {
  const h = await openPanel(apps([budget,{id:'old-web',title:'Web',appType:'web',savedAt}]));
  expect(h.cards()).toEqual(['app-budget','old-web']);
  expect(h.$('[data-app-filter]')).toBeNull();
  h.card('app-budget')!.querySelector('[data-app-more]')!.click();
  expect(h.$('.app-row-menu [data-action="publish"]')).not.toBeNull();
});
