import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createLogDelivery } from '../../src/main/util/log-delivery';

class HeldWorker extends EventEmitter {
  messages: any[] = [];
  unref = vi.fn();
  postMessage = vi.fn((message: any) => { this.messages.push(message); });
  terminate = vi.fn(async () => 0);
}

describe('log delivery isolation', () => {
  it('returns with the worker stalled, bounds its mailbox and reserves critical capacity', async () => {
    const worker = new HeldWorker();
    const delivery = createLogDelivery({}, () => worker as any);
    for (let i = 0; i < 1000; i++) delivery.send({ level: 'info', data: ['record'] });
    expect(worker.messages).toHaveLength(192);
    for (let i = 0; i < 100; i++) delivery.send({ level: 'error', data: ['failure'] });
    expect(worker.messages).toHaveLength(256);
    expect(delivery.stats()).toEqual({ pending: 256, dropped: 844, failed: false });
    // No acknowledgement is needed to continue the product action.
    let completed = false;
    await new Promise<void>(resolve => setImmediate(() => { completed = true; resolve(); }));
    expect(completed).toBe(true);
    worker.emit('message', { written: true });
    expect(worker.messages.at(-1)).toMatchObject({ level: 'warn', data: ['Log records dropped', { dropped: 844 }] });
    expect(delivery.stats().pending).toBe(256);
    worker.emit('message', { written: true });
    expect(delivery.canAccept('error')).toBe(true);
    await delivery.close();
  });

  it('contains post failures, worker failure and later producer calls', async () => {
    const worker = new HeldWorker();
    const delivery = createLogDelivery({}, () => worker as any);
    worker.postMessage.mockImplementationOnce(() => { throw new Error('injected channel failure'); });
    expect(() => delivery.send({ level: 'error' })).not.toThrow();
    expect(delivery.stats().pending).toBe(0);
    worker.emit('error', new Error('injected worker failure'));
    expect(() => delivery.send({ level: 'error' })).not.toThrow();
    expect(delivery.stats()).toEqual({ pending: 0, dropped: 2, failed: true });
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    await delivery.close();
  });

  it('does not loop on write failures and reports loss after a successful write', async () => {
    const worker = new HeldWorker();
    const delivery = createLogDelivery({}, () => worker as any);
    delivery.send({ level: 'warn' });
    worker.emit('message', { written: false });
    expect(worker.messages).toHaveLength(1);
    expect(delivery.stats().dropped).toBe(1);
    delivery.send({ level: 'warn' });
    worker.emit('message', { written: true });
    expect(worker.messages).toHaveLength(3);
    await delivery.close();
  });

  it('writes scoped records and performs retention/rotation in a real worker', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'orkas-worker-log-'));
    writeFileSync(path.join(directory, '2000-01-01.log'), 'expired');
    writeFileSync(path.join(directory, 'keep.txt'), 'untouched');
    let consoleOutput = '';
    const delivery = createLogDelivery({ directory, fileLevel: 'info', consoleLevel: 'info',
      retainDays: 7, totalMaxBytes: 100000, fileMaxBytes: 256 }, (file, config) => {
      const worker = new Worker(file, { ...config, stdout: true, stderr: true });
      worker.stdout.on('data', chunk => { consoleOutput += chunk.toString(); });
      worker.stderr.on('data', chunk => { consoleOutput += chunk.toString(); });
      return worker;
    });
    try {
      for (let i = 0; i < 8; i++) delivery.send({ level: 'info', scope: 'worker-smoke', date: new Date(), data: [`record-${i}`, 'x'.repeat(100)] });
      await vi.waitFor(() => expect(delivery.stats()).toMatchObject({ pending: 0, failed: false }), { timeout: 5000 });
      const files = readdirSync(directory);
      expect(files).not.toContain('2000-01-01.log');
      expect(readFileSync(path.join(directory, 'keep.txt'), 'utf8')).toBe('untouched');
      expect(files.some(file => file.endsWith('.old.log'))).toBe(true);
      const current = files.find(file => /^\d{4}-\d{2}-\d{2}\.log$/.test(file))!;
      expect(readFileSync(path.join(directory, current), 'utf8')).toContain('worker-smoke');
      expect(readFileSync(path.join(directory, current), 'utf8')).toContain('record-7');
      await vi.waitFor(() => expect(consoleOutput).toContain('record-7'));
      expect(consoleOutput).toContain('worker-smoke');
    } finally { await delivery.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
