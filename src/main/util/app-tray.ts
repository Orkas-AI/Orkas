import { nativeImage, Tray } from 'electron';

type TrayOptions = {
  platform: NodeJS.Platform;
  iconPath: string;
  displayName: string;
  onActivate: () => void;
  warn: (message: string) => void;
};

/** The tray is optional: failure must not interrupt the already-created main window. */
export function createOptionalTray({ platform, iconPath, displayName, onActivate, warn }: TrayOptions): Tray | null {
  if (platform !== 'darwin' && platform !== 'win32') return null;

  const warnSafely = (message: string): void => {
    try { warn(message); } catch { /* diagnostic failure cannot make the tray mandatory */ }
  };
  let tray: Tray | null = null;
  try {
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      warnSafely('tray icon unavailable');
      return null;
    }
    if (platform === 'darwin') image.setTemplateImage(true);
    tray = new Tray(image);
    tray.setToolTip(displayName);
    tray.on('click', () => {
      try { onActivate(); } catch { warnSafely('tray activation unavailable'); }
    });
    return tray;
  } catch {
    try { tray?.destroy(); } catch { /* best-effort cleanup of a partial tray */ }
    warnSafely('tray unavailable');
    return null;
  }
}
