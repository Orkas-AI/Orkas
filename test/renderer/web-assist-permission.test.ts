import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/modules/web-assist.js'), 'utf8');
function fixture(invoke = vi.fn(async () => ({ handled: true }))) {
  const elements = new Map<string, any>();
  const element = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, { hidden: false, disabled: false, textContent: '', focus: vi.fn() });
    return elements.get(selector);
  };
  const first = { tab_id: 'first', permission_request: { id: 'one', message: 'Allow https://site.example to use notifications?' } };
  const other = { tab_id: 'other', permission_request: { id: 'two', message: '<site-controlled-text>' } };
  const context = vm.createContext({
    currentState: { active_tab_id: 'first' }, selected: first,
    selectedTab: () => context.selected,
    activeView: 'conversation', panelOpen: true, panelTab: 'browser', contextEpoch: 0,
    permissionPromptEl: { hidden: true, querySelector: element, querySelectorAll: () => [element('[data-act="deny-permission"]'), element('[data-act="allow-permission"]')] },
    activityBtn: { disabled: false }, activePermissionPrompt: null,
    setActivityOpen: vi.fn(), renderState: vi.fn(() => context.renderPermissionPrompt()),
    label: (_key: string, fallback: string) => fallback, window: { orkas: { invoke } },
  });
  vm.runInContext(source.slice(source.indexOf('  function renderPermissionPrompt()'), source.indexOf('  function setActivityOpen(')), context);
  return { context, element, invoke, first, other };
}

describe('site permission browser chrome', () => {
  it('shows only the selected page request, uses text safely, and leaves denial as the default focus', () => {
    const { context, first, other, element } = fixture();
    context.selected = other; context.renderPermissionPrompt();
    expect(context.permissionPromptEl.hidden).toBe(true);
    context.selected = first; context.panelTab = 'files'; context.renderPermissionPrompt();
    expect(context.permissionPromptEl.hidden).toBe(true);
    context.panelTab = 'browser';
    (first as any).page_dialog = { id: 'page-message' };
    context.renderPermissionPrompt();
    expect(context.permissionPromptEl.hidden).toBe(true);
    delete (first as any).page_dialog;
    context.renderPermissionPrompt();
    expect(context.permissionPromptEl.hidden).toBe(false);
    expect(context.activityBtn.disabled).toBe(true);
    expect(element('.web-assist-permission-message').textContent).toContain('notifications');
    expect(element('[data-act="deny-permission"]').focus).toHaveBeenCalledOnce();
    context.renderPermissionPrompt();
    expect(element('[data-act="deny-permission"]').focus).toHaveBeenCalledOnce();
    context.selected = other; context.currentState.active_tab_id = 'other'; context.renderPermissionPrompt();
    expect(element('.web-assist-permission-message').textContent).toBe('<site-controlled-text>');
    expect(element('.web-assist-permission-message').innerHTML).toBeUndefined();
  });
  it.each([true, false])('sends exactly the displayed request and removes it after choosing %s', async allowed => {
    const { context, invoke, first } = fixture();
    context.renderPermissionPrompt(); await context.answerPermissionPrompt(allowed);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('webAssist.permissionResponse', { tabId: 'first', requestId: 'one', allowed });
    expect(first.permission_request).toBeUndefined();
    expect(context.permissionPromptEl.hidden).toBe(true);
    expect(context.activityBtn.disabled).toBe(false);
  });
  it('keeps failed answers retryable and ignores late answers after switching page or task', async () => {
    let finish!: (value: unknown) => void;
    const invoke = vi.fn().mockResolvedValueOnce({ handled: false }).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { context, element, other } = fixture(invoke);
    context.renderPermissionPrompt(); await context.answerPermissionPrompt(true);
    expect(element('.web-assist-permission-error').hidden).toBe(false);
    expect(element('[data-act="deny-permission"]').disabled).toBe(false);
    const pending = context.answerPermissionPrompt(true);
    await context.answerPermissionPrompt(true); expect(invoke).toHaveBeenCalledTimes(2);
    context.contextEpoch++; context.selected = other; context.currentState.active_tab_id = 'other'; context.renderPermissionPrompt();
    finish({ handled: true }); await pending;
    expect(other.permission_request).toBeDefined();
    expect(element('.web-assist-permission-error').hidden).toBe(true);
    expect(element('[data-act="deny-permission"]').disabled).toBe(false);
    context.panelOpen = false; context.renderPermissionPrompt();
    await context.answerPermissionPrompt(true); expect(invoke).toHaveBeenCalledTimes(2);
  });
});
