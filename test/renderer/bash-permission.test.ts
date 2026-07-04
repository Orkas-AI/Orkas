import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

type DialogResult = string | { choice: string; mode?: string };

function loadHarness(dialogResult: DialogResult, invokeImpl?: (channel: string, payload: any) => Promise<any>) {
  let pushHandler: ((info: any) => void) | null = null;
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
        }),
      },
    },
  };
  context.window.window = context.window;
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/bash_permission.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'bash_permission.js' });
  if (!pushHandler) throw new Error('bash:permission handler was not registered');

  return { context, pushHandler, dialogArgs, invokeCalls, monitorEvent, warn };
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
      decision: 'allow_once',
      mode: 'all_files_auto',
      mode_changed: true,
      categories: 'network_egress',
    }));
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
      decision: 'allow_once',
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
  });
});
