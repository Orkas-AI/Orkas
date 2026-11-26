import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function preload(isMainFrame = true) {
  let controlled = false;
  const listeners = new Map<string, (event: any) => void>();
  const native = vi.fn(async function(this: unknown, ...args: unknown[]) { return { receiver: this, args }; });
  const main: any = { showOpenFilePicker: native, showSaveFilePicker: native, showDirectoryPicker: native,
    dispatchEvent(event: any) { listeners.get(event.type)?.(event); return !event.defaultPrevented; } };
  const sendSync = vi.fn(() => controlled);
  const Event = class {
    defaultPrevented = false;
    constructor(public type: string) {}
    preventDefault() { this.defaultPrevented = true; }
  };
  const context = { window: main, Proxy, Reflect, Event, DOMException };
  vm.runInNewContext(readFileSync(path.resolve(__dirname, '../../../src/main/features/web_assist_file_picker_preload.js'), 'utf8'), {
    process: { isMainFrame },
    window: { addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener) },
    require: () => ({ ipcRenderer: { sendSync }, contextBridge: {
      executeInMainWorld: ({ func }: any) => vm.runInNewContext(`(${func.toString()})()`, context),
    } }),
  });
  return { main, native, sendSync, control: (value: boolean) => { controlled = value; } };
}

describe('website file-system picker compatibility', () => {
  it.each(['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker'])('%s cancels under AI control and preserves exact native calls after handback', async name => {
    const p = preload(); p.control(true);
    // Page polyfills cannot replace the event bridge used by the adapter.
    p.main.dispatchEvent = () => true;
    await expect(p.main[name]({ suggestedName: 'report.txt' })).rejects.toMatchObject({ name: 'AbortError' });
    expect(p.native).not.toHaveBeenCalled();
    p.control(false);
    const options = { suggestedName: 'report.txt' };
    const receiver = {};
    const result = await p.main[name].call(receiver, options);
    expect(result.receiver).toBe(receiver); expect(result.args[0]).toBe(options);
    expect(p.native).toHaveBeenCalledTimes(1);
  });
  it('leaves native file system pickers unchanged in child frames', () => {
    const p = preload(false);
    p.control(true);
    expect(p.main.showDirectoryPicker).toBe(p.native);
    expect(p.sendSync).not.toHaveBeenCalled();
  });
});
