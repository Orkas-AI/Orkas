import { describe, it, expect, vi } from 'vitest';

import {
  bindAbort,
  levelOrInfo,
  LineSplitter,
  StderrTail,
} from '../../../../src/main/features/local_agents/backends/base';

describe('local_agents/backends/base', () => {
  it('keeps only the bounded stderr tail', () => {
    const tail = new StderrTail(8);

    tail.push('abc');
    tail.push('def');
    tail.push('ghi');

    expect(tail.toString()).toBe('defghi');

    tail.push('0123456789');
    expect(tail.toString()).toBe('23456789');
  });

  it('splits newline-delimited chunks and flushes trailing data', () => {
    const splitter = new LineSplitter();
    const lines: string[] = [];

    splitter.push('one\r\ntwo', line => lines.push(line));
    splitter.push(' continued\nthree\n', line => lines.push(line));
    splitter.push('tail', line => lines.push(line));
    splitter.flush(line => lines.push(line));
    splitter.flush(line => lines.push(line));

    expect(lines).toEqual(['one', 'two continued', 'three', 'tail']);
  });

  it('normalizes CLI log levels to the renderer contract', () => {
    expect(levelOrInfo('TRACE')).toBe('debug');
    expect(levelOrInfo('warning')).toBe('warn');
    expect(levelOrInfo('fatal')).toBe('error');
    expect(levelOrInfo('notice')).toBe('info');
    expect(levelOrInfo(3)).toBe('info');
  });

  it('sends SIGTERM on abort, escalates to SIGKILL, and cleans up listeners', () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const kills: string[] = [];
    const child = {
      kill: (signal: string) => {
        kills.push(signal);
        return true;
      },
    } as any;

    const cleanup = bindAbort(child, ac.signal, 50);
    ac.abort();
    expect(kills).toEqual(['SIGTERM']);

    vi.advanceTimersByTime(50);
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);

    cleanup();
    vi.advanceTimersByTime(100);
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
    vi.useRealTimers();
  });
});
