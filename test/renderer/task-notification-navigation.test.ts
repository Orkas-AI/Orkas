import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const stateSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/state.js'), 'utf8');
const bootSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/boot.js'), 'utf8');

function extractFunction(source: string, name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

describe('task notification navigation', () => {
  it('queues a cold-start click until the user is initialized, then opens the target conversation', () => {
    const setView = vi.fn();
    const click = vi.fn();
    const context: any = {
      currentUserId: '',
      _pendingTaskNotificationNavigation: null,
      setView,
      Monitor: { click },
      window: { Monitor: true },
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction(stateSource, '_normalizeTaskNotificationNavigation'),
      extractFunction(stateSource, '_openTaskNotificationConversation'),
      extractFunction(stateSource, '_consumePendingTaskNotificationConversation'),
    ].join('\n'), context);

    expect(context._openTaskNotificationConversation({
      user_id: 'u1',
      conversation_id: 'abc_123',
      terminal_status: 'completed',
    })).toBe(false);
    expect(setView).not.toHaveBeenCalled();

    context.currentUserId = 'u1';
    expect(context._consumePendingTaskNotificationConversation()).toBe(true);
    expect(click).not.toHaveBeenCalled();
    expect(setView).toHaveBeenCalledWith('conversation', 'abc_123', { entryPoint: 'task_notification' });
  });

  it('rejects malformed ids and unsupported terminal statuses', () => {
    const context: any = {
      currentUserId: 'u1',
      _pendingTaskNotificationNavigation: null,
      setView: vi.fn(),
      Monitor: { click: vi.fn() },
      window: { Monitor: true },
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction(stateSource, '_normalizeTaskNotificationNavigation'),
      extractFunction(stateSource, '_openTaskNotificationConversation'),
    ].join('\n'), context);

    expect(context._openTaskNotificationConversation({
      user_id: 'u1',
      conversation_id: '../private',
      terminal_status: 'completed',
    })).toBe(false);
    expect(context._openTaskNotificationConversation({
      user_id: 'u1',
      conversation_id: 'abc123',
      terminal_status: 'cancelled',
    })).toBe(false);
    expect(context._openTaskNotificationConversation({
      user_id: '../other-user',
      conversation_id: 'abc123',
      terminal_status: 'completed',
    })).toBe(false);
    expect(context.setView).not.toHaveBeenCalled();
  });

  it('discards a pending notification when account initialization resolves to another user', () => {
    const setView = vi.fn();
    const context: any = {
      currentUserId: '',
      _pendingTaskNotificationNavigation: null,
      setView,
      Monitor: { click: vi.fn() },
      window: { Monitor: true },
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction(stateSource, '_normalizeTaskNotificationNavigation'),
      extractFunction(stateSource, '_openTaskNotificationConversation'),
      extractFunction(stateSource, '_consumePendingTaskNotificationConversation'),
    ].join('\n'), context);

    expect(context._openTaskNotificationConversation({
      user_id: 'account-a',
      conversation_id: 'account_a_conversation',
      terminal_status: 'failed',
    })).toBe(false);

    context.currentUserId = 'account-b';
    expect(context._consumePendingTaskNotificationConversation()).toBe(false);
    expect(setView).not.toHaveBeenCalled();
    expect(context._pendingTaskNotificationNavigation).toBeNull();

    context.currentUserId = 'account-a';
    expect(context._consumePendingTaskNotificationConversation()).toBe(false);
    expect(setView).not.toHaveBeenCalled();
  });

  it('restores the saved view before consuming a pending notification click', () => {
    const restoreAt = bootSource.indexOf('_restoreLastView();');
    const consumeAt = bootSource.indexOf('_consumePendingTaskNotificationConversation();');
    const readyAt = bootSource.indexOf('_markBootReady();');
    expect(restoreAt).toBeGreaterThan(-1);
    expect(consumeAt).toBeGreaterThan(restoreAt);
    expect(readyAt).toBeGreaterThan(consumeAt);
  });

  it('does not overwrite an explicit sidebar navigation when boot restoration finishes', () => {
    const context: any = {
      _bootUserNavigated: true,
      _bootRestoreComplete: false,
      conversations: [],
      localStorage: { getItem: vi.fn(() => null) },
      setView: vi.fn(),
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(bootSource, '_restoreLastView'), context);

    context._restoreLastView();

    expect(context.setView).not.toHaveBeenCalled();
    expect(context._bootRestoreComplete).toBe(true);
  });

  it('forces one startup view-enter event when the default Commander view is already active', () => {
    const context: any = {
      _bootUserNavigated: false,
      _bootRestoreComplete: false,
      conversations: [],
      localStorage: { getItem: vi.fn(() => null) },
      setView: vi.fn(),
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(bootSource, '_restoreLastView'), context);

    context._restoreLastView();

    expect(context.setView).toHaveBeenCalledWith('new-chat', null, {
      forceEnter: true,
      entryPoint: 'startup',
    });
    expect(context._bootRestoreComplete).toBe(true);
  });

  it('marks sidebar navigation before changing the active view', () => {
    const context: any = {
      _markBootUserNavigation: vi.fn(),
      _trackNavSidebar: vi.fn(),
      setView: vi.fn(),
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(stateSource, '_setViewFromSidebar'), context);

    context._setViewFromSidebar('skills');

    expect(context._markBootUserNavigation).toHaveBeenCalledOnce();
    expect(context.setView).toHaveBeenCalledWith('skills');
  });
});
