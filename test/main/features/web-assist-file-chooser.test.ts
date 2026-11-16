import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  attachWebAssistFileChoosers, refreshWebAssistFileChoosers, webAssistFileChooser,
  clearWebAssistFileChooser, webAssistFrames,
  takeWebAssistFilePickerNotice,
  cancelWebAssistFileChooser,
} from '../../../src/main/features/web_assist_protocol';

function browser() {
  let owner: string | undefined = 'run-one';
  let attached = false;
  const commands: Array<{ method: string; params: any; session?: string }> = [];
  const debuggerSession = Object.assign(new EventEmitter(), {
    isAttached: () => attached,
    attach: () => { attached = true; },
    detach: () => { attached = false; debuggerSession.emit('detach'); },
    sendCommand: vi.fn(async (method: string, params: any, session?: string) => {
      commands.push({ method, params, session });
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: session ? 'child' : 'main', ...(session ? { parentId: 'main' } : {}), url: 'https://example.com' } } };
      if (method === 'DOM.resolveNode') return { object: { objectId: `node-${params.backendNodeId}` } };
      return {};
    }),
  });
  const page = Object.assign(new EventEmitter(), { debugger: debuggerSession, ipc: new EventEmitter(), mainFrame: {},
    isDestroyed: () => false, getURL: () => 'https://example.com' }) as unknown as WebContents;
  const changed = vi.fn();
  attachWebAssistFileChoosers(page, () => owner, changed);
  const show = (session?: string, node = 42) => debuggerSession.emit('message', {}, 'Page.fileChooserOpened', {
    backendNodeId: node, frameId: session ? 'child' : 'main', mode: 'selectMultiple',
  }, session);
  return { page, debuggerSession, commands, changed, show, setOwner: (value?: string) => { owner = value; } };
}

describe('task browser file selection ownership', () => {
  it('intercepts AI file selection before input and retains one target under repeated scripted opens', async () => {
    const b = browser();
    await webAssistFrames(b.page);
    expect(b.commands).toContainEqual({ method: 'Page.setInterceptFileChooserDialog', params: { enabled: true }, session: undefined });
    b.show();
    const first = webAssistFileChooser(b.page)!;
    expect(first).toMatchObject({ backendNodeId: 42, frameId: 'main', multiple: true });
    for (let i = 0; i < 1000; i++) b.show('', i + 43);
    expect(webAssistFileChooser(b.page)?.id).toBe(first.id);
    expect(b.commands.filter(c => c.method === 'DOM.resolveNode')).toHaveLength(1);
    clearWebAssistFileChooser(b.page);
    expect(webAssistFileChooser(b.page)).toBeUndefined();
    await first.target; await Promise.resolve();
    expect(b.commands).toContainEqual({ method: 'Runtime.releaseObject', params: { objectId: 'node-42' }, session: undefined });
    b.page.emit('destroyed');
  });

  it('covers newly attached cross-process frames before the next AI action', async () => {
    const b = browser(); await webAssistFrames(b.page);
    b.debuggerSession.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'oopif', targetInfo: { type: 'iframe' }, waitingForDebugger: true });
    await webAssistFrames(b.page);
    expect(b.commands).toContainEqual({ method: 'Page.setInterceptFileChooserDialog', params: { enabled: true }, session: 'oopif' });
    b.show('oopif');
    expect(webAssistFileChooser(b.page)).toMatchObject({ sessionId: 'oopif', frameId: 'child' });
    b.debuggerSession.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'oopif' });
    expect(webAssistFileChooser(b.page)).toBeUndefined();
    b.page.emit('destroyed');
  });

  it('releases interception after a failed handback update and allows fresh protocol setup', async () => {
    const b = browser(); await webAssistFrames(b.page); b.show();
    b.setOwner();
    b.debuggerSession.sendCommand.mockRejectedValueOnce(new Error('synthetic protocol failure'));
    await expect(refreshWebAssistFileChoosers(b.page)).rejects.toThrow('synthetic protocol failure');
    expect(b.debuggerSession.isAttached()).toBe(false);
    expect(webAssistFileChooser(b.page)).toBeUndefined();
    await webAssistFrames(b.page);
    expect(b.commands.filter(command => command.method === 'Page.setInterceptFileChooserDialog').at(-1)?.params.enabled).toBe(false);
    b.page.emit('destroyed');
  });

  it.each([['retired', true], ['live', false]] as const)(
    'isolates a %s child setup failure from an unrelated pending root upload', async (_label, retired) => {
      const b = browser(); await webAssistFrames(b.page); b.show();
      const rootSelection = webAssistFileChooser(b.page)!;
      let rejectSetup!: (error: Error) => void;
      const delayedSetup = new Promise<never>((_resolve, reject) => { rejectSetup = reject; });
      const send = b.debuggerSession.sendCommand.getMockImplementation()!;
      b.debuggerSession.sendCommand.mockImplementation((method, params, session) => (
        method === 'Runtime.enable' && session === 'transient-child'
          ? delayedSetup : send(method, params, session)
      ));
      b.debuggerSession.emit('message', {}, 'Target.attachedToTarget', {
        sessionId: 'transient-child', targetInfo: { type: 'iframe' },
      });
      const refresh = refreshWebAssistFileChoosers(b.page);
      // Drain runnable protocol work; refresh now awaits the child setup.
      await new Promise<void>(resolve => setImmediate(resolve));
      if (retired) b.debuggerSession.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'transient-child' });
      rejectSetup(new Error('synthetic child setup failure'));
      try {
        if (retired) {
          await expect(refresh).resolves.toBeUndefined();
          expect(b.debuggerSession.isAttached()).toBe(true);
          expect(webAssistFileChooser(b.page)).toBe(rootSelection);
          expect((await webAssistFrames(b.page)).map(frame => frame.id)).toEqual(['main']);
        } else {
          await expect(refresh).rejects.toThrow('synthetic child setup failure');
          expect(b.debuggerSession.isAttached()).toBe(false);
          expect(webAssistFileChooser(b.page)).toBeUndefined();
        }
        expect(b.commands.some(command => command.method === 'DOM.setFileInputFiles')).toBe(false);
      } finally { b.page.emit('destroyed'); }
    },
  );

  it('invalidates a chooser when its frame navigates without discarding an unrelated frame selection', async () => {
    const b = browser(); await webAssistFrames(b.page); b.show('');
    expect(webAssistFileChooser(b.page)?.sessionId).toBeUndefined();
    b.debuggerSession.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'other-frame' } });
    expect(webAssistFileChooser(b.page)).toBeDefined();
    b.debuggerSession.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'main' } });
    expect(webAssistFileChooser(b.page)).toBeUndefined();
    b.page.emit('destroyed');
  });

  it('keeps frame inventory usable when a newly discovered child retires during setup', async () => {
    const b = browser(); await webAssistFrames(b.page);
    let rejectSetup!: (error: Error) => void;
    const delayedSetup = new Promise<never>((_resolve, reject) => { rejectSetup = reject; });
    const send = b.debuggerSession.sendCommand.getMockImplementation()!;
    let discovered = false;
    b.debuggerSession.sendCommand.mockImplementation((method, params, session) => {
      if (method === 'Runtime.enable' && session === 'new-child') return delayedSetup;
      if (method === 'Page.getFrameTree' && !session && !discovered) {
        discovered = true;
        b.debuggerSession.emit('message', {}, 'Target.attachedToTarget', {
          sessionId: 'new-child', targetInfo: { type: 'iframe' },
        });
      }
      return send(method, params, session);
    });
    const frames = webAssistFrames(b.page);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(discovered).toBe(true);
    b.debuggerSession.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'new-child' });
    rejectSetup(new Error('synthetic child setup failure'));
    try {
      await expect(frames).resolves.toEqual([{ id: 'main', parentId: undefined, sessionId: undefined, url: 'https://example.com', name: '' }]);
      expect(b.debuggerSession.isAttached()).toBe(true);
    } finally { b.page.emit('destroyed'); }
  });

  it('finishes explicit cancellation without uploading and restores normal interception for the next request', async () => {
    const b = browser(); await webAssistFrames(b.page); b.show();
    const selection = webAssistFileChooser(b.page)!;
    await cancelWebAssistFileChooser(b.page, selection, () => null);
    expect(webAssistFileChooser(b.page)).toBeUndefined();
    expect(b.commands.some(c => c.method === 'DOM.setFileInputFiles')).toBe(false);
    expect(b.commands.filter(c => c.method === 'Page.setInterceptFileChooserDialog').map(c => c.params)).toEqual([
      { enabled: true }, { enabled: true, cancel: true }, { enabled: true },
    ]);
    b.show(); expect(webAssistFileChooser(b.page)).toBeDefined();
    b.page.emit('destroyed');
  });

  it('releases an unavailable target so a later file selection can recover', async () => {
    const b = browser(); await webAssistFrames(b.page);
    b.debuggerSession.sendCommand.mockRejectedValueOnce(new Error('synthetic missing node'));
    b.show();
    const selection = webAssistFileChooser(b.page)!;
    await expect(selection.target).rejects.toThrow('synthetic missing node');
    expect(webAssistFileChooser(b.page)).toBeUndefined();
    b.show(undefined, 44);
    expect(webAssistFileChooser(b.page)?.backendNodeId).toBe(44);
    b.page.emit('destroyed');
  });

  it.each(['takeover', 'replacement', 'navigation', 'crash', 'detach', 'destroy'])('invalidates pending upload refs on %s without selecting or reading files', async event => {
    const b = browser(); await webAssistFrames(b.page); b.show();
    if (event === 'takeover' || event === 'replacement') { b.setOwner(event === 'replacement' ? 'run-two' : undefined); await refreshWebAssistFileChoosers(b.page); }
    if (event === 'navigation') b.page.emit('did-start-navigation', {}, 'https://example.com/next', false, true);
    if (event === 'crash') b.page.emit('render-process-gone', {}, {});
    if (event === 'detach') b.debuggerSession.detach();
    if (event === 'destroy') b.page.emit('destroyed');
    expect(webAssistFileChooser(b.page)).toBeUndefined();
    expect(b.commands.some(c => c.method === 'DOM.setFileInputFiles')).toBe(false);
    if (event === 'takeover') {
      expect(b.commands).toContainEqual({ method: 'Page.setInterceptFileChooserDialog', params: { enabled: false }, session: undefined });
      b.show(); expect(webAssistFileChooser(b.page)).toBeUndefined();
    }
    b.page.emit('destroyed');
  });

  it('leaves manual/unowned pages native and releases listeners after disposal', async () => {
    const b = browser(); b.setOwner(); await webAssistFrames(b.page); b.show();
    expect(webAssistFileChooser(b.page)).toBeUndefined();
    expect(b.commands).toContainEqual({ method: 'Page.setInterceptFileChooserDialog', params: { enabled: false }, session: undefined });
    b.page.emit('destroyed');
    expect(b.debuggerSession.listenerCount('message')).toBe(0);
    expect(b.page.listenerCount('did-start-navigation')).toBe(0);
    expect(b.page.listenerCount('render-process-gone')).toBe(0);
  });

  it('denies only owned-frame file-system pickers and reports cancellation without file access', () => {
    const b = browser();
    const ipc = b.page.ipc as unknown as EventEmitter;
    const event = { sender: b.page, senderFrame: { top: b.page.mainFrame }, returnValue: undefined as unknown };
    ipc.emit('web-assist:file-system-picker', event, 'save');
    expect(event.returnValue).toBe(true);
    expect(takeWebAssistFilePickerNotice(b.page)).toEqual({ native_file_picker: { kind: 'save', state: 'cancelled' } });
    expect(takeWebAssistFilePickerNotice(b.page)).toEqual({});
    for (const bad of [
      { ...event, sender: {}, returnValue: undefined },
      { ...event, senderFrame: { top: {} }, returnValue: undefined },
    ]) {
      ipc.emit('web-assist:file-system-picker', bad, 'save'); expect(bad.returnValue).toBe(false);
    }
    const unknown = { ...event, returnValue: undefined };
    ipc.emit('web-assist:file-system-picker', unknown, 'unknown'); expect(unknown.returnValue).toBe(false);
    b.setOwner();
    const manual = { ...event, returnValue: undefined };
    ipc.emit('web-assist:file-system-picker', manual, 'save'); expect(manual.returnValue).toBe(false);
    b.page.emit('destroyed'); expect(ipc.listenerCount('web-assist:file-system-picker')).toBe(0);
  });
});
