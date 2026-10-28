import { t, type Lang } from '../i18n';
import { createLogger } from '../logger';
import {
  subscribeTaskTerminals,
  type TaskTerminalEvent,
  type TaskTerminalListener,
  type TaskTerminalStatus,
} from './group_chat/bus';
import {
  subscribeTaskInterventions,
  type TaskInterventionEvent,
  type TaskInterventionListener,
} from '../util/task-intervention-events';

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
type TaskInterventionSubscribe = (listener: TaskInterventionListener) => () => void;
type TaskNotificationStatus = Exclude<TaskTerminalStatus, 'cancelled'>;
/** What produced the run: a scheduled automation, or any other task. The
 *  copy names the kind and, when several of one kind and status pile up
 *  while the app is in the background, their count; never task content. */
type TaskNotificationKind = 'task' | 'automation';
type TaskNotificationEvent = Pick<TaskTerminalEvent, 'user_id' | 'conversation_id'> & {
  status: TaskNotificationStatus;
  kind: TaskNotificationKind;
};
const INTERVENTION_TERMINAL_COALESCE_MS = 2 * 60_000;

function eventKey(event: Pick<TaskTerminalEvent, 'user_id' | 'conversation_id'>): string {
  return `${event.user_id}\0${event.conversation_id}`;
}

/** Unread notifications of one kind and status for one account collapse into
 *  a single counted one, so three overnight automation failures read as
 *  "3 automation runs failed" instead of three identical alerts. */
function groupKey(event: TaskNotificationEvent): string {
  return `${event.user_id}\0${event.kind}\0${event.status}`;
}

function kindFor(event: Pick<TaskTerminalEvent, 'kind'>): TaskNotificationKind {
  return event.kind === 'automation' ? 'automation' : 'task';
}

function copyFor(
  kind: TaskNotificationKind,
  status: TaskNotificationStatus,
  count: number,
  lang: Lang,
): { title: string; body: string } {
  return {
    title: count > 1
      ? t(`notification.${kind}.${status}.title_many`, { count }, lang)
      : t(`notification.${kind}.${status}.title`, undefined, lang),
    body: t(`notification.task.${status}.body`, undefined, lang),
  };
}

/**
 * Bridge privacy-safe bus terminal events to the operating system. The caller
 * owns all Electron dependencies so this feature stays independently testable.
 */
export function startTaskNotifications(
  runtime: TaskNotificationRuntime,
  subscribeTerminals: TaskTerminalSubscribe = subscribeTaskTerminals,
  subscribeInterventions: TaskInterventionSubscribe = subscribeTaskInterventions,
): () => void {
  let unreadCount = 0;
  const activeNotifications = new Set<TaskNotificationHandle>();
  const recentInterventions = new Map<string, number>();
  /** The one visible notification per account, kind and status, with how
   *  many events it stands for and the conversation its click opens. */
  const groups = new Map<string, { count: number; handle: TaskNotificationHandle; conversationId: string }>();

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
  const closeNotification = (notification: TaskNotificationHandle): void => {
    try {
      notification.close();
    } catch (err) {
      log.warn('native task notification close failed', {
        error: (err as Error)?.message || String(err),
      });
    }
  };
  const closeActiveNotifications = (): void => {
    const notifications = [...activeNotifications];
    activeNotifications.clear();
    groups.clear();
    for (const notification of notifications) closeNotification(notification);
  };
  const markNotificationsRead = (): void => {
    if (unreadCount > 0) updateBadge(0);
    recentInterventions.clear();
    closeActiveNotifications();
  };

  // Clear any stale OS-owned badge left behind by an unclean prior exit.
  updateBadge(0);
  const stopFocusListener = runtime.onDidFocus(markNotificationsRead);
  const deliver = (event: TaskNotificationEvent, intervention = false): void => {
    const key = eventKey(event);
    const group = groupKey(event);
    let badgeOwned = false;
    let interventionShownAt = 0;
    let notification: TaskNotificationHandle | null = null;
    try {
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
      const previous = groups.get(group);
      const count = (previous?.count || 0) + 1;
      const createdNotification = runtime.createNotification(copyFor(event.kind, event.status, count, lang));
      notification = createdNotification;
      activeNotifications.add(createdNotification);
      // The counted notification replaces the one it absorbs. Register the
      // new owner before closing the old handle so its close callback cannot
      // drop the group it no longer owns.
      groups.set(group, { count, handle: createdNotification, conversationId: event.conversation_id });
      if (previous) {
        activeNotifications.delete(previous.handle);
        closeNotification(previous.handle);
      }
      const releaseGroup = (): void => {
        if (groups.get(group)?.handle === createdNotification) groups.delete(group);
      };
      createdNotification.onClose((reason) => {
        // A timed-out Windows toast can remain in Action Center. Keep the
        // handle alive so its message and click route remain available there,
        // and keep counting into it until the user acts on it.
        if (reason === 'timedOut') return;
        activeNotifications.delete(createdNotification);
        releaseGroup();
      });
      createdNotification.onFailed(() => {
        // Native delivery failures are asynchronous on macOS and Windows.
        // Roll back only while this notification still owns an unread badge.
        if (!activeNotifications.delete(createdNotification)) return;
        releaseGroup();
        if (
          interventionShownAt > 0
          && recentInterventions.get(key) === interventionShownAt
        ) {
          recentInterventions.delete(key);
        }
        badgeOwned = false;
        updateBadge(unreadCount - 1);
      });
      createdNotification.onClick(() => {
        try {
          // A stale notification must never navigate into another account's
          // local conversation namespace after an account switch.
          if (runtime.getActiveUserId() !== event.user_id) {
            if (activeNotifications.delete(createdNotification)) {
              releaseGroup();
              badgeOwned = false;
              updateBadge(unreadCount - 1);
            }
            return;
          }
          // A counted notification opens the conversation of its latest event;
          // the sidebar shows the rest.
          const target = groups.get(group)?.handle === createdNotification
            ? groups.get(group)!.conversationId
            : event.conversation_id;
          markNotificationsRead();
          runtime.openConversation(target, event.status, event.user_id);
        } catch (err) {
          log.warn('task notification click failed', { error: (err as Error)?.message || String(err) });
        }
      });
      if (intervention) {
        interventionShownAt = Date.now();
        recentInterventions.set(key, interventionShownAt);
      }
      createdNotification.show();
    } catch (err) {
      // Notifications are a best-effort attention layer. They must never
      // affect persistence, task completion, the worker scheduler, or leave a
      // badge for a notification the operating system never accepted.
      if (notification && activeNotifications.delete(notification)) {
        if (groups.get(group)?.handle === notification) groups.delete(group);
        try {
          notification.close();
        } catch {
          // The original creation/show failure remains the actionable error.
        }
      }
      if (
        interventionShownAt > 0
        && recentInterventions.get(key) === interventionShownAt
      ) {
        recentInterventions.delete(key);
      }
      if (badgeOwned) updateBadge(unreadCount - 1);
      log.warn('native task notification failed', { error: (err as Error)?.message || String(err) });
    }
  };
  const unsubscribeTerminals = subscribeTerminals((event: TaskTerminalEvent) => {
    if (event.status === 'cancelled') return;
    const key = eventKey(event);
    const interventionAt = recentInterventions.get(key);
    if (interventionAt !== undefined) {
      if (Date.now() - interventionAt <= INTERVENTION_TERMINAL_COALESCE_MS) return;
      recentInterventions.delete(key);
    }
    deliver({
      user_id: event.user_id,
      conversation_id: event.conversation_id,
      status: event.status,
      kind: kindFor(event),
    });
  });
  const unsubscribeInterventions = subscribeInterventions((event: TaskInterventionEvent) => {
    // An intervention carries no entry point; it reads as a task needing a reply.
    deliver({
      user_id: event.user_id,
      conversation_id: event.conversation_id,
      status: 'waiting_input',
      kind: 'task',
    }, true);
  });

  return () => {
    unsubscribeTerminals();
    unsubscribeInterventions();
    stopFocusListener();
    markNotificationsRead();
  };
}
