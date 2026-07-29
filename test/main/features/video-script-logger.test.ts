import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/logger-shim';

describe('VideoStudio bundled script logger', () => {
  const originalDebug = process.env.ORKAS_VIDEO_SCRIPT_DEBUG;

  beforeEach(() => {
    delete process.env.ORKAS_VIDEO_SCRIPT_DEBUG;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDebug == null) delete process.env.ORKAS_VIDEO_SCRIPT_DEBUG;
    else process.env.ORKAS_VIDEO_SCRIPT_DEBUG = originalDebug;
  });

  it('does not emit video-script diagnostics unless explicitly enabled', () => {
    const spies = [
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
    ];
    const logger = createLogger('video-edit');

    logger.error('failed');
    logger.warn('warning');
    logger.info('working');
    logger.debug('details');

    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  it('routes each enabled level and preserves ordinary bounded context', () => {
    process.env.ORKAS_VIDEO_SCRIPT_DEBUG = '1';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const logger = createLogger('video-edit');

    logger.error('failed', { code: 7 });
    logger.warn('warning');
    logger.info('working');
    logger.debug('details');

    expect(error).toHaveBeenCalledWith('[video-edit] failed', { code: 7 });
    expect(warn).toHaveBeenCalledWith('[video-edit] warning');
    expect(info).toHaveBeenCalledWith('[video-edit] working');
    expect(debug).toHaveBeenCalledWith('[video-edit] details');
  });

  it('prevents forged lines and redacts paths, credentials and content recursively', () => {
    process.env.ORKAS_VIDEO_SCRIPT_DEBUG = '1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const circular: Record<string, unknown> = {
      apiKey: 'sk-private-value',
      nested: {
        path: 'C:\\Users\\alice\\private\\clip.mp4',
        content: 'private transcript',
      },
      ok: true,
    };
    circular.self = circular;
    const logger = createLogger('ocr-runtime]\n[forged');

    logger.warn(
      'failed path=/Users/test/project/clip.mp4 token=raw-token Authorization: Bearer raw-bearer',
      circular,
    );

    expect(warn).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(warn.mock.calls[0]);
    expect(serialized).not.toMatch(/alice|private transcript|raw-token|raw-bearer|sk-private|\\n/);
    expect(serialized).toContain('<local-path>');
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('[Circular]');
    expect(serialized).toContain('"ok":true');
  });

  it('bounds adversarial messages, collections and nesting', () => {
    process.env.ORKAS_VIDEO_SCRIPT_DEBUG = '1';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const logger = createLogger(`scope-${'x'.repeat(500)}`);
    const values = Array.from({ length: 100 }, (_, index) => ({ index }));

    logger.info('m'.repeat(10_000), { values, deep: { a: { b: { c: { d: 'hidden' } } } } });

    const [line, context] = info.mock.calls[0] as [string, Record<string, unknown>];
    expect(line.length).toBeLessThan(2_200);
    expect(line).toContain('…[truncated]');
    expect((context.values as unknown[])).toHaveLength(33);
    expect(JSON.stringify(context)).toContain('[MaxDepth]');
  });
});
