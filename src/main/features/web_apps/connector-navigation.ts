import { BrowserWindow } from 'electron';
import { getActiveUserId } from '../users';
import { AppError } from './runtime';

/** Navigation only: connection consent and credentials stay with Connectors. */
export async function openConnectors(uid: string): Promise<{ opened: true }> {
  if (getActiveUserId() !== uid) throw new AppError('E_CLOSED');
  const target = BrowserWindow.getAllWindows().find(win => {
    try { return !win.isDestroyed() && new URL(win.webContents.getURL()).pathname.endsWith('/index.html'); }
    catch { return false; }
  });
  if (!target) throw new AppError('E_UNAVAILABLE');
  target.webContents.send('connectors:open-from-app', { user_id: uid });
  if (target.isFocusable()) {
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
  }
  return { opened: true };
}
