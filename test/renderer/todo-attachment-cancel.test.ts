import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { composerAccessorSource } from './composer-test-source';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/project-detail.js'), 'utf8');
const { _arrayBufferToBase64 } = require('../../src/renderer/modules/utils.js');

// Real renderer actions with a disk-backed IPC fixture: cancellation must preserve
// bytes, not merely repaint the attachment chip. Main storage has its own suite.
function editorFixture(pid: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cancel-'));
  for (const name of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(dir, name), `original ${name}`);
  const editor = { hidden: true };
  const input = { value: '', dataset: {}, focus() {}, setSelectionRange() {} };
  const chips = { innerHTML: '', hidden: true, querySelectorAll: () => [] };
  const elements: Record<string, any> = {
    'project-todo-add': editor, 'project-todo-input': input, 'project-todo-attachments': chips,
    'project-todo-save': {}, 'project-todo-cancel': {}, 'project-todo-counter': {},
  };
  const alerts = vi.fn();
  const state = { failUpdate: false, failDelete: '', content: 'Original', blockUpdate: null as Promise<any> | null };
  const invoke = vi.fn(async (channel: string, p: any) => {
    if (channel === 'projects.tasks.update') {
      if (state.blockUpdate) await state.blockUpdate;
      if (state.failUpdate) return { ok: false, error: 'save_failed' };
      state.content = p.content;
    }
    if (channel === 'projects.tasks.attachments.delete') {
      if (state.failDelete === p.name) return { ok: false };
      fs.rmSync(path.join(dir, p.name), { force: true });
    }
    if (channel === 'projects.tasks.attachments.upload') {
      fs.writeFileSync(path.join(dir, p.name), Buffer.from(p.dataBase64, 'base64'));
      return { name: p.name };
    }
    return { ok: true };
  });
  const context = vm.createContext({
    document: { readyState: 'loading', addEventListener() {}, getElementById: (id: string) => elements[id] || null },
    window: { addEventListener() {}, orkas: { invoke } },
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    t: (key: string) => key, escapeHtml: String, uiIconHtml: () => '', uiAlert: alerts,
    CHAT_ATTACH_ACCEPT: ['.txt'], _arrayBufferToBase64,
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    setTimeout: () => 0, clearTimeout() {},
  });
  vm.runInContext(composerAccessorSource, context);
  vm.runInContext(source, context);
  const open = () => context._openProjectTodoEditor({ id: 't_abcabcabcabc', content: state.content,
    status: 'todo', attachments: fs.readdirSync(dir) }, { pid, global: !pid, tasks: [], agents: [] });
  open();
  return { context, state, editor, input, chips, alerts, invoke, open,
    bytes: (name: string) => fs.readFileSync(path.join(dir, name), 'utf8'),
    names: () => fs.readdirSync(dir), dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('todo attachment removal is committed by Save', () => {
  it.each(['p_project', ''])('cancel preserves original bytes and reopening restores chips (scope %s)', async (pid) => {
    const f = editorFixture(pid);
    try {
      await f.context._removeTodoEditorAttachment('a.txt');
      expect(f.chips.innerHTML).not.toContain('a.txt');
      expect(f.bytes('a.txt')).toBe('original a.txt');
      f.context._closeProjectTodoEditor();
      f.open();
      expect(f.chips.innerHTML).toContain('a.txt');
      expect(f.bytes('a.txt')).toBe('original a.txt');
      expect(f.invoke.mock.calls.some(([c]) => c === 'projects.tasks.attachments.delete')).toBe(false);
    } finally { f.dispose(); }
  });

  it('does not delete on failed Save and commits only selected files on retry', async () => {
    const f = editorFixture('p_project');
    try {
      await f.context._removeTodoEditorAttachment('a.txt');
      f.input.value = 'Edited';
      f.state.failUpdate = true;
      await f.context._saveProjectTodoEditor();
      expect(f.names()).toEqual(['a.txt', 'b.txt']);
      expect(f.editor.hidden).toBe(false);
      expect(f.alerts).toHaveBeenCalledWith('project.todo.failed');
      f.state.failUpdate = false;
      await f.context._saveProjectTodoEditor();
      expect(f.names()).toEqual(['b.txt']);
      expect(f.state.content).toBe('Edited');
      expect(f.editor.hidden).toBe(true);
    } finally { f.dispose(); }
  });

  it('retains failed deletions for retry without repeating successful removals', async () => {
    const f = editorFixture('p_project');
    try {
      await f.context._removeTodoEditorAttachment('a.txt');
      await f.context._removeTodoEditorAttachment('b.txt');
      f.state.failDelete = 'b.txt';
      await f.context._saveProjectTodoEditor();
      expect(f.names()).toEqual(['b.txt']);
      expect(f.editor.hidden).toBe(false);
      expect(f.alerts).toHaveBeenCalledWith('project.todo.failed');
      f.state.failDelete = '';
      await f.context._saveProjectTodoEditor();
      expect(f.names()).toEqual([]);
      expect(f.invoke.mock.calls.filter(([c, p]) => c === 'projects.tasks.attachments.delete' && p.name === 'a.txt')).toHaveLength(1);
      expect(f.editor.hidden).toBe(true);
    } finally { f.dispose(); }
  });

  it('keeps a reattached file when Save commits the edit', async () => {
    const f = editorFixture('p_project');
    try {
      await f.context._removeTodoEditorAttachment('a.txt');
      await f.context._todoPickAndUploadFiles([{ name: 'a.txt', size: 3,
        arrayBuffer: async () => new Uint8Array([110, 101, 119]).buffer }]);
      await f.context._saveProjectTodoEditor();
      expect(f.bytes('a.txt')).toBe('new');
      expect(f.names()).toEqual(['a.txt', 'b.txt']);
    } finally { f.dispose(); }
  });

  it('ignores attachment changes while Save is in progress', async () => {
    const f = editorFixture('p_project');
    let release!: () => void;
    try {
      await f.context._removeTodoEditorAttachment('a.txt');
      f.state.blockUpdate = new Promise<void>((resolve) => { release = resolve; });
      const save = f.context._saveProjectTodoEditor();
      await f.context._removeTodoEditorAttachment('b.txt');
      await f.context._todoPickAndUploadFiles([{ name: 'a.txt', size: 3,
        arrayBuffer: async () => new Uint8Array([110, 101, 119]).buffer }]);
      release();
      await save;
      expect(f.names()).toEqual(['b.txt']);
      expect(f.invoke.mock.calls.some(([c]) => c === 'projects.tasks.attachments.upload')).toBe(false);
      expect(f.editor.hidden).toBe(true);
    } finally { release?.(); f.dispose(); }
  });
});
