// Sandboxed frame preload: only standard prompt semantics cross this channel.
// Electron replaces Blink's prompt with an unsupported-operation stub. Preserve
// that behavior outside an actively controlled task browser, with no page IPC API.
const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame) {
  contextBridge.executeInMainWorld({ func: () => { delete window.prompt; } });
  contextBridge.exposeInMainWorld('prompt', (message = '', defaultValue = '') => {
    const result = ipcRenderer.sendSync('web-assist:prompt', String(message), String(defaultValue));
    if (!result?.handled) throw new Error('prompt() is not supported.');
    return result.accepted ? result.value : null;
  });
}
