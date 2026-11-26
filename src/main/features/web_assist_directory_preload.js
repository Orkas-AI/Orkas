const { ipcRenderer, webUtils } = require('electron');

// This channel is sent only to the host's offscreen file input. Chromium
// clones the FileList and its file-backed blobs directly to the selected frame.
ipcRenderer.on('web-assist:directory-source', event => {
  const [port] = event.ports;
  const input = document.querySelector('input[type=file][webkitdirectory]');
  try { if (input instanceof HTMLInputElement) port.postMessage(input.files); }
  finally { port.close(); }
});

// DevTools invokes this in Electron's isolated preload world for the exact
// frame. No receiver, file paths, or message port are exposed to the page.
globalThis.__orkasReceiveDirectory = nonce => {
  const { port1, port2 } = new MessageChannel();
  let selection = null;
  let finish;
  const count = new Promise(resolve => { finish = resolve; });
  const close = () => {
    port1.close();
    selection = null;
    finish(null);
  };
  port1.onmessage = ({ data }) => {
    if (!(data instanceof FileList)) { close(); return; }
    selection = data;
    port1.close();
    finish(selection.length);
  };
  port1.onmessageerror = close;
  ipcRenderer.postMessage('web-assist:directory-receiver', nonce, [port2]);
  return {
    count,
    close,
    paths(offset, limit) {
      return selection ? Array.from({ length: Math.min(limit, selection.length - offset) },
        (_, index) => webUtils.getPathForFile(selection[offset + index])) : [];
    },
    apply(input, allowDetached) {
      if (!selection || !(input instanceof HTMLInputElement) || input.ownerDocument !== document || input.type !== 'file'
        || !input.webkitdirectory || input.disabled || (!allowDetached && !input.isConnected)) return { status: 'invalid' };
      if (sameSelection(input.files, selection)) {
        input.dispatchEvent(new Event('cancel', { bubbles: true }));
        return { status: 'cancelled' };
      }
      input.files = selection;
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if ((!allowDetached && !input.isConnected) || input.files?.length !== selection.length) return { status: 'invalid' };
      return { status: 'applied', count: selection.length };
    },
  };
};

/** @param {FileList} previous @param {FileList} next */
function sameSelection(previous, next) {
  if (previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index++) {
    const filePath = webUtils.getPathForFile(next[index]);
    if (!filePath || filePath !== webUtils.getPathForFile(previous[index])
      || next[index].webkitRelativePath !== previous[index].webkitRelativePath) return false;
  }
  return true;
}
