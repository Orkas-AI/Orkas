import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

type MarkdownEditorExports = {
  _mveApplyMd: (state: any, textarea: FakeTextarea, kind: string) => void;
  _mveEnterEdit: (state: any) => void;
  _mveOnKey: (state: any, textarea: FakeTextarea, event: any) => void;
  _mveSave: (state: any) => Promise<void>;
  _mveScanTaskLines: (content: string) => Array<{ lineIdx: number; checked: boolean }>;
  _mveWriteSource: (source: Record<string, unknown>, content: string) => Promise<Record<string, unknown>>;
};

class FakeTextarea {
  value: string;
  selectionStart = 0;
  selectionEnd = 0;
  disabled = false;

  constructor(value: string) {
    this.value = value;
    this.selectionEnd = value.length;
  }

  setRangeText(replacement: string, start: number, end: number): void {
    this.value = `${this.value.slice(0, start)}${replacement}${this.value.slice(end)}`;
  }

  addEventListener(): void {}
  focus(): void {}
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function loadMarkdownEditor(input: {
  invoke?: ReturnType<typeof vi.fn>;
  apiFetch?: ReturnType<typeof vi.fn>;
  alert?: ReturnType<typeof vi.fn>;
} = {}): MarkdownEditorExports {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../src/renderer/modules/md-view-edit.js'),
    'utf8',
  );
  const module = { exports: {} as MarkdownEditorExports };
  const invoke = input.invoke || vi.fn(async () => ({ ok: true }));
  const apiFetch = input.apiFetch || vi.fn(async () => ({
    json: async () => ({ ok: true }),
  }));
  const alert = input.alert || vi.fn(async () => undefined);
  const sandbox = {
    module,
    exports: module.exports,
    createLogger: () => ({
      debug() {},
      info() {},
      warn() {},
      error() {},
    }),
    window: {
      orkas: { invoke },
      uiIconHtml: () => '',
    },
    navigator: {
      clipboard: { writeText: vi.fn(async () => undefined) },
    },
    apiFetch,
    uiAlert: alert,
    t: (key: string) => key,
    escapeHtml: (value: unknown) => String(value),
    renderMarkdown: (value: unknown) => `<p>${String(value)}</p>`,
    console,
  };
  vm.runInNewContext(source, sandbox, { filename: 'md-view-edit.js' });
  return module.exports;
}

function editorState(content: string, draft = content) {
  const textarea = new FakeTextarea(draft);
  const saveButton = { disabled: false };
  const cancelButton = { disabled: false };
  const bodyEl = {
    innerHTML: '',
    querySelector: (selector: string) => (
      selector === '[data-mve-textarea]' ? textarea : null
    ),
    querySelectorAll: () => [],
  };
  const actionsEl = {
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll: (selector: string) => (
      selector.includes('data-mve-action') ? [saveButton, cancelButton] : []
    ),
  };
  return {
    textarea,
    saveButton,
    cancelButton,
    state: {
      source: { kind: 'workspace', absPath: '/workspace/note.md', cid: 'cid-1' },
      caps: {
        edit: true,
        save: true,
        delete: false,
        reveal: false,
        taskCheckbox: false,
      },
      callbacks: {
        onDirtyChange: vi.fn(),
        onDraftChange: vi.fn(),
        onSaved: vi.fn(),
      },
      bodyEl,
      actionsEl,
      actionIconOnly: true,
      content,
      draft,
      mode: 'edit',
      preview: false,
      destroyed: false,
      saving: false,
    },
  };
}

describe('Markdown view/edit behavior', () => {
  it('toggles a normally numbered multi-line list off instead of nesting it', () => {
    const editor = loadMarkdownEditor();
    const { state, textarea } = editorState('1. alpha\n2. beta');
    textarea.selectionStart = 0;
    textarea.selectionEnd = textarea.value.length;

    editor._mveApplyMd(state, textarea, 'ol');

    expect(textarea.value).toBe('alpha\nbeta');
    expect(state.draft).toBe('alpha\nbeta');
  });

  it('does not mutate or consume keyboard shortcuts during IME composition', () => {
    const editor = loadMarkdownEditor();
    const { state, textarea } = editorState('草稿');
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
    const preventDefault = vi.fn();

    editor._mveOnKey(state, textarea, {
      key: 'Tab',
      isComposing: true,
      keyCode: 229,
      preventDefault,
    });

    expect(textarea.value).toBe('草稿');
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('keeps a read-only mount out of edit mode even through the controller API', () => {
    const editor = loadMarkdownEditor();
    const { state } = editorState('# Locked');
    state.mode = 'view';
    state.caps.edit = false;

    editor._mveEnterEdit(state);

    expect(state.mode).toBe('view');
  });

  it('single-flights Save and locks mutable controls until the write settles', async () => {
    const gate = deferred<{ ok: boolean }>();
    const invoke = vi.fn(() => gate.promise);
    const editor = loadMarkdownEditor({ invoke });
    const { state, textarea, saveButton, cancelButton } = editorState(
      '# Before',
      '# Current draft',
    );
    textarea.value = '# Current draft';

    const first = editor._mveSave(state);
    const second = editor._mveSave(state);
    const disabledWhilePending = {
      textarea: textarea.disabled,
      save: saveButton.disabled,
      cancel: cancelButton.disabled,
    };
    gate.resolve({ ok: true });
    await Promise.all([first, second]);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('produced.writeText', {
      path: '/workspace/note.md',
      cid: 'cid-1',
      content: '# Current draft',
    });
    expect(disabledWhilePending).toEqual({
      textarea: true,
      save: true,
      cancel: true,
    });
    expect(state.content).toBe('# Current draft');
    expect(state.saving).toBe(false);
    expect(state.callbacks.onSaved).toHaveBeenCalledWith('# Current draft');
  });

  it('keeps the draft editable when Save fails', async () => {
    const invoke = vi.fn(async () => ({ ok: false, error: 'disk_full' }));
    const alert = vi.fn(async () => undefined);
    const editor = loadMarkdownEditor({ invoke, alert });
    const { state, textarea, saveButton, cancelButton } = editorState(
      '# Before',
      '# Unsaved draft',
    );

    await editor._mveSave(state);

    expect(state.mode).toBe('edit');
    expect(state.content).toBe('# Before');
    expect(state.draft).toBe('# Unsaved draft');
    expect(textarea.disabled).toBe(false);
    expect(saveButton.disabled).toBe(false);
    expect(cancelButton.disabled).toBe(false);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(state.callbacks.onSaved).not.toHaveBeenCalled();
  });

  it('preserves the owning scope in workspace writes and refuses ephemeral persistence', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const editor = loadMarkdownEditor({ invoke });

    await expect(editor._mveWriteSource({
      kind: 'workspace',
      absPath: '/workspace/note.md',
      cid: 'cid-1',
      projectId: 'project-1',
    }, 'updated')).resolves.toEqual({ ok: true });
    await expect(editor._mveWriteSource({
      kind: 'ephemeral',
      initialText: 'scratch',
    }, 'updated')).resolves.toEqual({
      ok: false,
      error: 'source is not writable',
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('produced.writeText', {
      path: '/workspace/note.md',
      cid: 'cid-1',
      projectId: 'project-1',
      content: 'updated',
    });
  });

  it('maps only rendered Markdown task lines and ignores code-fence look-alikes', () => {
    const editor = loadMarkdownEditor();

    expect(editor._mveScanTaskLines([
      '- [ ] pending',
      '  - [X] nested done',
      '- ordinary bullet',
      '```',
      '- [ ] code-looking task',
      '```',
    ].join('\n'))).toEqual([
      { lineIdx: 0, checked: false },
      { lineIdx: 1, checked: true },
    ]);
  });
});
