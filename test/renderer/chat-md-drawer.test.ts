import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

type Listener = (event: any) => void;

class FakeClassList {
  values = new Set<string>();

  add(value: string): void {
    this.values.add(value);
  }

  remove(value: string): void {
    this.values.delete(value);
  }

  contains(value: string): boolean {
    return this.values.has(value);
  }
}

class FakeElement {
  hidden = true;
  textContent = '';
  innerHTML = '';
  value = '';
  selectionStart = 0;
  selectionEnd = 0;
  classList = new FakeClassList();
  listeners = new Map<string, Listener[]>();
  focused = false;
  closestResult: FakeElement | null = null;
  tagName = 'DIV';

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event: any): boolean {
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    return true;
  }

  focus(): void {
    this.focused = true;
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  closest(): FakeElement | null {
    return this.closestResult;
  }
}

class FakeDocument {
  elements = new Map<string, FakeElement>();
  listeners = new Map<string, Listener[]>();
  activeElement: FakeElement | null = null;

  constructor() {
    for (const id of [
      'chat-md-drawer-panel',
      'chat-md-drawer-title',
      'chat-md-drawer-body',
      'chat-md-drawer-actions',
      'chat-md-drawer-close',
      'chat-input',
    ]) {
      this.elements.set(id, new FakeElement());
    }
  }

  getElementById(id: string): FakeElement | null {
    return this.elements.get(id) || null;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, event: any): void {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

type DrawerExports = {
  openChatMdDrawer: (input?: {
    source?: Record<string, unknown>;
    initialMode?: string;
    title?: string;
  }) => Promise<void>;
  closeChatMdDrawer: (input?: { force?: boolean }) => Promise<void>;
  isChatMdDrawerOpen: () => boolean;
  _defaultTitle: (source: Record<string, unknown>) => string;
  _sendDraftToChatInput: (text: unknown) => boolean;
};

function loadDrawer(input: {
  mount?: ReturnType<typeof vi.fn>;
  confirm?: ReturnType<typeof vi.fn>;
} = {}) {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../src/renderer/modules/chat-md-drawer.js'),
    'utf8',
  );
  const module = { exports: {} as DrawerExports };
  const document = new FakeDocument();
  const mount = input.mount || vi.fn(() => ({ destroy: vi.fn() }));
  const confirm = input.confirm || vi.fn(async () => true);
  class FakeEvent {
    type: string;
    bubbles: boolean;

    constructor(type: string, options: { bubbles?: boolean } = {}) {
      this.type = type;
      this.bubbles = !!options.bubbles;
    }
  }
  const sandbox = {
    module,
    exports: module.exports,
    createLogger: () => ({
      debug() {},
      info() {},
      warn() {},
      error() {},
    }),
    window: {} as Record<string, unknown>,
    document,
    Event: FakeEvent,
    mountMdViewEdit: mount,
    uiConfirm: confirm,
    t: (key: string) => key,
    console,
  };
  vm.runInNewContext(source, sandbox, { filename: 'chat-md-drawer.js' });
  return {
    drawer: module.exports,
    document,
    mount,
    confirm,
  };
}

describe('chat Markdown drawer', () => {
  it('treats a missing open payload as a safe no-op', async () => {
    const { drawer, mount } = loadDrawer();

    await expect(drawer.openChatMdDrawer()).resolves.toBeUndefined();

    expect(drawer.isChatMdDrawerOpen()).toBe(false);
    expect(mount).not.toHaveBeenCalled();
  });

  it('keeps a dirty drawer open when discard is rejected, then tears it down once accepted', async () => {
    const controller = { destroy: vi.fn() };
    const confirm = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { drawer, document, mount } = loadDrawer({
      mount: vi.fn(() => controller),
      confirm,
    });
    await drawer.openChatMdDrawer({
      source: { kind: 'ephemeral', initialText: '# draft' },
    });
    const callbacks = mount.mock.calls[0][0].callbacks;
    callbacks.onDirtyChange(true);

    await drawer.closeChatMdDrawer();
    expect(drawer.isChatMdDrawerOpen()).toBe(true);
    expect(controller.destroy).not.toHaveBeenCalled();

    await drawer.closeChatMdDrawer();
    expect(drawer.isChatMdDrawerOpen()).toBe(false);
    expect(controller.destroy).toHaveBeenCalledTimes(1);
    expect(document.getElementById('chat-md-drawer-panel')?.hidden).toBe(true);
  });

  it('does not insert or report success for an empty draft', () => {
    const { drawer, document } = loadDrawer();
    const chatInput = document.getElementById('chat-input')!;
    chatInput.value = 'existing';
    const inputListener = vi.fn();
    chatInput.addEventListener('input', inputListener);

    expect(drawer._sendDraftToChatInput(' \n\t ')).toBe(false);

    expect(chatInput.value).toBe('existing');
    expect(inputListener).not.toHaveBeenCalled();
    expect(chatInput.focused).toBe(false);
  });

  it('appends a real draft without smashing existing input and moves the caret', () => {
    const { drawer, document } = loadDrawer();
    const chatInput = document.getElementById('chat-input')!;
    chatInput.value = 'existing';
    const inputListener = vi.fn();
    chatInput.addEventListener('input', inputListener);

    expect(drawer._sendDraftToChatInput('# next')).toBe(true);

    expect(chatInput.value).toBe('existing\n# next');
    expect(inputListener).toHaveBeenCalledTimes(1);
    expect(chatInput.focused).toBe(true);
    expect(chatInput.selectionStart).toBe(chatInput.value.length);
    expect(chatInput.selectionEnd).toBe(chatInput.value.length);
  });

  it('fails closed when the editor cannot mount', async () => {
    const { drawer, document } = loadDrawer({
      mount: vi.fn(() => {
        throw new Error('mount failed');
      }),
    });

    await expect(drawer.openChatMdDrawer({
      source: { kind: 'workspace', absPath: '/workspace/note.md' },
    })).resolves.toBeUndefined();

    expect(drawer.isChatMdDrawerOpen()).toBe(false);
    expect(document.getElementById('chat-md-drawer-panel')?.hidden).toBe(true);
    expect(document.getElementById('chat-md-drawer-panel')?.classList.contains('is-open')).toBe(false);
  });

  it('ignores Escape during IME composition', async () => {
    const { drawer, document } = loadDrawer();
    await drawer.openChatMdDrawer({
      source: { kind: 'ephemeral', initialText: '输入中' },
    });

    document.dispatch('keydown', {
      key: 'Escape',
      keyCode: 229,
      isComposing: true,
    });

    expect(drawer.isChatMdDrawerOpen()).toBe(true);
  });
});
