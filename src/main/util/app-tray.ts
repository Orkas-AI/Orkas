import { Menu, nativeImage, Tray } from 'electron';

type TrayOptions = {
  platform: NodeJS.Platform;
  iconPath: string;
  displayName: string;
  labels: () => { open: string; quit: string };
  onActivate: () => void;
  onQuit: () => void;
  warn: (message: string) => void;
};

/** The tray is optional: failure must not interrupt the already-created main window. */
export function createOptionalTray({ platform, iconPath, displayName, labels, onActivate, onQuit, warn }: TrayOptions): Tray | null {
  if (platform !== 'darwin' && platform !== 'win32') return null;
  const warnSafely = (message: string): void => {
    try { warn(message); } catch { /* diagnostic failure cannot make the tray mandatory */ }
  };
  const action = (run: () => void, message: string) => () => {
    try { run(); } catch { warnSafely(message); }
  };
  let tray: Tray | null = null;
  try {
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) { warnSafely('tray icon unavailable'); return null; }
    if (platform === 'darwin') image.setTemplateImage(true);
    tray = new Tray(image);
    tray.setToolTip(displayName);
    // Build on each opening so account/language changes cannot leave stale copy.
    // Own both mouse buttons; no second automatic context menu is registered.
    const openMenu = action(() => {
      const text = labels();
      tray!.popUpContextMenu(Menu.buildFromTemplate([
        { label: text.open, click: action(onActivate, 'tray activation unavailable') },
        { label: text.quit, click: action(onQuit, 'tray quit unavailable') },
      ]));
    }, 'tray menu unavailable');
    tray.on('click', openMenu);
    tray.on('right-click', openMenu);
    return tray;
  } catch {
    try { tray?.destroy(); } catch { /* best-effort cleanup of a partial tray */ }
    warnSafely('tray unavailable');
    return null;
  }
}
