import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function harness(invoke: ReturnType<typeof vi.fn>) {
  const context: any = {
    document: { addEventListener: vi.fn(), querySelectorAll: () => [] },
    window: { addEventListener: vi.fn(), orkas: { invoke } },
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    t: (key: string) => key,
    uiToast: vi.fn(),
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(resolve(__dirname, '../../src/renderer/modules/user-workspace.js'), 'utf8'), context);
  return context;
}

describe('workspace mutation outcome', () => {
  it('distinguishes picker failure from user cancellation', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, path: '' });
    const context = harness(invoke);
    await context._selectAndSetWorkspace('new-chat');
    expect(context.uiToast).toHaveBeenCalledOnce();
    context.uiToast.mockClear();
    await context._selectAndSetWorkspace('new-chat');
    expect(context.uiToast).not.toHaveBeenCalled();
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['workspace.selectDirectory', 'workspace.selectDirectory']);
  });

  it('keeps a successful workspace mutation successful when UI refresh rejects', async () => {
    const invoke = vi.fn(async () => ({ ok: true, path: '/fixture/workspace' }));
    const context = harness(invoke);
    context._refreshAllWorkspaceInfo = vi.fn(async () => { throw new Error('fixture refresh failure'); });
    await context._selectAndSetWorkspace('new-chat', '/fixture/workspace');
    expect(invoke).toHaveBeenCalledWith('workspace.set', { path: '/fixture/workspace' });
    expect(context.uiToast).not.toHaveBeenCalled();
  });

  it('opens the selected folder without an undefined timing variable', async () => {
    const invoke = vi.fn(async () => ({ ok: false }));
    const context = harness(invoke);
    await expect(context._openWorkspaceFolder('new-chat')).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith('workspace.openPath', {});
  });
});
