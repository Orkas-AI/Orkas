import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import {
  bindAbort,
  killProcessTree,
  levelOrInfo,
  LineSplitter,
  reapCliAfterProtocolTerminal,
  StderrTail,
  stripAnsi,
} from '../../../../src/main/features/local_agents/backends/base';

const itPosix = process.platform === 'win32' ? it.skip : it;

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

  it('strips terminal color and OSC sequences from persisted CLI diagnostics', () => {
    expect(stripAnsi('\u001b[2m2026-07-21\u001b[0m \u001b[31mERROR\u001b[0m cache failed'))
      .toBe('2026-07-21 ERROR cache failed');
    expect(stripAnsi('\u001b]0;secret title\u0007plain')).toBe('plain');
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

  it('uses taskkill tree mode on Windows and falls back when taskkill fails', () => {
    const callbacks = new Map<string, (...args: any[]) => void>();
    const killer = {
      once: vi.fn((event: string, cb: (...args: any[]) => void) => {
        callbacks.set(event, cb);
        return killer;
      }),
      unref: vi.fn(),
    };
    const spawnFn = vi.fn(() => killer);
    const child = { pid: 2468, kill: vi.fn() };

    killProcessTree(child as any, 'SIGTERM', {
      platform: 'win32',
      spawnFn: spawnFn as any,
    });

    expect(spawnFn).toHaveBeenCalledWith(
      expect.stringMatching(/taskkill\.exe$/i),
      ['/pid', '2468', '/t', '/f'],
      { stdio: 'ignore', windowsHide: true },
    );
    expect(killer.unref).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();

    callbacks.get('exit')?.(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('falls back to the direct Windows child when taskkill cannot start', () => {
    const child = { pid: 1357, kill: vi.fn() };
    const spawnFn = vi.fn(() => { throw new Error('spawn failed'); });

    killProcessTree(child as any, 'SIGKILL', {
      platform: 'win32',
      spawnFn: spawnFn as any,
    });

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  itPosix('reaps a CLI asynchronously after an authoritative protocol terminal', () => {
    vi.useFakeTimers();
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const child = Object.assign(new EventEmitter(), {
      pid: 24680,
      stdin: { end: vi.fn() },
      kill: vi.fn(),
    });

    try {
      reapCliAfterProtocolTerminal(child as any, 50);
      expect(child.stdin.end).toHaveBeenCalledOnce();
      expect(processKill).not.toHaveBeenCalled();

      vi.advanceTimersByTime(50);
      expect(processKill).toHaveBeenCalledWith(-24680, 'SIGTERM');

      vi.advanceTimersByTime(10_000);
      expect(processKill).toHaveBeenCalledWith(-24680, 'SIGKILL');

      child.emit('close', 0);
      const callsAtClose = processKill.mock.calls.length;
      vi.advanceTimersByTime(20_000);
      expect(processKill).toHaveBeenCalledTimes(callsAtClose);
    } finally {
      processKill.mockRestore();
      vi.useRealTimers();
    }
  });
});
