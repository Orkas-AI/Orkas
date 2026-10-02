import { describe, expect, it, vi } from 'vitest';

const terminalMock = vi.hoisted(() => ({ listener: null as ((event: any) => void) | null }));
vi.mock('../../../src/main/features/group_chat/bus', () => ({
  subscribeTaskTerminals: (listener: (event: any) => void) => {
    terminalMock.listener = listener;
    return () => { terminalMock.listener = null; };
  },
}));

import {
  refreshTaskUnreadTray,
  resetTaskUnreadTrayOwner,
  startTaskUnreadTray,
} from '../../../src/main/features/task_unread_tray';

function start() {
  let userId = 'u1';
  let enabled = true;
  let focused = false;
  const titles: string[] = [];
  const warn = vi.fn();
  const stop = startTaskUnreadTray({
    tray: { setTitle: (title: string) => { titles.push(title); } },
    getActiveUserId: () => userId,
    isEnabled: () => enabled,
    isMainWindowFocused: () => focused,
    warn,
  });
  return {
    titles,
    warn,
    stop,
    setUserId: (value: string) => { userId = value; },
    setEnabled: (value: boolean) => { enabled = value; },
    setFocused: (value: boolean) => { focused = value; refreshTaskUnreadTray(); },
    terminal: (conversationId: string, owner = userId, status = 'completed') => {
      terminalMock.listener?.({ user_id: owner, conversation_id: conversationId, status });
    },
  };
}

describe('macOS menu bar unread task count', () => {
  it('stays optional before an account has been activated', () => {
    const setTitle = vi.fn();
    const stop = startTaskUnreadTray({
      tray: { setTitle },
      getActiveUserId: () => { throw new Error('account not ready'); },
      isEnabled: () => true,
      isMainWindowFocused: () => false,
      warn: vi.fn(),
    });
    try {
      expect(setTitle).toHaveBeenLastCalledWith('');
      terminalMock.listener?.({ user_id: 'u1', conversation_id: 'a', status: 'completed' });
      expect(setTitle).toHaveBeenCalledTimes(1);
    } finally { stop(); }
  });

  it('counts only the current absence and clears immediately on entering any main-window view', () => {
    const runtime = start();
    try {
      runtime.setFocused(true);
      runtime.terminal('old-task');
      expect(runtime.titles.at(-1)).toBe('');

      runtime.setFocused(false);
      runtime.terminal('a');
      runtime.terminal('b');
      expect(runtime.titles.at(-1)).toBe('2');

      runtime.setFocused(true);
      expect(runtime.titles.at(-1)).toBe('');
      runtime.terminal('foreground-task');
      runtime.setFocused(false);
      expect(runtime.titles.at(-1)).toBe('');
      runtime.terminal('a');
      expect(runtime.titles.at(-1)).toBe('1');
    } finally { runtime.stop(); }
  });

  it('hides notifications when disabled and cannot resurrect an acknowledged absence', () => {
    const runtime = start();
    try {
      runtime.terminal('a');
      runtime.terminal('b');
      runtime.setEnabled(false);
      refreshTaskUnreadTray();
      expect(runtime.titles.at(-1)).toBe('');
      runtime.terminal('c');
      runtime.setEnabled(true);
      refreshTaskUnreadTray();
      expect(runtime.titles.at(-1)).toBe('3');

      runtime.setEnabled(false);
      runtime.setFocused(true);
      runtime.setFocused(false);
      runtime.setEnabled(true);
      refreshTaskUnreadTray();
      expect(runtime.titles.at(-1)).toBe('');
    } finally { runtime.stop(); }
  });

  it('counts live terminals while away, deduplicating tasks and excluding other accounts and cancellations', () => {
    const runtime = start();
    try {
      runtime.terminal('a');
      runtime.terminal('a');
      runtime.terminal('b', 'other-user');
      runtime.terminal('cancelled-task', 'u1', 'cancelled');
      expect(runtime.titles.at(-1)).toBe('1');
      runtime.terminal('stopped-task', 'u1', 'stopped');
      runtime.terminal('failed-task', 'u1', 'failed');
      runtime.terminal('waiting-task', 'u1', 'waiting_input');
      expect(runtime.titles.at(-1)).toBe('4');
    } finally { runtime.stop(); }
  });

  it('clears the old account immediately and rejects its delayed terminal', () => {
    const runtime = start();
    try {
      runtime.terminal('a');
      runtime.setUserId('u2');
      resetTaskUnreadTrayOwner();
      expect(runtime.titles.at(-1)).toBe('');
      runtime.terminal('a', 'u1');
      expect(runtime.titles.at(-1)).toBe('');
      runtime.terminal('b');
      expect(runtime.titles.at(-1)).toBe('1');
      runtime.setUserId('u1');
      resetTaskUnreadTrayOwner();
      expect(runtime.titles.at(-1)).toBe('');
    } finally { runtime.stop(); }
  });

  it('caps the visible text and starts the next absence empty after a burst', () => {
    const runtime = start();
    try {
      for (let i = 0; i < 501; i += 1) runtime.terminal(`task${i}`);
      expect(runtime.titles.at(-1)).toBe('99+');
      runtime.setFocused(true);
      runtime.setFocused(false);
      runtime.terminal('new-task');
      expect(runtime.titles.at(-1)).toBe('1');
    } finally { runtime.stop(); }
  });
});
