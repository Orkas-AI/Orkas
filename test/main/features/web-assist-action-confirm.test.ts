import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TARGET = {
  userId: 'web-assist-confirm-user',
  conversationId: 'c1',
  tabId: 'tab-1',
  origin: 'https://chatgpt.com',
  tag: 'button',
  label: 'Send prompt',
};

beforeEach(async () => {
  const users = await import('../../../src/main/features/users');
  users.activateUser(TARGET.userId);
  const permissions = await import('../../../src/main/features/permissions');
  permissions.setLocalExecMode('all_files_approval');
});

afterEach(async () => {
  const confirm = await import('../../../src/main/features/web_assist_confirm');
  confirm._setBroadcastForTest(null);
  confirm.clearWebAssistActionGrants({});
  vi.resetModules();
});

describe('web_assist_confirm', () => {
  it('only offers the handbacks a user is allowed to resolve', async () => {
    const confirm = await import('../../../src/main/features/web_assist_confirm');
    expect(confirm.isGateableWebAssistReason('high_impact_action')).toBe(true);
    expect(confirm.isGateableWebAssistReason('form_submission_or_authorization')).toBe(true);
    // Approving these would put a secret or a file in the model's hands.
    expect(confirm.isGateableWebAssistReason('sensitive_input')).toBe(false);
    expect(confirm.isGateableWebAssistReason('sensitive_form_submission')).toBe(false);
    expect(confirm.isGateableWebAssistReason('file_upload')).toBe(false);
    expect(confirm.isGateableWebAssistReason(undefined)).toBe(false);
  });

  it('runs without a dialog in trusted mode and still leaves no standing grant', async () => {
    const confirm = await import('../../../src/main/features/web_assist_confirm');
    const permissions = await import('../../../src/main/features/permissions');
    permissions.setLocalExecMode('all_files_auto');
    const broadcast = vi.fn();
    confirm._setBroadcastForTest(broadcast);
    await expect(confirm.requestWebAssistActionConfirm({
      target: TARGET, reason: 'high_impact_action', pageTitle: 'ChatGPT', controlKind: 'button',
    })).resolves.toBe('once');
    expect(broadcast).not.toHaveBeenCalled();
    // The mode is the standing permission; a later cautious mode must bite.
    expect(confirm.hasWebAssistActionGrant(TARGET)).toBe(false);
  });

  it('remembers a run grant for the same control and asks again for anything else', async () => {
    const confirm = await import('../../../src/main/features/web_assist_confirm');
    const pushed: Array<{ channel: string; payload: any }> = [];
    confirm._setBroadcastForTest((channel, payload) => { pushed.push({ channel, payload }); });
    const pending = confirm.requestWebAssistActionConfirm({
      target: TARGET, reason: 'high_impact_action', pageTitle: 'ChatGPT', controlKind: 'button',
    });
    expect(pushed[0].channel).toBe('web-assist:action-confirm');
    expect(pushed[0].payload).toMatchObject({
      control_label: 'Send prompt',
      page_origin: 'https://chatgpt.com',
      reason: 'high_impact_action',
    });
    expect(confirm.respond(pushed[0].payload.request_id, 'run')).toBe(true);
    await expect(pending).resolves.toBe('run');

    confirm.rememberWebAssistActionGrant(TARGET);
    expect(confirm.hasWebAssistActionGrant(TARGET)).toBe(true);
    for (const changed of [
      { ...TARGET, origin: 'https://gemini.google.com' },
      { ...TARGET, label: 'Delete account' },
      { ...TARGET, tabId: 'tab-2' },
      { ...TARGET, conversationId: 'c2' },
      { ...TARGET, userId: 'someone-else' },
    ]) {
      expect(confirm.hasWebAssistActionGrant(changed)).toBe(false);
    }
  });

  it('answers once without widening to later attempts', async () => {
    const confirm = await import('../../../src/main/features/web_assist_confirm');
    const pushed: Array<{ channel: string; payload: any }> = [];
    confirm._setBroadcastForTest((channel, payload) => { pushed.push({ channel, payload }); });
    const pending = confirm.requestWebAssistActionConfirm({
      target: TARGET, reason: 'form_submission_or_authorization', pageTitle: 'Shop', controlKind: 'button',
    });
    confirm.respond(pushed[0].payload.request_id, 'once');
    await expect(pending).resolves.toBe('once');
    expect(confirm.hasWebAssistActionGrant(TARGET)).toBe(false);
  });

  it('denies when no renderer can show the request', async () => {
    const confirm = await import('../../../src/main/features/web_assist_confirm');
    confirm._setBroadcastForTest(() => false);
    await expect(confirm.requestWebAssistActionConfirm({
      target: TARGET, reason: 'high_impact_action', pageTitle: 'ChatGPT', controlKind: 'button',
    })).resolves.toBe('deny');
  });

  it('withdraws a pending request and every grant when the account changes', async () => {
    const confirm = await import('../../../src/main/features/web_assist_confirm');
    const users = await import('../../../src/main/features/users');
    const pushed: Array<{ channel: string; payload: any }> = [];
    confirm._setBroadcastForTest((channel, payload) => { pushed.push({ channel, payload }); });
    confirm.rememberWebAssistActionGrant(TARGET);
    const pending = confirm.requestWebAssistActionConfirm({
      target: TARGET, reason: 'high_impact_action', pageTitle: 'ChatGPT', controlKind: 'button',
    });
    users.activateUser('another-web-assist-user');
    await expect(pending).resolves.toBe('deny');
    expect(confirm.hasWebAssistActionGrant(TARGET)).toBe(false);
    expect(pushed.at(-1)?.channel).toBe('web-assist:action-confirm-cancelled');
    // A late click on the withdrawn dialog cannot revive it.
    expect(confirm.respond(pushed[0].payload.request_id, 'run')).toBe(false);
  });

  it('withdraws an aborted call and rejects its late approval', async () => {
    const confirm = await import('../../../src/main/features/web_assist_confirm');
    const pushed: Array<{ channel: string; payload: any }> = [];
    confirm._setBroadcastForTest((channel, payload) => { pushed.push({ channel, payload }); });
    const controller = new AbortController();
    const pending = confirm.requestWebAssistActionConfirm({
      target: TARGET, reason: 'high_impact_action', pageTitle: 'ChatGPT', controlKind: 'button',
      signal: controller.signal,
    });
    controller.abort();
    expect(pushed.at(-1)?.channel).toBe('web-assist:action-confirm-cancelled');
    expect(confirm.respond(pushed[0].payload.request_id, 'run')).toBe(false);
    await expect(pending).resolves.toBe('deny');
  });

  it('drops the grants of one tab and leaves the rest', async () => {
    const confirm = await import('../../../src/main/features/web_assist_confirm');
    const other = { ...TARGET, tabId: 'tab-2' };
    confirm.rememberWebAssistActionGrant(TARGET);
    confirm.rememberWebAssistActionGrant(other);
    confirm.clearWebAssistActionGrants({ tabId: TARGET.tabId });
    expect(confirm.hasWebAssistActionGrant(TARGET)).toBe(false);
    expect(confirm.hasWebAssistActionGrant(other)).toBe(true);
  });

  it('binds a grant to an origin and never to a full URL', async () => {
    const confirm = await import('../../../src/main/features/web_assist_confirm');
    expect(confirm.webAssistPageOrigin('https://chatgpt.com/c/abc?token=secret')).toBe('https://chatgpt.com');
    expect(confirm.webAssistPageOrigin('http://localhost:9000/x')).toBe('http://localhost:9000');
    expect(confirm.webAssistPageOrigin('file:///etc/passwd')).toBe('');
    expect(confirm.webAssistPageOrigin('not a url')).toBe('');
    // An unresolvable origin is never remembered, so each attempt asks again.
    const unresolved = { ...TARGET, origin: '' };
    confirm.rememberWebAssistActionGrant(unresolved);
    expect(confirm.hasWebAssistActionGrant(unresolved)).toBe(false);
  });
});
