/** Target-scoped Chromium input. No window activation or system input is used. */
import type { MouseInputEvent, WebContents } from 'electron';
import { OperationTimeoutError, withOperationTimeout } from '../util/operation-timeout';

type Result = Record<string, unknown>;
type Point = { x: number; y: number; width: number; height: number };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const FRAME_CHECK_MS = 150;
const WAKE_FRAME_MS = 1500;
const WAKE_SETTLE_MS = 800;

/** Native mouse moves are delivered with animation frames. A task page whose
 *  document was created while its view was hidden (opened or navigated while
 *  the user watched another task, or under a minimised or hidden window)
 *  never produces one, so its first move is never acknowledged.
 *  backgroundThrottling:false only keeps a widget that has painted from being
 *  hidden again, which is why a page the user has seen once stays clickable.
 *  Reasserting it wakes some platforms. On Windows Electron 42, a short focus
 *  emulation pulse is also needed. It makes the document virtually visible,
 *  without showing the view or activating a window. Rendering continues after
 *  disabling emulation and detaching; no virtual focus or debugger is retained.
 *  Do not overwrite another debugger's unknown emulation state.
 *
 *  Input within about half a second of a woken page's navigation can be
 *  acknowledged but dropped; keep the measured 800 ms settle before input.
 *  `frame` reports false only when no frame arrived in time. */
export async function wakeWebAssistRendering(
  contents: WebContents,
  frame: (timeoutMs: number) => Promise<boolean>,
  canEmulateFocus: () => boolean = () => true,
): Promise<'rendering' | 'woken' | 'not_rendered'> {
  if (await frame(FRAME_CHECK_MS)) return 'rendering';
  contents.setBackgroundThrottling(false);
  if (!await frame(WAKE_FRAME_MS)) {
    if (!canEmulateFocus() || contents.debugger.isAttached()) return 'not_rendered';
    const focus = (enabled: boolean) => withOperationTimeout(
      contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled }),
      { timeoutMs: WAKE_FRAME_MS, code: 'input_timeout', stage: 'browser rendering' },
    );
    try {
      contents.debugger.attach('1.3');
      try {
        await focus(true);
        await frame(WAKE_FRAME_MS);
      } finally {
        try {
          if (!contents.isDestroyed() && contents.debugger.isAttached()) await focus(false);
        } finally {
          if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
        }
      }
    } catch (error) {
      // A busy renderer can also stall DevTools commands. No pointer was sent,
      // so preserve the same pre-input refusal and explicit retry path.
      if (error instanceof OperationTimeoutError) return 'not_rendered';
      throw error;
    }
    // Verify the page keeps rendering after releasing the temporary session.
    if (!await frame(WAKE_FRAME_MS)) return 'not_rendered';
  }
  await pause(WAKE_SETTLE_MS);
  return 'woken';
}
const pendingPointer = new WeakMap<WebContents, { x: number; y: number; type: MouseInputEvent['type']; button?: string }>();
/** Consume one matching native event, never an entire in-flight command window. */
export function consumeWebAssistPointerEvent(contents: WebContents, input: MouseInputEvent): boolean {
  const expected = pendingPointer.get(contents);
  if (!expected || input.type !== expected.type || (expected.button && input.button !== expected.button)
    || Math.abs(input.x - expected.x) >= 1 || Math.abs(input.y - expected.y) >= 1) return false;
  pendingPointer.delete(contents);
  return true;
}

export async function dispatchWebAssistPointer(
  contents: WebContents,
  prepare: () => Promise<Result>,
  validate: () => Result | null,
  scale: () => number,
  drag?: { x: number; y: number },
  onDispatch?: () => void,
): Promise<Result> {
  const deadline = Date.now() + 2000;
  const command = async (method: string, params: Record<string, unknown>) => {
    const type = params.type === 'mousePressed' ? 'mouseDown' : params.type === 'mouseReleased' ? 'mouseUp' : 'mouseMove';
    pendingPointer.set(contents, { x: Number(params.x), y: Number(params.y), type,
      ...(type !== 'mouseMove' ? { button: 'left' } : {}) });
    try {
      return await withOperationTimeout(contents.debugger.sendCommand(method, params),
        { timeoutMs: 2000, code: 'input_timeout', stage: 'browser input' });
    } finally { pendingPointer.delete(contents); }
  };
  let previous: Point | undefined;
  let point: Point | undefined;
  // Wait only before input. Never replay a dispatched click or drag.
  while (Date.now() < deadline) {
    const invalid = validate();
    if (invalid) return invalid;
    let result: Result;
    try {
      result = await withOperationTimeout(prepare(), {
        timeoutMs: Math.max(1, deadline - Date.now()), code: 'input_timeout', stage: 'browser target',
      });
    } catch (error) {
      if (!(error instanceof OperationTimeoutError)) throw error;
      point = undefined;
      break;
    }
    if (!result.pointer) {
      if (!['element_obscured', 'element_not_visible'].includes(String(result.code))) return result;
      previous = undefined;
    } else {
      point = result.pointer as Point;
      if (![point.x, point.y, point.width, point.height].every(Number.isFinite)) {
        return { ok: false, code: 'action_failed', error: 'The control position is unavailable.' };
      }
      if (previous && Math.abs(previous.x - point.x) < 0.5 && Math.abs(previous.y - point.y) < 0.5) break;
      previous = point;
      point = undefined;
    }
    await pause(50);
  }
  if (!point) return { ok: false, code: 'element_not_ready', error: 'The control is moving, hidden or covered; observe the page again.' };
  const invalid = validate();
  if (invalid) return invalid;
  const end = { x: point.x + (drag?.x || 0), y: point.y + (drag?.y || 0) };
  if (end.x < 0 || end.y < 0 || end.x >= point.width || end.y >= point.height) {
    return { ok: false, code: 'invalid_drag', error: 'The drag must end inside the page viewport.' };
  }
  const factor = scale();
  const attachedHere = !contents.debugger.isAttached();
  let pressed = false;
  let last = { x: point.x * factor, y: point.y * factor };
  try {
    if (attachedHere) contents.debugger.attach('1.3');
    onDispatch?.();
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...last });
    // Hover handlers can replace or cover a control. Check again before pressing.
    const ready = await withOperationTimeout(prepare(), {
      timeoutMs: 2000, code: 'input_timeout', stage: 'browser target',
    });
    const hovered = ready.pointer as Point | undefined;
    if (!hovered || hovered.x !== point.x || hovered.y !== point.y) {
      return ready.ok === false ? ready : { ok: false, code: 'stale_element', error: 'The control moved; observe the page again.' };
    }
    const cancelled = validate();
    if (cancelled) return cancelled;
    if (scale() !== factor) return { ok: false, code: 'page_changed', error: 'The page resized; observe it again.' };
    pressed = true;
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...last, button: 'left', buttons: 1, clickCount: 1 });
    if (drag) {
      for (let step = 1; step <= 12; step++) {
        const stopped = validate();
        if (stopped) return stopped;
        if (scale() !== factor) return { ok: false, code: 'page_changed', error: 'The page resized during the drag; observe it again.' };
        last = { x: (point.x + drag.x * step / 12) * factor, y: (point.y + drag.y * step / 12) * factor };
        await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...last, button: 'left', buttons: 1 });
        await pause(16);
      }
    }
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...last, button: 'left', buttons: 0, clickCount: 1 });
    pressed = false;
    return { ok: true, outcome: 'acted' };
  } finally {
    // Release even after cancellation so a page cannot keep a stuck pointer.
    if (pressed && !contents.isDestroyed()) {
      try { await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...last, button: 'left', buttons: 0, clickCount: 1 }); } catch { /* page may have gone */ }
    }
    if (attachedHere && !contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
  }
}
