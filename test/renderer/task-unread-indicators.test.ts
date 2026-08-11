import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const unreadSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/task-unread.js'),
  'utf8',
);

function makeTaskItem(cid: string) {
  let unreadDot: any = null;
  let hasUnreadClass = false;
  const title = { kind: 'title' };
  const children: any[] = [title];
  Object.defineProperty(title, 'nextSibling', {
    get: () => children[children.indexOf(title) + 1] || null,
  });
  const row: any = {
    firstChild: title,
    querySelector(selector: string) {
      if (selector.includes('task-unread-dot')) return unreadDot;
      if (selector.includes('conv-item-title')) return title;
      return null;
    },
    insertBefore(node: any, reference: any) {
      unreadDot = node;
      const index = reference ? children.indexOf(reference) : children.length;
      children.splice(index < 0 ? children.length : index, 0, node);
      node.remove = () => {
        if (unreadDot === node) {
          unreadDot = null;
          const nodeIndex = children.indexOf(node);
          if (nodeIndex >= 0) children.splice(nodeIndex, 1);
        }
      };
    },
  };
  return {
    dataset: { cid },
    classList: {
      toggle(_name: string, enabled: boolean) { hasUnreadClass = enabled; },
    },
    querySelector(selector: string) {
      return selector.includes('conv-item-row') ? row : null;
    },
    __hasUnreadDot: () => !!unreadDot,
    __hasUnreadClass: () => hasUnreadClass,
    __dotIsAfterTitle: () => children.indexOf(unreadDot) === children.indexOf(title) + 1,
  };
}

function loadUnreadRenderer(
  persisted = new Map<string, string>(),
  options: {
    focused?: boolean;
    loadConversations?: (context: any) => void | Promise<void>;
  } = {},
) {
  let focused = options.focused !== false;
  const dots: Record<string, any> = {
    'tasks-unread-dot': { hidden: true },
    'projects-unread-dot': { hidden: true },
  };
  const projectDots = new Map(['p1', 'p2'].map((projectId) => [projectId, {
    hidden: true,
    dataset: { projectUnreadDot: projectId },
  }]));
  const taskItems: any[] = [];
  const contentTaskItems: any[] = [];
  const context: any = {
    console,
    setTimeout,
    clearTimeout,
    currentUserId: 'u1',
    currentView: 'new-chat',
    currentCid: null,
    conversations: [],
    _projectDetailPid: 'p1',
    localStorage: {
      getItem: (key: string) => persisted.get(key) ?? null,
      setItem: (key: string, value: string) => { persisted.set(key, value); },
      removeItem: (key: string) => { persisted.delete(key); },
    },
    document: {
      visibilityState: 'visible',
      hasFocus: () => focused,
      addEventListener: vi.fn(),
      createElement: vi.fn(() => ({
        className: '',
        setAttribute() {},
        remove() {},
      })),
      getElementById: (id: string) => dots[id] || null,
      querySelectorAll: (selector: string) => {
        if (selector === '[data-project-unread-dot]') return Array.from(projectDots.values());
        if (selector === '.sidebar-conversation-nav .conv-item[data-cid]') return taskItems;
        if (selector === '.conv-item[data-cid]') return [...taskItems, ...contentTaskItems];
        return [];
      },
    },
    window: {
      addEventListener: vi.fn(),
    },
  };
  context.window.window = context.window;
  context.__dots = dots;
  context.__projectDot = projectDots.get('p1');
  context.__projectDots = projectDots;
  context.__addTaskItem = (cid: string) => {
    const item = makeTaskItem(cid);
    taskItems.push(item);
    return item;
  };
  context.__addContentTaskItem = (cid: string) => {
    const item = makeTaskItem(cid);
    contentTaskItems.push(item);
    return item;
  };
  context.__setFocused = (value: boolean) => { focused = value; };
  if (options.loadConversations) {
    context.loadConversations = () => options.loadConversations!(context);
  }
  vm.createContext(context);
  vm.runInContext(unreadSource, context);
  return context;
}

describe('unread task reply indicators', () => {
  it('persists per-task state and aggregates global and project dots', () => {
    const persisted = new Map<string, string>();
    const context = loadUnreadRenderer(persisted);
    context.conversations.push(
      { conversation_id: 'global-task', project_id: '' },
      { conversation_id: 'project-task', project_id: 'p1' },
    );

    expect(context._handleTaskTerminalUnread({
      type: 'terminal',
      conversation_id: 'global-task',
      status: 'completed',
      finished_at_ms: 100,
    })).toBe(true);
    expect(context._handleTaskTerminalUnread({
      type: 'terminal',
      conversation_id: 'project-task',
      status: 'failed',
      finished_at_ms: 200,
    })).toBe(true);

    expect(context._isConversationUnread('global-task')).toBe(true);
    expect(context._isConversationUnread('project-task')).toBe(true);
    expect(context.__dots['tasks-unread-dot'].hidden).toBe(false);
    expect(context.__dots['projects-unread-dot'].hidden).toBe(false);
    expect(context.__projectDot.hidden).toBe(false);

    context._markConversationRead('project-task', { readAt: 250 });
    expect(context._isConversationUnread('project-task')).toBe(false);
    expect(context.__projectDot.hidden).toBe(true);
    expect(context.__dots['projects-unread-dot'].hidden).toBe(true);
    expect(context.__dots['tasks-unread-dot'].hidden).toBe(false);

    const restored = loadUnreadRenderer(persisted);
    restored.conversations.push(
      { conversation_id: 'global-task', project_id: '' },
      { conversation_id: 'project-task', project_id: 'p1' },
    );
    restored._restoreUnreadTaskState();
    expect(restored._isConversationUnread('global-task')).toBe(true);
    expect(restored._isConversationUnread('project-task')).toBe(false);
  });

  it('keeps the global Tasks parent dot until every unread child task is viewed', () => {
    const context = loadUnreadRenderer();
    context.conversations.push(
      { conversation_id: 'global-a', project_id: '' },
      { conversation_id: 'global-b', project_id: '' },
    );
    const rowA = context.__addTaskItem('global-a');
    const rowB = context.__addTaskItem('global-b');

    context._markConversationUnread('global-a', { finishedAt: 100 });
    context._markConversationUnread('global-b', { finishedAt: 200 });
    expect(rowA.__hasUnreadDot()).toBe(true);
    expect(rowB.__hasUnreadDot()).toBe(true);
    expect(context.__dots['tasks-unread-dot'].hidden).toBe(false);

    context._markConversationRead('global-a', { readAt: 250 });
    expect(rowA.__hasUnreadDot()).toBe(false);
    expect(rowB.__hasUnreadDot()).toBe(true);
    expect(context.__dots['tasks-unread-dot'].hidden).toBe(false);

    context._markConversationRead('global-b', { readAt: 300 });
    expect(rowB.__hasUnreadDot()).toBe(false);
    expect(context.__dots['tasks-unread-dot'].hidden).toBe(true);
  });

  it('keeps each Project parent and the Projects root lit while any descendant remains unread', () => {
    const context = loadUnreadRenderer();
    context.conversations.push(
      { conversation_id: 'p1-a', project_id: 'p1' },
      { conversation_id: 'p1-b', project_id: 'p1' },
      { conversation_id: 'p2-a', project_id: 'p2' },
    );
    context._markConversationUnread('p1-a', { finishedAt: 100 });
    context._markConversationUnread('p1-b', { finishedAt: 200 });
    context._markConversationUnread('p2-a', { finishedAt: 300 });

    expect(context.__projectDots.get('p1').hidden).toBe(false);
    expect(context.__projectDots.get('p2').hidden).toBe(false);
    expect(context.__dots['projects-unread-dot'].hidden).toBe(false);

    // Reading one of two p1 children must not clear its sidebar project or
    // the sidebar Projects root.
    context._markConversationRead('p1-a', { readAt: 350 });
    expect(context.__projectDots.get('p1').hidden).toBe(false);
    expect(context.__dots['projects-unread-dot'].hidden).toBe(false);

    // Once p1 is exhausted, only p1-specific indicators clear. p2 keeps the
    // Projects root lit.
    context._markConversationRead('p1-b', { readAt: 400 });
    expect(context.__projectDots.get('p1').hidden).toBe(true);
    expect(context.__projectDots.get('p2').hidden).toBe(false);
    expect(context.__dots['projects-unread-dot'].hidden).toBe(false);

    context._refreshUnreadTaskIndicators('p2');
    expect(context.__projectDots.get('p2').hidden).toBe(false);

    context._markConversationRead('p2-a', { readAt: 450 });
    expect(context.__projectDots.get('p2').hidden).toBe(true);
    expect(context.__dots['projects-unread-dot'].hidden).toBe(true);
  });

  it('updates every sidebar copy but never adds dots to content task lists', () => {
    const context = loadUnreadRenderer();
    context.conversations.push(
      { conversation_id: 'c1', project_id: 'p1' },
      { conversation_id: 'c2', project_id: 'p1' },
    );
    const sidebarCopy = context.__addTaskItem('c1');
    const expandedProjectSidebarCopy = context.__addTaskItem('c1');
    const contentCopy = context.__addContentTaskItem('c1');
    const sibling = context.__addTaskItem('c2');

    context._markConversationUnread('c1', { finishedAt: 100 });
    context._markConversationUnread('c2', { finishedAt: 200 });
    expect(sidebarCopy.__hasUnreadDot()).toBe(true);
    expect(sidebarCopy.__dotIsAfterTitle()).toBe(true);
    expect(expandedProjectSidebarCopy.__hasUnreadDot()).toBe(true);
    expect(expandedProjectSidebarCopy.__dotIsAfterTitle()).toBe(true);
    expect(contentCopy.__hasUnreadDot()).toBe(false);
    expect(sibling.__hasUnreadDot()).toBe(true);

    context._markConversationRead('c1', { readAt: 250 });
    expect(sidebarCopy.__hasUnreadDot()).toBe(false);
    expect(expandedProjectSidebarCopy.__hasUnreadDot()).toBe(false);
    expect(contentCopy.__hasUnreadDot()).toBe(false);
    expect(sibling.__hasUnreadDot()).toBe(true);
    expect(context.__projectDots.get('p1').hidden).toBe(false);
  });

  it('moves aggregate attention when an unread task changes project scope', () => {
    const context = loadUnreadRenderer();
    const conversation = { conversation_id: 'moving-task', project_id: 'p1' };
    context.conversations.push(conversation);
    context._markConversationUnread('moving-task', { finishedAt: 100 });
    expect(context.__projectDots.get('p1').hidden).toBe(false);
    expect(context.__projectDots.get('p2').hidden).toBe(true);

    conversation.project_id = 'p2';
    context._refreshUnreadTaskIndicators('p2');
    expect(context.__projectDots.get('p1').hidden).toBe(true);
    expect(context.__projectDots.get('p2').hidden).toBe(false);
    expect(context.__dots['projects-unread-dot'].hidden).toBe(false);
  });

  it('resolves an initially unknown task into the correct parent without losing unread state', async () => {
    const context = loadUnreadRenderer();
    context.loadConversations = vi.fn(async () => {
      context.conversations.push({ conversation_id: 'late-task', project_id: 'p1' });
    });

    context._markConversationUnread('late-task', { finishedAt: 100 });
    expect(context._isConversationUnread('late-task')).toBe(true);
    expect(context.__projectDots.get('p1').hidden).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(context.loadConversations).toHaveBeenCalledOnce();
    expect(context.loadConversations).toHaveBeenCalledWith({ full: true });
    expect(context._isConversationUnread('late-task')).toBe(true);
    expect(context.__projectDots.get('p1').hidden).toBe(false);
    expect(context.__dots['projects-unread-dot'].hidden).toBe(false);
  });

  it('does not mark every task in a project read merely by opening the project page', () => {
    const context = loadUnreadRenderer();
    context.conversations.push(
      { conversation_id: 'p1-a', project_id: 'p1' },
      { conversation_id: 'p1-b', project_id: 'p1' },
    );
    context._markConversationUnread('p1-a', { finishedAt: 100 });
    context._markConversationUnread('p1-b', { finishedAt: 200 });

    context.currentView = 'project';
    context.currentCid = null;
    context._refreshUnreadTaskIndicators('p1');
    context._acknowledgeVisibleUnreadTask();

    expect(context._isConversationUnread('p1-a')).toBe(true);
    expect(context._isConversationUnread('p1-b')).toBe(true);
    expect(context.__projectDots.get('p1').hidden).toBe(false);
    expect(context.__dots['projects-unread-dot'].hidden).toBe(false);
  });

  it('keeps account state isolated and reconciles persisted read watermarks', () => {
    const persisted = new Map<string, string>();
    const context = loadUnreadRenderer(persisted);
    context.conversations.push({ conversation_id: 'u1-task', project_id: '' });
    context._markConversationUnread('u1-task', { finishedAt: 100 });

    context.currentUserId = 'u2';
    context._restoreUnreadTaskState();
    expect(context._isConversationUnread('u1-task')).toBe(false);
    context.conversations.splice(0, context.conversations.length,
      { conversation_id: 'u2-task', project_id: '' });
    context._markConversationUnread('u2-task', { finishedAt: 200 });

    context.currentUserId = 'u1';
    context.conversations.splice(0, context.conversations.length,
      { conversation_id: 'u1-task', project_id: '' });
    context._restoreUnreadTaskState();
    expect(context._isConversationUnread('u1-task')).toBe(true);
    expect(context._isConversationUnread('u2-task')).toBe(false);

    persisted.set('task_unread_v1_u3', JSON.stringify({
      unread: [
        { cid: 'old-reply', projectId: '', finishedAt: 100 },
        { cid: 'new-reply', projectId: '', finishedAt: 300 },
      ],
      read: [
        { cid: 'old-reply', readAt: 200 },
        { cid: 'new-reply', readAt: 200 },
      ],
    }));
    context.currentUserId = 'u3';
    context.conversations.splice(0, context.conversations.length,
      { conversation_id: 'old-reply', project_id: '' },
      { conversation_id: 'new-reply', project_id: '' });
    context._restoreUnreadTaskState();
    expect(context._isConversationUnread('old-reply')).toBe(false);
    expect(context._isConversationUnread('new-reply')).toBe(true);

    persisted.set('task_unread_v1_u4', JSON.stringify(['legacy-task']));
    context.currentUserId = 'u4';
    context.conversations.splice(0, context.conversations.length,
      { conversation_id: 'legacy-task', project_id: '' });
    context._restoreUnreadTaskState();
    expect(context._isConversationUnread('legacy-task')).toBe(true);
  });

  it('does not mark the focused open task, but marks it while the app is in the background', () => {
    const context = loadUnreadRenderer();
    context.currentView = 'conversation';
    context.currentCid = 'c1';
    context.conversations.push({ conversation_id: 'c1', project_id: '' });

    expect(context._handleTaskTerminalUnread({
      type: 'terminal',
      conversation_id: 'c1',
      status: 'completed',
      finished_at_ms: 100,
    })).toBe(false);
    expect(context._isConversationUnread('c1')).toBe(false);

    context.__setFocused(false);
    expect(context._handleTaskTerminalUnread({
      type: 'terminal',
      conversation_id: 'c1',
      status: 'waiting_input',
      finished_at_ms: 200,
    })).toBe(true);
    expect(context._isConversationUnread('c1')).toBe(true);

    context.__setFocused(true);
    context._acknowledgeVisibleUnreadTask();
    expect(context._isConversationUnread('c1')).toBe(false);
  });

  it('ignores cancelled runs and stale terminal replays older than the read boundary', () => {
    const context = loadUnreadRenderer();
    context.conversations.push({ conversation_id: 'c1', project_id: '' });

    expect(context._handleTaskTerminalUnread({
      type: 'terminal',
      conversation_id: 'c1',
      status: 'cancelled',
      finished_at_ms: 100,
    })).toBe(false);
    context._markConversationRead('c1', { readAt: 300 });
    expect(context._handleTaskTerminalUnread({
      type: 'terminal',
      conversation_id: 'c1',
      status: 'completed',
      finished_at_ms: 200,
    })).toBe(false);
    expect(context._isConversationUnread('c1')).toBe(false);

    // A truly newer reply for the same task must reopen the unread state.
    expect(context._handleTaskTerminalUnread({
      type: 'terminal',
      conversation_id: 'c1',
      status: 'completed',
      finished_at_ms: 400,
    })).toBe(true);
    expect(context._isConversationUnread('c1')).toBe(true);
    expect(context.__dots['tasks-unread-dot'].hidden).toBe(false);
  });

  it('keeps parent indicators when one unread child is deleted', () => {
    const context = loadUnreadRenderer();
    context.conversations.push(
      { conversation_id: 'p1-a', project_id: 'p1' },
      { conversation_id: 'p1-b', project_id: 'p1' },
      { conversation_id: 'p2-a', project_id: 'p2' },
    );
    context._markConversationUnread('p1-a', { finishedAt: 100 });
    context._markConversationUnread('p1-b', { finishedAt: 200 });
    context._markConversationUnread('p2-a', { finishedAt: 300 });

    context._forgetUnreadConversation('p1-a');
    expect(context.__projectDots.get('p1').hidden).toBe(false);
    expect(context.__dots['projects-unread-dot'].hidden).toBe(false);

    context._forgetUnreadProject('p1');
    expect(context.__projectDots.get('p1').hidden).toBe(true);
    expect(context.__projectDots.get('p2').hidden).toBe(false);
    expect(context.__dots['projects-unread-dot'].hidden).toBe(false);
  });

  it('preserves the read boundary across relaunch and accepts only a newer terminal', () => {
    const persisted = new Map<string, string>();
    const context = loadUnreadRenderer(persisted);
    context.conversations.push({ conversation_id: 'c1', project_id: '' });
    context._handleTaskTerminalUnread({
      type: 'terminal',
      conversation_id: 'c1',
      status: 'completed',
      finished_at_ms: 100,
    });
    context._markConversationRead('c1', { readAt: 150 });

    const restored = loadUnreadRenderer(persisted);
    restored.conversations.push({ conversation_id: 'c1', project_id: '' });
    restored._restoreUnreadTaskState();

    expect(restored._handleTaskTerminalUnread({
      type: 'terminal',
      conversation_id: 'c1',
      status: 'failed',
      finished_at_ms: 120,
    })).toBe(false);
    expect(restored._isConversationUnread('c1')).toBe(false);

    expect(restored._handleTaskTerminalUnread({
      type: 'terminal',
      conversation_id: 'c1',
      status: 'failed',
      finished_at_ms: 200,
    })).toBe(true);
    expect(restored._isConversationUnread('c1')).toBe(true);
  });

  it('keeps unread state isolated when users switch and later return', () => {
    const persisted = new Map<string, string>();
    const context = loadUnreadRenderer(persisted);
    context.conversations.push({ conversation_id: 'task-a', project_id: '' });
    context._handleTaskTerminalUnread({
      type: 'terminal',
      conversation_id: 'task-a',
      status: 'completed',
      finished_at_ms: 100,
    });

    context.currentUserId = 'u2';
    context.conversations.splice(0, context.conversations.length, {
      conversation_id: 'task-b',
      project_id: '',
    });
    expect(context._isConversationUnread('task-a')).toBe(false);
    context._handleTaskTerminalUnread({
      type: 'terminal',
      conversation_id: 'task-b',
      status: 'waiting_input',
      finished_at_ms: 200,
    });
    expect(context._isConversationUnread('task-b')).toBe(true);

    context.currentUserId = 'u1';
    context.conversations.splice(0, context.conversations.length, {
      conversation_id: 'task-a',
      project_id: '',
    });
    expect(context._isConversationUnread('task-a')).toBe(true);
    expect(context._isConversationUnread('task-b')).toBe(false);
  });

  it('assigns an early terminal to its project after conversation scope loads', async () => {
    const context = loadUnreadRenderer(new Map(), {
      loadConversations: async (runtime) => {
        runtime.conversations.push({ conversation_id: 'late-task', project_id: 'p1' });
      },
    });

    expect(context._handleTaskTerminalUnread({
      type: 'terminal',
      conversation_id: 'late-task',
      status: 'completed',
      finished_at_ms: 100,
    })).toBe(true);
    expect(context._isConversationUnread('late-task')).toBe(true);
    expect(context.__projectDot.hidden).toBe(true);

    await vi.waitFor(() => {
      expect(context._taskUnreadProjectCount('p1')).toBe(1);
      expect(context.__projectDot.hidden).toBe(false);
    });
  });

  it('ships small red right-of-copy mounts only on sidebar surfaces', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
    const projects = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/projects.js'),
      'utf8',
    );
    const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');

    expect(html).toContain('id="tasks-unread-dot"');
    expect(html).toContain('id="projects-unread-dot"');
    expect(html).not.toContain('id="project-detail-unread-dot"');
    expect(html).not.toContain('id="project-tasks-unread-dot"');
    expect(projects).toContain('data-project-unread-dot=');
    expect(projects).toMatch(/project-name-unread-group[\s\S]*\$\{nameNode\}[\s\S]*\$\{unreadDot\}/);
    expect(css).toContain('.task-unread-dot');
    const dotBlock = css.match(/\.task-unread-dot\s*\{[\s\S]*?\}/)?.[0] || '';
    expect(dotBlock).toContain('width: 4px');
    expect(dotBlock).toContain('height: 4px');
    expect(dotBlock).toContain('background: var(--danger)');
    expect(dotBlock).not.toContain('box-shadow');
    expect(unreadSource).toContain(".sidebar-conversation-nav .conv-item[data-cid]");
    expect(unreadSource).not.toContain("querySelectorAll('.conv-item[data-cid]')");
  });
});
