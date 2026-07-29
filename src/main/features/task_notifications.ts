import { t } from '../i18n';
import { createLogger } from '../logger';
import {
  subscribeTaskTerminals,
  type TaskTerminalEvent,
  type TaskTerminalListener,
  type TaskTerminalStatus,
} from './group_chat/bus';

const log = createLogger('task-notifications');

export interface TaskNotificationHandle {
  onClick(listener: () => void): void;
  show(): void;
}

export interface TaskNotificationRuntime {
  getActiveUserId(): string;
  isEnabled(): boolean;
  hasFocusedWindow(): boolean;
  isSupported(): boolean;
  setBadgeCount(count: number): void;
  onDidFocus(listener: () => void): () => void;
  createNotification(options: { title: string; body: string }): TaskNotificationHandle;
  openConversation(conversationId: string, status: TaskTerminalStatus, userId: string): void;
}

type TaskTerminalSubscribe = (listener: TaskTerminalListener) => () => void;

function copyFor(status: Exclude<TaskTerminalStatus, 'cancelled'>): { title: string; body: string } {
  return {
    title: t(`notification.task.${status}.title`),
    body: t(`notification.task.${status}.body`),
  };
}

/**
 * Bridge privacy-safe bus terminal events to the operating system. The caller
 * owns all Electron dependencies so this feature stays independently testable.
 */
export function startTaskNotifications(
  runtime: TaskNotificationRuntime,
  subscribe: TaskTerminalSubscribe = subscribeTaskTerminals,
): () => void {
  let unreadCount = 0;

  const updateBadge = (nextCount: number): void => {
    unreadCount = Math.max(0, Math.trunc(nextCount));
    try {
      runtime.setBadgeCount(unreadCount);
    } catch (err) {
      // The badge is an additional best-effort attention layer. A platform
      // integration failure must not suppress the native notification.
      log.warn('task notification badge update failed', { error: (err as Error)?.message || String(err) });
    }
  };
  const clearUnread = (): void => {
    if (unreadCount > 0) updateBadge(0);
  };

  // Clear any stale OS-owned badge left behind by an unclean prior exit.
  updateBadge(0);
  const stopFocusListener = runtime.onDidFocus(clearUnread);
  const unsubscribe = subscribe((event: TaskTerminalEvent) => {
    let badgeIncremented = false;
    try {
      if (event.status === 'cancelled') return;
      if (runtime.getActiveUserId() !== event.user_id) return;
      if (!runtime.isEnabled()) return;
      if (runtime.hasFocusedWindow() || !runtime.isSupported()) return;

      updateBadge(unreadCount + 1);
      badgeIncremented = true;
      const notification = runtime.createNotification(copyFor(event.status));
      notification.onClick(() => {
        try {
          // A stale notification must never navigate into another account's
          // local conversation namespace after an account switch.
          if (runtime.getActiveUserId() !== event.user_id) return;
          clearUnread();
          runtime.openConversation(event.conversation_id, event.status, event.user_id);
        } catch (err) {
          log.warn('task notification click failed', { error: (err as Error)?.message || String(err) });
        }
      });
      notification.show();
    } catch (err) {
      // Notifications are a best-effort attention layer. They must never
      // affect persistence, task completion, the worker scheduler, or leave a
      // badge for a notification the operating system never accepted.
      if (badgeIncremented) updateBadge(unreadCount - 1);
      log.warn('native task notification failed', { error: (err as Error)?.message || String(err) });
    }
  });

  return () => {
    unsubscribe();
    stopFocusListener();
    clearUnread();
  };
}
