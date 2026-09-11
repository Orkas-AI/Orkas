import { afterEach, describe, expect, it, vi } from 'vitest';
const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ warn }) }));
import { createWebAssistDiagnostics } from '../../../src/main/features/web_assist_diagnostics';

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('core browser incident sampling', () => {
  it('merges repeated failures across tabs and admits later failures without URL or exception data', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const report = createWebAssistDiagnostics();
    const sender = { isDestroyed: () => false, send: vi.fn() };
    report(sender, 'page_load_failed', -105);
    expect(sender.send).toHaveBeenCalledExactlyOnceWith('web-assist:failure', {
      stage: 'load', error_type: 'network', error_message: 'Browser main-frame navigation failed',
      error_code: 'page_load_failed', net_error_code: -105, suppressed_count: 0,
    });
    for (let i = 0; i < 100; i++) report(sender, 'page_load_failed', -118);
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300_000);
    report(sender, 'page_load_failed', 'https://user:secret@example.com/path?token=secret');
    expect(sender.send.mock.calls[1][1]).toEqual({
      stage: 'load', error_type: 'network', error_message: 'Browser main-frame navigation failed',
      error_code: 'page_load_failed', suppressed_count: 100,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain('example.com');
  });

  it('caps all windows and failure classes at twelve per rolling hour with bounded aggregation', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const report = createWebAssistDiagnostics();
    const send = vi.fn();
    const kinds = ['page_load_failed', 'page_unresponsive', 'renderer_gone', 'view_unavailable'] as const;
    for (let batch = 0; batch < 4; batch++) {
      for (const kind of kinds) report({ isDestroyed: () => false, send }, kind);
      vi.advanceTimersByTime(300_000);
    }
    expect(send).toHaveBeenCalledTimes(12);
    for (let i = 0; i < 11000; i++) report({ isDestroyed: () => false, send }, 'renderer_gone');
    expect(send).toHaveBeenCalledTimes(12);
    vi.setSystemTime(3_600_000);
    report({ isDestroyed: () => false, send }, 'renderer_gone');
    expect(send).toHaveBeenCalledTimes(13);
    expect(send.mock.calls[12][1].suppressed_count).toBe(9999);
    expect(warn).toHaveBeenCalledTimes(13);
  });

  it('ignores invalid categories and closed owners, and never lets telemetry failure affect the browser', () => {
    const report = createWebAssistDiagnostics();
    const send = vi.fn(() => { throw new Error('fixture send unavailable'); });
    report({ isDestroyed: () => true, send }, 'renderer_gone');
    report({ isDestroyed: () => false, send }, 'private-url' as any);
    expect(send).not.toHaveBeenCalled();
    warn.mockImplementationOnce(() => { throw new Error('fixture logger unavailable'); });
    expect(() => report({ isDestroyed: () => false, send }, 'renderer_gone')).not.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });
});
