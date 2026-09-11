import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(async () => {
  const users = await import('../../../../src/main/features/users');
  users.activateUser('action-confirm-user');
  const permissions = await import('../../../../src/main/features/permissions');
  permissions.setLocalExecMode('all_files_approval');
});


afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});


describe('connectors/action_confirm', () => {
  it.each([
    ['feishu', 'execute_high_impact', { action: 'im.+messages-send' }, 'im.+messages-send'],
    ['dingtalk', 'execute_high_impact', { action: 'chat send' }, 'chat send'],
    ['xero', 'execute_destructive', { action: 'invoices.delete' }, 'invoices.delete'],
    ['shopify-admin', 'execute_high_impact', { action: 'orders.cancel' }, 'orders.cancel'],
    ['gmail', 'GMAIL_SEND_EMAIL', { action: 'unrelated parameter' }, 'GMAIL_SEND_EMAIL'],
    ['custom-example', 'execute_high_impact', { action: 'unrelated parameter' }, 'execute_high_impact'],
    ['unknown-provider', 'execute_high_impact', { action: 'unrelated parameter' }, 'execute_high_impact'],
    ['feishu', 'describe_action', { action: 'im.+messages-send' }, 'describe_action'],
    ['feishu', 'execute_high_impact', {}, 'execute_high_impact'],
    ['feishu', 'execute_high_impact', { action: null }, 'execute_high_impact'],
    ['feishu', 'execute_high_impact', { action: ['im.+messages-send'] }, 'execute_high_impact'],
    ['feishu', 'execute_high_impact', { actions: ['im.+messages-send'] }, 'execute_high_impact'],
    ['feishu', 'execute_high_impact', { action: { name: 'im.+messages-send' } }, 'execute_high_impact'],
    ['feishu', 'execute_high_impact', { action: ' ' }, 'execute_high_impact'],
  ])('shows the actual operation identifier for %s / %s without interpreting arbitrary parameters', async (connectorId, toolName, args, expected) => {
    const confirm = await import('../../../../src/main/features/connectors/action_confirm');
    let info: any;
    confirm._setBroadcastForTest((_channel, payload) => { info = payload; });
    const pending = confirm.requestActionConfirm({
      connectorId, toolName, args, displayName: connectorId, risk: 'H',
    });
    expect(info.action_name).toBe(expected);
    expect(info.tool_name).toBe(toolName);
    confirm.respond(info.request_id, false);
    await expect(pending).resolves.toBe(false);
  });

  it('preserves the operation when large parameters truncate the details, without mutating execution arguments', async () => {
    const confirm = await import('../../../../src/main/features/connectors/action_confirm');
    const args = {
      parameters: { user_id: 'recipient-1', attachments: [{ api_key: 'private-key', name: 'report' }] },
      ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`field_${i}`, 'x'.repeat(700)])),
      action: 'im.+messages-send',
    };
    const original = JSON.stringify(args);
    let info: any;
    confirm._setBroadcastForTest((_channel, payload) => { info = payload; });
    const pending = confirm.requestActionConfirm({
      connectorId: 'feishu', displayName: 'Feishu', toolName: 'execute_high_impact', risk: 'H', args,
    });
    try {
      expect(info.action_name).toBe('im.+messages-send');
      expect(info.arguments_preview).not.toContain('im.+messages-send');
      expect(info.arguments_preview).toContain('recipient-1');
      expect(info.arguments_preview).toContain('[redacted]');
      expect(info.arguments_preview).not.toContain('private-key');
      expect(info.arguments_preview.length).toBeLessThanOrEqual(8_002);
      expect(info.arguments_preview.endsWith('…')).toBe(true);
      expect(JSON.stringify(args)).toBe(original);
    } finally {
      confirm.respond(info.request_id, false);
      await expect(pending).resolves.toBe(false);
    }
  });

  it('grants all actions for one connector account in one task, including concurrent requests', async () => {
    const confirm = await import('../../../../src/main/features/connectors/action_confirm');
    const pushes: Array<{ channel: string; payload: any }> = [];
    confirm._setBroadcastForTest((channel, payload) => { pushes.push({ channel, payload }); });
    const opts = {
      cid: 'task-grant', connectorId: 'feishu', displayName: 'Feishu', accountLabel: 'Account A',
      toolName: 'execute_high_impact', risk: 'H' as const, args: { action: 'send', recipient: 'A' },
    };
    const first = confirm.requestActionConfirm(opts);
    const queued = confirm.requestActionConfirm({ ...opts, toolName: 'execute_destructive', risk: 'D' });
    const [one, two] = pushes.map((push) => push.payload);
    expect(one.can_allow_run).toBe(true);
    expect(confirm.respond(one.request_id, true, 'task')).toBe(true);
    await expect(first).resolves.toBe(true);
    await expect(queued).resolves.toBe(true);
    expect(pushes.at(-1)).toMatchObject({ channel: 'connectors:action-confirm-cancelled',
      payload: { request_ids: [two.request_id], approved: true } });
    expect(confirm.respond(two.request_id, false)).toBe(false);
    const delivered = pushes.length;
    await expect(confirm.requestActionConfirm({ ...opts, toolName: 'delete', risk: 'D', args: { id: 'other' } })).resolves.toBe(true);
    expect(pushes).toHaveLength(delivered);
    const permissions = await import('../../../../src/main/features/permissions');
    expect(permissions.getLocalExecMode()).toBe('all_files_approval');

    for (const change of [{ cid: 'other-task' }, { connectorId: 'gmail' }, { accountLabel: 'Account B' }, { accountKey: 'replacement-connection' }]) {
      const isolated = confirm.requestActionConfirm({ ...opts, ...change });
      expect(pushes.at(-1)?.channel).toBe('connectors:action-confirm');
      confirm.respond(pushes.at(-1)!.payload.request_id, false);
      await expect(isolated).resolves.toBe(false);
    }
    confirm.cancelForCid(opts.cid);
    const nextTask = confirm.requestActionConfirm(opts);
    expect(pushes.at(-1)?.channel).toBe('connectors:action-confirm');
    confirm.respond(pushes.at(-1)!.payload.request_id, false);
    await expect(nextTask).resolves.toBe(false);
  });

  it('does not cache one-time approval or denial and rejects task grants without a task', async () => {
    const confirm = await import('../../../../src/main/features/connectors/action_confirm');
    let info: any;
    confirm._setBroadcastForTest((_channel, payload) => { info = payload; });
    const opts = { connectorId: 'feishu', displayName: 'Feishu', toolName: 'send', risk: 'H' as const, args: {} };
    const noTask = confirm.requestActionConfirm(opts);
    expect(info.can_allow_run).toBe(false);
    expect(confirm.respond(info.request_id, true, 'task')).toBe(false);
    confirm.respond(info.request_id, false);
    await expect(noTask).resolves.toBe(false);
    for (const approved of [true, false, true]) {
      const pending = confirm.requestActionConfirm({ ...opts, cid: 'repeat-once' });
      expect(confirm.respond(info.request_id, approved)).toBe(true);
      await expect(pending).resolves.toBe(approved);
      expect(confirm.respond(info.request_id, true, 'task')).toBe(false);
    }
  });

  it('revokes task grants after account switching even when returning to the original account', async () => {
    const confirm = await import('../../../../src/main/features/connectors/action_confirm');
    const users = await import('../../../../src/main/features/users');
    let info: any;
    confirm._setBroadcastForTest((_channel, payload) => { info = payload; });
    const opts = { cid: 'switch-grant', connectorId: 'feishu', displayName: 'Feishu', toolName: 'send', risk: 'H' as const, args: {} };
    const first = confirm.requestActionConfirm(opts);
    confirm.respond(info.request_id, true, 'task');
    await expect(first).resolves.toBe(true);
    users.activateUser('other-account');
    users.activateUser('action-confirm-user');
    const next = confirm.requestActionConfirm(opts);
    expect(confirm.respond(info.request_id, false)).toBe(true);
    await expect(next).resolves.toBe(false);
  });

  it.each(['H', 'D'] as const)('executes an allowed %s action without a dialog in trusted mode', async (risk) => {
    const confirm = await import('../../../../src/main/features/connectors/action_confirm');
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.setLocalExecMode('all_files_auto');
    const broadcast = vi.fn();
    confirm._setBroadcastForTest(broadcast);
    await expect(confirm.requestActionConfirm({
      connectorId: 'shop', displayName: 'Shop', toolName: 'action', risk, args: {},
    })).resolves.toBe(true);
    expect(broadcast).not.toHaveBeenCalled();
    const aborted = new AbortController();
    aborted.abort();
    await expect(confirm.requestActionConfirm({
      connectorId: 'shop', displayName: 'Shop', toolName: 'action', risk, args: {}, signal: aborted.signal,
    })).resolves.toBe(false);
    confirm._setBroadcastForTest(null);
  });

  it('withdraws an old-account approval so a late click cannot execute it', async () => {
    const confirm = await import('../../../../src/main/features/connectors/action_confirm');
    const users = await import('../../../../src/main/features/users');
    const pushed: Array<{ channel: string; payload: any }> = [];
    confirm._setBroadcastForTest((channel, payload) => { pushed.push({ channel, payload }); });
    const pending = confirm.requestActionConfirm({
      connectorId: 'gmail', displayName: 'Gmail', toolName: 'GMAIL_SEND_EMAIL', risk: 'H', args: {},
    });
    users.activateUser('other-action-user');
    await expect(pending).resolves.toBe(false);
    expect(confirm.respond(pushed[0].payload.request_id, true)).toBe(false);
    expect(pushed.at(-1)?.channel).toBe('connectors:action-confirm-cancelled');
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.setLocalExecMode('all_files_auto');
    const delivered = pushed.length;
    await expect(confirm.requestActionConfirm({
      userId: 'action-confirm-user',
      connectorId: 'gmail', displayName: 'Gmail', toolName: 'GMAIL_SEND_EMAIL', risk: 'H', args: {},
    })).resolves.toBe(false);
    expect(pushed).toHaveLength(delivered);
    confirm._setBroadcastForTest(null);
  });

  it('withdraws expired approval, stops waiting progress, and permits a fresh retry', async () => {
    const confirm = await import('../../../../src/main/features/connectors/action_confirm');
    vi.useFakeTimers();
    const pushed: Array<{ channel: string; payload: any }> = [];
    const onWaiting = vi.fn();
    confirm._setBroadcastForTest((channel, payload) => { pushed.push({ channel, payload }); });
    const options = {
      cid: 'timeout-retry', connectorId: 'gmail', displayName: 'Gmail',
      toolName: 'GMAIL_SEND_EMAIL', risk: 'H' as const, args: { recipient_email: 'reader@example.com' }, onWaiting,
    };
    try {
      const pending = confirm.requestActionConfirm(options);
      const expiredId = pushed[0].payload.request_id;
      expect(onWaiting).toHaveBeenCalledWith(0);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(onWaiting).toHaveBeenLastCalledWith(25_000);
      await vi.advanceTimersByTimeAsync(10 * 60_000 - 25_000);
      await expect(pending).resolves.toBe(false);
      expect(pushed.at(-1)).toEqual({
        channel: 'connectors:action-confirm-cancelled',
        payload: { request_ids: [expiredId], cid: 'timeout-retry' },
      });
      expect(confirm.respond(expiredId, true)).toBe(false);
      const notificationsAtExpiry = onWaiting.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onWaiting).toHaveBeenCalledTimes(notificationsAtExpiry);
      expect(vi.getTimerCount()).toBe(0);

      const retry = confirm.requestActionConfirm(options);
      const retryId = pushed.at(-1)!.payload.request_id;
      expect(retryId).not.toBe(expiredId);
      expect(confirm.respond(retryId, true)).toBe(true);
      await expect(retry).resolves.toBe(true);
      expect(confirm.respond(retryId, true)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      confirm.cancelForCid('timeout-retry');
      confirm._setBroadcastForTest(null);
    }
  });

  it('cancels one task without discarding or approving another task waiting concurrently', async () => {
    const confirm = await import('../../../../src/main/features/connectors/action_confirm');
    const prompts: import('../../../../src/main/features/connectors/action_confirm').ActionConfirmInfo[] = [];
    confirm._setBroadcastForTest((channel, payload) => {
      if (channel === 'connectors:action-confirm') prompts.push(payload as typeof prompts[number]);
    });
    try {
      const first = confirm.requestActionConfirm({
        cid: 'task-first', connectorId: 'gmail', displayName: 'Gmail',
        toolName: 'GMAIL_SEND_EMAIL', risk: 'H', args: { recipient_email: 'first@example.com' },
      });
      const second = confirm.requestActionConfirm({
        cid: 'task-second', connectorId: 'gmail', displayName: 'Gmail',
        toolName: 'GMAIL_SEND_EMAIL', risk: 'H', args: { recipient_email: 'second@example.com' },
      });
      let secondSettled = false;
      void second.then(() => { secondSettled = true; });
      expect(prompts).toHaveLength(2);
      expect(prompts[0].request_id).not.toBe(prompts[1].request_id);
      confirm.cancelForCid('task-first');
      await expect(first).resolves.toBe(false);
      expect(secondSettled).toBe(false);
      expect(confirm.respond(prompts[0].request_id, true)).toBe(false);
      expect(confirm.respond(prompts[1].request_id, true)).toBe(true);
      await expect(second).resolves.toBe(true);
      expect(confirm.respond(prompts[1].request_id, true)).toBe(false);
    } finally {
      confirm.cancelForCid('task-first');
      confirm.cancelForCid('task-second');
      confirm._setBroadcastForTest(null);
    }
  });

  it('rejects immediately when no window can present the sensitive action', async () => {
    const confirm = await import('../../../../src/main/features/connectors/action_confirm');
    let requestId = '';
    confirm._setBroadcastForTest((_channel, payload: any) => {
      requestId = payload.request_id;
      return false;
    });
    await expect(confirm.requestActionConfirm({
      connectorId: 'gmail', displayName: 'Gmail', toolName: 'GMAIL_SEND_EMAIL', risk: 'H', args: {},
    })).resolves.toBe(false);
    expect(confirm.respond(requestId, true)).toBe(false);
    confirm._setBroadcastForTest(null);
  });

  it('stops waiting progress when cancellation arrives during the first notification', async () => {
    const confirm = await import('../../../../src/main/features/connectors/action_confirm');
    vi.useFakeTimers();
    const controller = new AbortController();
    confirm._setBroadcastForTest(() => true);
    const onWaiting = vi.fn(() => controller.abort());
    await expect(confirm.requestActionConfirm({
      connectorId: 'gmail', displayName: 'Gmail', toolName: 'GMAIL_SEND_EMAIL', risk: 'H', args: {},
      signal: controller.signal, onWaiting,
    })).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    confirm._setBroadcastForTest(null);
  });

  it('shows the exact normalized action context and resolves only from its matching response', async () => {
    const confirm = await import('../../../../src/main/features/connectors/action_confirm');
    const pushed: Array<{ channel: string; payload: any }> = [];
    confirm._setBroadcastForTest((channel, payload) => { pushed.push({ channel, payload }); });
    try {
      const pending = confirm.requestActionConfirm({
        cid: 'conv-1',
        connectorId: 'shop',
        displayName: 'Shop',
        accountLabel: 'Store A',
        toolName: 'SHOP_CREATE_REFUND',
        risk: 'H',
        sensitiveOperation: 'money',
        args: { order_id: 'order-1', amount: 12.5 },
      });

      expect(pushed).toHaveLength(1);
      expect(pushed[0]).toMatchObject({
        channel: 'connectors:action-confirm',
        payload: {
          connector_id: 'shop',
          display_name: 'Shop',
          account_label: 'Store A',
          tool_name: 'SHOP_CREATE_REFUND',
          risk: 'H',
          sensitive_operation: 'money',
          cid: 'conv-1',
        },
      });
      expect(pushed[0].payload.arguments_preview).toContain('"amount": 12.5');
      expect(confirm.respond('not-this-request', true)).toBe(false);
      expect(confirm.respond(pushed[0].payload.request_id, true)).toBe(true);
      await expect(pending).resolves.toBe(true);
      expect(confirm.respond(pushed[0].payload.request_id, true)).toBe(false);
    } finally {
      confirm._setBroadcastForTest(null);
    }
  });

  it('redacts secret-like fields from the renderer preview without hiding recipients or amounts', async () => {
    const confirm = await import('../../../../src/main/features/connectors/action_confirm');

    const preview = confirm.previewArguments({
      recipient_email: 'buyer@example.com',
      amount: 99,
      api_key: 'secret-value',
      nested: { refresh_token: 'secret-token', order_id: 'order-2' },
    });

    expect(preview).toContain('buyer@example.com');
    expect(preview).toContain('99');
    expect(preview).toContain('order-2');
    expect(preview).not.toContain('secret-value');
    expect(preview).not.toContain('secret-token');
    expect(preview.match(/\[redacted\]/g)).toHaveLength(2);
  });

  it('fails closed on cancellation and invalidates the renderer request', async () => {
    const confirm = await import('../../../../src/main/features/connectors/action_confirm');
    const pushed: Array<{ channel: string; payload: any }> = [];
    const controller = new AbortController();
    confirm._setBroadcastForTest((channel, payload) => { pushed.push({ channel, payload }); });
    try {
      const pending = confirm.requestActionConfirm({
        cid: 'conv-2',
        connectorId: 'shop',
        displayName: 'Shop',
        toolName: 'SHOP_DELETE_ORDER',
        risk: 'D',
        args: { order_id: 'order-2' },
        signal: controller.signal,
      });

      controller.abort();

      await expect(pending).resolves.toBe(false);
      expect(pushed.at(-1)).toEqual({
        channel: 'connectors:action-confirm-cancelled',
        payload: { request_ids: [pushed[0].payload.request_id], cid: 'conv-2' },
      });
      expect(confirm.respond(pushed[0].payload.request_id, true)).toBe(false);
    } finally {
      confirm._setBroadcastForTest(null);
    }
  });
});
