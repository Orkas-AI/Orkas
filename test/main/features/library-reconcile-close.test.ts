import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

vi.mock('../../../src/main/features/kb_embed', () => ({ embedTexts: vi.fn(() => { throw new Error('Cancelled scan must not embed'); }) }));

afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });

it('settles an aborted Library snapshot only after its real file descriptor closes, preserving sources and the index', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-reconcile-close-'));
  const file = path.join(root, 'source.md');
  const body = Buffer.alloc(1024 * 1024, 'a');
  fs.writeFileSync(file, body);
  const originalRead = fs.createReadStream.bind(fs);
  const originalClose = fs.close.bind(fs);
  let stream!: fs.ReadStream;
  let descriptor = -1;
  let opened!: () => void;
  const didOpen = new Promise<void>(resolve => { opened = resolve; });
  let closing!: () => void;
  const didRequestClose = new Promise<void>(resolve => { closing = resolve; });
  let release: (() => void) | undefined;
  vi.spyOn(fs, 'createReadStream').mockImplementation(((name: fs.PathLike, options: any) => {
    if (String(name) !== file) return originalRead(name, options);
    stream = originalRead(name, { ...options, fs: {
      open: fs.open, read: fs.read,
      close(fd: number, callback: (error: NodeJS.ErrnoException | null) => void) {
        release = () => originalClose(fd, callback);
        closing();
      },
    } });
    stream.once('open', fd => { descriptor = fd; opened(); });
    return stream;
  }) as typeof fs.createReadStream);
  syncBuiltinESMExports();
  const { openLibraryCorpus, closeLibraryCorpus } = await import('../../../src/main/features/library_corpus');
  const dbDir = path.join(root, 'index');
  const corpus = openLibraryCorpus({ uid: 'close-fixture', scope: 'global', sourceRoot: root,
    dbDir, imageSessionPrefix: 'close-fixture', emit: vi.fn() });
  const controller = new AbortController();
  let settled = false;
  const scan = corpus.reconcile(controller.signal).then(result => { settled = true; return result; });
  try {
    await didOpen;
    controller.abort();
    await didRequestClose;
    await new Promise(resolve => setImmediate(resolve));
    expect(settled, 'an open descriptor still belongs to the cancelled scan').toBe(false);
    expect(fs.fstatSync(descriptor).isFile()).toBe(true);
    release!(); release = undefined;
    expect(await scan).toMatchObject({ cancelled: true, enqueuedUpsert: 0, enqueuedDelete: 0 });
    expect(stream.closed).toBe(true);
    expect(() => fs.fstatSync(descriptor)).toThrow();
    expect(fs.readFileSync(file)).toEqual(body);
    expect(fs.existsSync(dbDir)).toBe(false);
  } finally {
    release?.();
    await scan;
    closeLibraryCorpus(dbDir);
    vi.restoreAllMocks(); syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
