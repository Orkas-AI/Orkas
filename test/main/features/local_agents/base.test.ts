import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const { cleanupWarning } = vi.hoisted(() => ({ cleanupWarning: vi.fn() }));
vi.mock('../../../../src/main/logger', () => ({ createLogger: () => ({ warn: cleanupWarning }) }));

import {
  bindAbort,
  killProcessTree,
  levelOrInfo,
  LineSplitter,
  reapCliAfterProtocolTerminal,
  spawnCli,
  StderrTail,
  stripAnsi,
} from '../../../../src/main/features/local_agents/backends/base';

const itPosix = process.platform === 'win32' ? it.skip : it;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (processIsAlive(pid)) throw new Error(`process ${pid} did not exit`);
}

describe('local_agents/backends/base', () => {
  it('assembles one long line delivered in many chunks without rescanning', () => {
    // A single stream-json line carrying a base64 image arrives in 64 KiB
    // chunks; the splitter must yield it exactly once (2026-08-28 review D-6).
    const splitter = new LineSplitter();
    const payload = 'x'.repeat(1024 * 1024);
    const lines: string[] = [];
    for (let at = 0; at < payload.length; at += 65536) {
      splitter.push(payload.slice(at, at + 65536), (line) => lines.push(line));
    }
    expect(lines).toEqual([]);
    splitter.push('\r\nnext\n', (line) => lines.push(line));
    expect(lines).toEqual([payload, 'next']);
  });

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
      { stdio: 'ignore', windowsHide: true, timeout: 10_000 },
    );
    expect(killer.unref).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();

    cleanupWarning.mockClear();
    callbacks.get('error')?.(new Error('private diagnostic'));
    callbacks.get('exit')?.(1);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(cleanupWarning).toHaveBeenCalledExactlyOnceWith('CLI process tree termination failed', {
      platform: 'win32', failure: 'tree_command_failed', fallback: 'direct_child_only',
    });
  });

  it('does not signal a closed child again after cancellation grace expires', () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
    const controller = new AbortController();
    const detach = bindAbort(child as any, controller.signal, 50);
    try {
      controller.abort();
      child.emit('close', 0);
      detach();
      vi.advanceTimersByTime(100);
      expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    } finally { detach(); vi.useRealTimers(); }
  });

  it('waits for the Windows tree command before releasing terminal input', () => {
    const killer = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const complete = vi.fn();
    const child = { pid: 2468, kill: vi.fn() };
    cleanupWarning.mockClear();
    killProcessTree(child, 'SIGTERM', {
      platform: 'win32', spawnFn: (() => killer) as any, onComplete: complete,
    });
    expect(complete).not.toHaveBeenCalled();
    killer.emit('exit', 0);
    expect(complete).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    expect(cleanupWarning).not.toHaveBeenCalled();
  });

  it('falls back to the direct Windows child when taskkill cannot start', () => {
    const child = { pid: 1357, kill: vi.fn() };
    const spawnFn = vi.fn(() => { throw new Error('spawn failed'); });

    cleanupWarning.mockClear();
    killProcessTree(child as any, 'SIGKILL', {
      platform: 'win32',
      spawnFn: spawnFn as any,
    });

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(cleanupWarning).toHaveBeenCalledExactlyOnceWith('CLI process tree termination failed', {
      platform: 'win32', failure: 'tree_command_unavailable', fallback: 'direct_child_only',
    });
  });

  itPosix('signals the CLI tree before a fast parent exit can cancel cleanup', () => {
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
      expect(processKill).toHaveBeenCalledWith(-24680, 'SIGTERM');

      child.emit('close', 0);
      const callsAtClose = processKill.mock.calls.length;
      vi.advanceTimersByTime(50);
      expect(processKill).toHaveBeenCalledTimes(callsAtClose);
    } finally {
      processKill.mockRestore();
      vi.useRealTimers();
    }
  });

  itPosix('escalates terminal cleanup when the CLI process does not exit', () => {
    vi.useFakeTimers();
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const child = Object.assign(new EventEmitter(), {
      pid: 24681,
      stdin: { end: vi.fn() },
      kill: vi.fn(),
    });

    try {
      reapCliAfterProtocolTerminal(child as any, 50);
      expect(processKill).toHaveBeenCalledWith(-24681, 'SIGTERM');

      vi.advanceTimersByTime(50);
      expect(processKill).toHaveBeenCalledWith(-24681, 'SIGKILL');
    } finally {
      processKill.mockRestore();
      vi.useRealTimers();
    }
  });

  it('reaps a spawned descendant when a completed CLI exits immediately', async () => {
    const descendantSource = 'setInterval(() => {}, 1000);';
    const parentSource = [
      "const { spawn } = require('node:child_process');",
      `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' });`,
      "process.stdout.write(String(descendant.pid) + '\\n', () => setTimeout(() => process.exit(0), 25));",
    ].join('\n');
    const child = spawn(process.execPath, ['-e', parentSource], {
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let descendantPid = 0;

    try {
      descendantPid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CLI fixture did not report its descendant')), 5_000);
        child.once('error', err => {
          clearTimeout(timer);
          reject(err);
        });
        child.stdout.once('data', chunk => {
          clearTimeout(timer);
          resolve(Number(String(chunk).trim()));
        });
      });
      expect(Number.isSafeInteger(descendantPid) && descendantPid > 0).toBe(true);
      expect(processIsAlive(descendantPid)).toBe(true);

      reapCliAfterProtocolTerminal(child, 250);

      await waitForProcessExit(descendantPid);
      expect(processIsAlive(descendantPid)).toBe(false);
    } finally {
      killProcessTree(child, 'SIGKILL');
      if (descendantPid && processIsAlive(descendantPid)) {
        try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  });
  itPosix.each(['terminal', 'abort', 'parent-exit'] as const)(
    'removes a resistant descendant after %s while preserving unrelated work', async mode => {
      const node = process.env.ORKAS_TEST_NODE || process.execPath;
      const resistant = "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);";
      const source = [
        "const { spawn } = require('node:child_process');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(resistant)}], { stdio: ['ignore', 'pipe', 'ignore'] });`,
        "child.stdout.once('data', () => process.stdout.write(String(child.pid) + '\\n'));",
        "process.stdin.on('data', () => process.exit(7));",
        "setInterval(() => {}, 1000);",
      ].join('\n');
      const parent = mode === 'parent-exit'
        ? spawnCli(node, ['-e', source], process.cwd())
        : spawn(node, ['-e', source], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const unrelated = spawn(node, ['-e', "setInterval(() => {}, 1000)"], { stdio: 'ignore' });
      let descendantPid = 0;
      let detach = () => {};
      try {
        const data = await once(parent.stdout, 'data', { signal: AbortSignal.timeout(3_000) });
        descendantPid = Number(String(data[0]).trim());
        expect(descendantPid).toBeGreaterThan(0);
        const closed = once(parent, 'close', { signal: AbortSignal.timeout(3_000) });
        if (mode === 'terminal') reapCliAfterProtocolTerminal(parent, 100);
        else if (mode === 'abort') {
          const controller = new AbortController();
          detach = bindAbort(parent, controller.signal, 100);
          controller.abort();
          detach(); // Settling the backend must not cancel already-started cleanup.
        } else parent.stdin.write('exit');
        await closed;
        await waitForProcessExit(descendantPid, 1_000);
        expect(processIsAlive(descendantPid)).toBe(false);
        expect(processIsAlive(unrelated.pid!)).toBe(true);
      } finally {
        detach();
        killProcessTree(parent, 'SIGKILL');
        if (descendantPid && processIsAlive(descendantPid)) process.kill(descendantPid, 'SIGKILL');
        unrelated.kill('SIGKILL');
      }
    },
  );

  it('starts terminal tree termination before closing stdin can release the parent', () => {
    vi.useFakeTimers();
    const actions: string[] = [];
    const child = Object.assign(new EventEmitter(), {
      stdin: { end: () => actions.push('stdin-closed') },
      kill: () => { actions.push('terminate'); return true; },
    });
    try {
      reapCliAfterProtocolTerminal(child as any, 50);
      expect(actions.slice(0, 2)).toEqual(['terminate', 'stdin-closed']);
      child.emit('close');
    } finally { vi.useRealTimers(); }
  });

});
