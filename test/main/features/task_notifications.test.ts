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
import {
  _resetTaskInterventionsForTest,
  emitTaskIntervention,
  type TaskInterventionListener,
} from '../../../src/main/util/task-intervention-events';

function terminal(status: TaskTerminalEvent['status']): TaskTerminalEvent {
  return {
    run_id: 'run-1',
    user_id: 'u1',
    conversation_id: 'c1',
    entry_point: 'conversation',
    status,
    started_at_ms: 10,
    finished_at_ms: 20,
  };
}

describe('task completion notifications', () => {
  let listener: TaskTerminalListener;
  let interventionListener: TaskInterventionListener;
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
  let unsubscribeInterventions: ReturnType<typeof vi.fn>;
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
    unsubscribeInterventions = vi.fn();
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
    }, (next) => {
      interventionListener = next;
      return unsubscribeInterventions;
    });
  });

  it.each([
    ['completed', 'notification.task.completed.title', 'notification.task.completed.body'],
    ['stopped', 'notification.task.stopped.title', 'notification.task.stopped.body'],
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

  it.each(['sensitive_operation', 'interactive_cli_input'] as const)('uses background notification and waiting-input navigation for %s', kind => {
    interventionListener({
      attention_id: `${kind}:req-1`,
      user_id: 'u1',
      conversation_id: 'c1',
      kind,
    });

    expect(createNotification).toHaveBeenCalledWith({
      title: 'zh:notification.task.waiting_input.title',
      body: 'zh:notification.task.waiting_input.body',
    });
    expect(setBadgeCount).toHaveBeenLastCalledWith(1);
    clickListener!();
    expect(openConversation).toHaveBeenCalledWith('c1', 'waiting_input', 'u1');
  });

  it('receives intervention signals through the production default subscription', () => {
    stopTaskNotifications();
    _resetTaskInterventionsForTest();
    const stopDefaultSubscription = startTaskNotifications(runtime, (next) => {
      listener = next;
      return unsubscribe;
    });

    try {
      emitTaskIntervention({
        attention_id: 'delete_confirmation:req-default',
        user_id: 'u1',
        conversation_id: 'c1',
        kind: 'delete_confirmation',
      });

      expect(createNotification).toHaveBeenCalledWith({
        title: 'zh:notification.task.waiting_input.title',
        body: 'zh:notification.task.waiting_input.body',
      });
      expect(showNotification).toHaveBeenCalledOnce();
    } finally {
      stopDefaultSubscription();
      _resetTaskInterventionsForTest();
    }
  });

  it('ignores a background intervention owned by another account', () => {
    interventionListener({
      attention_id: 'connector_permission:req-u2',
      user_id: 'u2',
      conversation_id: 'c1',
      kind: 'connector_permission',
    });

    expect(createNotification).not.toHaveBeenCalled();
    expect(resolveLanguageForUser).not.toHaveBeenCalled();
    expect(setBadgeCount.mock.calls.map(([count]) => count)).toEqual([0]);
  });

  it('coalesces a terminal immediately following an intervention until the app returns to the foreground', () => {
    interventionListener({
      attention_id: 'delete_confirmation:req-1',
      user_id: 'u1',
      conversation_id: 'c1',
      kind: 'delete_confirmation',
    });
    listener(terminal('completed'));

    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(setBadgeCount).toHaveBeenLastCalledWith(1);

    focusListener!();
    focused = false;
    listener({ ...terminal('completed'), run_id: 'run-2' });
    expect(createNotification).toHaveBeenCalledTimes(2);
  });

  it('delivers a terminal after the intervention coalescing window expires', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    interventionListener({
      attention_id: 'connector_permission:req-1',
      user_id: 'u1',
      conversation_id: 'c1',
      kind: 'connector_permission',
    });

    now.mockReturnValue(1_000 + 2 * 60_000 + 1);
    listener(terminal('failed'));

    expect(createNotification).toHaveBeenCalledTimes(2);
    expect(showNotification).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('does not coalesce another account terminal with a colliding conversation id', () => {
    interventionListener({
      attention_id: 'sensitive_operation:req-u1',
      user_id: 'u1',
      conversation_id: 'c1',
      kind: 'sensitive_operation',
    });

    activeUserId = 'u2';
    listener({ ...terminal('completed'), user_id: 'u2' });

    expect(createNotification).toHaveBeenCalledTimes(2);
    expect(showNotification).toHaveBeenCalledTimes(2);
  });

  it('does not suppress a later terminal when the intervention notification was rejected', () => {
    showNotification.mockImplementationOnce(() => {
      throw new Error('native notification unavailable');
    });
    interventionListener({
      attention_id: 'interactive_cli_input:session-1',
      user_id: 'u1',
      conversation_id: 'c1',
      kind: 'interactive_cli_input',
    });

    listener(terminal('completed'));

    expect(createNotification).toHaveBeenCalledTimes(2);
    expect(showNotification).toHaveBeenCalledTimes(2);
    expect(setBadgeCount).toHaveBeenLastCalledWith(1);
  });

  it('restores later terminal delivery after an asynchronous intervention notification failure', () => {
    interventionListener({
      attention_id: 'connector_install:req-async-failure',
      user_id: 'u1',
      conversation_id: 'c1',
      kind: 'connector_install',
    });

    expect(failedListener).toBeTypeOf('function');
    failedListener!();
    listener(terminal('failed'));

    expect(createNotification).toHaveBeenCalledTimes(2);
    expect(showNotification).toHaveBeenCalledTimes(2);
    expect(setBadgeCount.mock.calls.map(([count]) => count)).toEqual([0, 1, 0, 1]);
  });

  it('suppresses disabled, foreground, unsupported, cancelled, and other-user events', () => {
    enabled = false;
    listener(terminal('completed'));
    enabled = true;
    focused = true;
    listener(terminal('completed'));
    interventionListener({
      attention_id: 'sensitive_operation:req-focused',
      user_id: 'u1',
      conversation_id: 'c1',
      kind: 'sensitive_operation',
    });
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
    expect(unsubscribeInterventions).toHaveBeenCalledOnce();
    expect(stopFocusListener).toHaveBeenCalledOnce();
    expect(setBadgeCount).toHaveBeenLastCalledWith(0);
    expect(closeNotification).toHaveBeenCalledOnce();
  });
});
