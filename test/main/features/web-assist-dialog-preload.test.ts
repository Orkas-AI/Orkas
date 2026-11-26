import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function preload(handled: boolean, isMainFrame = true) {
  const main: { prompt: (message?: string, defaultValue?: string) => string | null } = { prompt: () => { throw new Error('prompt() is not supported.'); } };
  const sendSync = vi.fn(() => ({ handled, accepted: true, value: '张三' }));
  vm.runInNewContext(readFileSync(path.resolve(__dirname, '../../../src/main/features/web_assist_dialog_preload.js'), 'utf8'), {
    process: { isMainFrame },
    require: () => ({ ipcRenderer: { sendSync }, contextBridge: {
      executeInMainWorld: ({ func }: any) => vm.runInNewContext(`(${func.toString()})()`, { window: main }),
      exposeInMainWorld: (name: string, fn: any) => { (main as any)[name] = fn; },
    } }),
  });
  return { main, sendSync };
}
describe('browser-native prompt adapter', () => {
  it('exposes only prompt semantics and preserves synchronous Unicode input/results', () => {
    const p = preload(true);
    expect(Object.keys(p.main)).toEqual(['prompt']);
    expect(p.main.prompt('名字', '  default  ')).toBe('张三');
    expect(p.sendSync).toHaveBeenCalledExactlyOnceWith('web-assist:prompt', '名字', '  default  ');
    p.sendSync.mockReturnValueOnce({ handled: true, accepted: false, value: '' });
    expect(p.main.prompt()).toBe(null);
  });
  it('preserves Electron unsupported-prompt behavior when the host has no current AI authority', () => {
    const p = preload(false);
    expect(() => p.main.prompt()).toThrow('prompt() is not supported.');
  });
  it('keeps the existing prompt behavior in child frames', () => {
    const p = preload(true, false);
    expect(() => p.main.prompt()).toThrow('prompt() is not supported.');
    expect(p.sendSync).not.toHaveBeenCalled();
  });
});
