import { dialog, type BrowserWindow } from 'electron';

import { t } from '../i18n';
import { createLogger } from '../logger';

const log = createLogger('window-close-confirmation');

/** Guard native main-window closes without changing the app's quit lifecycle. */
export function installWindowCloseConfirmation(
  win: BrowserWindow,
  hasActiveWork: () => boolean,
  isQuitting: () => boolean,
): void {
  let pending = false;
  let confirmed = false;

  win.on('close', (event) => {
    if (confirmed || isQuitting()) return;
    if (!pending && !hasActiveWork()) return;
    event.preventDefault();
    if (pending) return;
    pending = true;

    void (async () => {
      try {
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          title: t('window.close_running_title'),
          message: t('window.close_running_message'),
          buttons: [t('common.cancel'), t('window.close_confirm')],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (response !== 1 || win.isDestroyed() || isQuitting()) return;
        confirmed = true;
        win.close();
      } catch {
        log.warn('Close confirmation failed; keeping window open');
      } finally {
        // A renderer may veto close; a later request needs a fresh decision.
        confirmed = false;
        pending = false;
      }
    })();
  });
}
