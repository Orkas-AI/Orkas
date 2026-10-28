import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/kb-picker.js'),
  'utf8',
);
const indexSource = readFileSync(
  resolve(__dirname, '../../src/renderer/index.html'),
  'utf8',
);

function load(
  initialStorage: Record<string, string> = {},
  elements: Record<string, unknown> = {},
) {
  const values = new Map(Object.entries(initialStorage));
  const translations: Record<string, string> = {
    'contexts.root_label': 'Root',
    'contexts.transfer.global_library': 'Global Library',
    'contexts.transfer.project_library': 'Project Library',
    'kb_picker.title_global': 'Save to Global Library',
    'kb_picker.title_project': 'Save to Project Library',
    'kb_picker.target': 'Saving to: {library} / {rel}',
  };
  const sandbox: Record<string, any> = {
    currentUserId: 'account-a',
    createLogger: () => ({ warn: vi.fn() }),
    t: (key: string, params: Record<string, unknown> = {}) => (
      (translations[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
    ),
    escapeHtml: (value: unknown) => String(value ?? ''),
    apiFetch: vi.fn(),
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
    document: { getElementById: (id: string) => elements[id] ?? null },
    setTimeout: vi.fn(),
    window: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'kb-picker.js' });
  return { sandbox, values };
}

describe('Library location picker', () => {
  it('binds the visible cancel and confirm actions without inline global lookups', () => {
    const cancel = { addEventListener: vi.fn() };
    const confirm = { addEventListener: vi.fn() };
    const { sandbox } = load({}, {
      'kb-picker-cancel': cancel,
      'kb-picker-confirm': confirm,
    });

    expect(indexSource).toContain('id="kb-picker-cancel"');
    expect(indexSource).toContain('id="kb-picker-confirm"');
    expect(indexSource).not.toContain('onclick="closeKbPicker()"');
    expect(indexSource).not.toContain('onclick="confirmKbPicker()"');
    expect(cancel.addEventListener).toHaveBeenCalledWith('click', sandbox.window.closeKbPicker);
    expect(confirm.addEventListener).toHaveBeenCalledWith('click', sandbox.window.confirmKbPicker);
  });

  it('identifies the Global or Project Library in both the title and destination', () => {
    const { sandbox } = load();
    const target = { textContent: '' };
    sandbox.document = {
      getElementById: (id: string) => (id === 'kb-picker-target' ? target : null),
    };

    expect(sandbox._kbPickerDefaultTitle({ type: 'global' }))
      .toBe('Save to Global Library');
    vm.runInContext(
      "_kbPickerScope = { type: 'global' }; _kbPickerCurrentDir = ''; _kbPickerRenderTarget();",
      sandbox,
    );
    expect(target.textContent).toBe('Saving to: Global Library / Root');

    expect(sandbox._kbPickerDefaultTitle({ type: 'project', projectId: 'project-1' }))
      .toBe('Save to Project Library');
    vm.runInContext(
      "_kbPickerScope = { type: 'project', projectId: 'project-1' }; _kbPickerCurrentDir = 'research'; _kbPickerRenderTarget();",
      sandbox,
    );
    expect(target.textContent).toBe('Saving to: Project Library / research/');
  });

  it('scopes remembered global and project folders to the active account', () => {
    const { sandbox } = load();

    const accountAGlobal = sandbox._kbPickerLastDirKey({ type: 'global' });
    const accountAProject = sandbox._kbPickerLastDirKey({
      type: 'project',
      projectId: 'project-1',
    });
    sandbox.currentUserId = 'account-b';
    const accountBGlobal = sandbox._kbPickerLastDirKey({ type: 'global' });
    const accountBProject = sandbox._kbPickerLastDirKey({
      type: 'project',
      projectId: 'project-1',
    });

    expect(accountAGlobal).not.toBe(accountBGlobal);
    expect(accountAProject).not.toBe(accountBProject);
    expect(accountAGlobal).toContain('account-a');
    expect(accountBGlobal).toContain('account-b');
  });

  it('migrates the legacy shared folder only to the first account that opens it', () => {
    const { sandbox, values } = load({
      'kb-picker.last-dir': 'team/reference',
    });

    expect(sandbox._kbPickerReadLastDir({ type: 'global' })).toBe('team/reference');
    expect(values.has('kb-picker.last-dir')).toBe(false);
    sandbox.currentUserId = 'account-b';
    expect(sandbox._kbPickerReadLastDir({ type: 'global' })).toBe('');
  });

  it('rejects traversal names and resolves a valid extensionless name in the selected folder', async () => {
    const { sandbox, values } = load();
    const name = { value: '../private' };
    const message = { textContent: '', className: '' };
    const removeOpen = vi.fn();
    sandbox.document = {
      getElementById: (id: string) => {
        if (id === 'kb-picker-name') return name;
        if (id === 'kb-picker-msg') return message;
        if (id === 'kb-picker-modal') return { classList: { remove: removeOpen } };
        return null;
      },
    };
    const resolved: unknown[] = [];
    sandbox.capturePickerResult = (value: unknown) => { resolved.push(value); };
    vm.runInContext(
      "_kbPickerScope = { type: 'global' }; _kbPickerCurrentDir = 'notes'; _kbPickerResolve = capturePickerResult;",
      sandbox,
    );

    await sandbox.confirmKbPicker();
    expect(message.textContent).toBe('kb_picker.name_bad_chars');
    expect(resolved).toEqual([]);
    expect(removeOpen).not.toHaveBeenCalled();

    name.value = 'meeting notes';
    await sandbox.confirmKbPicker();
    expect(resolved).toEqual([{ path: 'notes/meeting notes.md' }]);
    expect(removeOpen).toHaveBeenCalledOnce();
    expect(values.get('kb-picker.last-dir:account-a')).toBe('notes');
  });
});


function pickerFlow() {
  const elements: Record<string, any> = {};
  for (const id of ['modal', 'title', 'name', 'msg', 'tree', 'target']) {
    const classes = new Set<string>();
    elements['kb-picker-' + id] = {
      value: '', textContent: '', innerHTML: '', focus: vi.fn(),
      classList: { add: (value: string) => classes.add(value), remove: (value: string) => classes.delete(value), contains: (value: string) => classes.has(value) },
      querySelectorAll: () => [],
    };
  }
  const { sandbox, values } = load({}, elements);
  const requests: Array<{ scope: string; resolve: (tree: any[]) => void; reject: (error: Error) => void }> = [];
  sandbox.apiFetch = vi.fn(() => new Promise((resolve, reject) => requests.push({
    scope: 'global', resolve: tree => resolve({ json: async () => ({ ok: true, tree }) }), reject,
  })));
  sandbox.window.orkas = { invoke: vi.fn((method: string, args: any) => {
    expect(method).toBe('projects.files.tree');
    return new Promise((resolve, reject) => requests.push({ scope: args.projectId, resolve: tree => resolve({ ok: true, tree }), reject }));
  }) };
  const outcomes: unknown[] = [];
  const begin = (name: string, scope: any = { type: 'global' }, dir = '') => {
    const promise = sandbox.pickKbLocation({ defaultName: name, scope, defaultDir: dir });
    promise.then((value: unknown) => outcomes.push({ name, value }));
    return promise;
  };
  return { sandbox, values, elements, requests, outcomes, begin };
}
const settlePicker = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const folder = (name: string) => [{ type: 'dir', name, relPath: name, children: [] }];

describe('Library picker request ownership', () => {
  it('cancels the superseded caller before either directory response arrives', async () => {
    const flow = pickerFlow();
    flow.begin('first');
    const second = flow.begin('second', { type: 'project', projectId: 'p2' }, 'new');
    await settlePicker();
    expect(flow.outcomes).toEqual([{ name: 'first', value: null }]);
    flow.requests[0].resolve(folder('old')); await settlePicker();
    expect(flow.elements['kb-picker-modal'].classList.contains('open')).toBe(false);
    flow.requests[1].resolve(folder('new')); await settlePicker();
    expect(flow.elements['kb-picker-title'].textContent).toBe('Save to Project Library');
    expect(flow.elements['kb-picker-name'].value).toBe('second');
    await flow.sandbox.confirmKbPicker();
    await expect(second).resolves.toEqual({ path: 'new/second.md' });
    expect(flow.values.get('kb-picker.last-dir:account-a.project.p2')).toBe('new');
  });

  it.each(['resolve', 'reject'] as const)('ignores an obsolete tree %s after the latest picker has opened', async outcome => {
    const flow = pickerFlow();
    flow.begin('first', { type: 'project', projectId: 'p1' }, 'old');
    const latest = flow.begin('latest', { type: 'global' }, 'new');
    flow.requests[1].resolve(folder('new')); await settlePicker();
    if (outcome === 'resolve') flow.requests[0].resolve(folder('old'));
    else flow.requests[0].reject(new Error('controlled tree failure'));
    await settlePicker();
    expect(flow.elements['kb-picker-name'].value).toBe('latest');
    expect(flow.elements['kb-picker-title'].textContent).toBe('Save to Global Library');
    expect(flow.elements['kb-picker-tree'].innerHTML).toContain('data-kb-picker-dir="new"');
    expect(flow.elements['kb-picker-tree'].innerHTML).not.toContain('data-kb-picker-dir="old"');
    await flow.sandbox.confirmKbPicker();
    await expect(latest).resolves.toEqual({ path: 'new/latest.md' });
    expect(flow.outcomes).toEqual([{ name: 'first', value: null }, { name: 'latest', value: { path: 'new/latest.md' } }]);
  });

  it.each(['resolve', 'reject'] as const)('closing a pending tree settles immediately and ignores its eventual %s', async outcome => {
    const flow = pickerFlow();
    flow.begin('cancelled');
    flow.sandbox.closeKbPicker(); await settlePicker();
    expect(flow.outcomes).toEqual([{ name: 'cancelled', value: null }]);
    if (outcome === 'resolve') flow.requests[0].resolve(folder('late'));
    else flow.requests[0].reject(new Error('controlled tree failure'));
    await settlePicker();
    expect(flow.elements['kb-picker-modal'].classList.contains('open')).toBe(false);
    expect(flow.outcomes).toHaveLength(1);
  });

  it('hides the previous controls while its replacement tree is loading', async () => {
    const flow = pickerFlow();
    flow.begin('first'); flow.requests[0].resolve(folder('old')); await settlePicker();
    expect(flow.elements['kb-picker-modal'].classList.contains('open')).toBe(true);
    flow.begin('second'); await settlePicker();
    expect(flow.elements['kb-picker-modal'].classList.contains('open')).toBe(false);
    expect(flow.outcomes).toEqual([{ name: 'first', value: null }]);
    flow.requests[1].resolve([]); await settlePicker();
    expect(flow.elements['kb-picker-modal'].classList.contains('open')).toBe(true);
    flow.sandbox.closeKbPicker(); await settlePicker();
    expect(flow.outcomes).toEqual([{ name: 'first', value: null }, { name: 'second', value: null }]);
  });

  it('keeps the existing root fallback usable after a current tree failure', async () => {
    const flow = pickerFlow();
    const current = flow.begin('retry', { type: 'project', projectId: 'p2' }, 'missing');
    flow.requests[0].reject(new Error('controlled tree failure')); await settlePicker();
    expect(flow.elements['kb-picker-modal'].classList.contains('open')).toBe(true);
    expect(flow.elements['kb-picker-target'].textContent).toBe('Saving to: Project Library / Root');
    await flow.sandbox.confirmKbPicker(); await expect(current).resolves.toEqual({ path: 'retry.md' });
  });

  it('does not run delayed focus work after its owning picker closes', async () => {
    const flow = pickerFlow(); flow.begin('first'); flow.requests[0].resolve([]); await settlePicker();
    const focus = flow.sandbox.setTimeout.mock.calls[0][0];
    flow.sandbox.closeKbPicker(); focus();
    expect(flow.elements['kb-picker-name'].focus).not.toHaveBeenCalled();
  });
});
