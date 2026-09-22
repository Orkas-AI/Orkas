// The Library lists (global tree, project tree, and the @ picker) order by
// modification time, newest first, so a file saved a minute ago is at the top
// instead of sinking to wherever its name sorts alphabetically.
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const OLD = 1_700_000_000;   // seconds — what both backends emit
const MID = 1_750_000_000;
const NEW = 1_780_000_000;

function loadRendererModule(file: string, extra: Record<string, unknown> = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules', file), 'utf8');
  const context: any = {
    AbortController,
    ArrayBuffer,
    Blob,
    TextDecoder,
    Uint8Array,
    clearTimeout,
    performance,
    setTimeout,
    createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
    escapeHtml: (value: unknown) => String(value ?? ''),
    t: (key: string) => key,
    Monitor: { error: vi.fn() },
    document: {
      readyState: 'loading',
      addEventListener: vi.fn(),
      body: {},
      getElementById: vi.fn(() => null),
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
    },
    ...extra,
  };
  context.window = context.window || { addEventListener: vi.fn(), Monitor: context.Monitor };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: file });
  return context;
}

const file = (name: string, mtime: number) => ({ name, path: name, relPath: name, type: 'file', mtime });
const dir = (name: string, mtime: number) => ({ name, path: name, relPath: name, type: 'dir', mtime, children: [] });

describe('Library ordering is recency-first', () => {
  it.each([
    ['contexts.js', '_sortCtxNodes'],
    ['project-detail.js', '_sortProjectLibraryNodes'],
  ])('puts the newest file first in %s', (module, fnName) => {
    const context = loadRendererModule(module);
    const sorted = context[fnName]([
      file('archived-notes.md', OLD),
      file('zebra-report.md', NEW),
      file('meeting-minutes.md', MID),
    ]);
    expect(sorted.map((n: any) => n.name)).toEqual([
      'zebra-report.md',
      'meeting-minutes.md',
      'archived-notes.md',
    ]);
  });

  it.each([
    ['contexts.js', '_sortCtxNodes'],
    ['project-detail.js', '_sortProjectLibraryNodes'],
  ])('keeps folders ahead of files and orders them by mtime too in %s', (module, fnName) => {
    const context = loadRendererModule(module);
    const sorted = context[fnName]([
      file('brand-new.md', NEW),
      dir('stale-folder', OLD),
      dir('fresh-folder', MID),
    ]);
    expect(sorted.map((n: any) => n.name)).toEqual(['fresh-folder', 'stale-folder', 'brand-new.md']);
  });

  it.each([
    ['contexts.js', '_sortCtxNodes'],
    ['project-detail.js', '_sortProjectLibraryNodes'],
  ])('falls back to name order when mtime is missing or tied in %s', (module, fnName) => {
    const context = loadRendererModule(module);
    const sorted = context[fnName]([
      { name: 'no-mtime-b.md', path: 'no-mtime-b.md', relPath: 'no-mtime-b.md', type: 'file' },
      file('tied-b.md', MID),
      { name: 'no-mtime-a.md', path: 'no-mtime-a.md', relPath: 'no-mtime-a.md', type: 'file' },
      file('tied-a.md', MID),
    ]);
    expect(sorted.map((n: any) => n.name)).toEqual([
      'tied-a.md', 'tied-b.md',       // same mtime → alphabetical
      'no-mtime-a.md', 'no-mtime-b.md', // unknown mtime sinks to the bottom
    ]);
  });

  it('orders the @ picker library rows newest-first across both scopes', async () => {
    const projectTree = [file('project-old.md', OLD), file('project-new.md', NEW)];
    const globalTree = [dir('folder', MID), file('global-mid.md', MID)];
    (globalTree[0] as any).children = [file('global-newest.md', NEW + 100)];
    const context = loadRendererModule('agents.js', {
      window: {
        addEventListener: vi.fn(),
        orkas: { invoke: vi.fn(async () => ({ ok: true, tree: projectTree })) },
      },
      apiFetch: vi.fn(async () => ({ json: async () => ({ ok: true, tree: globalTree }) })),
      Event: class {},
      addEventListener: vi.fn(),
    });

    const rows = await context._loadLibraryPickerRows('proj-1');

    expect(rows.map((r: any) => r.name)).toEqual([
      'global-newest.md',
      'project-new.md',
      'global-mid.md',
      'project-old.md',
    ]);
  });
});
