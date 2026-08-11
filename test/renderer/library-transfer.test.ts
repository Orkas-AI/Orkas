import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const transfer = require('../../src/renderer/modules/library-transfer.js') as {
  _libraryValue: (ref: { scope: string; projectId?: string }) => string;
  _parseLibraryValue: (value: string) => { scope: string; projectId?: string } | null;
  _folderRows: (nodes: unknown[]) => Array<{ path: string; name: string; depth: number }>;
  _projectsFromResponse: (response: unknown) => unknown[];
  _canSubmitTransfer: (state: { loading: boolean; destinationReady: boolean }) => boolean;
  _transferFailureTelemetry: (error: unknown) => Record<string, unknown>;
  _createLatestFolderLoader: (
    loadTree: (ref: { scope: string; projectId?: string }) => Promise<unknown[]>,
    handlers: {
      onStart: (ref: { scope: string; projectId?: string }) => void;
      onReady: (tree: unknown[], ref: { scope: string; projectId?: string }) => void;
      onError: (error: unknown, ref: { scope: string; projectId?: string }) => void;
      onFinish: (ref: { scope: string; projectId?: string }) => void;
    },
  ) => (ref: { scope: string; projectId?: string }) => Promise<boolean>;
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

  it('keeps destructive submission disabled until the destination tree loads', () => {
    expect(transfer._canSubmitTransfer({
      loading: true,
      destinationReady: false,
    })).toBe(false);
    expect(transfer._canSubmitTransfer({
      loading: false,
      destinationReady: false,
    })).toBe(false);
    expect(transfer._canSubmitTransfer({
      loading: false,
      destinationReady: true,
    })).toBe(true);
  });

  it('does not let a slow previous destination replace the latest folder tree', async () => {
    const pending = new Map<string, {
      resolve: (tree: unknown[]) => void;
      reject: (error: Error) => void;
    }>();
    const events: string[] = [];
    const load = transfer._createLatestFolderLoader(
      (ref) => new Promise<unknown[]>((resolve, reject) => {
        pending.set(ref.projectId || 'global', { resolve, reject });
      }),
      {
        onStart: (ref) => events.push(`start:${ref.projectId}`),
        onReady: (_tree, ref) => events.push(`ready:${ref.projectId}`),
        onError: (_error, ref) => events.push(`error:${ref.projectId}`),
        onFinish: (ref) => events.push(`finish:${ref.projectId}`),
      },
    );

    const slow = load({ scope: 'project', projectId: 'slow' });
    const latest = load({ scope: 'project', projectId: 'latest' });
    pending.get('latest')!.resolve([{ type: 'dir', relPath: 'latest-folder' }]);
    await expect(latest).resolves.toBe(true);
    pending.get('slow')!.resolve([{ type: 'dir', relPath: 'stale-folder' }]);
    await expect(slow).resolves.toBe(false);

    expect(events).toEqual([
      'start:slow',
      'start:latest',
      'ready:latest',
      'finish:latest',
    ]);
  });

  it('ignores an obsolete destination failure after a newer tree is ready', async () => {
    const pending = new Map<string, {
      resolve: (tree: unknown[]) => void;
      reject: (error: Error) => void;
    }>();
    const events: string[] = [];
    const load = transfer._createLatestFolderLoader(
      (ref) => new Promise<unknown[]>((resolve, reject) => {
        pending.set(ref.projectId || 'global', { resolve, reject });
      }),
      {
        onStart: (ref) => events.push(`start:${ref.projectId}`),
        onReady: (_tree, ref) => events.push(`ready:${ref.projectId}`),
        onError: (_error, ref) => events.push(`error:${ref.projectId}`),
        onFinish: (ref) => events.push(`finish:${ref.projectId}`),
      },
    );

    const obsolete = load({ scope: 'project', projectId: 'obsolete' });
    const latest = load({ scope: 'project', projectId: 'latest' });
    pending.get('latest')!.resolve([]);
    await latest;
    pending.get('obsolete')!.reject(new Error('private /Users/test/library'));
    await expect(obsolete).resolves.toBe(false);

    expect(events).not.toContain('error:obsolete');
    expect(events.at(-1)).toBe('finish:latest');
  });

  it('does not put raw IPC failures or local paths into telemetry', () => {
    const payload = transfer._transferFailureTelemetry(
      new Error('copy failed at /Users/test/customer-plan.md'),
    );

    expect(payload).toEqual({ error_code: 'transfer_failed', error_type: 'operation' });
    expect(JSON.stringify(payload)).not.toContain('/Users/private');
    expect(JSON.stringify(payload)).not.toContain('customer-plan.md');
  });

  it('keeps stable transfer failures queryable without raw backend details', () => {
    expect(transfer._transferFailureTelemetry({ error: 'target_exists' })).toEqual({
      error_code: 'target_exists',
      error_type: 'conflict',
    });
    expect(transfer._transferFailureTelemetry({ error: 'invalid_batch' })).toEqual({
      error_code: 'invalid_batch',
      error_type: 'validation',
    });
    expect(transfer._transferFailureTelemetry('source_delete_failed')).toEqual({
      error_code: 'source_delete_failed',
      error_type: 'operation',
    });
    expect(transfer._transferFailureTelemetry({
      code: 'E_IPC_REQUEST',
      error: 'private backend detail',
    })).toEqual({
      error_code: 'E_IPC_REQUEST',
      error_type: 'operation',
    });
  });

  it('keeps row menus compact with one consolidated transfer action', () => {
    const contexts = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/contexts.js'), 'utf8');
    const project = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/project-detail.js'), 'utf8');

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
  });
});
