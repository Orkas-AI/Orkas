import { Menu, nativeImage, Tray } from 'electron';
import path from 'node:path';

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
    // Native menus accept raster icons; these are exports of the shared
    // renderer's monitor/log-out glyphs, with 2x representations for Retina.
    const menuIcon = (name: string) => {
      try {
        const icon = nativeImage.createFromPath(path.join(path.dirname(iconPath), `tray-${name}.png`));
        if (icon.isEmpty()) throw new Error('empty icon');
        if (platform === 'darwin') icon.setTemplateImage(true);
        return icon;
      } catch {
        warnSafely('tray menu icon unavailable');
        return undefined;
      }
    };
    const openIcon = menuIcon('open'), quitIcon = menuIcon('quit');
    // Build on each opening so account/language changes cannot leave stale copy.
    // Own both mouse buttons; no second automatic context menu is registered.
    const openMenu = action(() => {
      const text = labels();
      // Electron exposes no native menu minimum width. Trailing em spaces
      // leave breathing room after short translations without changing copy.
      const padding = '\u2003'.repeat(4);
      tray!.popUpContextMenu(Menu.buildFromTemplate([
        { label: text.open + padding, icon: openIcon, click: action(onActivate, 'tray activation unavailable') },
        { label: text.quit + padding, icon: quitIcon, click: action(onQuit, 'tray quit unavailable') },
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
