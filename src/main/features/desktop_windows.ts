import type { BrowserWindow, WebContents } from 'electron';

interface Dependencies {
  canHide(): boolean;
  /** Standalone Linux retains the native close owner because it has no tray. */
  nativeClose?(): boolean;
  isShutdownComplete(): boolean;
}

/** Closing only hides the main window. Explicit quit and update own shutdown. */
export function createDesktopWindowController(deps: Dependencies) {
  const windows = new Set<BrowserWindow>();
  return {
    owns(sender: WebContents) { return [...windows].some(win => !win.isDestroyed() && win.webContents === sender); },
    install(win: BrowserWindow, isQuitting = () => false) {
      windows.add(win);
      win.on('close', event => {
        // Squirrel closes windows before before-quit. Prepared updates must
        // destroy them, while ordinary close never starts shutdown preparation.
        if (deps.nativeClose?.() || isQuitting() || deps.isShutdownComplete()) return;
        event.preventDefault();
        // Without a Windows tray the visible window is the recovery entry.
        if (deps.canHide()) win.hide();
      });
      win.on('closed', () => { windows.delete(win); });
    },
  };
}
let controller: ReturnType<typeof createDesktopWindowController> | null = null;
export function setDesktopWindowController(value: ReturnType<typeof createDesktopWindowController>) { controller = value; }
export function getDesktopWindowController() { return controller; }
