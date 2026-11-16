import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { captureFileCreationFence, isFileCreatedAfterFence } from '../../../../src/main/features/group_chat/file-creation-fence';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const fixture = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-fence-')); roots.push(root); return root; };

it('adopts immediate new files while preserving old and edited files as foreign across filesystem ticks', async () => {
  const root = fixture();
  for (let index = 0; index < 20; index++) {
    const old = path.join(root, `old-${index}`), fresh = path.join(root, `fresh-${index}`);
    fs.writeFileSync(old, 'user bytes');
    const fence = await captureFileCreationFence(root, new AbortController().signal);
    expect(fence).toBeGreaterThan(0);
    fs.writeFileSync(fresh, 'new output');
    fs.writeFileSync(old, 'edited during the run');
    expect(isFileCreatedAfterFence(fresh, fence)).toBe(true);
    expect(isFileCreatedAfterFence(old, fence)).toBe(false);
    expect(isFileCreatedAfterFence(root, fence)).toBe(false);
    expect(fs.readdirSync(root).some(name => name.startsWith('.orkas-creation-'))).toBe(false);
  }
});

it('fails closed for missing directories, cancellation, unknown and same-tick creation times', async () => {
  const root = fixture(), controller = new AbortController(); controller.abort();
  expect(await captureFileCreationFence(root, controller.signal)).toBeUndefined();
  expect(await captureFileCreationFence(path.join(root, 'missing'), new AbortController().signal)).toBeUndefined();
  expect(isFileCreatedAfterFence(path.join(root, 'missing'), 1)).toBe(false);
  expect(isFileCreatedAfterFence(root, undefined)).toBe(false);
  for (const birthtimeMs of [0, 99, 100]) {
    vi.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true, birthtimeMs } as fs.Stats);
    expect(isFileCreatedAfterFence('fixture', 100)).toBe(false);
    vi.restoreAllMocks();
  }
});

it('bounds a filesystem with an unsupported creation clock and removes temporary markers', async () => {
  const root = fixture();
  const stat = vi.spyOn(fs.promises, 'stat').mockResolvedValue({ birthtimeMs: 0 } as fs.Stats);
  expect(await captureFileCreationFence(root, new AbortController().signal)).toBeUndefined();
  expect(stat).toHaveBeenCalledOnce();
  expect(fs.readdirSync(root)).toEqual([]);
});

it('does not admit shell files when a positive filesystem creation clock never advances', async () => {
  const root = fixture();
  const stat = vi.spyOn(fs.promises, 'stat').mockResolvedValue({ birthtimeMs: 100 } as fs.Stats);
  const fence = await captureFileCreationFence(root, new AbortController().signal);
  expect(fence).toBeUndefined();
  expect(stat.mock.calls.length).toBeGreaterThan(1);
  expect(stat.mock.calls.length).toBeLessThanOrEqual(33);
  expect(fs.readdirSync(root)).toEqual([]);
});
