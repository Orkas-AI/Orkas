import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../../../../src/main/features/local_agents/backends/base.js', () => ({ killProcessTree: (_child: unknown, _signal: unknown, options: any) => options.onComplete() }));
afterEach(() => { vi.restoreAllMocks(); });
it('limits actual version subprocesses across concurrent callers and releases slots on success, error and timeout', async () => {
  vi.resetModules();
  const children: any[] = [];
  mocks.spawn.mockImplementation(() => {
    const child: any = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    children.push(child); return child;
  });
  const { detectVersionResult } = await import('../../../../src/main/features/local_agents/version');
  const requests = Array.from({ length: 4 }, () => detectVersionResult('/missing-cli', 40));
  await new Promise(resolve => setImmediate(resolve));
  expect(children).toHaveLength(2);
  children[0].stdout.emit('data', 'tool 9.0.0'); children[0].emit('close', 0);
  await new Promise(resolve => setImmediate(resolve));
  expect(children).toHaveLength(3);
  children[1].emit('error', new Error('not installed'));
  await new Promise(resolve => setImmediate(resolve));
  expect(children).toHaveLength(4);
  const result = await Promise.all(requests);
  expect(result.map(entry => entry.status)).toEqual(['success', 'failed', 'timeout', 'timeout']);
  const last = detectVersionResult('/missing-cli', 1000);
  await new Promise(resolve => setImmediate(resolve));
  expect(children).toHaveLength(5);
  children[4].emit('error', new Error('not installed'));
  expect((await last).status).toBe('failed');
});

it('expires a queued probe without launching it later or consuming a future slot', async () => {
  vi.resetModules(); const children: any[] = [];
  mocks.spawn.mockImplementation(() => {
    const child: any = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); children.push(child); return child;
  });
  const { detectVersionResult } = await import('../../../../src/main/features/local_agents/version');
  const first = detectVersionResult('/first', 1000);
  const second = detectVersionResult('/second', 1000);
  await new Promise(resolve => setImmediate(resolve));
  expect((await detectVersionResult('/queued', 10)).status).toBe('timeout');
  expect(children).toHaveLength(2);
  children[0].emit('error', new Error('gone')); children[1].emit('error', new Error('gone'));
  await Promise.all([first, second]);
  const retry = detectVersionResult('/retry', 1000);
  await new Promise(resolve => setImmediate(resolve));
  expect(children).toHaveLength(3);
  children[2].emit('error', new Error('gone')); await retry;
});
