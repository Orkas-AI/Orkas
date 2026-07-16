import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const transfer = require('../../src/renderer/modules/library-transfer.js') as {
  _libraryValue: (ref: { scope: string; projectId?: string }) => string;
  _parseLibraryValue: (value: string) => { scope: string; projectId?: string } | null;
  _folderRows: (nodes: unknown[]) => Array<{ path: string; name: string; depth: number }>;
  _projectsFromResponse: (response: unknown) => unknown[];
};

describe('shared Library transfer dialog', () => {
  it('round-trips global and project Library picker values', () => {
    expect(transfer._libraryValue({ scope: 'global' })).toBe('global');
    expect(transfer._libraryValue({ scope: 'project', projectId: 'p-1' })).toBe('project:p-1');
    expect(transfer._parseLibraryValue('global')).toEqual({ scope: 'global' });
    expect(transfer._parseLibraryValue('project:p-1')).toEqual({ scope: 'project', projectId: 'p-1' });
    expect(transfer._parseLibraryValue('project:')).toBeNull();
  });

  it('flattens only folders and preserves their visible depth', () => {
    expect(transfer._folderRows([
      {
        type: 'dir', name: 'Docs', path: 'Docs', children: [
          { type: 'file', name: 'a.md', path: 'Docs/a.md' },
          { type: 'dir', name: '2026', path: 'Docs/2026', children: [] },
        ],
      },
      { type: 'file', name: 'root.md', path: 'root.md' },
    ])).toEqual([
      { path: 'Docs', name: 'Docs', depth: 0 },
      { path: 'Docs/2026', name: '2026', depth: 1 },
    ]);
  });

  it('supports project tree relPath values', () => {
    expect(transfer._folderRows([
      { type: 'dir', name: 'Assets', relPath: 'nested/Assets', children: [] },
    ])).toEqual([{ path: 'nested/Assets', name: 'Assets', depth: 0 }]);
  });

  it('accepts the existing projects.list IPC response without requiring an ok wrapper', () => {
    const projects = [{ project_id: 'p-1', name: 'Alpha' }];
    expect(transfer._projectsFromResponse({ projects })).toEqual(projects);
    expect(transfer._projectsFromResponse({ ok: true })).toEqual([]);
  });

  it('keeps row menus compact with one consolidated transfer action', () => {
    const contexts = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/contexts.js'), 'utf8');
    const project = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/project-detail.js'), 'utf8');
    const dialog = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/library-transfer.js'), 'utf8');
    const archivePicker = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-picker.js'), 'utf8');
    const zh = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/renderer/locales/zh.json'), 'utf8'));

    expect(contexts.match(/action: 'organize'/g)).toHaveLength(2);
    expect(project.match(/action: 'organize'/g)).toHaveLength(2);
    expect(`${contexts}\n${project}`).not.toMatch(/action: '(move_to|copy_to)'/);
    expect(contexts).toContain("label: t('contexts.transfer.title'), dividerBefore: true");
    expect(project).toContain("label: t('contexts.transfer.title'), dividerBefore: true");
    expect(contexts).toContain('ctx-row-menu-divider');
    expect(project).toContain('ctx-row-menu-divider');
    const contextMenuStart = contexts.indexOf('function _ctxMenuItemsFor');
    const contextFileStart = contexts.indexOf('  // file', contextMenuStart);
    const contextFileMenu = contexts.slice(contextFileStart, contexts.indexOf('\n  return items;', contextFileStart));
    const projectFileMenu = project.slice(project.indexOf('function _projectFileMenuItemsFor'), project.indexOf('\n  return items;', project.indexOf('function _projectFileMenuItemsFor')));
    for (const source of [contextFileMenu, projectFileMenu]) {
      const ordered = ['edit', 'rename', 'delete', 'ask_commander', 'organize'];
      ordered.forEach((action, index) => {
        if (index > 0) expect(source.indexOf(`action: '${action}'`)).toBeGreaterThan(source.indexOf(`action: '${ordered[index - 1]}'`));
      });
      expect(source).toContain("action: 'ask_commander', label: t('contexts.menu.ask_commander'), dividerBefore: true");
    }
    expect(contextFileMenu.indexOf("action: 'open_in_system'")).toBeGreaterThan(contextFileMenu.indexOf("action: 'organize'"));
    expect(projectFileMenu.indexOf("action: 'reveal'")).toBeGreaterThan(projectFileMenu.indexOf("action: 'organize'"));
    expect(dialog).toContain("data-transfer-mode=\"move\"");
    expect(dialog).toContain("data-transfer-mode=\"copy\"");
    expect(dialog).toContain("root.orkas.invoke('library.transfer'");
    expect(dialog).toContain("Array.isArray(data?.tree)");
    expect(dialog).toContain('32 + row.depth * 18');
    expect(archivePicker).toContain('32 + depth * 18');
    expect(zh['chat.archive_picker_title']).toBe('存档到资料库');
  });
});
