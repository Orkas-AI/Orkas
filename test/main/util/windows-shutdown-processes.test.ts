import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { captureWindowsShutdownProcesses, hasCapturedWindowsAppProcess } from '../../../src/main/util/windows-shutdown-processes';
import { exerciseWindowsShutdown } from '../../helpers/windows-shutdown-scenario';

function helper(ownerPid = 1000) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stdin: new PassThrough(),
    kill: vi.fn(),
  });
  const launch = vi.fn(() => child);
  return { child, launch, capture: () => captureWindowsShutdownProcesses('win32', ownerPid, launch as never) };
}

describe('Windows app-owned process shutdown', () => {
  it.each(['ready\n', 'owned:42\nready\n', `owned:${process.pid},0\nready\n`])(
    'rejects incomplete process ownership before app handoff: %s', async output => {
      const { child, capture } = helper(process.pid);
      const captured = capture();
      child.stdout.write(output);
      await expect(captured).rejects.toThrow('snapshot is invalid');
      expect(hasCapturedWindowsAppProcess(process.pid)).toBe(false);
      expect(child.kill).toHaveBeenCalledOnce();
    },
  );

  it.each(['dispose', 'exit', 'error'])('only reuses an app-wide process snapshot until %s', async outcome => {
    const { child, capture } = helper(process.pid);
    const captured = capture();
    expect(hasCapturedWindowsAppProcess(42)).toBe(false);
    child.stdout.write(`owned:${process.pid},42\nready\n`);
    const processes = await captured;
    expect(hasCapturedWindowsAppProcess(42)).toBe(true);
    expect(hasCapturedWindowsAppProcess(43)).toBe(false);
    try {
      if (outcome === 'dispose') processes.dispose();
      else if (outcome === 'exit') child.emit('exit', 1);
      else child.emit('error', new Error('helper unavailable'));
      expect(hasCapturedWindowsAppProcess(42)).toBe(false);
    } finally { processes.dispose(); }
  });

  it('keeps graceful saves separate from forced cleanup and waits for helper exit', async () => {
    const { child, capture, launch } = helper();
    const captured = capture();
    child.stdout.write('ready\r\n');
    const processes = await captured;
    expect(launch.mock.calls[0][2]).toMatchObject({ windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    expect(child.stdin.read()).toBeNull();
    let done = false;
    const pending = processes.terminate().then(() => { done = true; });
    expect(child.stdin.read().toString()).toBe('stop\n');
    await Promise.resolve();
    expect(done).toBe(false);
    child.emit('exit', 0);
    await pending;
    expect(done).toBe(true);
    processes.dispose();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(['startup', 'cleanup'])('fails closed on a %s timeout without retaining a timer', async phase => {
    vi.useFakeTimers();
    try {
      const { child, capture } = helper();
      const captured = capture();
      let pending: Promise<unknown> = captured;
      if (phase === 'cleanup') {
        child.stdout.write('ready\n');
        pending = (await captured).terminate();
      }
      const rejected = expect(pending).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
      expect(child.kill).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('rejects a failed descendant sweep instead of allowing installer handoff', async () => {
    const { child, capture } = helper();
    const captured = capture();
    child.stdout.write('ready\n');
    const processes = await captured;
    const failed = expect(processes.terminate()).rejects.toThrow('cleanup failed');
    child.emit('exit', 1);
    await failed;
    processes.dispose();
  });

  it('releases the helper without requesting termination when a save is cancelled', async () => {
    const { child, capture } = helper();
    const captured = capture();
    child.stdout.write('ready\n');
    (await captured).dispose();
    expect(child.stdin.read()).toBeNull();
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit('exit', null);
  });

  it('does not create a Windows helper on other platforms', async () => {
    const launch = vi.fn();
    const processes = await captureWindowsShutdownProcesses('darwin', 1000, launch as never);
    await processes.terminate();
    processes.dispose();
    expect(launch).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')(
    'stops orphaned and late Windows descendants, releases locked files, and preserves unrelated work',
    async () => {
      await exerciseWindowsShutdown(process.env.ORKAS_TEST_NODE!);
    }, 60_000,
  );
});
