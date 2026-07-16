import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

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
  vm.runInContext(source, context, { filename: 'project-detail.js' });
  vm.runInContext("_projectDetailPid = 'project-1'", context);
  return context;
}

describe('Project Library popup copy', () => {
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

    expect(context.uiAlert).toHaveBeenCalledOnce();
    const message = context.uiAlert.mock.calls[0][0];
    expect(message).toContain('contexts.upload_failed');
    expect(message).toContain(file.name);
    expect(message).not.toContain('EACCES');
    expect(message).not.toContain('/private/project/path');
  });
});
