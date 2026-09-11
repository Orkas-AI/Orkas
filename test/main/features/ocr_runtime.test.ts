import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

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
  ocrFile,
  ocrImageText,
  OCR_RUNTIME_KEY,
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

async function useRealPythonWithGbkParent(text: string, fail = false): Promise<void> {
  const childProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const localPython = path.resolve(__dirname, '../../../../venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const candidates = [process.env.ORKAS_TEST_PYTHON, localPython, 'python3', 'python'];
  const python = candidates.find((candidate) => candidate
    && childProcess.spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0);
  if (!python) throw new Error('OCR encoding regression requires Python; set ORKAS_TEST_PYTHON');

  const venvPython = _ocrVenvPythonForTest();
  fs.mkdirSync(path.dirname(venvPython), { recursive: true });
  fs.writeFileSync(venvPython, 'python');
  const modules = path.join(mocks.root, 'python-modules');
  fs.mkdirSync(modules);
  // Only the recognition engine is replaced. Execute the production Python
  // script and its real stdout bytes through Node's normal UTF-8 decoder.
  fs.writeFileSync(path.join(modules, 'rapidocr.py'), [
    'class RapidOCR:',
    '    def __init__(self, params=None): pass',
    '    def __call__(self, image_path):',
    fail ? `        raise ValueError(${JSON.stringify(text)})`
      : `        return [[${JSON.stringify(text)}, 0.99]]`,
    '',
  ].join('\n'), 'utf8');
  for (const name of ['onnxruntime', 'pypdfium2']) {
    fs.writeFileSync(path.join(modules, `${name}.py`), '');
  }
  vi.stubEnv('PYTHONIOENCODING', 'gbk');
  vi.stubEnv('PYTHONUTF8', '0');
  mocks.execFile.mockImplementation((_file: string, args: string[], options: any, callback: Function) => (
    childProcess.execFile(python, args, {
      ...options,
      env: { ...options.env, PYTHONPATH: modules },
    }, (error, stdout, stderr) => callback(error, { stdout, stderr }))
  ));
}

describe('OCR runtime provisioning', () => {
  beforeEach(() => {
    mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ocr-runtime-'));
    mocks.execFile.mockReset();
    _resetOcrRuntimeForTest();
  });

  afterEach(() => {
    _resetOcrRuntimeForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(mocks.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('uses the platform-native virtualenv executable layout', () => {
    expect(_ocrVenvPythonForTest('D:\\venv', 'win32')).toBe(path.join('D:\\venv', 'Scripts', 'python.exe'));
    expect(_ocrVenvPythonForTest('/tmp/venv', 'darwin')).toBe(path.join('/tmp/venv', 'bin', 'python'));
  });

  it.each(['中文识别结果', '中文 • 🚀'])('preserves %s through Python stdout and the OCR cache with a GBK parent', async (text) => {
    await useRealPythonWithGbkParent(text);
    const image = path.join(mocks.root, 'page.jpg');
    fs.writeFileSync(image, 'image');

    await expect(ocrImageText({ absPath: image })).resolves.toMatchObject({
      ok: true, text, items: [{ text, score: 0.99 }],
    });
    const first = await ocrFile({ userId: 'ocr-owner', absPath: image });
    expect(first).toMatchObject({ ok: true, cached: false, content: expect.stringContaining(text) });
    const runs = mocks.execFile.mock.calls.length;
    await expect(ocrFile({ userId: 'ocr-owner', absPath: image })).resolves.toMatchObject({
      ok: true, cached: true, content: expect.stringContaining(text),
    });
    expect(mocks.execFile).toHaveBeenCalledTimes(runs);
  });

  it('preserves a Unicode engine error instead of failing to encode the error response', async () => {
    const message = '无法识别 • 🚀';
    await useRealPythonWithGbkParent(message, true);
    const image = path.join(mocks.root, 'page.jpg');
    fs.writeFileSync(image, 'image');

    await expect(ocrImageText({ absPath: image })).resolves.toMatchObject({
      ok: false, errorCode: 'E_OCR_FAILED', message: expect.stringContaining(message),
    });
  });

  it('rebuilds a legacy cache that may contain text decoded with the wrong encoding', async () => {
    await useRealPythonWithGbkParent('中文');
    const image = path.join(mocks.root, 'page.jpg');
    fs.writeFileSync(image, 'image');
    const stat = fs.statSync(image);
    const shortHash = (value: string) => createHash('sha1').update(value).digest('hex').slice(0, 16);
    // Freeze the persisted v2 format: changing the production cache key must
    // leave this old, potentially corrupted entry ineligible for reuse.
    const oldKey = shortHash(JSON.stringify({
      cacheVersion: 2,
      absPath: image,
      size: stat.size,
      mtime: stat.mtimeMs,
      ctime: stat.ctimeMs,
      contentSha256: createHash('sha256').update('image').digest('hex'),
      pages: '',
      runtime: OCR_RUNTIME_KEY,
    }));
    const cacheDir = path.join(mocks.root, 'cache', shortHash(image));
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, `ocr.${oldKey}.md`), '����');

    await expect(ocrFile({ userId: 'ocr-owner', absPath: image })).resolves.toMatchObject({
      ok: true, cached: false, content: expect.stringContaining('中文'),
    });
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

  it('clears an incomplete existing virtualenv before recreating it', async () => {
    const staleVenv = path.join(mocks.root, '.venv');
    fs.mkdirSync(staleVenv, { recursive: true });
    fs.writeFileSync(path.join(staleVenv, 'interrupted-install'), 'stale');
    installSuccessfulExecMock();

    await expect(_ensureOcrRuntimeForTest()).resolves.toMatchObject({ ok: true });

    const venvCall = mocks.execFile.mock.calls.find(([, args]) => args[0] === 'venv');
    expect(venvCall?.[1]).toEqual([
      'venv',
      '--clear',
      '--python',
      mocks.python,
      staleVenv,
    ]);
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

  it('does not reuse stale OCR after a same-size file is replaced with its mtime preserved', async () => {
    const python = _ocrVenvPythonForTest();
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, 'python');
    const image = path.join(mocks.root, 'page.png');
    fs.writeFileSync(image, 'first-image');
    const fixedTime = new Date('2026-01-01T00:00:00.000Z');
    fs.utimesSync(image, fixedTime, fixedTime);
    const stableStat = await fs.promises.stat(image);
    // Model filesystems where same-size replacements preserve or collide on every
    // timestamp, so this test proves content identity is part of the cache key.
    vi.spyOn(fs.promises, 'stat').mockResolvedValue(stableStat);
    let ocrRuns = 0;
    mocks.execFile.mockImplementation((_file: string, args: string[], _options: unknown, callback: Function) => {
      if (args.length === 2) {
        callback(null, { stdout: 'ok', stderr: '' });
      } else {
        ocrRuns += 1;
        callback(null, {
          stdout: JSON.stringify({
            ok: true,
            pages: [{ page: 1, text: ocrRuns === 1 ? 'first result' : 'second result', items: [] }],
          }),
          stderr: '',
        });
      }
      return { kill: vi.fn() };
    });

    const first = await ocrFile({ userId: 'ocr-owner', absPath: image });
    expect(first).toMatchObject({ ok: true, cached: false });
    if (!first.ok) return;
    expect(first.content).toContain('first result');

    fs.writeFileSync(image, 'other-image');
    fs.utimesSync(image, fixedTime, fixedTime);
    const second = await ocrFile({ userId: 'ocr-owner', absPath: image });

    expect(second).toMatchObject({ ok: true, cached: false });
    if (!second.ok) return;
    expect(second.content).toContain('second result');
    expect(ocrRuns).toBe(2);
  });

  it('flattens a transparent image before sending it to the OCR process and removes the temporary copy', async () => {
    const python = _ocrVenvPythonForTest();
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, 'python');
    const image = path.join(mocks.root, 'transparent.png');
    const { Jimp } = await import('jimp' as any);
    const transparent: any = new Jimp({ width: 20, height: 20, color: 0x00000000 });
    fs.writeFileSync(image, await transparent.getBuffer('image/png'));
    let preparedPath = '';

    mocks.execFile.mockImplementation((_file: string, args: string[], _options: unknown, callback: Function) => {
      if (args.length === 2) {
        callback(null, { stdout: 'ok', stderr: '' });
      } else {
        const payload = JSON.parse(args[2]);
        preparedPath = payload.path;
        expect(preparedPath).not.toBe(image);
        expect(fs.readFileSync(preparedPath).subarray(0, 3).toString('hex')).toBe('ffd8ff');
        callback(null, {
          stdout: JSON.stringify({
            ok: true,
            pages: [{ page: 1, text: 'visible', items: [] }],
          }),
          stderr: '',
        });
      }
      return { kill: vi.fn() };
    });

    await expect(ocrFile({ userId: 'ocr-owner', absPath: image })).resolves.toMatchObject({ ok: true });
    expect(preparedPath).not.toBe('');
    expect(fs.existsSync(preparedPath)).toBe(false);
  });
});
