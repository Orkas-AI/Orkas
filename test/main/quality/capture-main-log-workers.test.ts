import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';
import { captureMainLogWorkers } from '../../helpers/capture-main-log-workers';
import { expectTestLog } from '../../helpers/test-log-analysis';

it('retains both real asynchronous Worker console channels in the owning case log capture', async () => {
  expectTestLog({ level: 'warn', source: 'capture-stdout', message: /^preserved stdout$/ });
  expectTestLog({ level: 'warn', source: 'capture-stderr', message: /^preserved stderr$/ });
  const close = await captureMainLogWorkers();
  try {
    const { createLogDelivery } = await import('../../../src/main/util/log-delivery');
    const delivery = createLogDelivery({}, (_file, config) => new Worker(`
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', () => {
        process.stdout.write('[00:00:00.000] [warn] [(capture-stdout)] preserved stdout\\n');
        process.stderr.write('[00:00:00.000] [warn] [(capture-stderr)] preserved stderr\\n');
        parentPort.postMessage({ written: true });
      });
    `, { ...config, eval: true }));
    delivery.send({ level: 'warn' });
    await vi.waitFor(() => expect(delivery.stats().pending).toBe(0));
  } finally {
    await close();
    vi.resetModules();
  }
});

it('captures concurrent restart workers without growing shared console listeners or relaxing their limits', async () => {
  const events = ['unpipe', 'error', 'close', 'finish'] as const;
  const streams = [process.stdout, process.stderr];
  const before = streams.map(stream => ({ limit: stream.getMaxListeners(),
    counts: events.map(event => stream.listenerCount(event)) }));
  const close = await captureMainLogWorkers();
  const outputs: PassThrough[] = [];
  try {
    for (let index = 0; index < 12; index++) {
      vi.resetModules();
      const stdout = new PassThrough(), stderr = new PassThrough();
      outputs.push(stdout, stderr);
      const worker = Object.assign(new EventEmitter(), {
        stdout, stderr, unref() {}, postMessage() {},
        async terminate() { stdout.end(); stderr.end(); return 0; },
      });
      (await import('../../../src/main/util/log-delivery')).createLogDelivery({}, () => worker as any);
    }
    for (const [index, stream] of streams.entries()) {
      expect(stream.getMaxListeners()).toBe(before[index].limit);
      for (const [eventIndex, event] of events.entries()) {
        expect(stream.listenerCount(event), `${event} listeners must not grow with restart workers`)
          .toBeLessThanOrEqual(before[index].counts[eventIndex] + 1);
      }
    }
  } finally {
    await close();
    expect(outputs.every(output => output.readableEnded)).toBe(true);
    vi.resetModules();
  }
});

it('waits for the forwarded console write after worker EOF before completing cleanup', async () => {
  const close = await captureMainLogWorkers();
  const stdout = new PassThrough(), stderr = new PassThrough();
  const marker = 'log-capture-delayed-write\n';
  const write = process.stdout.write.bind(process.stdout);
  let release: (() => void) | undefined;
  let entered!: () => void;
  const writing = new Promise<void>(resolve => { entered = resolve; });
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any, ...args: any[]) => {
    if (String(chunk) !== marker) return (write as any)(chunk, ...args);
    release = () => { (write as any)(chunk, ...args); };
    entered();
    return true;
  }) as any);
  const worker = Object.assign(new EventEmitter(), {
    stdout, stderr, unref() {}, postMessage() {},
    async terminate() { stdout.end(marker); stderr.end(); return 0; },
  });
  let closing: Promise<void> | undefined;
  try {
    (await import('../../../src/main/util/log-delivery')).createLogDelivery({}, () => worker as any);
    let settled = false;
    closing = close().then(() => { settled = true; });
    await writing;
    await vi.waitFor(() => expect(stdout.readableEnded).toBe(true));
    // Give the helper's EOF poll an opportunity to finish; the controlled
    // downstream write still has not acknowledged its bytes.
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    release!(); release = undefined;
    await closing;
  } finally {
    release?.();
    await closing?.catch(() => {});
    output.mockRestore();
  }
});

it.each([false, true])('settles console EOF before cleanup and fails closed on missing EOF=%s', async missingEof => {
  const close = await captureMainLogWorkers();
  const stdout = new PassThrough(), stderr = new PassThrough();
  // Exit promises and independent console channels can settle in different
  // turns. Delivery acknowledgements alone do not drain the console streams.
  const worker = Object.assign(new EventEmitter(), {
    stdout, stderr, unref() {}, postMessage() {},
    async terminate() {
      if (!missingEof) setImmediate(() => { stdout.end(); stderr.end(); });
      return 0;
    },
  });
  try {
    const { createLogDelivery } = await import('../../../src/main/util/log-delivery');
    createLogDelivery({}, (_file, config) => {
      expect(config).toMatchObject({ stdout: true, stderr: true });
      return worker as any;
    });
    if (missingEof) await expect(close()).rejects.toThrow();
    else {
      await close();
      expect(stdout.readableEnded).toBe(true);
      expect(stderr.readableEnded).toBe(true);
    }
  } finally {
    stdout.end(); stderr.end(); stdout.resume(); stderr.resume();
  }
});
