import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: vi.fn(),
  dialog: {
    showMessageBox: vi.fn(),
    showOpenDialog: vi.fn(),
  },
  shell: {
    openExternal: vi.fn(),
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
    trashItem: vi.fn(),
  },
}));

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-core-client-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('core-agent client skill sandbox env', () => {
  it('passes the canonical workspace root through to bash skill invocations', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');
    const paths = await import('../../../../src/main/paths');

    expect(client.buildSkillSandboxEnv()).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      ORKAS_PC_DIR: paths.PC_ROOT,
      ORKAS_WORKSPACE_ROOT: path.resolve(tmpDir),
      ORKAS_VENV_ROOT: path.join(path.resolve(tmpDir), 'venv'),
      ORKAS_PYTHON_VENV_ROOT: path.join(path.resolve(tmpDir), 'venv', 'python'),
      UV_CACHE_DIR: path.join(path.resolve(tmpDir), 'venv', 'python', 'cache', 'uv'),
      PIP_CACHE_DIR: path.join(path.resolve(tmpDir), 'venv', 'python', 'cache', 'pip'),
    });
  });

  it('stops waiting for a wedged event stream when the abort signal fires', async () => {
    const client = await import('../../../../src/main/model/core-agent/client');
    const controller = new AbortController();

    async function* stuckStream() {
      yield { type: 'delta', text: 'started' };
      await new Promise(() => { /* never resolves */ });
    }

    const iterator = client.stopStreamOnAbort(stuckStream(), controller.signal, 'test')[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: { type: 'delta', text: 'started' }, done: false });
    const pending = iterator.next();
    controller.abort();
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
  });
});
