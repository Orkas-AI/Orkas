import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchWebAssistUserActivity } from '../../../src/main/features/web_assist_activity';

describe('automatic browser handback after human input', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  function page() {
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, ipc: new EventEmitter() });
    const changed = vi.fn();
    const activity = watchWebAssistUserActivity(contents as unknown as WebContents, changed);
    const key = (type: string, code = 'KeyA', isComposing = false) => contents.emit('before-input-event', {}, { type, code, isComposing });
    const mouse = (type: string) => contents.emit('before-mouse-event', {}, { type, button: 'left', x: 10, y: 20 });
    return { contents, changed, activity, key, mouse };
  }

  it('reports composition and wheel input without exposing an API or accepting page-script events', () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const send = vi.fn();
    const window = { addEventListener: (type: string, handler: any) => listeners.set(type, handler) };
    vm.runInNewContext(readFileSync(path.join(__dirname, '../../../src/main/features/web_assist_activity_preload.js'), 'utf8'), {
      require: (name: string) => { expect(name).toBe('electron'); return { ipcRenderer: { send } }; }, window,
    });
    listeners.get('compositionstart')!({ isTrusted: false });
    expect(send).not.toHaveBeenCalled();
    listeners.get('compositionstart')!({ isTrusted: true });
    listeners.get('compositionend')!({ isTrusted: false });
    listeners.get('input')!({ isTrusted: true, isComposing: true });
    expect(send.mock.calls).toEqual([['web-assist:composition', true]]);
    listeners.get('input')!({ isTrusted: true, isComposing: false });
    listeners.get('compositionend')!({ isTrusted: true });
    expect(send.mock.calls).toEqual([['web-assist:composition', true], ['web-assist:composition', false]]);
    listeners.get('wheel')!({ isTrusted: false });
    expect(send).toHaveBeenCalledTimes(2);
    listeners.get('wheel')!({ isTrusted: true });
    expect(send).toHaveBeenLastCalledWith('web-assist:wheel');
    expect(listeners.has('scroll')).toBe(false);
    expect(Object.keys(window)).toEqual(['addEventListener']);
  });

  it.each(['key', 'mouse'] as const)('does not interrupt held %s input, then resumes exactly once after release and silence', async kind => {
    const p = page();
    if (kind === 'key') p.key('keyDown'); else p.mouse('mouseDown');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(p.changed).not.toHaveBeenCalledWith(false);
    if (kind === 'key') p.key('keyUp'); else p.mouse('mouseUp');
    await vi.advanceTimersByTimeAsync(9999);
    expect(p.changed).not.toHaveBeenCalledWith(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(p.changed).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(p.changed.mock.calls.filter(([active]) => !active)).toHaveLength(1);
    p.activity.dispose();
  });

  it('keeps IME composition paused across released keys until composition ends', async () => {
    const p = page();
    p.key('keyDown', 'KeyA', true); p.key('keyUp', 'KeyA', true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(p.changed).not.toHaveBeenCalledWith(false);
    p.key('keyDown', 'Enter', false); p.key('keyUp', 'Enter', false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(p.changed).toHaveBeenLastCalledWith(false);
    p.activity.dispose();
  });

  it('accepts an isolated IME commit without a key, but ignores foreign and malformed reports', async () => {
    const p = page();
    const frame = { sender: p.contents, senderFrame: { frameToken: 'main' } };
    p.contents.ipc.emit('web-assist:composition', frame, true);
    p.key('keyDown', 'KeyA', true); p.key('keyUp', 'KeyA', true);
    p.contents.ipc.emit('web-assist:composition', { ...frame, sender: {} }, false);
    p.contents.ipc.emit('web-assist:composition', frame, 'false');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(p.changed).not.toHaveBeenCalledWith(false);
    p.contents.ipc.emit('web-assist:composition', frame, false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(p.changed).toHaveBeenLastCalledWith(false);
    p.activity.dispose();
    expect(p.contents.ipc.listenerCount('web-assist:composition')).toBe(0);
  });

  it.each(['mouseMove', 'mouseWheel', 'isolatedWheel'])('renews only the operated page on %s, without a timer per event', async renewal => {
    const p = page(); const other = page();
    p.mouse('mouseMove');
    expect(p.changed).not.toHaveBeenCalled();
    const wheelEvent = { sender: p.contents, senderFrame: { frameToken: 'main' } };
    p.contents.ipc.emit('web-assist:wheel', { ...wheelEvent, sender: other.contents });
    p.contents.ipc.emit('web-assist:wheel', { sender: p.contents });
    expect(p.changed).not.toHaveBeenCalled();
    const input = () => renewal === 'isolatedWheel'
      ? p.contents.ipc.emit('web-assist:wheel', wheelEvent) : p.mouse(renewal);
    if (renewal === 'isolatedWheel') input(); else p.mouse('mouseWheel');
    await vi.advanceTimersByTimeAsync(9900);
    for (let i = 0; i < 1000; i++) input();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(9999);
    expect(p.changed).not.toHaveBeenCalledWith(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(p.changed).toHaveBeenLastCalledWith(false);
    const resumedCalls = p.changed.mock.calls.length;
    p.mouse('mouseMove');
    expect(p.changed).toHaveBeenCalledTimes(resumedCalls);
    expect(other.changed).not.toHaveBeenCalled();
    p.activity.dispose(); other.activity.dispose();
    expect(p.contents.ipc.listenerCount('web-assist:wheel')).toBe(0);
  });

  it.each(['blur', 'hidden'])('recovers swallowed release events after the page is %s', async reason => {
    const p = page();
    p.key('keyDown', 'KeyA', true); p.mouse('mouseDown');
    if (reason === 'blur') p.contents.emit('blur'); else p.activity.release();
    await vi.advanceTimersByTimeAsync(9999);
    expect(p.changed).not.toHaveBeenCalledWith(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(p.changed).toHaveBeenLastCalledWith(false);
    p.activity.dispose();
  });

  it.each(['closed', 'account switched'])('does not reactivate a page or leak timers after it is %s', async reason => {
    const p = page();
    p.mouse('mouseWheel');
    if (reason === 'closed') p.contents.emit('destroyed'); else p.activity.dispose();
    expect(vi.getTimerCount()).toBe(0);
    p.activity.release(); p.key('keyDown');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(p.changed).toHaveBeenCalledTimes(1);
  });
});
