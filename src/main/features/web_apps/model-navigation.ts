import { BrowserWindow } from 'electron';
import { getActiveUserId } from '../users';
import { AppError } from './runtime';

/** Navigation only; model configuration and credentials remain in Settings. */
export async function configureModels(uid: string, kind: 'image' | 'video' | 'audio'): Promise<{ opened: true }> {
  if (getActiveUserId() !== uid) throw new AppError('E_CLOSED');
  if (!['image', 'video', 'audio'].includes(kind)) throw new AppError('E_INPUT');
  const target = BrowserWindow.getAllWindows().find(win => {
    try { return !win.isDestroyed() && new URL(win.webContents.getURL()).pathname.endsWith('/index.html'); }
    catch { return false; }
  });
  if (!target) throw new AppError('E_UNAVAILABLE');
  target.webContents.send('settings:open-models-from-app', { user_id: uid, kind: kind === 'audio' ? 'tts' : kind });
  if (target.isFocusable()) {
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
  }
  return { opened: true };
}
