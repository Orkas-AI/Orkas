import { afterEach, describe, expect, it, vi } from 'vitest';
const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ warn }) }));
import { createWebAssistDiagnostics } from '../../../src/main/features/web_assist_diagnostics';

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('local browser diagnostics', () => {
  it.each([
    ['crashed', 1, 'crashed', 1],
    ['oom', -1, 'oom', -1],
    ['killed', Number.MIN_SAFE_INTEGER, 'killed', Number.MIN_SAFE_INTEGER],
    ['abnormal-exit', Number.MAX_SAFE_INTEGER, 'abnormal-exit', Number.MAX_SAFE_INTEGER],
    ['crashed', 3221225477, 'crashed', 3221225477],
    ['PRIVATE_REASON', 'PRIVATE_CODE', 'unknown', 'unknown'],
    ['killed', Number.MAX_SAFE_INTEGER + 1, 'killed', 'unknown'],
    ['oom', NaN, 'oom', 'unknown'],
  ])('retains native exit %s/%s in local diagnostics without expanding telemetry', (reason, exitCode, safeReason, safeCode) => {
    const sender = { isDestroyed: () => false, send: vi.fn() };
    const report = createWebAssistDiagnostics();
    report(sender, 'renderer_gone', undefined, undefined, { reason, exitCode });
    expect(warn).toHaveBeenCalledExactlyOnceWith('browser failure', expect.objectContaining({
      renderer_exit_reason: safeReason, renderer_exit_code: safeCode,
    }));
    expect(sender.send).not.toHaveBeenCalled();
    for (let i = 0; i < 100; i++) report(sender, 'renderer_gone', undefined, undefined, { reason, exitCode });
    expect(warn).toHaveBeenCalledOnce();
    expect(sender.send).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE');
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain('PRIVATE');
  });


  it('merges repeated failures across tabs and admits later failures without URL or exception data', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const report = createWebAssistDiagnostics();
    const sender = { isDestroyed: () => false };
    report(sender, 'page_load_failed', -105);
    expect(warn).toHaveBeenCalledExactlyOnceWith('browser failure', {
      stage: 'load', error_type: 'network', error_message: 'Browser main-frame navigation failed',
      error_code: 'page_load_failed', net_error_code: -105, suppressed_count: 0,
    });
    for (let i = 0; i < 100; i++) report(sender, 'page_load_failed', -118);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300_000);
    report(sender, 'page_load_failed', 'https://user:secret@example.com/path?token=secret');
    expect(warn.mock.calls[1][1]).toEqual({
      stage: 'load', error_type: 'network', error_message: 'Browser main-frame navigation failed',
      error_code: 'page_load_failed', suppressed_count: 100,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });

  it('caps all windows and failure classes at twelve per rolling hour with bounded aggregation', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const report = createWebAssistDiagnostics();
    const kinds = ['page_load_failed', 'page_unresponsive', 'renderer_gone', 'view_unavailable'] as const;
    for (let batch = 0; batch < 4; batch++) {
      for (const kind of kinds) report({ isDestroyed: () => false }, kind);
      vi.advanceTimersByTime(300_000);
    }
    expect(warn).toHaveBeenCalledTimes(12);
    for (let i = 0; i < 11000; i++) report({ isDestroyed: () => false }, 'renderer_gone');
    vi.setSystemTime(3_600_000);
    report({ isDestroyed: () => false }, 'renderer_gone');
    expect(warn.mock.calls[12][1].suppressed_count).toBe(9999);
    expect(warn).toHaveBeenCalledTimes(13);
  });

  it('ignores invalid categories and closed owners, and never lets logging failure affect the browser', () => {
    const report = createWebAssistDiagnostics();
    report({ isDestroyed: () => true }, 'renderer_gone');
    report({ isDestroyed: () => false }, 'private-url' as any);
    expect(warn).not.toHaveBeenCalled();
    warn.mockImplementationOnce(() => { throw new Error('fixture logger unavailable'); });
    expect(() => report({ isDestroyed: () => false }, 'renderer_gone')).not.toThrow();
  });
});
