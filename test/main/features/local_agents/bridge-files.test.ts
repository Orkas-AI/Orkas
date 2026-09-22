import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { readBridgeFilePage } from '../../../../src/main/features/local_agents/bridge-files';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-bridge-pages-')); });
afterEach(() => { vi.mocked(fs.readSync).mockReset(); fs.rmSync(root, { recursive: true, force: true }); });

function readAll(file: string, limit: number, encoding: 'utf8' | 'base64') {
  const chunks: Buffer[] = [];
  let offset: number | null = 0;
  const size = fs.statSync(file).size;
  // Bound iteration so a stuck cursor fails locally instead of hanging the suite.
  for (let count = 0; offset !== null && count <= size + 1; count++) {
    const page = readBridgeFilePage(file, { offset, limit, encoding });
    const bytes = Buffer.from(page.content, encoding);
    expect(page.bytes).toBe(size);
    expect(bytes.length).toBeLessThanOrEqual(limit);
    if (page.next_offset !== null) {
      expect(page.next_offset).toBeGreaterThan(offset);
      expect(page.next_offset).toBe(offset + bytes.length);
    }
    chunks.push(bytes);
    offset = page.next_offset;
  }
  expect(offset).toBeNull();
  return Buffer.concat(chunks);
}

describe('complete bridge resource retrieval', () => {
  it.skipIf(process.platform === 'win32')('rejects an unopened FIFO without blocking resource retrieval', () => {
    const fifo = path.join(root, 'resource.pipe');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    const module = path.join(root, 'bridge-files.cjs');
    buildSync({
      entryPoints: [path.resolve(__dirname, '../../../../src/main/features/local_agents/bridge-files.ts')],
      outfile: module, bundle: true, platform: 'node', format: 'cjs',
    });
    // Run the actual reader in a bounded child: a regression must not hang
    // the test runner (or Electron's main thread) before fstat can reject it.
    const child = spawnSync(process.execPath, ['-e', `
      const { readBridgeFilePage } = require(process.argv[1]);
      require('node:assert').throws(() => readBridgeFilePage(process.argv[2], {}), /regular file/);
    `, module, fifo], { timeout: 2000, killSignal: 'SIGKILL', encoding: 'utf8' });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
  });

  it('preserves UTF-8 source bytes including BOM across minimum and maximum page boundaries', () => {
    const file = path.join(root, 'guide.md');
    // Every UTF-8 width, CRLF and a BOM at both the start and an interior boundary.
    for (const limit of [4, 5, 7, 59_999, 60_000]) {
      const source = Buffer.from('\uFEFFaé中🙂\r\n\uFEFFz'.repeat(limit < 100 ? 10 : 3200));
      fs.writeFileSync(file, source);
      expect(readAll(file, limit, 'utf8'), `page limit ${limit}`).toEqual(source);
    }
  });

  it('recovers invalid text and mid-codepoint reads using binary pages without replacing bytes', () => {
    const file = path.join(root, 'template.bin');
    const source = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256));
    fs.writeFileSync(file, source);
    expect(() => readBridgeFilePage(file, {})).toThrow(/base64/);
    for (const limit of [4, 7, 60_000]) expect(readAll(file, limit, 'base64')).toEqual(source);
    const text = path.join(root, 'text.md');
    fs.writeFileSync(text, '🙂done');
    expect(() => readBridgeFilePage(text, { offset: 1 })).toThrow(/next_offset/);
    expect(readAll(text, 4, 'utf8')).toEqual(Buffer.from('🙂done'));
  });

  it('distinguishes empty resources, exact EOF and invalid cursors without leaking file paths', () => {
    const file = path.join(root, 'empty');
    fs.writeFileSync(file, '');
    expect(readBridgeFilePage(file, {})).toMatchObject({ content: '', bytes: 0, next_offset: null });
    fs.writeFileSync(file, 'data');
    expect(readBridgeFilePage(file, { offset: 4 })).toMatchObject({ content: '', bytes: 4, next_offset: null });
    for (const input of [{ offset: 5 }, { offset: -1 }, { offset: 0.5 }, { offset: '0' }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { limit: 3 }, { limit: 60001 }, { encoding: 'hex' }]) {
      expect(() => readBridgeFilePage(file, input)).toThrow();
    }
    fs.rmSync(file);
    try { readBridgeFilePage(file, {}); throw new Error('missing resource was accepted'); }
    catch (error) {
      expect(String(error)).toContain('unavailable');
      expect(String(error)).not.toContain(root);
    }
  });

  it('assembles full pages despite short filesystem reads', async () => {
    const file = path.join(root, 'short-reads.md');
    const source = Buffer.from('\uFEFFguide🙂\r\n'.repeat(10));
    fs.writeFileSync(file, source);
    const { readSync: original } = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(fs.readSync).mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
      original(fd, buffer, offset, Math.min(length, 2), position)) as typeof fs.readSync);
    expect(readAll(file, 7, 'utf8')).toEqual(source);
  });
});
