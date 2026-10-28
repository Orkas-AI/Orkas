import type { ElectronApplication } from '@playwright/test';

export async function holdInvokeResponse(app: ElectronApplication, channel: string) {
  await app.evaluate(({ ipcMain }, channel) => {
    const handlers = (ipcMain as any)._invokeHandlers as Map<string, Function>;
    const original = handlers?.get('orkas.invoke');
    if (typeof original !== 'function' || (globalThis as any).__heldInvokeResponse) {
      throw new Error('Native held-response adapter unavailable');
    }
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const control = { calls: 0, polls: 0, flowId: '', ready: false, entryIds: [] as string[], release, restore: () => {
      if (handlers.get('orkas.invoke') !== wrapped) throw new Error('Native handler owner changed');
      ipcMain.removeHandler('orkas.invoke'); ipcMain.handle('orkas.invoke', original as any);
      delete (globalThis as any).__heldInvokeResponse;
    } };
    const wrapped = async (event: unknown, request: any) => {
      if (request?.channel === 'auth.pollOAuthFlow') control.polls += 1;
      if (request?.channel !== channel) return original(event, request);
      const call = ++control.calls;
      const result = await original(event, request);
      if (call === 1) { control.flowId = result?.flowId || ''; control.entryIds = Array.isArray(result?.entries) ? result.entries.map((entry: any) => entry.entryId) : []; control.ready = true; await gate; }
      return result;
    };
    ipcMain.removeHandler('orkas.invoke'); ipcMain.handle('orkas.invoke', wrapped as any);
    (globalThis as any).__heldInvokeResponse = control;
  }, channel);
}
