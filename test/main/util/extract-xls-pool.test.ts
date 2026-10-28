import { describe, expect, it, vi } from 'vitest';

const parser = vi.hoisted(() => {
  const jobs: Array<{ input?: Buffer; close: (error: Error | null, stdout: string) => void }> = [];
  return { jobs, active: 0, maxActive: 0 };
});

// Control only the child protocol and its completion order. Real XLS parsing,
// byte preservation and workbook errors remain covered by extract-xls.test.ts.
vi.mock('../../../src/main/util/bundled-runtime', () => ({
  bundledRuntimeEnv: () => ({ ORKAS_PYTHON: 'controlled-xls-reader' }),
}));
vi.mock('node:child_process', () => ({
  execFile: (_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    parser.active++;
    parser.maxActive = Math.max(parser.maxActive, parser.active);
    const job = {
      input: undefined as Buffer | undefined,
      close(error: Error | null, stdout: string) {
        parser.active--;
        callback(error, stdout);
      },
    };
    parser.jobs.push(job);
    return { stdin: { on() {}, end(input: Buffer) { job.input = input; } } };
  },
}));

import { xlsBufferToMarkdown } from '../../../src/main/util/extract-xls';

describe('XLS reader admission and child lifecycle', () => {
  it('bounds admission at two active and 32 waiting, wakes FIFO and releases every failure', async () => {
    const calls = Array.from({ length: 35 }, (_, index) =>
      xlsBufferToMarkdown(Buffer.from(String(index))).then(
        value => ({ status: 'fulfilled' as const, value }),
        error => ({ status: 'rejected' as const, error: error.message as string }),
      ));
    expect(parser.jobs.map(job => job.input?.toString())).toEqual(['0', '1']);
    expect(parser.active).toBe(2);
    expect(await calls[34]).toEqual({ status: 'rejected', error: expect.stringContaining('busy') });

    for (let index = 0; index < 34; index++) {
      expect(parser.jobs[index].input?.toString()).toBe(String(index));
      if (index === 0) parser.jobs[index].close(new Error('controlled child failure'), '');
      else parser.jobs[index].close(null, JSON.stringify(index === 33
        ? { sheets: [{ name: 'Queued', rows: [{ number: 1, values: ['queued valid workbook'] }] }] }
        : { error: 'format' }));
      const result = await calls[index];
      expect(result).toEqual(index === 33
        ? { status: 'fulfilled', value: expect.stringContaining('queued valid workbook') }
        : { status: 'rejected', error: expect.stringContaining(index === 0 ? 'resource limit' : 'Cannot read') });
      // Each completion admits exactly the oldest waiter, never a third child.
      expect(parser.jobs).toHaveLength(Math.min(34, index + 3));
      expect(parser.active).toBe(Math.min(2, 33 - index));
    }
    expect(parser.maxActive).toBe(2);
    expect(parser.active).toBe(0);
    const after = xlsBufferToMarkdown(Buffer.from('after'));
    expect(parser.jobs[34].input?.toString()).toBe('after');
    parser.jobs[34].close(null, JSON.stringify({ sheets: [{ name: 'After', rows: [{ number: 1, values: ['after valid workbook'] }] }] }));
    await expect(after).resolves.toContain('after valid workbook');
    expect(parser.active).toBe(0);
  });
});
