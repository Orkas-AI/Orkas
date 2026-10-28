import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

async function checkNativeStderr(stderr: string, platform: NodeJS.Platform = process.platform) {
  const { ELECTRON_MACOS_TASK_POLICY_WARNING_RE } = await import('../../../../scripts/model-eval-log-policy.mjs');
  for (const line of stderr.split(/\r?\n/).filter(Boolean)) {
    expect(platform === 'darwin' && ELECTRON_MACOS_TASK_POLICY_WARNING_RE.test(line),
      'Unexpected native Chromium stderr').toBe(true);
    console.warn('[native-host-warning]', line);
  }
}

it('renders actual blank Office pages but rejects absent selections in native Chromium', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-page-selection-'));
  const env = { ...process.env, ORKAS_WORKSPACE_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const resultPath = path.join(root, 'results.json');
    const logs = await promisify(execFile)(require('electron'), [
      path.resolve('test/fixtures/office/page-selection-render.cjs'), process.cwd(), resultPath,
    ], { env, timeout: 30_000, maxBuffer: 256 * 1024 });
    // Even an otherwise empty Electron app emits one console CRLF on Windows.
    expect(process.platform === 'win32' ? ['', '\r\n'] : ['']).toContain(logs.stdout);
    await checkNativeStderr(logs.stderr);
    const results = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    expect(results).toHaveLength(6);
    for (const row of results) {
      expect(row.rendered, JSON.stringify(row)).toBe(row.visible);
      if (!row.visible) expect(row.error).toContain('E_OFFICE_RENDER_PAGE_UNAVAILABLE');
      if (row.visible) {
        expect(row.security).toMatchObject({ inlineScript: true, nodeAccess: false, evalBlocked: true, connectBlocked: true });
        expect(row.security.evalRan).toBeUndefined();
        // The attempted data: fetch is an explicit negative control. Keep its
        // CSP diagnostics visible while rejecting unrelated browser output.
        expect(row.security.logs).toHaveLength(2);
        for (const log of row.security.logs) {
          expect(log.level).toBe('error');
          expect(log.message).toContain('Content Security Policy');
          expect(log.message).toContain('data:text/plain,controlled-probe');
        }
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 40_000);

it.skipIf(!['darwin', 'win32'].includes(process.platform))('partitions a Word handover consistently across the first two real preview pages', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-word-pagination-'));
  const env = { ...process.env, ORKAS_WORKSPACE_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const resultPath = path.join(root, 'results.json');
    const logs = await promisify(execFile)(require('electron'), [
      path.resolve('test/fixtures/office/word-pagination.cjs'), process.cwd(), resultPath,
    ], { env, timeout: 30_000, maxBuffer: 256 * 1024 });
    // The existing Windows native-test contract permits Electron's sole CRLF.
    expect(process.platform === 'win32' ? ['', '\r\n'] : ['']).toContain(logs.stdout);
    await checkNativeStderr(logs.stderr);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    expect(result.remainingWindows).toBe(0);
    expect(result.rows).toHaveLength(2);
    const rows = result.rows.sort((a: { page: string }, b: { page: string }) => Number(a.page) - Number(b.page));
    for (const row of rows) {
      expect(row.logs).toEqual([]);
      expect(row.pngHeader).toBe('89504e470d0a1a0a');
      expect(row.darkPixels).toBeGreaterThan(100);
      expect(row.sourcePreserved).toBe(true);
      expect(row.paragraphs.length).toBeGreaterThan(0);
    }
    // Independent source enumeration: each visible line appears exactly once,
    // in order, without prescribing the font-dependent page-break position.
    expect(rows.flatMap((row: { paragraphs: string[] }) => row.paragraphs)).toEqual(
      Array.from({ length: 24 }, (_, i) => `Line ${String(i + 1).padStart(3, '0')}: confirmed handover item`),
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 40_000);


// Synthetic classification controls do not launch Electron or rewrite raw logs.
const categoryWarning = '[12345:1026/194646.769918:ERROR:base/process/process_mac.cc:98] task_policy_set TASK_CATEGORY_POLICY: (os/kern) invalid argument (4)';
const suppressionWarning = '[12346:1026/194646.769919:ERROR:base/process/process_mac.cc:98] task_policy_set TASK_SUPPRESSION_POLICY: (os/kern) invalid argument (4)';

it('retains both exact macOS native policy diagnostics with their original lines', async () => {
  // Only these synthetic warnings are intercepted; real native cases above
  // retain console.warn output for the shared log-analysis gate.
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await checkNativeStderr('', 'darwin');
    expect(warn).not.toHaveBeenCalled();
    await checkNativeStderr(categoryWarning + '\r\n' + suppressionWarning + '\r\n', 'darwin');
    expect(warn.mock.calls).toEqual([
      ['[native-host-warning]', categoryWarning],
      ['[native-host-warning]', suppressionWarning],
    ]);
  } finally { warn.mockRestore(); }
});

it.each([
  ['unknown stderr', 'Unexpected renderer launch failure'],
  ['different kernel code', categoryWarning.replace('(4)', '(5)')],
  ['different native source', categoryWarning.replace('process_mac.cc', 'process_linux.cc')],
  ['additional trailing text', categoryWarning + ' another diagnostic'],
])('rejects %s without classifying it as a native host warning', async (_label, stderr) => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await expect(checkNativeStderr(stderr, 'darwin')).rejects.toThrow('Unexpected native Chromium stderr');
    expect(warn).not.toHaveBeenCalled();
  } finally { warn.mockRestore(); }
});

it.each(['win32', 'linux'] as const)('rejects the macOS native signature on %s', async platform => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await expect(checkNativeStderr(categoryWarning, platform)).rejects.toThrow('Unexpected native Chromium stderr');
    expect(warn).not.toHaveBeenCalled();
  } finally { warn.mockRestore(); }
});

it('rejects mixed stderr while retaining the preceding exact native warning', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await expect(checkNativeStderr(categoryWarning + '\nUnexpected renderer launch failure\n', 'darwin'))
      .rejects.toThrow('Unexpected native Chromium stderr');
    expect(warn.mock.calls).toEqual([['[native-host-warning]', categoryWarning]]);
  } finally { warn.mockRestore(); }
});
