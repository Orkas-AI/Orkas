import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

import * as ts from 'typescript';

const utilsSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/utils.js'), 'utf8');
const utilsParsed = ts.createSourceFile('utils.js', utilsSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const base64Utility = utilsParsed.statements.find(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === '_arrayBufferToBase64');
if (!base64Utility) throw new Error('missing upload base64 utility');

function loadProjectDetailScript() {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/project-detail.js'),
    'utf8',
  );
  const context: any = {
    AbortController,
    ArrayBuffer,
    Blob,
    clearTimeout,
    performance,
    setTimeout,
    Uint8Array,
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
    escapeHtml: (value: unknown) => String(value ?? ''),
    t: (key: string, vars?: Record<string, unknown>) => `${key}:${JSON.stringify(vars || {})}`,
    window: {
      addEventListener: vi.fn(),
      orkas: { invoke: vi.fn() },
    },
    document: {
      readyState: 'loading',
      addEventListener: vi.fn(),
      getElementById: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
    },
  };
  vm.createContext(context);
  vm.runInContext(base64Utility.getText(utilsParsed), context, { filename: 'upload-base64-utility.js' });
  vm.runInContext(source, context, { filename: 'project-detail.js' });
  vm.runInContext("_projectDetailPid = 'project-1'", context);
  return context;
}

describe('Project Library popup copy', () => {
  it.each([
    ['project', 'success'], ['project', 'failure'], ['project', 'rejection'],
    ['account', 'success'], ['account', 'failure'], ['account', 'rejection'],
  ])('isolates a late %s deletion %s without replacing the active scope', async (scope, outcome) => {
    const context = loadProjectDetailScript();
    context.currentUserId = 'first';
    context.uiConfirm = vi.fn(async () => true);
    context.uiAlert = vi.fn(async () => {});
    context._renderProjectFiles = vi.fn();
    vm.runInContext(`_projectDetailResolvedPid = 'project-1';
      _projectDetailMeta = { project: { project_id: 'project-1' }, files: [] };`, context);
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const response = new Promise((resolve, reject) => {
      release = () => outcome === 'rejection' ? reject(new Error('synthetic deletion failure'))
        : resolve({ ok: outcome === 'success' });
    });
    context.window.orkas.invoke = vi.fn(() => { started(); return response; });
    const deleting = context._deleteProjectFile('old.md');
    await waiting;
    if (scope === 'account') context.currentUserId = 'second';
    else vm.runInContext(`_projectDetailPid = 'project-2'; _projectDetailResolvedPid = 'project-2';
      _projectDetailMeta = { project: { project_id: 'project-2' }, files: [] };`, context);
    release();
    await deleting;
    expect(context.uiAlert).not.toHaveBeenCalled();
    expect(context._renderProjectFiles).not.toHaveBeenCalled();
    expect(context.window.orkas.invoke).toHaveBeenCalledExactlyOnceWith('projects.files.delete', { projectId: 'project-1', name: 'old.md' });
  });


  it.each([
    ['confirmation', 'project'], ['confirmation', 'account'],
    ['deletion', 'project'], ['deletion', 'account'],
  ])('ignores %s completion after changing %s', async (phase, scope) => {
    const context = loadProjectDetailScript();
    context.currentUserId = 'first';
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const gate = () => new Promise(resolve => { release = () => resolve(phase === 'confirmation' ? true : { ok: true }); started(); });
    context.uiConfirm = vi.fn(phase === 'confirmation' ? gate : async () => true);
    context.window.orkas.invoke = vi.fn(phase === 'deletion' ? gate : async () => ({ ok: true }));
    context._renderProjectFiles = vi.fn();
    const deleting = context._deleteProjectFile('old.md');
    await waiting;
    if (scope === 'account') context.currentUserId = 'second';
    else vm.runInContext("_projectDetailPid = 'project-2'", context);
    vm.runInContext("_projectDetailMeta = { files: [{ name: 'old.md', relPath: 'old.md', type: 'file' }] }", context);
    release();
    await deleting;
    expect(context.window.orkas.invoke).toHaveBeenCalledTimes(phase === 'confirmation' ? 0 : 1);
    expect(context._renderProjectFiles).not.toHaveBeenCalled();
    expect(vm.runInContext('_projectDetailMeta.files.length', context)).toBe(1);
  });

  it('removes a deleted subtree and updates the list without waiting for unrelated project reloads', async () => {
    const context = loadProjectDetailScript();
    const kept = { type: 'file', name: 'keep.md', relPath: 'keep.md', kind: 'text' };
    vm.runInContext(`_projectDetailMeta = { files: [
      { type: 'dir', name: 'Notes', relPath: 'Notes', children: [
        { type: 'file', name: 'old.md', relPath: 'Notes/old.md', kind: 'text' }
      ] }, kept
    ] }; _projectLibraryActiveName = 'Notes/old.md';
    _projectLibraryDrafts.set('Notes/old.md', 'unsaved draft');`, Object.assign(context, { kept }));
    context.uiConfirm = vi.fn(async () => true);
    context.window.orkas.invoke = vi.fn(async () => ({ ok: true }));
    context.loadProjectDetail = vi.fn(() => new Promise(() => {}));
    context._renderProjectFiles = vi.fn();
    context._clearProjectLibraryViewer = vi.fn();
    await context._deleteProjectFile('Notes');
    expect(context._renderProjectFiles).toHaveBeenCalledWith([kept]);
    expect(vm.runInContext('_projectDetailMeta.files', context)).toEqual([kept]);
    expect(vm.runInContext('_projectLibraryDrafts.size', context)).toBe(0);
    expect(context._clearProjectLibraryViewer).toHaveBeenCalledOnce();
    expect(context.loadProjectDetail).not.toHaveBeenCalled();
  });

  it('keeps files and the viewer when local deletion fails', async () => {
    const context = loadProjectDetailScript();
    vm.runInContext("_projectDetailMeta = { files: [{ name: 'old.md', relPath: 'old.md', type: 'file' }] }; _projectLibraryActiveName = 'old.md'", context);
    context.uiConfirm = vi.fn(async () => true);
    context.uiAlert = vi.fn(async () => {});
    context.window.orkas.invoke = vi.fn(async () => ({ ok: false }));
    context._renderProjectFiles = vi.fn();
    context._clearProjectLibraryViewer = vi.fn();
    await context._deleteProjectFile('old.md');
    expect(vm.runInContext('_projectDetailMeta.files.length', context)).toBe(1);
    expect(context._clearProjectLibraryViewer).not.toHaveBeenCalled();
    expect(context._renderProjectFiles).not.toHaveBeenCalled();
    expect(context.uiAlert).toHaveBeenCalledOnce();
  });

  it('requires confirmation before deleting and shows only the basename', async () => {
    const context = loadProjectDetailScript();
    context.uiConfirm = vi.fn(async () => false);

    await context._deleteProjectFile('Research/Notes/quarterly-plan.md');

    expect(context.uiConfirm).toHaveBeenCalledOnce();
    const prompt = context.uiConfirm.mock.calls[0][0];
    expect(prompt).toContain('contexts.file.del_confirm');
    expect(prompt).toContain('quarterly-plan.md');
    expect(prompt).not.toContain('Research/Notes');
    expect(context.window.orkas.invoke).not.toHaveBeenCalled();
  });

  it('lists failed filenames without exposing project backend details', async () => {
    const context = loadProjectDetailScript();
    const file = {
      name: 'project-brief.md',
      size: 12,
      arrayBuffer: vi.fn(async () => new ArrayBuffer(12)),
    };
    context.window.orkas.invoke = vi.fn(async () => ({
      ok: false,
      error: 'EACCES: /private/project/path must stay hidden',
    }));
    context.loadProjectDetail = vi.fn(async () => undefined);
    context.uiAlert = vi.fn(async () => undefined);

    await context._uploadProjectFiles([file], '', 'drop');

    expect(context.window.orkas.invoke).toHaveBeenCalledExactlyOnceWith('projects.files.upload', {
      projectId: 'project-1', name: file.name, data: Buffer.alloc(12).toString('base64'),
    });
    expect(context.uiAlert).toHaveBeenCalledOnce();
    const message = context.uiAlert.mock.calls[0][0];
    expect(message).toContain('contexts.upload_failed');
    expect(message).toContain(file.name);
    expect(message).not.toContain('EACCES');
    expect(message).not.toContain('/private/project/path');
  });
});
