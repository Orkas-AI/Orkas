/** Per-page human input lease. Native events own it; model calls cannot extend it. */
import type { Input, IpcMainEvent, MouseInputEvent, WebContents } from 'electron';
import { consumeWebAssistPointerEvent } from './web_assist_input';

export const WEB_ASSIST_USER_IDLE_MS = 10_000;

export function watchWebAssistUserActivity(contents: WebContents, changed: (active: boolean, edited?: boolean) => void) {
  const keys = new Set<string>();
  const buttons = new Set<string>();
  const composingFrames = new Set<string>();
  let composing = false;
  let active = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const touch = (edited = false) => {
    if (disposed) return;
    active = true;
    changed(true, edited);
    clearTimeout(timer);
    timer = undefined;
    // Silence while holding a key/button or selecting an IME candidate is not idle.
    if (keys.size || buttons.size || composing || composingFrames.size) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || contents.isDestroyed()) return;
      active = false;
      changed(false);
    }, WEB_ASSIST_USER_IDLE_MS);
    timer.unref();
  };
  const keyboard = (_event: unknown, input: Input) => {
    if (input.type !== 'keyDown' && input.type !== 'keyUp') return;
    const key = input.code || input.key || 'unknown';
    if (input.type === 'keyDown') keys.add(key);
    else keys.delete(key);
    composing = input.isComposing === true;
    touch(true);
  };
  const mouse = (_event: unknown, input: MouseInputEvent) => {
    if (consumeWebAssistPointerEvent(contents, input)) return;
    if (input.type === 'mouseDown') buttons.add(input.button || 'left');
    else if (input.type === 'mouseUp') buttons.delete(input.button || 'left');
    else if (input.type !== 'mouseWheel' && !(active && input.type === 'mouseMove')) return;
    touch();
  };
  const composition = (event: IpcMainEvent, composingNow: unknown) => {
    if (event.sender !== contents || !event.senderFrame || typeof composingNow !== 'boolean') return;
    const frame = event.senderFrame.frameToken;
    if (composingNow) composingFrames.add(frame);
    else {
      composingFrames.delete(frame);
      composing = false;
    }
    touch(true);
  };
  const wheel = (event: IpcMainEvent) => {
    if (event.sender === contents && event.senderFrame) touch();
  };
  // Focus/view loss can swallow keyUp/mouseUp. Clear held state, but still give
  // the user the full idle interval before allowing background work to continue.
  const release = () => {
    keys.clear();
    buttons.clear();
    composing = false;
    composingFrames.clear();
    if (active) touch();
  };
  contents.on('before-input-event', keyboard);
  contents.on('before-mouse-event', mouse);
  contents.on('blur', release);
  contents.ipc.on('web-assist:composition', composition);
  contents.ipc.on('web-assist:wheel', wheel);
  const dispose = () => {
    disposed = true;
    clearTimeout(timer);
    contents.removeListener('before-input-event', keyboard);
    contents.removeListener('before-mouse-event', mouse);
    contents.removeListener('blur', release);
    contents.ipc.removeListener('web-assist:composition', composition);
    contents.ipc.removeListener('web-assist:wheel', wheel);
    contents.removeListener('destroyed', dispose);
  };
  contents.once('destroyed', dispose);
  return { release, dispose };
}
