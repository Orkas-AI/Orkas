import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const loggerSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/logger.js'),
  'utf8',
);

describe('renderer logger privacy boundary', () => {
  it.each(['ResizeObserver loop completed with undelivered notifications.', 'ResizeObserver loop limit exceeded'])(
    'retains %s without reporting it as an uncaught exception', (message) => {
    const timers: Function[] = [];
    const forwarded = vi.fn();
    const listeners: Record<string, (event: any) => void> = {};
    const sandbox = { setTimeout: (fn: Function) => timers.push(fn), console: { warn: vi.fn(), error: vi.fn() }, window: {
      orkas: { log: forwarded }, addEventListener: (type: string, handler: any) => { listeners[type] = handler; },
    } };
    vm.runInNewContext(loggerSource, sandbox);
    listeners.error({ message, error: null });
    timers.shift()!();
    expect(forwarded).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'warn', message: 'browser resize notification' }));
    listeners.error({ message, error: new Error(message) });
    timers.shift()!();
    expect(forwarded).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'error', message: 'uncaught error' }));
    listeners.error({ message: 'ResizeObserver callback failed', error: null });
    timers.shift()!();
    expect(forwarded).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'error', message: 'uncaught error' }));
  });

  it('sanitizes messages and structured data before forwarding either log stream', () => {
    const timers: Function[] = [];
    const forwarded = vi.fn();
    const consoleCalls: unknown[][] = [];
    const sandbox: any = {
      setTimeout: (fn: Function) => timers.push(fn),
      Error,
      WeakSet,
      Object,
      String,
      Array,
      console: {
        error: (...args: unknown[]) => consoleCalls.push(args),
        warn: (...args: unknown[]) => consoleCalls.push(args),
        info: (...args: unknown[]) => consoleCalls.push(args),
        debug: (...args: unknown[]) => consoleCalls.push(args),
        log: (...args: unknown[]) => consoleCalls.push(args),
      },
      window: {
        orkas: { log: forwarded },
        addEventListener: vi.fn(),
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(loggerSource, sandbox, { filename: 'logger.js' });
    vm.runInContext("testLogger = createLogger('privacy')", sandbox);

    sandbox.testLogger.error(
      'failed /Users/test/Private Project/customer-plan.md',
      {
        filename: 'customer-plan.md',
        path: '/Users/test/Private Project/customer-plan.md',
        nested: {
          detail: 'file:///Users/test/Private%20Project/customer-plan.md',
          cloudRef: 'cloud/contexts/private/customer-plan.md',
        },
      },
      new Error('C:\\Users\\test\\Private Project\\customer-plan.md'),
    );

    expect(forwarded).not.toHaveBeenCalled();
    expect(consoleCalls).toHaveLength(0);
    timers.shift()!();
    expect(forwarded).toHaveBeenCalledOnce();
    const output = JSON.stringify([forwarded.mock.calls, consoleCalls]);
    expect(output).not.toContain('/Users/test');
    expect(output).not.toContain('C:\\\\Users\\\\test');
    expect(output).not.toContain('customer-plan.md');
    expect(output).not.toContain('Private Project');
    expect(output).toContain('***REDACTED_PATH***');
    expect(output).toContain('<local_path>');
  });
});

describe('renderer asynchronous log delivery', () => {
  function load() {
    const timers: Function[] = [];
    const forwarded = vi.fn();
    const output = vi.fn();
    const sandbox: any = { console: { info: output, warn: output, error: output },
      setTimeout: (fn: Function) => timers.push(fn),
      window: { orkas: { log: forwarded }, addEventListener: vi.fn() } };
    vm.runInNewContext(loggerSource + "\nthis.testLogger = createLogger('async');", sandbox);
    return { logger: sandbox.testLogger, timers, forwarded, output };
  }
  it('snapshots sanitized data before deferring IPC and console to a later turn', () => {
    const ctx = load();
    const getter = vi.fn(() => { throw new Error('must not evaluate diagnostic accessor'); });
    const data = { result: 'success', token: 'private', get detail() { return getter(); } };
    ctx.logger.info('result', data);
    data.result = 'later';
    expect(ctx.forwarded).not.toHaveBeenCalled();
    expect(ctx.output).not.toHaveBeenCalled();
    ctx.timers.shift()!();
    expect(ctx.forwarded.mock.calls[0][0].data[0]).toMatchObject({ result: 'success', token: '***REDACTED***', detail: '[accessor]' });
    expect(getter).not.toHaveBeenCalled();
  });
  it('bounds a log storm, preserves critical slots and yields between batches', () => {
    const ctx = load();
    for (let i = 0; i < 1000; i++) ctx.logger.info('normal');
    for (let i = 0; i < 100; i++) ctx.logger.error('critical');
    expect(ctx.timers).toHaveLength(1);
    expect(ctx.forwarded).not.toHaveBeenCalled();
    ctx.timers.shift()!();
    expect(ctx.forwarded).toHaveBeenCalledTimes(9);
    while (ctx.timers.length) ctx.timers.shift()!();
    const records = ctx.forwarded.mock.calls.map(call => call[0]);
    expect(records.filter(record => record.message === 'normal')).toHaveLength(192);
    expect(records.filter(record => record.message === 'critical')).toHaveLength(64);
    expect(records.find(record => record.message === 'Log buffer full').data).toEqual([{ dropped: 844 }]);
  });
  it('contains unavailable IPC and console and keeps processing later records', () => {
    const ctx = load();
    ctx.forwarded.mockImplementationOnce(() => { throw new Error('IPC closed'); });
    ctx.output.mockImplementationOnce(() => { throw new Error('console closed'); });
    ctx.logger.info('first'); ctx.logger.info('second');
    expect(() => ctx.timers.shift()!()).not.toThrow();
    expect(ctx.forwarded).toHaveBeenCalledTimes(2);
    expect(ctx.output).toHaveBeenCalledTimes(2);
  });
});
