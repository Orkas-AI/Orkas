import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

type DialogResult = string | { choice: string; mode?: string };

function loadHarness(
  dialogResult: DialogResult,
  invokeImpl?: (channel: string, payload: any) => Promise<any>,
  dialogImpl?: (arg: any) => Promise<any>,
  visibility?: { state: 'visible' | 'hidden'; focused?: boolean },
) {
  let pushHandler: ((info: any) => void) | null = null;
  let cancelHandler: ((info: any) => void) | null = null;
  const dialogArgs: any[] = [];
  const invokeCalls: Array<{ channel: string; payload: any }> = [];
  const monitorEvent = vi.fn();
  const warn = vi.fn();
  const normalizedResult = typeof dialogResult === 'string' ? { choice: dialogResult } : dialogResult;

  const context: any = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    String,
    Array,
    ...(visibility ? {
      document: {
        visibilityState: visibility.state,
        hasFocus: () => visibility.focused === true,
      },
    } : {}),
    createLogger: () => ({ warn, info() {}, error() {} }),
    t: (key: string, vars?: Record<string, unknown>) => {
      const dict: Record<string, string> = {
        'bash.permission.title': 'Run this command?',
        'bash.permission.message': '{agent} wants {reasons}:',
        'bash.permission.action_title': 'Allow this sensitive action?',
        'bash.permission.action_message': '{agent} wants {operation}, which {reasons}:',
        'bash.permission.action_fallback': 'local action',
        'bash.permission.mode_title': 'Permission level',
        'bash.permission.mode_hint': 'You can change this in Settings - General - Tool Execution Access.',
        'bash.permission.allow_always': 'Always allow',
        'bash.permission.allow_once': 'Allow once',
        'bash.permission.allow_run': 'Allow for this task',
        'bash.permission.deny': "Don't run",
        'bash.permission.agent_fallback': 'The assistant',
        'chat.from_commander': 'Commander',
        'bash.permission.reason.network_egress': 'network',
        'bash.permission.reason_sep': ', ',
        'settings.localexec.mode.workspace_approval': 'Cautious',
        'settings.localexec.mode.workspace_approval_desc': 'Workspace files only, confirm sensitive actions',
        'settings.localexec.mode.all_files_approval': 'Standard',
        'settings.localexec.mode.all_files_approval_desc': 'All files, confirm sensitive actions',
        'settings.localexec.mode.all_files_auto': 'Trusted',
        'settings.localexec.mode.all_files_auto_desc': 'All files, no sensitive confirmations',
      };
      let text = dict[key] || key;
      for (const [k, v] of Object.entries(vars || {})) {
        text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
      }
      return text;
    },
    Monitor: { event: monitorEvent },
    window: {
      Monitor: { event: monitorEvent },
      __orkasBashPermissionDialogForTest: vi.fn(async (arg: any) => {
        dialogArgs.push(arg);
        if (dialogImpl) return dialogImpl(arg);
        return {
          choice: normalizedResult.choice,
          mode: normalizedResult.mode || arg.currentMode,
        };
      }),
      orkas: {
        invoke: vi.fn(async (channel: string, payload: any) => {
          invokeCalls.push({ channel, payload });
          if (invokeImpl) return invokeImpl(channel, payload);
          if (channel === 'permissions.getLocalExec') return { ok: true, mode: 'all_files_approval' };
          if (channel === 'permissions.setLocalExecMode') return { ok: true, mode: payload.mode };
          return { handled: true };
        }),
        onPushEvent: vi.fn((name: string, cb: (info: any) => void) => {
          if (name === 'bash:permission') pushHandler = cb;
          if (name === 'bash:permission_cancelled') cancelHandler = cb;
        }),
      },
    },
  };
  context.window.window = context.window;
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/bash_permission.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'bash_permission.js' });
  if (!pushHandler) throw new Error('bash:permission handler was not registered');
  if (!cancelHandler) throw new Error('bash:permission_cancelled handler was not registered');

  return { context, pushHandler, cancelHandler, dialogArgs, invokeCalls, monitorEvent, warn };
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe('renderer bash permission prompt', () => {
  it('reuses the shared chevron icon in the permission level trigger', () => {
    const code = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/bash_permission.js'), 'utf8');

    expect(code).toContain("window.uiIconHtml('chevron-down', 'bash-permission-mode-trigger-caret')");
    expect(code).toContain('${caretHtml}');
  });

  it('renders permission levels + settings hint and persists all_files_auto before allowing', async () => {
    const h = loadHarness({ choice: 'allow_once', mode: 'all_files_auto' });

    h.pushHandler({
      request_id: 'req-1',
      agent_id: 'commander',
      agent_name: 'Commander',
      command: 'curl https://example.com',
      reasons: ['network_egress'],
    });
    await flush();

    expect(h.dialogArgs[0]).toMatchObject({
      currentMode: 'all_files_approval',
      modeTitle: 'Permission level',
      modeHint: 'You can change this in Settings - General - Tool Execution Access.',
    });
    expect(h.dialogArgs[0].message).toContain('Commander wants network:');
    expect(h.dialogArgs[0].modes).toEqual([
      expect.objectContaining({ mode: 'workspace_approval', label: 'Cautious' }),
      expect.objectContaining({ mode: 'all_files_approval', label: 'Standard' }),
      expect.objectContaining({ mode: 'all_files_auto', label: 'Trusted' }),
    ]);
    expect(h.invokeCalls).toEqual([
      { channel: 'permissions.getLocalExec', payload: undefined },
      { channel: 'permissions.setLocalExecMode', payload: { mode: 'all_files_auto' } },
      { channel: 'bash.permission_response', payload: { request_id: 'req-1', decision: 'allow_once' } },
    ]);
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_result', expect.objectContaining({
      result: 'success',
      decision: 'allow_once',
      effective_decision: 'allow_once',
      mode: 'all_files_auto',
      mode_changed: true,
      categories: 'network_egress',
      duration_ms: expect.any(Number),
    }));
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_requested', {
      categories: 'network_egress',
      visibility_state: 'unknown',
    });
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_presented', expect.objectContaining({
      categories: 'network_egress',
      mode: 'all_files_approval',
      visibility_state: 'unknown',
      queue_wait_ms: expect.any(Number),
    }));
    expect(h.monitorEvent.mock.calls
      .map(([name]) => name)
      .filter((name) => name.startsWith('bash_risk_prompt_'))).toEqual([
      'bash_risk_prompt_requested',
      'bash_risk_prompt_presented',
      'bash_risk_prompt_result',
    ]);
  });

  it.each([
    ['a focused window', { state: 'visible', focused: true } as const, 'visible_focused'],
    ['an unfocused window', { state: 'visible', focused: false } as const, 'visible_unfocused'],
    ['a hidden window', { state: 'hidden', focused: true } as const, 'hidden'],
  ])('records bounded visibility when presenting in %s', async (_label, visibility, expectedState) => {
    const h = loadHarness('deny', undefined, undefined, visibility);

    h.pushHandler({ request_id: `req-${expectedState}`, reasons: ['destructive'] });
    await flush();

    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_requested', expect.objectContaining({
      visibility_state: expectedState,
    }));
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_presented', expect.objectContaining({
      visibility_state: expectedState,
    }));
    expect(h.monitorEvent.mock.calls.filter(([name]) => name === 'bash_risk_prompt_result')).toHaveLength(1);
  });

  it('keeps private prompt fields and unknown categories out of telemetry', async () => {
    const privatePath = '/private/workspace/customer-secret.txt';
    const h = loadHarness('deny');

    h.pushHandler({
      request_id: 'req-private-identifier',
      agent_id: 'private-agent-identifier',
      agent_name: 'Private Agent Name',
      command: `rm ${privatePath}`,
      operation: 'delete_file',
      subject: privatePath,
      reasons: ['destructive', 'unbounded-private-category', 'destructive'],
      cid: 'private-conversation-identifier',
    });
    await flush();

    const serialized = JSON.stringify(h.monitorEvent.mock.calls);
    expect(serialized).not.toContain(privatePath);
    expect(serialized).not.toContain('private-agent-identifier');
    expect(serialized).not.toContain('Private Agent Name');
    expect(serialized).not.toContain('private-conversation-identifier');
    expect(serialized).not.toContain('req-private-identifier');
    expect(serialized).not.toContain('unbounded-private-category');
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_requested', {
      categories: 'destructive',
      visibility_state: 'unknown',
    });
  });

  it('persists the selected permission level before allowing once', async () => {
    const h = loadHarness({ choice: 'allow_once', mode: 'workspace_approval' });

    h.pushHandler({
      request_id: 'req-mode',
      agent_name: 'Agent',
      operation: 'read_file',
      subject: '/Users/me/.ssh/id_rsa',
      reasons: ['network_egress'],
    });
    await flush();

    expect(h.invokeCalls).toEqual([
      { channel: 'permissions.getLocalExec', payload: undefined },
      { channel: 'permissions.setLocalExecMode', payload: { mode: 'workspace_approval' } },
      { channel: 'bash.permission_response', payload: { request_id: 'req-mode', decision: 'allow_once' } },
    ]);
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_result', expect.objectContaining({
      result: 'success',
      decision: 'allow_once',
      effective_decision: 'allow_once',
      mode: 'workspace_approval',
      mode_changed: true,
    }));
  });

  it('does not persist a changed level when the user denies the request', async () => {
    const h = loadHarness({ choice: 'deny', mode: 'all_files_auto' });

    h.pushHandler({
      request_id: 'req-deny',
      agent_name: 'Agent',
      command: 'curl https://example.com',
      reasons: ['network_egress'],
    });
    await flush();

    expect(h.invokeCalls).toEqual([
      { channel: 'permissions.getLocalExec', payload: undefined },
      { channel: 'bash.permission_response', payload: { request_id: 'req-deny', decision: 'deny' } },
    ]);
  });

  it('denies the request when a selected permission level cannot be persisted', async () => {
    const h = loadHarness({ choice: 'allow_once', mode: 'all_files_auto' }, async (channel) => {
      if (channel === 'permissions.getLocalExec') return { ok: true, mode: 'all_files_approval' };
      if (channel === 'permissions.setLocalExecMode') return { ok: false };
      return { handled: true };
    });

    h.pushHandler({
      request_id: 'req-2',
      agent_name: 'Agent',
      command: 'curl https://example.com',
      reasons: ['network_egress'],
    });
    await flush();

    expect(h.invokeCalls).toEqual([
      { channel: 'permissions.getLocalExec', payload: undefined },
      { channel: 'permissions.setLocalExecMode', payload: { mode: 'all_files_auto' } },
      { channel: 'bash.permission_response', payload: { request_id: 'req-2', decision: 'deny' } },
    ]);
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_result', expect.objectContaining({
      result: 'success',
      decision: 'allow_once',
      effective_decision: 'deny',
      mode_changed: false,
    }));
  });

  it('marks a verdict cancelled when main reports that the request is stale', async () => {
    const h = loadHarness('allow_once', async (channel) => {
      if (channel === 'permissions.getLocalExec') return { ok: true, mode: 'all_files_approval' };
      if (channel === 'bash.permission_response') return { ok: true, handled: false };
      return { ok: true };
    });

    h.pushHandler({
      request_id: 'req-stale',
      agent_name: 'Agent',
      command: 'curl https://example.com',
      reasons: ['network_egress'],
    });
    await flush();

    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_result', expect.objectContaining({
      result: 'cancelled',
      decision: 'allow_once',
      effective_decision: 'allow_once',
      error_type: 'state',
      error_code: 'stale_request',
    }));
  });

  it('keeps a resolved IPC rejection in the terminal failure denominator', async () => {
    const h = loadHarness('deny', async (channel) => {
      if (channel === 'permissions.getLocalExec') return { ok: true, mode: 'all_files_approval' };
      if (channel === 'bash.permission_response') return { ok: false, error: '/private/request' };
      return { ok: true };
    });

    h.pushHandler({
      request_id: 'req-rejected',
      agent_name: 'Agent',
      command: 'curl https://example.com',
      reasons: ['network_egress'],
    });
    await flush();

    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_result', expect.objectContaining({
      result: 'failure',
      decision: 'deny',
      error_type: 'ipc',
      error_code: 'response_failed',
    }));
    expect(JSON.stringify(h.monitorEvent.mock.calls)).not.toContain('/private/request');
  });

  it('closes a cancelled prompt without sending a stale renderer response', async () => {
    const h = loadHarness('deny', undefined, async () => new Promise(() => {}));

    h.pushHandler({
      request_id: 'req-cancelled',
      agent_name: 'Agent',
      command: 'rm protected.txt',
      reasons: ['network_egress'],
    });
    await flush();
    h.cancelHandler({ request_ids: ['req-cancelled'], cid: 'c1' });
    await flush();

    expect(h.dialogArgs).toHaveLength(1);
    expect(h.invokeCalls).toEqual([
      { channel: 'permissions.getLocalExec', payload: undefined },
    ]);
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_requested', expect.any(Object));
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_presented', expect.any(Object));
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_result', expect.objectContaining({
      result: 'cancelled',
      decision: 'none',
      effective_decision: 'deny',
      error_type: 'state',
      error_code: 'request_cancelled',
    }));
    expect(h.monitorEvent.mock.calls.filter(([name]) => name === 'bash_risk_prompt_result')).toHaveLength(1);
  });

  it('records cancellation during mode lookup without claiming presentation', async () => {
    let resolveMode!: (value: { ok: boolean; mode: string }) => void;
    const modeLookup = new Promise<{ ok: boolean; mode: string }>((resolve) => { resolveMode = resolve; });
    const h = loadHarness('deny', async (channel) => {
      if (channel === 'permissions.getLocalExec') return modeLookup;
      return { handled: true };
    });

    h.pushHandler({ request_id: 'req-before-presented', reasons: ['destructive'] });
    await flush();
    h.cancelHandler({ request_ids: ['req-before-presented'] });
    resolveMode({ ok: true, mode: 'all_files_approval' });
    await flush();

    expect(h.dialogArgs).toHaveLength(0);
    expect(h.invokeCalls).toEqual([
      { channel: 'permissions.getLocalExec', payload: undefined },
    ]);
    expect(h.monitorEvent.mock.calls.filter(([name]) => name === 'bash_risk_prompt_requested')).toHaveLength(1);
    expect(h.monitorEvent.mock.calls.filter(([name]) => name === 'bash_risk_prompt_presented')).toHaveLength(0);
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_result', expect.objectContaining({
      result: 'cancelled',
      error_code: 'request_cancelled',
    }));
    expect(h.monitorEvent.mock.calls.filter(([name]) => name === 'bash_risk_prompt_result')).toHaveLength(1);
  });

  it('records a queued cancellation without claiming that its dialog was presented', async () => {
    const h = loadHarness('deny', undefined, async () => new Promise(() => {}));

    h.pushHandler({ request_id: 'req-open', reasons: ['destructive'] });
    h.pushHandler({ request_id: 'req-queued', reasons: ['network_egress'] });
    await flush();
    h.cancelHandler({ request_ids: ['req-queued'] });
    await flush();

    const presented = h.monitorEvent.mock.calls.filter(([name]) => name === 'bash_risk_prompt_presented');
    expect(presented).toHaveLength(1);
    expect(h.monitorEvent).toHaveBeenCalledWith('bash_risk_prompt_result', expect.objectContaining({
      result: 'cancelled',
      categories: 'network_egress',
      error_code: 'request_cancelled',
    }));
    expect(h.monitorEvent.mock.calls.filter(([name]) => name === 'bash_risk_prompt_result')).toHaveLength(1);
  });
});
