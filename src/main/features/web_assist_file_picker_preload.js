// Preserve native File System Access APIs for humans. During an AI task,
// reject before opening modal UI so sites can use their ordinary download or
// file-input fallback. No file handles, bytes or paths cross this boundary.
const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame) {
  for (const kind of ['open', 'save', 'directory']) {
    window.addEventListener(`orkas:before-${kind}-file-picker`, event => {
      if (ipcRenderer.sendSync('web-assist:file-system-picker', kind) === true) event.preventDefault();
    }, true);
  }
  contextBridge.executeInMainWorld({ func: () => {
    const dispatch = window.dispatchEvent.bind(window);
    const NativeEvent = Event;
    const NativeDOMException = DOMException;
    const apply = Reflect.apply;
    for (const [name, kind] of [['showOpenFilePicker', 'open'], ['showSaveFilePicker', 'save'], ['showDirectoryPicker', 'directory']]) {
      const native = window[name];
      if (typeof native !== 'function') continue;
      window[name] = new Proxy(native, {
        async apply(target, receiver, args) {
          if (!dispatch(new NativeEvent(`orkas:before-${kind}-file-picker`, { cancelable: true }))) {
            throw new NativeDOMException('File selection was cancelled.', 'AbortError');
          }
          return apply(target, receiver, args);
        },
      });
    }
  } });
}
