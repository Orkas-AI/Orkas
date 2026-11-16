import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { attachWebAssistDialogs, interruptOnWebAssistDialog, WebAssistDialogOpenedError, webAssistDialogs } from '../../../src/main/features/web_assist_dialogs';

function browser(autoDismissAlerts = () => true) {
  let owner: string | undefined = 'run-one';
  const page = Object.assign(new EventEmitter(), { ipc: new EventEmitter(), mainFrame: {} });
  const native = vi.fn((_info, callback) => callback(false, ''));
  page.on('-run-dialog', native);
  const changed = vi.fn();
  const controller = attachWebAssistDialogs(page as WebContents, () => owner, changed, autoDismissAlerts)!;
  const show = (type = 'confirm', message = 'Continue?', value = '') => {
    const reply = vi.fn();
    page.emit('-run-dialog', { dialogType: type, messageText: message, defaultPromptText: value,
      frame: { origin: 'https://example.com', url: 'https://example.com' } }, reply);
    return reply;
  };
  return { page, native, changed, controller, show, setOwner: (value?: string) => { owner = value; } };
}

describe('task-scoped native dialog decisions and recovery', () => {
  it('holds an alert outside AI control until one explicit acknowledgement, without opening native UI', () => {
    const b = browser(() => false);
    const reply = b.show('alert', 'Submission failed');
    const pending = b.controller.pending()!;
    expect(pending.info.messageText).toBe('Submission failed');
    expect(reply).not.toHaveBeenCalled();
    expect(b.controller.act(pending.id, 'click', 'e2')).toMatchObject({ ok: false });
    expect(b.controller.act(pending.id, 'press', undefined, undefined, 'Escape')).toMatchObject({ ok: true });
    expect(reply).toHaveBeenCalledExactlyOnceWith(true, '');
    expect(b.controller.act(pending.id, 'click', 'e1')).toMatchObject({ code: 'stale_page' });
    expect(b.native).not.toHaveBeenCalled();
    b.controller.dispose();
  });
  it('does not replace an unknown or absent native handler layout', () => {
    const page = new EventEmitter();
    expect(attachWebAssistDialogs(page as WebContents, () => 'run', vi.fn())).toBeUndefined();
    const first = vi.fn(), second = vi.fn();
    page.on('-run-dialog', first); page.on('-run-dialog', second);
    expect(attachWebAssistDialogs(page as WebContents, () => 'run', vi.fn())).toBeUndefined();
    page.emit('-run-dialog', {}, vi.fn());
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1);
  });

  it('admits prompt IPC only from a current owned frame and releases malformed or foreign callers', () => {
    const b = browser();
    const frame = { top: b.page.mainFrame, url: 'https://example.com', origin: 'https://example.com' };
    const event = { sender: b.page, senderFrame: frame, returnValue: undefined as any };
    b.page.ipc.emit('web-assist:prompt', event, 'Name?', 'private-default');
    expect(event.returnValue).toBeUndefined();
    const dialog = b.controller.pending()!;
    b.controller.act(dialog.id, 'fill', 'e3', '  张三😀  ');
    b.controller.act(dialog.id, 'click', 'e1');
    expect(event.returnValue).toEqual({ handled: true, accepted: true, value: '  张三😀  ' });
    for (const [sender, senderFrame, message] of [[{}, frame, 'Name?'], [b.page, { top: {} }, 'Name?'], [b.page, null, 'Name?'], [b.page, frame, {}]]) {
      const denied = { sender, senderFrame, returnValue: undefined as any };
      b.page.ipc.emit('web-assist:prompt', denied, message, '');
      expect(denied.returnValue).toEqual({ handled: false });
      expect(b.controller.pending()).toBeUndefined();
    }
    b.setOwner();
    const manual = { ...event, returnValue: undefined };
    b.page.ipc.emit('web-assist:prompt', manual, 'Name?', '');
    expect(manual.returnValue).toEqual({ handled: false });
    b.controller.dispose();
    expect(b.page.ipc.listenerCount('web-assist:prompt')).toBe(0);
  });

  it('retains bounded alert evidence under a flood while resuming each script once', () => {
    const b = browser();
    const replies = Array.from({ length: 1000 }, () => b.show('alert', 'x'.repeat(10_000)));
    for (const reply of replies) expect(reply).toHaveBeenCalledExactlyOnceWith(true, '');
    expect(b.native).not.toHaveBeenCalled();
    const notices: any = b.controller.notices();
    expect(notices.dismissed_dialogs).toHaveLength(4);
    expect(notices.dismissed_dialogs.every((item: any) => item.message.length <= 500)).toBe(true);
    expect(notices.dismissed_dialogs_omitted).toBe(996);
    expect(b.controller.notices()).toEqual({});
    b.controller.dispose();
  });

  it.each(['navigation', 'native-cancel', 'crash', 'destroy', 'replacement'])('cancels a pending prompt without accepting or duplicating effects on %s', event => {
    const b = browser(); const reply = b.show('prompt', 'Name?', 'private');
    const id = b.controller.pending()!.id;
    if (event === 'navigation') b.page.emit('did-start-navigation', {}, 'https://example.com/next', false, true);
    if (event === 'native-cancel') b.page.emit('-cancel-dialogs', { resetState: true });
    if (event === 'crash') b.page.emit('render-process-gone', {}, {});
    if (event === 'destroy') b.page.emit('destroyed');
    if (event === 'replacement') { b.setOwner('run-two'); b.controller.pending(); }
    expect(reply).toHaveBeenCalledExactlyOnceWith(false, '');
    expect(b.controller.act(id, 'click', 'e1')).toMatchObject({ ok: false, code: 'stale_page' });
    b.controller.cancel();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(b.native).not.toHaveBeenCalled();
    b.controller.dispose();
  });

  it('keeps a decision during same-document and unrelated subframe navigation', () => {
    const b = browser(); const reply = b.show();
    b.page.emit('did-start-navigation', {}, 'https://example.com#section', true, true);
    b.page.emit('did-start-navigation', {}, 'https://frame.example.com', false, false);
    expect(reply).not.toHaveBeenCalled();
    expect(b.controller.act(b.controller.pending()!.id, 'press', undefined, undefined, 'Escape')).toMatchObject({ ok: true });
    expect(reply).toHaveBeenCalledExactlyOnceWith(false, '');
    b.controller.dispose();
  });

  it('preserves the first decision and rejects a second dialog rather than replacing its authority', () => {
    const b = browser(); const first = b.show(), second = b.show('prompt');
    expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledExactlyOnceWith(false, '');
    expect(b.controller.act(b.controller.pending()!.id, 'click', 'e1')).toMatchObject({ ok: true });
    expect(first).toHaveBeenCalledExactlyOnceWith(true, '');
    b.controller.dispose();
  });

  it('yields a blocked native input acknowledgement as a pending decision without sending input twice', async () => {
    const b = browser();
    let acknowledge!: () => void;
    const send = vi.fn(() => new Promise<void>(resolve => { acknowledge = resolve; b.show(); }));
    await expect(interruptOnWebAssistDialog(b.page as WebContents, send)).rejects.toBeInstanceOf(WebAssistDialogOpenedError);
    expect(send).toHaveBeenCalledTimes(1);
    b.controller.act(b.controller.pending()!.id, 'click', 'e2'); acknowledge();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    b.controller.dispose();
  });

  it('restores the exact native handler after disposal and preserves manual dialog semantics', () => {
    const b = browser(); b.setOwner();
    const manual = b.show('alert');
    expect(manual).toHaveBeenCalledExactlyOnceWith(false, '');
    b.controller.dispose(); b.controller.dispose();
    expect(webAssistDialogs(b.page as WebContents)).toBeUndefined();
    expect(b.page.listeners('-run-dialog')).toEqual([b.native]);
    expect(b.page.listenerCount('-cancel-dialogs')).toBe(0);
    const after = b.show();
    expect(after).toHaveBeenCalledExactlyOnceWith(false, '');
    expect(b.native).toHaveBeenCalledTimes(2);
  });
});
