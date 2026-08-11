import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/i18n', () => ({
  // Default to a stale English process locale. Production must pass the
  // event user's current persisted locale explicitly.
  t: (key: string, _vars?: Record<string, string | number>, lang = 'en') => `${lang}:${key}`,
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

vi.mock('../../../src/main/features/group_chat/bus', () => ({
  subscribeTaskTerminals: vi.fn(),
}));

import {
  startTaskNotifications,
  type TaskNotificationRuntime,
} from '../../../src/main/features/task_notifications';
import type { TaskTerminalEvent, TaskTerminalListener } from '../../../src/main/features/group_chat/bus';

function terminal(status: TaskTerminalEvent['status']): TaskTerminalEvent {
  return {
    run_id: 'run-1',
    user_id: 'u1',
    conversation_id: 'c1',
    status,
    started_at_ms: 10,
    finished_at_ms: 20,
  };
}

describe('task completion notifications', () => {
  let listener: TaskTerminalListener;
  let clickListener: (() => void) | null;
  let closeListener: ((reason?: string) => void) | null;
  let failedListener: (() => void) | null;
  let runtime: TaskNotificationRuntime;
  let createNotification: ReturnType<typeof vi.fn>;
  let closeNotification: ReturnType<typeof vi.fn>;
  let showNotification: ReturnType<typeof vi.fn>;
  let openConversation: ReturnType<typeof vi.fn>;
  let setBadgeCount: ReturnType<typeof vi.fn>;
  let resolveLanguageForUser: ReturnType<typeof vi.fn>;
  let stopFocusListener: ReturnType<typeof vi.fn>;
  let focusListener: (() => void) | null;
  let stopTaskNotifications: () => void;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let activeUserId: string;
  let enabled: boolean;
  let focused: boolean;
  let supported: boolean;

  beforeEach(() => {
    clickListener = null;
    closeListener = null;
    failedListener = null;
    activeUserId = 'u1';
    enabled = true;
    focused = false;
    supported = true;
    focusListener = null;
    closeNotification = vi.fn();
    showNotification = vi.fn();
    openConversation = vi.fn();
    setBadgeCount = vi.fn();
    resolveLanguageForUser = vi.fn(() => 'zh');
    stopFocusListener = vi.fn();
    unsubscribe = vi.fn();
    createNotification = vi.fn(() => ({
      onClick: (next: () => void) => { clickListener = next; },
      onClose: (next: (reason?: string) => void) => { closeListener = next; },
      onFailed: (next: () => void) => { failedListener = next; },
      show: showNotification,
      close: closeNotification,
    }));
    runtime = {
      getActiveUserId: () => activeUserId,
      isEnabled: () => enabled,
      hasFocusedWindow: () => focused,
      isSupported: () => supported,
      resolveLanguageForUser,
      setBadgeCount,
      onDidFocus: (next) => {
        focusListener = next;
        return stopFocusListener;
      },
      createNotification,
      openConversation,
    };
    stopTaskNotifications = startTaskNotifications(runtime, (next) => {
      listener = next;
      return unsubscribe;
    });
  });

  it.each([
    ['completed', 'notification.task.completed.title', 'notification.task.completed.body'],
    ['failed', 'notification.task.failed.title', 'notification.task.failed.body'],
    ['waiting_input', 'notification.task.waiting_input.title', 'notification.task.waiting_input.body'],
  ] as const)('shows generic localized copy for %s and routes clicks to the conversation', (status, title, body) => {
    listener(terminal(status));

    expect(createNotification).toHaveBeenCalledWith({ title: `zh:${title}`, body: `zh:${body}` });
    expect(resolveLanguageForUser).toHaveBeenLastCalledWith('u1');
    expect(setBadgeCount).toHaveBeenLastCalledWith(1);
    expect(clickListener).toBeTypeOf('function');
    clickListener!();
    expect(setBadgeCount).toHaveBeenLastCalledWith(0);
    expect(openConversation).toHaveBeenCalledWith('c1', status, 'u1');
  });

  it('suppresses disabled, foreground, unsupported, cancelled, and other-user events', () => {
    enabled = false;
    listener(terminal('completed'));
    enabled = true;
    focused = true;
    listener(terminal('completed'));
    focused = false;
    supported = false;
    listener(terminal('failed'));
    supported = true;
    listener(terminal('cancelled'));
    listener({ ...terminal('completed'), user_id: 'u2' });

    expect(createNotification).not.toHaveBeenCalled();
    expect(resolveLanguageForUser).not.toHaveBeenCalled();
    expect(setBadgeCount).toHaveBeenCalledTimes(1);
    expect(setBadgeCount).toHaveBeenLastCalledWith(0);
  });

  it('keeps background notifications managed until focus, then closes them and clears the badge', () => {
    listener(terminal('completed'));
    listener({ ...terminal('failed'), run_id: 'run-2' });

    expect(setBadgeCount).toHaveBeenLastCalledWith(2);
    expect(showNotification).toHaveBeenCalledTimes(2);
    expect(closeNotification).not.toHaveBeenCalled();
    expect(closeListener).toBeTypeOf('function');
    closeListener!('timedOut');
    expect(focusListener).toBeTypeOf('function');
    focusListener!();
    expect(setBadgeCount).toHaveBeenLastCalledWith(0);
    expect(closeNotification).toHaveBeenCalledTimes(2);
  });

  it('does not open a stale notification after the active user changes', () => {
    listener(terminal('completed'));
    activeUserId = 'u2';
    clickListener!();

    expect(openConversation).not.toHaveBeenCalled();
    expect(setBadgeCount).toHaveBeenLastCalledWith(0);
  });

  it('releases a synchronously rejected notification and rolls back its badge', () => {
    showNotification.mockImplementationOnce(() => {
      throw new Error('native notification unavailable');
    });

    expect(() => listener(terminal('completed'))).not.toThrow();
    expect(setBadgeCount.mock.calls.map(([count]) => count)).toEqual([0, 1, 0]);
    expect(closeNotification).toHaveBeenCalledOnce();

    listener({ ...terminal('failed'), run_id: 'run-2' });
    expect(setBadgeCount).toHaveBeenLastCalledWith(1);
  });

  it('rolls back only the matching badge when native delivery fails asynchronously', () => {
    listener(terminal('completed'));

    expect(failedListener).toBeTypeOf('function');
    failedListener!();
    expect(setBadgeCount.mock.calls.map(([count]) => count)).toEqual([0, 1, 0]);

    listener({ ...terminal('failed'), run_id: 'run-2' });
    expect(setBadgeCount).toHaveBeenLastCalledWith(1);
    expect(closeNotification).not.toHaveBeenCalled();
  });

  it('removes listeners and clears the badge when stopped', () => {
    listener(terminal('completed'));

    stopTaskNotifications();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(stopFocusListener).toHaveBeenCalledOnce();
    expect(setBadgeCount).toHaveBeenLastCalledWith(0);
    expect(closeNotification).toHaveBeenCalledOnce();
  });
});
