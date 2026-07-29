import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function loadProjectDetailScript() {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/project-detail.js'),
    'utf8',
  );
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'projects.files.reconcile') {
      return { ok: true, recoveredProcessing: 1 };
    }
    if (channel === 'projects.files.status') {
      return {
        ok: true,
        files: [{
          name: 'poster.png',
          kind: 'image',
          status: 'ready',
          chunks: 1,
        }],
      };
    }
    throw new Error(`unexpected channel: ${channel}`);
  });
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
    t: (key: string) => key,
    window: {
      addEventListener: vi.fn(),
      orkas: { invoke },
    },
    document: {
      readyState: 'loading',
      addEventListener: vi.fn(),
      getElementById: vi.fn(() => null),
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'project-detail.js' });
  vm.runInContext(`
    _projectDetailPid = 'project-1';
    _projectDetailMeta = {
      files: [{ type: 'file', name: 'poster.png', relPath: 'poster.png', kind: 'image' }]
    };
    _projectKbStatusByName = {
      'poster.png': { status: 'processing', kind: 'image' }
    };
  `, context);
  return { context, invoke };
}

describe('Project Library indexing recovery', () => {
  it('reconciles a processing row left behind by a previous app process', async () => {
    const { context, invoke } = loadProjectDetailScript();

    context._kickProjectKbReconcileIfNeeded();

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('projects.files.reconcile', {
        projectId: 'project-1',
      });
    });
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('projects.files.status', {
        projectId: 'project-1',
        skipReconcile: true,
      });
    });
    await vi.waitFor(() => {
      const status = vm.runInContext("_projectKbStatusByName['poster.png']", context);
      expect(status).toMatchObject({
        status: 'ready',
        chunks: 1,
      });
    });

    context._kickProjectKbReconcileIfNeeded();
    expect(invoke.mock.calls.filter(([channel]) => channel === 'projects.files.reconcile')).toHaveLength(1);
  });
});
