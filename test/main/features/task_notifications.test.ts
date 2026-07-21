import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/i18n', () => ({
  t: (key: string) => key,
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
  let runtime: TaskNotificationRuntime;
  let createNotification: ReturnType<typeof vi.fn>;
  let openConversation: ReturnType<typeof vi.fn>;
  let setBadgeCount: ReturnType<typeof vi.fn>;
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
    activeUserId = 'u1';
    enabled = true;
    focused = false;
    supported = true;
    focusListener = null;
    openConversation = vi.fn();
    setBadgeCount = vi.fn();
    stopFocusListener = vi.fn();
    unsubscribe = vi.fn();
    createNotification = vi.fn(() => ({
      onClick: (next: () => void) => { clickListener = next; },
      show: vi.fn(),
    }));
    runtime = {
      getActiveUserId: () => activeUserId,
      isEnabled: () => enabled,
      hasFocusedWindow: () => focused,
      isSupported: () => supported,
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

    expect(createNotification).toHaveBeenCalledWith({ title, body });
    expect(setBadgeCount).toHaveBeenLastCalledWith(1);
    expect(clickListener).toBeTypeOf('function');
    clickListener!();
    expect(setBadgeCount).toHaveBeenLastCalledWith(0);
    expect(openConversation).toHaveBeenCalledWith('c1', status);
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
    expect(setBadgeCount).toHaveBeenCalledTimes(1);
    expect(setBadgeCount).toHaveBeenLastCalledWith(0);
  });

  it('counts background task notifications and clears the badge when the app regains focus', () => {
    listener(terminal('completed'));
    listener({ ...terminal('failed'), run_id: 'run-2' });

    expect(setBadgeCount).toHaveBeenLastCalledWith(2);
    expect(focusListener).toBeTypeOf('function');
    focusListener!();
    expect(setBadgeCount).toHaveBeenLastCalledWith(0);
  });

  it('does not open a stale notification after the active user changes', () => {
    listener(terminal('completed'));
    activeUserId = 'u2';
    clickListener!();

    expect(openConversation).not.toHaveBeenCalled();
    expect(setBadgeCount).toHaveBeenLastCalledWith(1);
  });

  it('removes listeners and clears the badge when stopped', () => {
    listener(terminal('completed'));

    stopTaskNotifications();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(stopFocusListener).toHaveBeenCalledOnce();
    expect(setBadgeCount).toHaveBeenLastCalledWith(0);
  });
});
