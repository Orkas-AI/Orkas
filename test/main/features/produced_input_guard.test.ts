import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, createReadStream: vi.fn(original.createReadStream) };
});

import { excludeUnchangedInputs } from '../../../src/main/features/produced_input_guard';

describe('input bytes at the output finalization boundary', () => {
  let root: string;
  const write = (name: string, text: string) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, text);
    return file;
  };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'produced-input-')); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  it('protects renamed copies and links but does not exempt changed bytes or later replacements', async () => {
    const input = write('input.mp4', 'source');
    const copy = write('unrelated-name.mov', 'source');
    const generated = write('input-copy.mp4', 'result');
    const link = path.join(root, 'alias.mp4');
    fs.symlinkSync(input, link);
    expect(await excludeUnchangedInputs([copy, link, input, generated], [input])).toEqual([generated]);
    fs.writeFileSync(copy, 'edited');
    expect(await excludeUnchangedInputs([copy, generated], [input])).toEqual([copy, generated]);
    expect(fs.readFileSync(input, 'utf8')).toBe('source');
  });

  it('does not read media bodies when no source has the candidate size, and hashes a repeated source once', async () => {
    const input = write('large.mp4', 'long source content');
    const output = write('short.mp4', 'short');
    const streams = vi.mocked(fs.createReadStream);
    streams.mockClear();
    expect(await excludeUnchangedInputs([output], [input])).toEqual([output]);
    expect(streams).not.toHaveBeenCalled();
    const copy1 = write('copy1.mp4', 'long source content');
    const copy2 = write('copy2.mp4', 'long source content');
    expect(await excludeUnchangedInputs([copy1, copy2], [input, input])).toEqual([]);
    expect(streams.mock.calls.filter(([file]) => file === input)).toHaveLength(1);
  });

  it('does not exempt changed bytes when distinct 64-bit file ids round to the same number', async () => {
    const input = write('input.mp4', 'source');
    const copy = write('copy.mp4', 'source');
    const output = write('output.mp4', 'result');
    const ids = new Map([
      [input, 72_057_594_037_927_936n],
      [copy, 72_057_594_037_927_937n],
      [output, 72_057_594_037_927_938n],
    ]);
    expect(new Set([...ids.values()].map(Number)).size).toBe(1);
    const stat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (file: any, ...args: any[]) => {
      const result = await (stat as any)(file, ...args);
      if (ids.has(file)) result.ino = args[0]?.bigint ? ids.get(file) : Number(ids.get(file));
      return result;
    });
    expect(await excludeUnchangedInputs([copy, output], [input])).toEqual([output]);
    expect(fs.readFileSync(input, 'utf8')).toBe('source');
  });

  it('protects a real hard-linked input without reading its media body', async () => {
    const input = write('source.mp4', 'source');
    const alias = path.join(root, 'alias.mp4');
    fs.linkSync(input, alias);
    const streams = vi.mocked(fs.createReadStream);
    streams.mockClear();
    expect(await excludeUnchangedInputs([alias], [input])).toEqual([]);
    expect(streams).not.toHaveBeenCalled();
  });

  it('tolerates a removed attachment but fails without modifying files when a live input cannot be verified', async () => {
    const output = write('output.mp4', 'result');
    const input = write('input.mp4', 'source');
    expect(await excludeUnchangedInputs([output], [path.join(root, 'removed.mp4')])).toEqual([output]);
    const stat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (file: any, ...args: any[]) => {
      if (file === input) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
      return (stat as any)(file, ...args);
    });
    await expect(excludeUnchangedInputs([output], [input])).rejects.toMatchObject({ code: 'EACCES' });
    expect(fs.readFileSync(output, 'utf8')).toBe('result');
  });
});
