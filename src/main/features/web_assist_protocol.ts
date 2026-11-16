/** Fixed isolated-world execution in task-owned Chromium frames. No model scripts. */
import { ipcMain, type IpcMainEvent, type WebContents } from 'electron';
import { withOperationTimeout } from '../util/operation-timeout';
import { createLogger } from '../logger';
const log = createLogger('web-assist-protocol');

export interface WebAssistFrame {
  id: string;
  parentId?: string;
  sessionId?: string;
  url: string;
  name: string;
}
interface ProtocolState {
  ready: Promise<void>;
  sessions: Map<string, Promise<void>>;
}
const states = new WeakMap<WebContents, ProtocolState>();

export interface WebAssistFileChooser {
  id: string;
  authority: string;
  backendNodeId: number;
  frameId: string;
  sessionId?: string;
  multiple: boolean;
  target: Promise<{ objectId?: string; sessionId?: string }>;
}
interface FileChooserController {
  authority: () => string | undefined;
  changed: () => void;
  pending?: WebAssistFileChooser;
  nativePicker?: { kind: 'open' | 'save' | 'directory'; authority: string };
  revision: number;
  applied: Map<string, boolean>;
  updates: Map<string, Promise<void>>;
}
const fileChoosers = new WeakMap<WebContents, FileChooserController>();
let filePickerIpcRegistered = false;

export function configureWebAssistFilePickers(): void {
  if (filePickerIpcRegistered) return;
  filePickerIpcRegistered = true;
  // Session preloads also run in unowned authorization windows. Release their
  // sync query immediately without changing native file picker behavior.
  ipcMain.on('web-assist:file-system-picker', event => {
    if (!fileChoosers.has(event.sender)) event.returnValue = false;
  });
}

export function takeWebAssistFilePickerNotice(contents: WebContents): Record<string, unknown> {
  const controller = fileChoosers.get(contents);
  const picker = controller?.nativePicker;
  if (controller) controller.nativePicker = undefined;
  return picker && picker.authority === controller!.authority()
    ? { native_file_picker: { kind: picker.kind, state: 'cancelled' } } : {};
}

/** Bind policy to the host's task lease, never to page content or model input. */
export function attachWebAssistFileChoosers(contents: WebContents, authority: () => string | undefined, changed: () => void): void {
  const controller: FileChooserController = { authority, changed, revision: 0, applied: new Map(), updates: new Map() };
  fileChoosers.set(contents, controller);
  const picker = (event: IpcMainEvent, kind: unknown) => {
    const authority = controller.authority();
    if (event.sender !== contents || !event.senderFrame || event.senderFrame.top !== contents.mainFrame
      || !authority || (kind !== 'open' && kind !== 'save' && kind !== 'directory')) {
      event.returnValue = false; return;
    }
    controller.nativePicker = { kind, authority };
    controller.changed();
    event.returnValue = true;
  };
  contents.ipc?.on('web-assist:file-system-picker', picker);
  const clear = () => { controller.nativePicker = undefined; clearWebAssistFileChooser(contents); };
  const navigation = (_event: unknown, _url: string, sameDocument: boolean, mainFrame: boolean) => {
    if (!sameDocument && mainFrame) {
      clear();
      void refreshWebAssistFileChoosers(contents).catch(() => log.warn('file chooser control update failed'));
    }
  };
  contents.on('did-start-navigation', navigation);
  contents.on('render-process-gone', clear);
  contents.once('destroyed', () => {
    clear(); fileChoosers.delete(contents);
    contents.ipc?.removeListener('web-assist:file-system-picker', picker);
    contents.removeListener('did-start-navigation', navigation);
    contents.removeListener('render-process-gone', clear);
  });
}

export function clearWebAssistFileChooser(contents: WebContents): void {
  const controller = fileChoosers.get(contents);
  if (!controller?.pending) return;
  const selection = controller.pending;
  controller.pending = undefined;
  void selection.target.then(async target => {
    if (target.objectId && !contents.isDestroyed()) await webAssistCommand(contents, 'Runtime.releaseObject', { objectId: target.objectId }, target.sessionId);
  }).catch(() => {});
  controller.changed();
}

export function webAssistFileChooser(contents: WebContents): WebAssistFileChooser | undefined {
  const controller = fileChoosers.get(contents);
  if (controller?.pending && controller.pending.authority !== controller.authority()) clearWebAssistFileChooser(contents);
  return controller?.pending;
}

/** Finish an explicit Cancel through Chromium's own cancel event, preserving
 * an existing FileList. No click/key input or upload is replayed. */
export async function cancelWebAssistFileChooser(contents: WebContents, chooser: WebAssistFileChooser,
  validate: () => Record<string, unknown> | null): Promise<void> {
  const target = await chooser.target;
  if (!target.objectId || validate() || webAssistFileChooser(contents) !== chooser) throw new Error('browser_upload_scope_changed');
  const controller = fileChoosers.get(contents)!;
  try {
    await webAssistCommand(contents, 'Page.setInterceptFileChooserDialog', { enabled: true, cancel: true }, chooser.sessionId);
    if (validate()) throw new Error('browser_upload_scope_changed');
    const result = await webAssistCommand(contents, 'Runtime.callFunctionOn', { objectId: target.objectId,
      functionDeclaration: 'function(){HTMLInputElement.prototype.showPicker.call(this)}', userGesture: true, returnByValue: true }, chooser.sessionId);
    if (result.exceptionDetails) throw new Error('browser_upload_cancel_failed');
    clearWebAssistFileChooser(contents);
  } finally {
    controller.applied.delete(chooser.sessionId || '');
    await updateFileChooserSession(contents, chooser.sessionId);
  }
}

async function updateFileChooserSession(contents: WebContents, sessionId?: string): Promise<void> {
  const controller = fileChoosers.get(contents);
  if (!controller) return;
  const key = sessionId || '';
  // Human takeover and a task ending can race an in-flight setup. Serialize
  // each target and re-read current authority immediately before sending.
  const update = (controller.updates.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
    if (fileChoosers.get(contents) !== controller || contents.isDestroyed()) return;
    const enabled = Boolean(controller.authority());
    if (controller.applied.get(key) === enabled) return;
    await webAssistCommand(contents, 'Page.setInterceptFileChooserDialog', { enabled }, sessionId);
    controller.applied.set(key, enabled);
  });
  controller.updates.set(key, update);
  try { await update; }
  finally { if (controller.updates.get(key) === update) controller.updates.delete(key); }
}

export async function refreshWebAssistFileChoosers(contents: WebContents): Promise<void> {
  webAssistFileChooser(contents);
  const state = states.get(contents);
  if (!state) return;
  try {
    await state.ready;
    await updateFileChooserSession(contents);
    for (const [sessionId, ready] of state.sessions) {
      try {
        await ready;
        if (state.sessions.get(sessionId) === ready) await updateFileChooserSession(contents, sessionId);
      } catch (error) {
        // A retired child cannot revoke the live page's interception or upload.
        if (state.sessions.get(sessionId) === ready) throw error;
      }
    }
  } catch (error) {
    // Releasing our debugger also releases interception. A failed disable
    // must never leave manual pages trapped behind an old AI lease.
    if (states.get(contents) === state && !contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
    throw error;
  }
}

export function ownsWebAssistDebugger(contents: WebContents): boolean {
  return states.has(contents);
}

export async function webAssistCommand(
  contents: WebContents, method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 5000,
): Promise<any> {
  return withOperationTimeout(contents.debugger.sendCommand(method, params, sessionId), {
    timeoutMs, code: 'browser_protocol_timeout', stage: 'browser operation',
  });
}

async function protocol(contents: WebContents): Promise<ProtocolState> {
  let state = states.get(contents);
  if (state) { await state.ready; return state; }
  if (contents.debugger.isAttached()) throw new Error('browser_debugger_in_use');
  contents.debugger.attach('1.3');
  state = { ready: Promise.resolve(), sessions: new Map() };
  states.set(contents, state);
  const current = state;
  const debuggerSession = contents.debugger;
  const setup = async (sessionId?: string) => {
    await webAssistCommand(contents, 'Runtime.enable', {}, sessionId);
    if (fileChoosers.has(contents)) {
      await webAssistCommand(contents, 'Page.enable', {}, sessionId);
      await updateFileChooserSession(contents, sessionId);
    }
    await webAssistCommand(contents, 'Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
    }, sessionId);
  };
  const message = (_event: unknown, method: string, params: any, sessionId?: string) => {
    if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe') {
      const ready = setup(params.sessionId);
      current.sessions.set(params.sessionId, ready);
      // Inventory/evaluation reports setup failure; never leave an unhandled promise.
      void ready.catch(() => {});
    } else if (method === 'Target.detachedFromTarget') {
      current.sessions.delete(params.sessionId);
      const controller = fileChoosers.get(contents);
      controller?.applied.delete(params.sessionId);
      if (controller?.pending?.sessionId === params.sessionId) clearWebAssistFileChooser(contents);
    } else if (method === 'Page.frameNavigated' || method === 'Page.frameDetached') {
      const pending = fileChoosers.get(contents)?.pending;
      if (pending && pending.frameId === (method === 'Page.frameNavigated' ? params.frame?.id : params.frameId)) clearWebAssistFileChooser(contents);
    } else if (method === 'Page.fileChooserOpened') {
      const controller = fileChoosers.get(contents);
      const authority = controller?.authority();
      if (!controller || !authority || !Number.isSafeInteger(params.backendNodeId)
        || typeof params.frameId !== 'string' || (sessionId && !current.sessions.has(sessionId))) return;
      // Like a native chooser, retain one decision. Repeated scripted opens
      // cannot replace the chosen target or grow a queue of remote handles.
      if (webAssistFileChooser(contents)) return;
      const targetSession = sessionId || undefined;
      const target = webAssistCommand(contents, 'DOM.resolveNode', { backendNodeId: params.backendNodeId }, targetSession)
        .then(result => ({ objectId: result.object?.objectId, sessionId: targetSession }));
      const selection: WebAssistFileChooser = { id: String(++controller.revision), authority, backendNodeId: params.backendNodeId,
        frameId: params.frameId, sessionId: targetSession, multiple: params.mode === 'selectMultiple', target };
      controller.pending = selection;
      void target.catch(() => { if (controller.pending === selection) clearWebAssistFileChooser(contents); });
      controller.changed();
    }
  };
  const cleanup = () => {
    if (states.get(contents) === current) states.delete(contents);
    current.sessions.clear();
    clearWebAssistFileChooser(contents);
    fileChoosers.get(contents)?.applied.clear();
    debuggerSession.removeListener('message', message);
    debuggerSession.removeListener('detach', cleanup);
    contents.removeListener('destroyed', cleanup);
  };
  debuggerSession.on('message', message);
  debuggerSession.once('detach', cleanup);
  contents.once('destroyed', cleanup);
  state.ready = setup().catch(error => {
    const owned = states.get(contents) === current;
    cleanup();
    if (owned && !contents.isDestroyed() && debuggerSession.isAttached()) debuggerSession.detach();
    throw error;
  });
  await state.ready;
  return state;
}

export async function webAssistFrames(contents: WebContents): Promise<WebAssistFrame[]> {
  // Lightweight unit hosts have no Chromium frame. Their existing isolated
  // executor remains the oracle for feature state; real Electron uses CDP.
  if (!contents.mainFrame) return [{ id: 'main', url: contents.getURL(), name: '' }];
  const state = await protocol(contents);
  await refreshWebAssistFileChoosers(contents);
  const frames = new Map<string, WebAssistFrame>();
  const collect = (tree: any, sessionId?: string) => {
    const frame = tree.frame;
    if (frame) frames.set(frame.id, { id: frame.id, parentId: frame.parentId,
      sessionId, url: frame.url || '', name: frame.name || '' });
    for (const child of tree.childFrames || []) collect(child, sessionId);
  };
  collect((await webAssistCommand(contents, 'Page.getFrameTree')).frameTree);
  // Attachment discovery may add nested sessions while this inventory runs.
  const visited = new Set<string>();
  while ([...state.sessions.keys()].some(id => !visited.has(id))) {
    for (const [id, ready] of [...state.sessions]) {
      if (visited.has(id)) continue;
      visited.add(id);
      try { await ready; }
      catch (error) {
        if (state.sessions.get(id) === ready) throw error;
        continue;
      }
      if (state.sessions.get(id) !== ready) continue;
      try { collect((await webAssistCommand(contents, 'Page.getFrameTree', {}, id)).frameTree, id); }
      catch { if (state.sessions.get(id) === ready) throw new Error('browser_frame_unavailable'); }
    }
  }
  return [...frames.values()];
}

export async function webAssistEvaluate(
  contents: WebContents, code: string, frameId?: string,
  returnByValue = true, userGesture = false, knownFrames?: WebAssistFrame[],
): Promise<any> {
  if (!contents.mainFrame) return contents.executeJavaScriptInIsolatedWorld(1001, [{ code }], userGesture);
  const frames = knownFrames || await webAssistFrames(contents);
  const frame = frameId ? frames.find(item => item.id === frameId) : frames.find(item => !item.parentId);
  if (!frame) throw new Error('browser_frame_unavailable');
  const world = await webAssistCommand(contents, 'Page.createIsolatedWorld', {
    frameId: frame.id, worldName: 'orkas-browser-controller', grantUniveralAccess: false,
  }, frame.sessionId);
  const result = await webAssistCommand(contents, 'Runtime.evaluate', {
    expression: code, contextId: world.executionContextId,
    returnByValue, awaitPromise: true, userGesture,
  }, frame.sessionId, 30_000);
  if (result.exceptionDetails) throw new Error('browser_page_script_failed');
  return returnByValue ? result.result?.value : { ...result.result, sessionId: frame.sessionId };
}

/** Frame-local checked pointer -> root viewport, using the actual iframe box. */
export async function webAssistRootPointer(contents: WebContents, frameId: string | undefined, result: any, checkHit = true, knownFrames?: WebAssistFrame[]): Promise<any> {
  if (!frameId || !result?.pointer || !contents.mainFrame) return result;
  const frames = knownFrames || await webAssistFrames(contents);
  let frame = frames.find(item => item.id === frameId);
  let { x, y } = result.pointer;
  // Electron reports OOPIF native input in the receiving frame's viewport
  // pixels, rather than the root CSS coordinates used to dispatch the event.
  const eventPoint = { x, y };
  const zoom = contents.getZoomFactor();
  let xx = 1, xy = 0, yx = 0, yy = 1;
  while (frame?.parentId) {
    const parent = frames.find(item => item.id === frame!.parentId);
    if (!parent) throw new Error('browser_frame_unavailable');
    const owner = await webAssistCommand(contents, 'DOM.getFrameOwner', { frameId: frame.id }, parent.sessionId);
    const ownerObject = checkHit ? await webAssistCommand(contents, 'DOM.resolveNode', { backendNodeId: owner.backendNodeId }, parent.sessionId) : undefined;
    try {
      if (ownerObject?.object?.objectId) await webAssistCommand(contents, 'Runtime.callFunctionOn', { objectId: ownerObject.object.objectId, functionDeclaration: 'function(){this.scrollIntoView({block: "nearest", inline: "nearest", behavior: "instant"})}', returnByValue: true }, parent.sessionId);
      const box = (await webAssistCommand(contents, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId }, parent.sessionId)).model;
      const quad: number[] = box.content;
      const local = await webAssistEvaluate(contents, '({width:innerWidth,height:innerHeight})', frame.id, true, false, frames);
      const originalX = x, originalY = y;
      const ax = (quad[2] - quad[0]) / local.width, bx = (quad[6] - quad[0]) / local.height;
      const ay = (quad[3] - quad[1]) / local.width, by = (quad[7] - quad[1]) / local.height;
      x = quad[0] + originalX * ax + originalY * bx;
      y = quad[1] + originalX * ay + originalY * by;
      [xx, xy, yx, yy] = [ax * xx + bx * yx, ax * xy + bx * yy, ay * xx + by * yx, ay * xy + by * yy];
      if (ownerObject?.object?.objectId) {
        const hit = await webAssistCommand(contents, 'Runtime.callFunctionOn', { objectId: ownerObject.object.objectId,
          functionDeclaration: 'function(x,y){let hit=this.ownerDocument.elementFromPoint(x,y);while(hit?.shadowRoot){const inner=hit.shadowRoot.elementFromPoint(x,y);if(!inner||inner===hit)break;hit=inner;}return hit===this||this.contains(hit)}',
          arguments: [{value:x},{value:y}], returnByValue:true }, parent.sessionId);
        if (hit.result?.value !== true) return { ok: false, code: 'element_obscured', error: 'Another element covers this frame.' };
      }
    } finally {
      if (ownerObject?.object?.objectId) await webAssistCommand(contents, 'Runtime.releaseObject', { objectId: ownerObject.object.objectId }, parent.sessionId).catch(() => {});
    }
    frame = parent;
  }
  const viewport = await webAssistEvaluate(contents, '({width:innerWidth,height:innerHeight})', undefined, true, false, frames);
  const det = xx * yy - xy * yx;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-8) return { ok: false, code: 'element_not_visible', error: 'The frame has no visible area.' };
  return { ...result, pointer: { x, y, ...viewport, eventPoint: { x: eventPoint.x * zoom, y: eventPoint.y * zoom,
    transform: [zoom * yy / det, -zoom * xy / det, -zoom * yx / det, zoom * xx / det] } } };
}

/** Screenshot points already use root CSS pixels; only their native receipt
 * needs conversion when the receiver is a cross-process frame. */
export async function webAssistPointPointer(contents: WebContents, result: any): Promise<any> {
  if (!result?.pointer || !contents.mainFrame) return result;
  const frames = await webAssistFrames(contents);
  const root = frames.find(frame => !frame.parentId);
  const { x, y } = result.pointer;
  const hit = await webAssistCommand(contents, 'DOM.getNodeForLocation', { x: Math.floor(x), y: Math.floor(y) });
  const node = (await webAssistCommand(contents, 'DOM.describeNode', { backendNodeId: hit.backendNodeId })).node;
  const frameId = node.frameId || hit.frameId;
  if (!frameId || frameId === root?.id) return result;
  const origin = await webAssistRootPointer(contents, frameId, { pointer: { x: 0, y: 0 } }, false, frames);
  if (!origin.pointer) return origin;
  const [xx, xy, yx, yy] = origin.pointer.eventPoint.transform;
  const dx = x - origin.pointer.x, dy = y - origin.pointer.y;
  return { ...result, pointer: { ...result.pointer, eventPoint: {
    x: xx * dx + xy * dy, y: yx * dx + yy * dy, transform: [xx, xy, yx, yy],
  } } };
}

export async function setWebAssistInputFiles(
  contents: WebContents, code: string | WebAssistFileChooser, files: string[], frameId?: string,
  validate: () => Record<string, unknown> | null = () => null,
): Promise<number> {
  const pending = typeof code !== 'string';
  const target = pending
    ? await code.target
    : await webAssistEvaluate(contents, code, frameId, false, true);
  if (!target?.objectId) throw new Error('browser_upload_target_unavailable');
  try {
    const properties = await webAssistCommand(contents, 'Runtime.callFunctionOn', {
      objectId: target.objectId, returnByValue: true,
      functionDeclaration: 'function(pending){return {valid:(pending||this.isConnected)&&this.tagName==="INPUT"&&this.type==="file"&&!this.disabled,multiple:this.multiple,directory:this.webkitdirectory}}',
      arguments: [{ value: pending }],
    }, target.sessionId);
    const control = properties.result?.value;
    if (!control?.valid || (!control.multiple && files.length > 1)) throw new Error('browser_upload_target_unavailable');
    await webAssistCommand(contents, 'Runtime.callFunctionOn', {
      objectId: target.objectId, returnByValue: true,
      functionDeclaration: 'function(){const state={};state.promise=new Promise(resolve=>{const done=event=>{this.removeEventListener("change",done);this.removeEventListener("cancel",done);queueMicrotask(()=>resolve({connected:this.isConnected,count:this.files.length,cancelled:event.type==="cancel",hidden:document.visibilityState==="hidden"}));};this.addEventListener("change",done);this.addEventListener("cancel",done);state.clean=()=>{this.removeEventListener("change",done);this.removeEventListener("cancel",done);};});(globalThis.__orkasFileSelections ||= new WeakMap()).set(this,state);}',
    }, target.sessionId);
    if (validate()) throw new Error('browser_upload_scope_changed');
    await webAssistCommand(contents, 'DOM.setFileInputFiles', { objectId: target.objectId, files }, target.sessionId, 600_000);
    const receipt = await webAssistCommand(contents, 'Runtime.callFunctionOn', {
      objectId: target.objectId, returnByValue: true, awaitPromise: true,
      functionDeclaration: 'function(){return globalThis.__orkasFileSelections.get(this).promise}',
    }, target.sessionId, 600_000);
    if (receipt.result?.value?.cancelled) {
      // Chromium emits cancel when the same files are selected again. Verify
      // their actual native paths before accepting that idempotent selection;
      // a cancelled new selection must never report the old files as uploaded.
      let retained = !control.directory && (pending || receipt.result.value.connected) && receipt.result.value.count === files.length;
      for (let index = 0; retained && index < files.length; index += 1) {
        const file = await webAssistCommand(contents, 'Runtime.callFunctionOn', {
          objectId: target.objectId, functionDeclaration: 'function(index){return this.files[index]}',
          arguments: [{ value: index }], returnByValue: false,
        }, target.sessionId);
        try {
          const info = await webAssistCommand(contents, 'DOM.getFileInfo', { objectId: file.result.objectId }, target.sessionId);
          retained = info.path === files[index];
        } finally {
          if (file.result?.objectId) await webAssistCommand(contents, 'Runtime.releaseObject', { objectId: file.result.objectId }, target.sessionId).catch(() => {});
        }
      }
      if (!retained) throw new Error(control.directory && receipt.result.value.hidden ? 'browser_directory_page_hidden' : 'browser_upload_cancelled');
    }
    if ((!pending && !receipt.result?.value?.connected) || (!control.directory && receipt.result?.value?.count !== files.length) || validate()) throw new Error('browser_upload_not_retained');
    return receipt.result.value.count;
  } finally {
    await webAssistCommand(contents, 'Runtime.callFunctionOn', { objectId: target.objectId, functionDeclaration: 'function(){globalThis.__orkasFileSelections?.get(this)?.clean();globalThis.__orkasFileSelections?.delete(this)}' }, target.sessionId).catch(() => {});
    if (!pending) await webAssistCommand(contents, 'Runtime.releaseObject', { objectId: target.objectId }, target.sessionId).catch(() => {});
  }
}
