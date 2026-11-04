import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { recoveredPreviewWindows, type PreviewAttempt, type PreviewRecoverySnapshot } from '../e2e/fixtures/preview-recovery';
import { analyzeWebAppLogs, navigationFailureReceipt } from '../e2e/fixtures/web-app-log-analysis';

const failed: PreviewAttempt = { id: 1, entryKey: 'app-a', version: 'before', stable: true,
  started: 1, ended: 2, interactions: true, ok: false, windows: [10],
  viewports: ['desktop:1280x800'], runtimeErrorWindows: [10] };
const fixed: PreviewAttempt = { ...failed, id: 2, version: 'after', started: 3, ended: 4,
  ok: true, windows: [20], runtimeErrorWindows: [] };
const snapshot = (attempts = [failed, fixed]): PreviewRecoverySnapshot => ({ attempts, currentVersions: { 'app-a': 'after' } });

describe('preview recovery ownership', () => {
  it('associates a later stable full preview with its exact failed window', () => {
    expect(recoveredPreviewWindows(snapshot())).toEqual([{ windowId: 10, failedAttempt: 1, recoveredBy: 2 }]);
  });
  it.each([
    ['different app', { entryKey: 'app-b' }],
    ['visual only', { interactions: false }],
    ['still failing', { ok: false }],
    ['runtime error hidden by success', { runtimeErrorWindows: [20] }],
    ['incomplete viewport', { viewports: ['mobile:390x844'] }],
    ['changed during preview', { stable: false }],
    ['version unavailable', { version: null }],
    ['changed after preview', { version: 'stale' }],
    ['overlapping attempt', { started: 2 }],
  ] as Array<[string, Partial<PreviewAttempt>]>)('does not accept %s as recovery', (_, change) => {
    expect(recoveredPreviewWindows(snapshot([failed, { ...fixed, ...change }]))).toEqual([]);
  });
  it('does not recover a failed attempt whose own runtime evidence is missing', () => {
    expect(recoveredPreviewWindows(snapshot([{ ...failed, runtimeErrorWindows: [] }, fixed]))).toEqual([]);
    expect(recoveredPreviewWindows(snapshot([{ ...failed, ended: 0 }, fixed]))).toEqual([]);
  });
  it('does not recover a window claimed by multiple attempts', () => {
    expect(recoveredPreviewWindows(snapshot([failed, { ...fixed, windows: [10] }]))).toEqual([]);
  });
  it('a new failed attempt invalidates an earlier apparent recovery', () => {
    expect(recoveredPreviewWindows(snapshot([failed, fixed, { ...failed, id: 3, started: 5, ended: 6, windows: [30] }]))).toEqual([]);
  });
  it('allows more viewports while requiring every originally tested viewport', () => {
    expect(recoveredPreviewWindows(snapshot([failed, { ...fixed, viewports: [...fixed.viewports, 'mobile:390x844'] }]))).toHaveLength(1);
  });
});

describe('recovered error log classification', () => {
  const log = '[renderer:pageerror] TypeError: deterministic fixture fault\n    at onsubmit (fixture:1:1)\n[main:stdout] done\n';
  const range = { start: 1, end: 2, diagnosticIndex: 0 };
  it('retains original error severity and full line coverage while reporting recovery as a warning', () => {
    expect(analyzeWebAppLogs(log).passed).toBe(false);
    const report = analyzeWebAppLogs(log, [range]);
    expect(report).toMatchObject({ passed: true, requiresReview: true, coveragePassed: true,
      recoveredRendererErrorCount: 1, originalLevelCounts: { error: 1 }, levelCounts: { warn: 1, error: 0 } });
    expect(report.capturedLineCount).toBe(report.analyzedLineCount);
    expect(report.originalFindings).toContainEqual(expect.objectContaining({ severity: 'error', source: 'renderer' }));
    expect(report.findings).toContainEqual(expect.objectContaining({ severity: 'warning', source: 'preview-recovery' }));
  });
  it.each([
    '[renderer:pageerror] TypeError: deterministic fixture fault',
    '[renderer:error] TypeError: deterministic fixture fault',
    '[main:stderr] [12:00:00.000] [error] [(host)] deterministic fixture fault',
    '[main:stderr] unknown process error',
    '[main:stderr] [123:1030/125107.715048:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:386] SharedImageManager::ProduceMemory: Trying to Produce a Memory representation from a non-existent mailbox.',
  ])('leaves unrelated or later error fatal: %s', extra => {
    const report = analyzeWebAppLogs(log + extra, [range]);
    expect(report.passed).toBe(false);
    expect(report.coveragePassed).toBe(true);
    expect(report.recoveredRendererErrorCount).toBe(1);
  });
  it('classifies CRLF debugger lifecycle logs while retaining fatal unknown stderr', () => {
    const lifecycle = '[main:stderr] Debugger listening on ws://127.0.0.1:9229/abcd-1234\r\n'
      + 'For help, see: https://nodejs.org/learn/getting-started/debugging\r\n'
      + '[main:stderr] Waiting for the debugger to disconnect...\r\n'
      + '[fixture-cleanup] {"phase":"application-close","outcome":"completed"}\r\n';
    const report = analyzeWebAppLogs(lifecycle);
    expect(report.passed).toBe(true);
    expect(report.coveragePassed).toBe(true);
    expect(report.capturedLineCount).toBe(report.analyzedLineCount);
    expect(analyzeWebAppLogs(lifecycle + 'unknown process error\r\n').passed).toBe(false);
  });
  it('rejects a claimed recovery on a main-process line', () => {
    expect(() => analyzeWebAppLogs(log, [{ start: 3, end: 3, diagnosticIndex: 1 }])).toThrow('Invalid recovered');
  });
});

describe('case-owned IPC failure log receipts', () => {
  const message = "[12:00:00.001] [error] [ (ipc)] invoke savedApps.delete failed { error: 'fixture rejection', code: 'E_UNKNOWN' }";
  const consoleLine = `[main:stderr] ${message}`;
  const fileLine = message.replace('[12:00:00.001]', '[2026-10-30 12:00:00.001]');
  const log = `${consoleLine}\n===== workspace/logs/main.log =====\n${fileLine}\n`;
  const receipt = { start: 1, end: 1, diagnosticIndex: 0, reason: 'expected-ipc-failure' as const,
    channel: 'savedApps.delete', messageHash: createHash('sha256').update(message).digest('hex') };
  it('retains both original errors and reviews only the exact console/file pair', () => {
    expect(analyzeWebAppLogs(log).passed).toBe(false);
    expect(analyzeWebAppLogs(log, [receipt])).toMatchObject({ passed: true, requiresReview: true,
      coveragePassed: true, expectedInvokeFailureCount: 1, originalLevelCounts: { error: 2 },
      levelCounts: { warn: 2, error: 0 }, recoveredRendererErrorCount: 0 });
  });
  const simultaneous = `${consoleLine}\n${consoleLine}\n===== workspace/logs/main.log =====\n${fileLine}\n${fileLine}\n`;
  const simultaneousReceipts = [receipt, { ...receipt, start: 2, end: 2, diagnosticIndex: 1 }];
  it('pairs distinct case-owned failures with identical messages in the same millisecond', () => {
    expect(analyzeWebAppLogs(simultaneous, simultaneousReceipts)).toMatchObject({
      passed: true, requiresReview: true, coveragePassed: true, expectedInvokeFailureCount: 2,
      originalLevelCounts: { error: 4 }, levelCounts: { warn: 4, error: 0 },
    });
  });
  it('rejects acknowledging the same console occurrence twice', () => {
    expect(() => analyzeWebAppLogs(log, [receipt, { ...receipt }])).toThrow('IPC failure');
  });
  it.each([
    ['unacknowledged console occurrence', simultaneous, [receipt]],
    ['missing repeated file evidence', `${consoleLine}\n${consoleLine}\n===== workspace/logs/main.log =====\n${fileLine}\n`, simultaneousReceipts],
    ['extra repeated console evidence', `${consoleLine}\n${simultaneous}`, simultaneousReceipts],
    ['extra repeated file evidence', `${simultaneous}${fileLine}\n`, simultaneousReceipts],
  ])('rejects %s for same-millisecond failures', (_, raw, receipts) => {
    expect(() => analyzeWebAppLogs(raw, receipts)).toThrow('IPC failure');
  });
  it('keeps unknown stderr fatal after accepting repeated case-owned failures', () => {
    expect(analyzeWebAppLogs(`${simultaneous}[main:stderr] unexpected native error\n`, simultaneousReceipts).passed).toBe(false);
  });
  it.each([
    ['unobserved error', log.replaceAll('12:00:00.001', '12:00:00.002')],
    ['missing file evidence', `${consoleLine}\n`],
    ['duplicate error', `${log}${consoleLine}\n`],
  ])('rejects %s', (_, raw) => {
    expect(() => analyzeWebAppLogs(raw, [receipt])).toThrow('IPC failure');
  });
  it('leaves another error on the same channel fatal', () => {
    expect(analyzeWebAppLogs(log + consoleLine.replace('12:00:00.001', '12:00:00.002'), [receipt]).passed).toBe(false);
  });
  it('rejects a mismatched channel, forged hash or receipt on a renderer line', () => {
    for (const change of [{ channel: 'savedApps.openForEditing' }, { messageHash: '0'.repeat(64) }, { start: 2, end: 2 }]) {
      expect(() => analyzeWebAppLogs(log, [{ ...receipt, ...change }])).toThrow('IPC failure');
    }
  });
});

describe('case-owned renderer fixture fault receipts', () => {
  const log = '[renderer:error] deliberate fixture fault';
  const receipt = { start: 1, end: 1, diagnosticIndex: 0, reason: 'expected-renderer-failure' as const,
    messageHash: createHash('sha256').update(log).digest('hex') };
  it('retains original severity and leaves subsequent identical faults fatal', () => {
    expect(analyzeWebAppLogs(log, [receipt])).toMatchObject({ passed: true, requiresReview: true,
      expectedRendererFailureCount: 1, originalLevelCounts: { error: 1 }, levelCounts: { error: 0, warn: 1 } });
    expect(analyzeWebAppLogs(log + '\n' + log, [receipt]).passed).toBe(false);
  });
  it('rejects changed messages, forged hashes and main-process look-alikes', () => {
    expect(() => analyzeWebAppLogs(log + ' changed', [receipt])).toThrow('Invalid expected renderer');
    expect(() => analyzeWebAppLogs(log, [{ ...receipt, messageHash: '0'.repeat(64) }])).toThrow('Invalid expected renderer');
    expect(() => analyzeWebAppLogs('[main:stderr] deliberate fixture fault', [receipt])).toThrow('Invalid recovered renderer');
  });
});

describe('case-owned Electron navigation failures', () => {
  it('binds navigation receipts to the Electron main process rather than its launcher', async () => {
    const source = readFileSync(new URL('../e2e/fixtures/orkas.ts', import.meta.url), 'utf8');
    const start = source.indexOf('  async acknowledgeNavigationFailure(');
    const end = source.indexOf('\n  private async acknowledgeMainFailures', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const method = ts.transpileModule(`({${source.slice(start, end)}})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const owner = runInNewContext(method, { process: { pid: 999 }, navigationFailureReceipt });
    owner.electronApp = { process: () => ({ pid: 41 }), evaluate: async (callback: Function) =>
      runInNewContext(`(${callback.toString()})()`, { process: { pid: 742 } }) };
    const url = 'http://127.0.0.1:1234/fixture?item=one#board';
    const line = `[12:00:00.001] [error] [ (console)] (node:742) electron: Failed to load URL: ${url} with error: ERR_CONNECTION_REFUSED`;
    let observed = false;
    owner.acknowledgeMainFailures = async (match: (line: string) => string | undefined,
      count: number, after: number, metadata: unknown) => {
      observed = true;
      expect(match(line)).toBeTypeOf('string');
      for (const changed of [line.replace('742', '41'), line.replace('742', '999'),
        line.replace('/fixture?', '/other?'), line.replace('REFUSED', 'RESET')]) expect(match(changed)).toBeUndefined();
      expect(count).toBe(1);
      expect(after).toBe(39);
      expect(metadata).toEqual({ reason: 'expected-navigation-failure' });
    };
    await owner.acknowledgeNavigationFailure(url, 'ERR_CONNECTION_REFUSED', 39);
    expect(observed).toBe(true);
  });

  const message = '(node:42) electron: Failed to load URL: http://127.0.0.1:1234/fixture with error: ERR_CONNECTION_REFUSED';
  const line = `[12:00:00.001] [error] [ (console)] ${message}`;
  const log = `[main:stderr] ${line}\n===== workspace/logs/main.log =====\n${line.replace('[12:00:00.001]', '[2026-10-30 12:00:00.001]')}\n`;
  const receipt = { start: 1, end: 1, diagnosticIndex: 0, reason: 'expected-navigation-failure' as const,
    messageHash: navigationFailureReceipt(line, message) };
  it('requires the exact process, URL and net error, retaining both original errors', () => {
    expect(analyzeWebAppLogs(log, [receipt])).toMatchObject({ passed: true, requiresReview: true,
      expectedNavigationFailureCount: 1, originalLevelCounts: { error: 2 }, levelCounts: { warn: 2, error: 0 } });
    for (const changed of [message.replace('42', '43'), message.replace('/fixture', '/other'), message.replace('REFUSED', 'RESET')]) {
      expect(navigationFailureReceipt(line, changed)).toBeUndefined();
    }
    expect(navigationFailureReceipt(line.replace('Failed to load URL:', 'Other failure:'))).toBeUndefined();
  });
  it('rejects missing/duplicated evidence and leaves a later failure or unknown stderr fatal', () => {
    expect(() => analyzeWebAppLogs(log.split('\n')[0], [receipt])).toThrow('IPC failure');
    expect(() => analyzeWebAppLogs(log + `[main:stderr] ${line}`, [receipt])).toThrow('IPC failure');
    expect(analyzeWebAppLogs(log + `[main:stderr] ${line.replace('12:00:00.001', '12:00:00.002')}`, [receipt]).passed).toBe(false);
    expect(analyzeWebAppLogs(log + '[main:stderr] unexpected native error', [receipt]).passed).toBe(false);
  });
});
