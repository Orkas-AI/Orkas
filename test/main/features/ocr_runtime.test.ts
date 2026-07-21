import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  root: '',
  uv: 'C:\\runtime\\uv.exe',
  python: 'C:\\runtime\\python.exe',
}));

vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
vi.mock('../../../src/main/paths', () => ({
  PYTHON_VENV_PIP_CACHE_DIR: 'C:\\cache\\pip',
  PYTHON_VENV_UV_CACHE_DIR: 'C:\\cache\\uv',
  pythonPackageVenvDir: () => path.join(mocks.root, '.venv'),
  userFileCacheDir: () => path.join(mocks.root, 'cache'),
}));
vi.mock('../../../src/main/util/bundled-runtime', () => ({
  bundledRuntimeEnv: () => ({ ORKAS_UV: mocks.uv, ORKAS_PYTHON: mocks.python }),
}));
vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  _ensureOcrRuntimeForTest,
  _ocrVenvPythonForTest,
  _resetOcrRuntimeForTest,
  ocrImageText,
} from '../../../src/main/features/ocr_runtime';

function installSuccessfulExecMock(delayMs = 0): void {
  mocks.execFile.mockImplementation((file: string, args: string[], _options: unknown, callback: Function) => {
    const finish = () => {
      if (file === mocks.uv && args[0] === 'venv') {
        const venv = args.at(-1)!;
        const python = _ocrVenvPythonForTest(venv);
        fs.mkdirSync(path.dirname(python), { recursive: true });
        fs.writeFileSync(python, 'python');
      }
      callback(null, 'ok', '');
    };
    if (delayMs > 0) setTimeout(finish, delayMs);
    else finish();
    return { kill: vi.fn() };
  });
}

describe('OCR runtime provisioning', () => {
  beforeEach(() => {
    mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ocr-runtime-'));
    mocks.execFile.mockReset();
    _resetOcrRuntimeForTest();
  });

  afterEach(() => {
    _resetOcrRuntimeForTest();
    fs.rmSync(mocks.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('uses the platform-native virtualenv executable layout', () => {
    expect(_ocrVenvPythonForTest('D:\\venv', 'win32')).toBe(path.join('D:\\venv', 'Scripts', 'python.exe'));
    expect(_ocrVenvPythonForTest('/tmp/venv', 'darwin')).toBe(path.join('/tmp/venv', 'bin', 'python'));
  });

  it('coalesces concurrent first-use installs and caches the verified runtime', async () => {
    installSuccessfulExecMock(10);
    const secondProgress: string[] = [];

    const first = _ensureOcrRuntimeForTest();
    const second = _ensureOcrRuntimeForTest((event) => secondProgress.push(event.phase));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    expect(secondProgress).toContain('ocr_runtime_wait');
    expect(mocks.execFile.mock.calls.filter(([, args]) => args[0] === 'venv')).toHaveLength(1);
    expect(mocks.execFile.mock.calls.filter(([, args]) => args[0] === 'pip')).toHaveLength(1);
    expect(mocks.execFile).toHaveBeenCalledTimes(3);

    await expect(_ensureOcrRuntimeForTest()).resolves.toMatchObject({ ok: true, installed: false });
    expect(mocks.execFile).toHaveBeenCalledTimes(3);
  });

  it('invalidates the ready cache when the virtualenv executable disappears', async () => {
    installSuccessfulExecMock();
    const first = await _ensureOcrRuntimeForTest();
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('runtime did not install');
    fs.rmSync(first.python, { force: true });

    await expect(_ensureOcrRuntimeForTest()).resolves.toMatchObject({ ok: true });
    expect(mocks.execFile.mock.calls.filter(([, args]) => args[0] === 'venv')).toHaveLength(2);
    expect(mocks.execFile.mock.calls.filter(([, args]) => args[0] === 'pip')).toHaveLength(2);
  });

  it('clears a failed in-flight install so a later call can retry', async () => {
    mocks.execFile.mockImplementationOnce((_file: string, _args: string[], _options: unknown, callback: Function) => {
      callback(new Error('venv locked'));
      return { kill: vi.fn() };
    });

    await expect(_ensureOcrRuntimeForTest()).resolves.toMatchObject({
      ok: false,
      errorCode: 'E_OCR_INSTALL_FAILED',
    });

    mocks.execFile.mockReset();
    installSuccessfulExecMock();
    await expect(_ensureOcrRuntimeForTest()).resolves.toMatchObject({ ok: true });
  });

  it('invalidates a cached runtime after a non-cancellation OCR process failure', async () => {
    installSuccessfulExecMock();
    await expect(_ensureOcrRuntimeForTest()).resolves.toMatchObject({ ok: true });
    const image = path.join(mocks.root, 'page.png');
    fs.writeFileSync(image, 'image');

    mocks.execFile.mockReset();
    mocks.execFile.mockImplementationOnce((_file: string, _args: string[], _options: unknown, callback: Function) => {
      callback(new Error('python runtime damaged'));
      return { kill: vi.fn() };
    });
    await expect(ocrImageText({ absPath: image })).resolves.toMatchObject({
      ok: false,
      errorCode: 'E_OCR_FAILED',
    });

    mocks.execFile.mockReset();
    installSuccessfulExecMock();
    await expect(_ensureOcrRuntimeForTest()).resolves.toMatchObject({ ok: true, installed: false });
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
  });
});
