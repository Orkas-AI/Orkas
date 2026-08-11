import { t, type Lang } from '../i18n';
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
  onClose(listener: (reason?: string) => void): void;
  onFailed(listener: () => void): void;
  show(): void;
  close(): void;
}

export interface TaskNotificationRuntime {
  getActiveUserId(): string;
  isEnabled(): boolean;
  hasFocusedWindow(): boolean;
  isSupported(): boolean;
  resolveLanguageForUser(userId: string): Lang;
  setBadgeCount(count: number): void;
  onDidFocus(listener: () => void): () => void;
  createNotification(options: { title: string; body: string }): TaskNotificationHandle;
  openConversation(conversationId: string, status: TaskTerminalStatus, userId: string): void;
}

type TaskTerminalSubscribe = (listener: TaskTerminalListener) => () => void;

function copyFor(
  status: Exclude<TaskTerminalStatus, 'cancelled'>,
  lang: Lang,
): { title: string; body: string } {
  return {
    title: t(`notification.task.${status}.title`, undefined, lang),
    body: t(`notification.task.${status}.body`, undefined, lang),
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
  const activeNotifications = new Set<TaskNotificationHandle>();

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
  const closeActiveNotifications = (): void => {
    const notifications = [...activeNotifications];
    activeNotifications.clear();
    for (const notification of notifications) {
      try {
        notification.close();
      } catch (err) {
        log.warn('native task notification close failed', {
          error: (err as Error)?.message || String(err),
        });
      }
    }
  };
  const markNotificationsRead = (): void => {
    if (unreadCount > 0) updateBadge(0);
    closeActiveNotifications();
  };

  // Clear any stale OS-owned badge left behind by an unclean prior exit.
  updateBadge(0);
  const stopFocusListener = runtime.onDidFocus(markNotificationsRead);
  const unsubscribe = subscribe((event: TaskTerminalEvent) => {
    let badgeOwned = false;
    let notification: TaskNotificationHandle | null = null;
    try {
      if (event.status === 'cancelled') return;
      if (runtime.getActiveUserId() !== event.user_id) return;
      if (!runtime.isEnabled()) return;
      if (runtime.hasFocusedWindow() || !runtime.isSupported()) return;

      // Read the originating account's persisted language at delivery time.
      // The process-global locale can be stale when another Orkas process or
      // cloud sync updates preferences while this process stays in the
      // background.
      const lang = runtime.resolveLanguageForUser(event.user_id);
      updateBadge(unreadCount + 1);
      badgeOwned = true;
      const createdNotification = runtime.createNotification(copyFor(event.status, lang));
      notification = createdNotification;
      activeNotifications.add(createdNotification);
      createdNotification.onClose((reason) => {
        // A timed-out Windows toast can remain in Action Center. Keep the
        // handle alive so its message and click route remain available there.
        if (reason === 'timedOut') return;
        activeNotifications.delete(createdNotification);
      });
      createdNotification.onFailed(() => {
        // Native delivery failures are asynchronous on macOS and Windows.
        // Roll back only while this notification still owns an unread badge.
        if (!activeNotifications.delete(createdNotification)) return;
        badgeOwned = false;
        updateBadge(unreadCount - 1);
      });
      createdNotification.onClick(() => {
        try {
          // A stale notification must never navigate into another account's
          // local conversation namespace after an account switch.
          if (runtime.getActiveUserId() !== event.user_id) {
            if (activeNotifications.delete(createdNotification)) {
              badgeOwned = false;
              updateBadge(unreadCount - 1);
            }
            return;
          }
          markNotificationsRead();
          runtime.openConversation(event.conversation_id, event.status, event.user_id);
        } catch (err) {
          log.warn('task notification click failed', { error: (err as Error)?.message || String(err) });
        }
      });
      createdNotification.show();
    } catch (err) {
      // Notifications are a best-effort attention layer. They must never
      // affect persistence, task completion, the worker scheduler, or leave a
      // badge for a notification the operating system never accepted.
      if (notification && activeNotifications.delete(notification)) {
        try {
          notification.close();
        } catch {
          // The original creation/show failure remains the actionable error.
        }
      }
      if (badgeOwned) updateBadge(unreadCount - 1);
      log.warn('native task notification failed', { error: (err as Error)?.message || String(err) });
    }
  });

  return () => {
    unsubscribe();
    stopFocusListener();
    markNotificationsRead();
  };
}
