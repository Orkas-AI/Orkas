/** Task-local adapter for Electron 42's -run-dialog callback boundary.
 * CDP alone cannot suppress Electron's parallel native dialog handler. Keep the
 * built-in listener for unsupported hosts and scope interception to this contents.
 * The real-Electron journey is the compatibility oracle for this private event;
 * unknown listener layouts retain Electron behavior rather than patching globals.
 */
import type { EventEmitter } from 'node:events';
import { ipcMain, type IpcMainEvent, type WebContents } from 'electron';
import { genId12 } from '../storage';

interface DialogInfo {
  dialogType: 'alert' | 'confirm' | 'prompt';
  messageText: string;
  defaultPromptText: string;
  frame: { url: string; origin: string; isDestroyed?: () => boolean };
}
type Reply = (accepted: boolean, value: string) => void;
interface Pending {
  id: string;
  authority: string;
  info: DialogInfo;
  reply: Reply;
  value: string;
}
export class WebAssistDialogOpenedError extends Error {
  constructor() { super('browser_dialog_opened'); }
}
let registered = false;
const controllers = new WeakMap<WebContents, ReturnType<typeof createController>>();

function createController(contents: WebContents, authority: () => string | undefined, changed: (pendingChanged: boolean) => void,
  native: (...args: any[]) => void, autoDismissAlerts: () => boolean) {
  let pending: Pending | undefined;
  let alerts: Array<{ type: 'alert'; message: string; message_truncated?: true }> = [];
  let omittedAlerts = 0;
  let disposed = false;
  const waiting = new Set<() => void>();
  const finish = (accepted: boolean, value = '') => {
    const dialog = pending;
    if (!dialog) return;
    pending = undefined;
    changed(true);
    dialog.reply(accepted, value);
  };
  const cancel = () => finish(false);
  const current = () => {
    if (pending && pending.authority !== authority()) cancel();
    return pending;
  };
  const events = contents as unknown as EventEmitter;
  const run = (info: DialogInfo, reply: Reply) => {
    const owner = authority();
    if (!owner || !['alert', 'confirm', 'prompt'].includes(info?.dialogType)
      || typeof info.messageText !== 'string' || typeof info.defaultPromptText !== 'string') return native.call(contents, info, reply);
    // Chromium serializes dialogs per contents. A second callback must never
    // replace a live decision or resolve it as approved.
    if (pending) { reply(false, ''); return; }
    if (info.dialogType === 'alert' && autoDismissAlerts()) {
      if (alerts.length < 4) alerts.push({ type: 'alert', message: info.messageText.slice(0, 500), ...(info.messageText.length > 500 ? { message_truncated: true as const } : {}) });
      else omittedAlerts++;
      changed(false); reply(true, '');
      return;
    }
    pending = { id: genId12(), authority: owner, info, reply, value: info.defaultPromptText };
    changed(true);
    for (const wake of waiting) wake();
  };
  const prompt = (event: IpcMainEvent, message: unknown, defaultValue: unknown) => {
    const frame = event.senderFrame;
    if (event.sender !== contents || !frame || frame.top !== contents.mainFrame || !authority()
      || typeof message !== 'string' || typeof defaultValue !== 'string') {
      event.returnValue = { handled: false };
      return;
    }
    run({ dialogType: 'prompt', messageText: message, defaultPromptText: defaultValue, frame },
      (accepted, value) => { event.returnValue = { handled: true, accepted, value }; });
  };
  contents.ipc?.on('web-assist:prompt', prompt);
  const navigation = (_event: unknown, _url: string, sameDocument: boolean, mainFrame: boolean) => {
    if (mainFrame && !sameDocument) cancel();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancel(); alerts = []; omittedAlerts = 0;
    controllers.delete(contents);
    contents.ipc?.removeListener('web-assist:prompt', prompt);
    events.removeListener('-run-dialog', run);
    contents.removeListener('-cancel-dialogs' as any, cancel);
    contents.removeListener('did-start-navigation', navigation);
    contents.removeListener('render-process-gone', cancel);
    contents.removeListener('destroyed', dispose);
    events.on('-run-dialog', native);
  };
  events.removeListener('-run-dialog', native);
  events.on('-run-dialog', run);
  contents.on('-cancel-dialogs' as any, cancel);
  contents.on('did-start-navigation', navigation);
  contents.on('render-process-gone', cancel);
  contents.once('destroyed', dispose);
  return {
    dispose, cancel,
    async interruptible<T>(run: () => Promise<T>): Promise<T> {
      let wake!: () => void;
      const opened = new Promise<never>((_resolve, reject) => {
        wake = () => reject(new WebAssistDialogOpenedError());
        waiting.add(wake);
      });
      try {
        const result = run();
        if (current()) wake();
        return await Promise.race([result, opened]);
      } finally { waiting.delete(wake); }
    },
    pending: () => current(),
    notices() {
      if (!alerts.length && !omittedAlerts) return {};
      const result = { dismissed_dialogs: alerts, ...(omittedAlerts ? { dismissed_dialogs_omitted: omittedAlerts } : {}) };
      alerts = []; omittedAlerts = 0;
      return result;
    },
    act(id: string, action: string, ref?: string, text?: string, keys?: string): Record<string, unknown> {
      const dialog = current();
      if (!dialog || dialog.id !== id) return { ok: false, code: 'stale_page', error: 'The dialog changed; observe the page again.' };
      if (action === 'fill' && ref === 'e3' && dialog.info.dialogType === 'prompt') {
        dialog.value = text!;
        return { ok: true, outcome: 'acted', action };
      }
      const accepted = action === 'click' && ref === 'e1' || action === 'press'
        && (keys === 'Enter' || dialog.info.dialogType === 'alert' && keys === 'Escape');
      const dismissed = dialog.info.dialogType !== 'alert'
        && (action === 'click' && ref === 'e2' || action === 'press' && keys === 'Escape');
      if (!accepted && !dismissed) return { ok: false, code: 'invalid_action', error: 'This dialog supports its OK/Cancel buttons, prompt input, Enter or Escape.' };
      finish(accepted, accepted && dialog.info.dialogType === 'prompt' ? dialog.value : '');
      return { ok: true, outcome: 'acted', action };
    },
  };
}

export function attachWebAssistDialogs(contents: WebContents, authority: () => string | undefined, changed: (pendingChanged: boolean) => void,
  autoDismissAlerts: () => boolean = () => true) {
  // Lightweight hosts without Electron's built-in handler keep their old seam.
  const listeners = contents.listeners?.('-run-dialog');
  if (!listeners || listeners.length !== 1) return undefined;
  const controller = createController(contents, authority, changed, listeners[0] as (...args: any[]) => void, autoDismissAlerts);
  controllers.set(contents, controller);
  return controller;
}
export function webAssistDialogs(contents: WebContents | undefined) { return contents ? controllers.get(contents) : undefined; }

/** Native input acknowledgements can wait for a synchronous dialog response.
 * Yield that decision without replaying the input or waiting for its timeout. */
export function interruptOnWebAssistDialog<T>(contents: WebContents, run: () => Promise<T>): Promise<T> {
  return controllers.get(contents)?.interruptible(run) ?? run();
}

/** Session preloads also run in authorization popups or unsupported hosts.
 * Always release their synchronous prompt call without granting AI authority. */
export function configureWebAssistDialogs(): void {
  if (registered) return;
  registered = true;
  ipcMain.on('web-assist:prompt', event => {
    if (!controllers.has(event.sender)) event.returnValue = { handled: false };
  });
}
