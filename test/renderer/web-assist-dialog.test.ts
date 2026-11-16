import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/modules/web-assist.js'), 'utf8');
function fixture(invoke = vi.fn(async () => ({ handled: true }))) {
  const elements = new Map<string, any>();
  const element = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, { hidden: false, disabled: false, textContent: '', value: '', focus: vi.fn() });
    return elements.get(selector);
  };
  const first: any = { tab_id: 'first', page_dialog: { id: 'one', type: 'prompt', message: '<untrusted>\nYour reply?', value: 'private-default' } };
  const other: any = { tab_id: 'other', page_dialog: { id: 'two', type: 'alert', message: 'Submission failed' } };
  const context = vm.createContext({
    currentState: { active_tab_id: 'first' }, selected: first, selectedTab: () => context.selected,
    activeView: 'conversation', panelOpen: true, panelTab: 'browser', contextEpoch: 0,
    pageDialogEl: { hidden: true, querySelector: element, querySelectorAll: () => [element('[data-act="cancel-dialog"]'), element('[data-act="accept-dialog"]')] },
    permissionPromptEl: { hidden: true }, activePageDialog: null, activityBtn: { disabled: false },
    setActivityOpen: vi.fn(), renderState: vi.fn(() => context.renderPageDialog()),
    label: (_key: string, fallback: string) => fallback, window: { orkas: { invoke } }, log: { warn: vi.fn() },
  });
  vm.runInContext(source.slice(source.indexOf('  function renderPageDialog()'), source.indexOf('  function setActivityOpen(')), context);
  return { context, element, invoke, first, other };
}

describe('tab-owned website dialog chrome', () => {
  it('renders only the selected visible task and preserves an edited draft and focus on refresh', () => {
    const { context, first, other, element } = fixture();
    context.selected = other; context.renderPageDialog();
    expect(context.pageDialogEl.hidden).toBe(true);
    context.selected = first; context.panelTab = 'files'; context.renderPageDialog();
    expect(context.pageDialogEl.hidden).toBe(true);
    context.panelTab = 'browser'; context.renderPageDialog();
    expect(element('.web-assist-permission-message').textContent).toBe('<untrusted>\nYour reply?');
    expect(element('.web-assist-permission-message').innerHTML).toBeUndefined();
    expect(element('input').value).toBe('private-default');
    element('input').value = 'draft'; context.renderPageDialog();
    expect(element('input').value).toBe('draft');
    expect(element('input').focus).toHaveBeenCalledOnce();
    context.currentState.active_tab_id = 'other'; context.selected = other; context.renderPageDialog();
    expect(element('[data-act="cancel-dialog"]').hidden).toBe(true);
    expect(element('.form-row').hidden).toBe(true);
    expect(element('[data-act="accept-dialog"]').textContent).toBe('OK');
  });

  it('stores human edits under the displayed request and answers verbatim only once', async () => {
    const { context, element, invoke } = fixture();
    context.renderPageDialog(); element('input').value = '  用户输入😀  ';
    context.claimPageDialog();
    expect(invoke).toHaveBeenLastCalledWith('webAssist.dialogResponse', { tabId: 'first', requestId: 'one', editing: true, value: '  用户输入😀  ' });
    await context.answerPageDialog(true); await context.answerPageDialog(true);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith('webAssist.dialogResponse', { tabId: 'first', requestId: 'one', accepted: true, value: '  用户输入😀  ' });
    expect(context.pageDialogEl.hidden).toBe(true);
  });

  it('leaves failed answers retryable and cannot clear a newer page decision with a late response', async () => {
    let finish!: (value: unknown) => void;
    const invoke = vi.fn().mockResolvedValueOnce({ handled: false }).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { context, element, other } = fixture(invoke);
    context.renderPageDialog(); await context.answerPageDialog(false);
    expect(element('.web-assist-permission-error').hidden).toBe(false);
    expect(element('[data-act="accept-dialog"]').disabled).toBe(false);
    const pending = context.answerPageDialog(true); await context.answerPageDialog(true);
    expect(invoke).toHaveBeenCalledTimes(2);
    context.contextEpoch++; context.selected = other; context.currentState.active_tab_id = 'other'; context.renderPageDialog();
    finish({ handled: true }); await pending;
    expect(other.page_dialog).toBeDefined();
    expect(element('.web-assist-permission-error').hidden).toBe(true);
    expect(element('[data-act="accept-dialog"]').disabled).toBe(false);
  });
});
