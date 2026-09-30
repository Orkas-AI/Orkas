import { describe, expect, it } from 'vitest';
import { recoveredPreviewWindows, type PreviewAttempt, type PreviewRecoverySnapshot } from '../e2e/fixtures/preview-recovery';
import { analyzeWebAppLogs } from '../e2e/fixtures/web-app-log-analysis';

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
