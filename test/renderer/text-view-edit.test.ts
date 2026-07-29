import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

type TextEditorExports = {
  _tveOnKey: (state: any, textarea: FakeTextarea, event: any) => void;
  _tveSave: (state: any) => Promise<void>;
};

class FakeTextarea {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  disabled = false;

  constructor(value: string) {
    this.value = value;
    this.selectionStart = value.length;
    this.selectionEnd = value.length;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function loadTextEditor(input: {
  invoke?: ReturnType<typeof vi.fn>;
  alert?: ReturnType<typeof vi.fn>;
} = {}): TextEditorExports {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../src/renderer/modules/text-view-edit.js'),
    'utf8',
  );
  const module = { exports: {} as TextEditorExports };
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
      orkas: {
        invoke: input.invoke || vi.fn(async () => ({ ok: true })),
      },
      uiIconHtml: () => '',
    },
    uiAlert: input.alert || vi.fn(async () => undefined),
    t: (key: string) => key,
    escapeHtml: (value: unknown) => String(value),
    console,
  };
  vm.runInNewContext(source, sandbox, { filename: 'text-view-edit.js' });
  return module.exports;
}

function editorState(content: string, draft = content) {
  const textarea = new FakeTextarea(draft);
  const saveButton = { disabled: false };
  const cancelButton = { disabled: false };
  return {
    textarea,
    saveButton,
    cancelButton,
    state: {
      source: { absPath: '/workspace/config.json', cid: 'cid-1' },
      caps: { edit: true, save: true },
      callbacks: {
        onDirtyChange: vi.fn(),
        onSaved: vi.fn(),
      },
      bodyEl: {
        innerHTML: '',
        querySelector: (selector: string) => (
          selector === '[data-tve-textarea]' ? textarea : null
        ),
      },
      actionsEl: {
        innerHTML: '',
        querySelector: () => null,
        querySelectorAll: (selector: string) => (
          selector.includes('data-tve-action') ? [saveButton, cancelButton] : []
        ),
      },
      actionIconOnly: true,
      content,
      draft,
      mode: 'edit',
      destroyed: false,
      saving: false,
    },
  };
}

describe('plain-text view/edit behavior', () => {
  it('does not insert Tab or consume the key while IME composition is active', () => {
    const editor = loadTextEditor();
    const { state, textarea } = editorState('正在输入');
    const preventDefault = vi.fn();

    editor._tveOnKey(state, textarea, {
      key: 'Tab',
      isComposing: true,
      keyCode: 229,
      preventDefault,
    });

    expect(textarea.value).toBe('正在输入');
    expect(state.draft).toBe('正在输入');
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('inserts one Tab at the current selection outside IME composition', () => {
    const editor = loadTextEditor();
    const { state, textarea } = editorState('ab');
    textarea.selectionStart = textarea.selectionEnd = 1;
    const preventDefault = vi.fn();

    editor._tveOnKey(state, textarea, {
      key: 'Tab',
      isComposing: false,
      keyCode: 9,
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe('a\tb');
    expect(state.draft).toBe('a\tb');
  });

  it('single-flights Save and locks mutable controls until completion', async () => {
    const gate = deferred<{ ok: boolean }>();
    const invoke = vi.fn(() => gate.promise);
    const editor = loadTextEditor({ invoke });
    const { state, textarea, saveButton, cancelButton } = editorState(
      '{"before":true}',
      '{"current":true}',
    );

    const first = editor._tveSave(state);
    const second = editor._tveSave(state);
    const disabledWhilePending = {
      textarea: textarea.disabled,
      save: saveButton.disabled,
      cancel: cancelButton.disabled,
    };
    gate.resolve({ ok: true });
    await Promise.all([first, second]);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('produced.writeText', {
      path: '/workspace/config.json',
      cid: 'cid-1',
      content: '{"current":true}',
    });
    expect(disabledWhilePending).toEqual({
      textarea: true,
      save: true,
      cancel: true,
    });
    expect(state.content).toBe('{"current":true}');
    expect(state.saving).toBe(false);
    expect(state.callbacks.onSaved).toHaveBeenCalledWith('{"current":true}');
  });

  it('keeps a failed draft editable and does not report it as saved', async () => {
    const invoke = vi.fn(async () => ({ ok: false, error: 'write_denied' }));
    const alert = vi.fn(async () => undefined);
    const editor = loadTextEditor({ invoke, alert });
    const { state, textarea, saveButton, cancelButton } = editorState(
      'before',
      'unsaved',
    );

    await editor._tveSave(state);

    expect(state.mode).toBe('edit');
    expect(state.content).toBe('before');
    expect(state.draft).toBe('unsaved');
    expect(textarea.disabled).toBe(false);
    expect(saveButton.disabled).toBe(false);
    expect(cancelButton.disabled).toBe(false);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(state.callbacks.onSaved).not.toHaveBeenCalled();
  });
});
