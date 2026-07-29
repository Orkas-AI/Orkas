import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/kb-picker.js'),
  'utf8',
);

function load(initialStorage: Record<string, string> = {}) {
  const values = new Map(Object.entries(initialStorage));
  const sandbox: Record<string, any> = {
    currentUserId: 'account-a',
    createLogger: () => ({ warn: vi.fn() }),
    t: (key: string) => key,
    escapeHtml: (value: unknown) => String(value ?? ''),
    apiFetch: vi.fn(),
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
    document: { getElementById: () => null },
    setTimeout: vi.fn(),
    window: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'kb-picker.js' });
  return { sandbox, values };
}

describe('Library location picker', () => {
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
