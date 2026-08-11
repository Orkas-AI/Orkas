import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

type Listener = (event?: any) => unknown;

class FakeClassList {
  private readonly values = new Set<string>();

  add(value: string): void { this.values.add(value); }
  remove(value: string): void { this.values.delete(value); }
  toggle(value: string, force?: boolean): void {
    if (force === false) this.values.delete(value);
    else this.values.add(value);
  }
}

class FakeElement {
  id = '';
  className = '';
  readonly classList = new FakeClassList();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, Listener[]>();
  readonly children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  private html = '';

  set innerHTML(value: string) {
    this.html = value;
    this.children.length = 0;
    const actionPattern = /data-action="([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = actionPattern.exec(value))) {
      const child = new FakeElement();
      child.dataset.action = match[1];
      this.appendChild(child);
    }
  }

  get innerHTML(): string { return this.html; }

  appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(): void {}

  async click(): Promise<void> {
    for (const listener of this.listeners.get('click') || []) {
      await listener({ stopPropagation() {} });
    }
  }

  querySelectorAll(selector: string): FakeElement[] {
    return selector === '.ctx-row-menu-item' ? this.children : [];
  }

  closest(): FakeElement | null { return null; }
  contains(target: unknown): boolean { return target === this || this.children.includes(target as FakeElement); }
  getBoundingClientRect(): { left: number; right: number; top: number; bottom: number; width: number; height: number } {
    return { left: 20, right: 220, top: 20, bottom: 52, width: 200, height: 180 };
  }
}

function createHarness(options: {
  projectId?: string;
  importResult: Record<string, unknown>;
  labels?: Record<string, string>;
}) {
  const policySource = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/file-operation-policy.js'),
    'utf8',
  );
  const infoSource = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/conversation-info.js'),
    'utf8',
  );
  const elements = new Map<string, FakeElement>();
  const body = new FakeElement();
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'savedApps.inspectBundleFromPath') return { ok: true, canSave: false };
    if (channel === 'library.importProduced') return options.importResult;
    throw new Error(`unexpected channel: ${channel}`);
  });
  const uiToast = vi.fn();
  const uiAlert = vi.fn(async () => undefined);
  const monitorEvent = vi.fn();
  const labels: Record<string, string> = {
    'conversation_info.file_reveal_action': 'Show in folder',
    'conversation_info.file_add_to_chat_action': 'Add to chat',
    'conversation_info.file_add_to_library_action': 'Add to Library',
    'conversation_info.file_add_to_library_done': 'Added to {library}',
    'conversation_info.file_add_to_library_failed': 'Add to Library failed: {reason}',
    'contexts.transfer.global_library': 'Global Library',
    'contexts.transfer.project_library': 'Project Library',
    'common.delete': 'Delete',
    ...options.labels,
  };
  const context: any = {
    console,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    Date,
    Map,
    Set,
    Array,
    String,
    Number,
    RegExp,
    currentView: 'conversation',
    conversations: [{
      conversation_id: 'conversation-1',
      project_id: options.projectId || '',
    }],
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    escapeHtml: (value: unknown) => String(value ?? ''),
    t: (key: string, vars?: Record<string, unknown>) => {
      let text = labels[key] || key;
      for (const [name, value] of Object.entries(vars || {})) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
      return text;
    },
    uiToast,
    uiAlert,
    Monitor: { event: monitorEvent },
    document: {
      readyState: 'complete',
      body,
      getElementById: (id: string) => elements.get(id) || null,
      createElement: () => new FakeElement(),
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
    },
    window: {
      Monitor: true,
      innerWidth: 1200,
      innerHeight: 800,
      addEventListener() {},
      removeEventListener() {},
      orkas: { invoke },
    },
  };
  context.window.window = context.window;
  const originalAppend = body.appendChild.bind(body);
  body.appendChild = (child: FakeElement) => {
    originalAppend(child);
    if (child.id) elements.set(child.id, child);
    return child;
  };

  vm.createContext(context);
  vm.runInContext(policySource, context, { filename: 'file-operation-policy.js' });
  vm.runInContext(infoSource, context, { filename: 'conversation-info.js' });

  return {
    context,
    invoke,
    uiToast,
    uiAlert,
    monitorEvent,
    async clickAddToLibrary(filePath: string) {
      const anchor = new FakeElement();
      await context.window.ConversationInfo.openFileMenu(
        anchor,
        filePath,
        path.basename(filePath),
        { cid: 'conversation-1' },
      );
      const menu = elements.get('conversation-info-file-menu');
      const action = menu?.children.find((item) => item.dataset.action === 'add-to-library');
      expect(action, 'Add to Library action should be visible').toBeDefined();
      await action!.click();
    },
  };
}

describe('ConversationInfo produced-file Library import', () => {
  it('reports the authoritative Project Library destination after a successful import', async () => {
    const harness = createHarness({
      projectId: 'project-1',
      importResult: { ok: true, scope: 'project', projectId: 'project-1' },
    });

    await harness.clickAddToLibrary('/workspace/poster.png');

    expect(harness.invoke).toHaveBeenCalledWith('library.importProduced', {
      path: '/workspace/poster.png',
      cid: 'conversation-1',
    });
    expect(harness.uiToast).toHaveBeenCalledWith('Added to Project Library', { variant: 'success' });
    expect(harness.uiAlert).not.toHaveBeenCalled();
    expect(harness.monitorEvent).toHaveBeenCalledWith('file_preview_add_library_result', expect.objectContaining({
      result: 'success',
      surface: 'conversation_info',
      kind: 'image',
      scope: 'project',
    }));
  });

  it('uses the shipped Chinese copy to say the result was saved to Project Library', async () => {
    const zh = JSON.parse(fs.readFileSync(
      path.join(__dirname, '../../src/renderer/locales/zh.json'),
      'utf8',
    )) as Record<string, string>;
    const harness = createHarness({
      projectId: 'project-1',
      importResult: { ok: true, scope: 'project', projectId: 'project-1' },
      labels: zh,
    });

    await harness.clickAddToLibrary('/workspace/poster.png');

    expect(harness.uiToast).toHaveBeenCalledWith('已添加到项目资料库', { variant: 'success' });
  });

  it('identifies Global Library for a non-project task', async () => {
    const harness = createHarness({
      importResult: { ok: true, scope: 'global', path: 'poster.png' },
    });

    await harness.clickAddToLibrary('/workspace/poster.png');

    expect(harness.uiToast).toHaveBeenCalledWith('Added to Global Library', { variant: 'success' });
    expect(harness.uiAlert).not.toHaveBeenCalled();
  });

  it('shows a failure and never emits a success toast when the import is rejected', async () => {
    const harness = createHarness({
      projectId: 'project-1',
      importResult: { ok: false, error: 'not_found' },
    });

    await harness.clickAddToLibrary('/workspace/poster.png');

    expect(harness.uiToast).not.toHaveBeenCalled();
    expect(harness.uiAlert).toHaveBeenCalledWith('Add to Library failed: not_found');
    expect(harness.monitorEvent).toHaveBeenCalledWith('file_preview_add_library_result', expect.objectContaining({
      result: 'failure',
      surface: 'conversation_info',
      kind: 'image',
      error_type: 'operation',
      error_code: 'source_not_found',
    }));
    expect(JSON.stringify(harness.monitorEvent.mock.calls)).not.toContain('/workspace/poster.png');
  });

  it('executes the project-only video action instead of silently returning', async () => {
    const harness = createHarness({
      projectId: 'project-1',
      importResult: { ok: true, scope: 'project', projectId: 'project-1' },
    });

    await harness.clickAddToLibrary('/workspace/demo.mp4');

    expect(harness.invoke).toHaveBeenCalledWith('library.importProduced', {
      path: '/workspace/demo.mp4',
      cid: 'conversation-1',
    });
    expect(harness.uiToast).toHaveBeenCalledWith('Added to Project Library', { variant: 'success' });
  });
});
