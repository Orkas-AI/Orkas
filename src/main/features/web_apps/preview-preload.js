// Narrow preview-only transport. No generic Orkas IPC, Node or credentials.
const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame) {
  const channel = 'orkas.web-app-preview';
  let sequence = 0;
  const pending = new Map();
  ipcRenderer.on(channel, (_event, reply) => {
    const item = pending.get(reply.id);
    if (!item) return;
    item.onEvent?.(reply.event);
    if (reply.event.type === 'result') {
      pending.delete(reply.id);
      clearTimeout(item.timer);
      item.resolve(reply.event.value);
    }
  });
  function request(operation, payload, onEvent) {
    const id = String(++sequence);
    /** @type {(value: any) => void} */
    let resolve = () => {};
    const promise = new Promise(done => { resolve = done; });
    const cancel = () => {
      const item = pending.get(id); if (!item) return;
      ipcRenderer.send(channel, { id, operation: 'webApps.cancel', payload });
      pending.delete(id); clearTimeout(item.timer);
      onEvent?.({ type: 'result', ok: false, value: { code: 'E_CANCELLED' } });
      resolve({ code: 'E_CANCELLED' });
    };
    pending.set(id, { resolve, onEvent, timer: setTimeout(cancel, 20000) });
    ipcRenderer.send(channel, { id, operation, payload });
    return { promise, cancel };
  }
  contextBridge.exposeInMainWorld('orkas', {
    invoke: (operation, payload) => request(operation, payload).promise,
    stream: (operation, payload, onEvent) => request(operation, payload, onEvent),
  });
}
