import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';

// Composer attachment routing (S9-2): a File dropped from the OS or pasted
// from Finder / Explorer resolves to a local path inside preload and is
// copied by main; only path-less Files (clipboard image data) keep the base64
// upload. The user-visible contract of the old byte route is preserved on the
// path route: the chip appears immediately, hash dedupe still applies, the
// same failure copy is shown, and one click/result telemetry pair is emitted.

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);

function extractFunction(name: string): string {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const asyncPrefix = source.slice(Math.max(0, start - 6), start) === 'async ' ? 'async ' : '';
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return asyncPrefix + source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function extractConst(name: string): string {
  const marker = `const ${name} = `;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const end = source.indexOf('];', start);
  return source.slice(start, end + 2);
}

type FakeFile = {
  name: string;
  size: number;
  localPath?: string;
  bytes?: Uint8Array;
  arrayBuffer: () => Promise<ArrayBuffer>;
  arrayBufferReads: number;
};

function fakeFile(name: string, opts: { localPath?: string; bytes?: Uint8Array } = {}): FakeFile {
  const bytes = opts.bytes || new TextEncoder().encode(`content of ${name}`);
  const file: FakeFile = {
    name,
    size: bytes.byteLength,
    localPath: opts.localPath,
    bytes,
    arrayBufferReads: 0,
    arrayBuffer: async () => {
      file.arrayBufferReads += 1;
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
  };
  return file;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function loadHarness(opts: {
  importResult?: (files: FakeFile[], resolved: number[]) => unknown;
  importReject?: Error;
  preloadSupportsPaths?: boolean;
  uploadResult?: (name: string) => unknown;
} = {}) {
  const chips = new Map<string, any[]>();
  const clicks: any[] = [];
  const events: any[] = [];
  const alerts: string[] = [];
  const uploads: Array<{ url: string; name: string; body: unknown }> = [];
  const importCalls: Array<{ scope: string; files: FakeFile[]; opts: any }> = [];
  let releaseImport: (() => void) | null = null;
  const importSettled = new Promise<void>((resolve) => { releaseImport = resolve; });
  // Main derives the kind from the extension on both routes; mirror that so
  // the chip assertions describe what the user would actually see.
  const kindOf = (name: string): string => context._chatAttachKindFromExt(context._chatAttachExtOf(name));

  const importLocalFiles = vi.fn((scope: string, files: FakeFile[], options: any) => {
    importCalls.push({ scope, files, opts: options });
    // Preload contract: the callback fires synchronously with the indexes of
    // Files that resolved to a path, before main starts copying.
    const resolved = files
      .map((file, index) => (file.localPath ? index : -1))
      .filter((index) => index >= 0);
    if (options && typeof options.onResolved === 'function') options.onResolved(resolved);
    return importSettled.then(() => {
      if (opts.importReject) throw opts.importReject;
      if (opts.importResult) return opts.importResult(files, resolved);
      return {
        ok: true,
        files: resolved.map((index) => ({
          index,
          name: files[index].name,
          ok: true,
          info: {
            name: files[index].name,
            kind: kindOf(files[index].name),
            bytes: files[index].size,
            mtime: 1,
          },
          sha256: sha256Hex(files[index].bytes!),
        })),
      };
    });
  });

  const context: any = {
    console,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Promise,
    Array,
    String,
    Number,
    Object,
    Uint8Array,
    crypto: webcrypto,
    encodeURIComponent,
    setTimeout,
    window: {
      orkas: opts.preloadSupportsPaths === false ? {} : { importLocalFiles },
    },
    URL: {
      createObjectURL: (file: FakeFile) => `blob:${file.name}`,
      revokeObjectURL: () => {},
    },
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
    uiAlert: vi.fn(async (text: string) => { alerts.push(text); }),
    _convTrackClick: vi.fn((name: string, payload: unknown) => { clicks.push({ name, payload }); }),
    _convTrackEvent: vi.fn((name: string, payload: unknown) => { events.push({ name, payload }); }),
    _chatAttachPayload: (cid: string, files: ArrayLike<FakeFile>, sourceName: string) => ({
      source: sourceName,
      target: 'conversation',
      file_count: Array.from(files).length,
    }),
    _chatAttachList: (cid: string) => chips.get(cid) || [],
    _chatAttachSet: (cid: string, items: any[]) => { chips.set(cid, items); },
    apiFetch: vi.fn(async (url: string, options: any) => {
      const name = decodeURIComponent(String(options.headers['X-Filename']));
      uploads.push({ url, name, body: options.body });
      const bytes = new Uint8Array(options.body);
      const data = opts.uploadResult
        ? opts.uploadResult(name)
        : { ok: true, info: { name, kind: kindOf(name), bytes: bytes.byteLength, mtime: 1 } };
      return { json: async () => data };
    }),
  };
  const code = [
    extractConst('CHAT_ATTACH_ACCEPT'),
    extractConst('CHAT_IMAGE_EXTS'),
    extractConst('CHAT_VIDEO_EXTS'),
    extractConst('CHAT_AUDIO_EXTS'),
    extractFunction('_chatAttachExtOf'),
    extractFunction('_chatAttachKindFromExt'),
    extractFunction('_chatAttachHex'),
    extractFunction('_chatAttachSha256'),
    extractFunction('_chatAttachPrepareUploadFiles'),
    extractFunction('_chatAttachReplaceByTempId'),
    extractFunction('_chatAttachNewTempId'),
    extractFunction('_chatAttachStartLocalImport'),
    extractFunction('_chatAttachSettleLocalImport'),
    extractFunction('_chatAttachUploadBytes'),
    extractFunction('_chatAttachUploadCore'),
  ].join('\n');
  vm.createContext(context);
  vm.runInContext(code, context, { filename: 'conversation-attach.js' });
  return {
    context,
    chips,
    clicks,
    events,
    alerts,
    uploads,
    importCalls,
    importLocalFiles,
    releaseImport: () => releaseImport!(),
    upload: (cid: string, files: FakeFile[], sourceName: string): Promise<void> =>
      context._chatAttachUploadCore(cid, files, sourceName),
  };
}

const CID = 'conv-route-1';

describe('composer attachment routing: OS files by path, clipboard data by bytes', () => {
  it.each(['drop', 'paste'])(
    'copies a %s of a genuine OS file by path, paints its chip immediately, and never reads its bytes in the renderer',
    async (sourceName) => {
      const h = loadHarness();
      const file = fakeFile('report.csv', { localPath: '/Users/test/Desktop/report.csv' });

      const done = h.upload(CID, [file], sourceName);
      // Chip is visible before main has copied anything (import still held).
      expect(h.chips.get(CID)).toEqual([expect.objectContaining({
        name: 'report.csv', displayName: 'report.csv', kind: 'text', bytes: file.size, status: 'uploading',
      })]);
      expect(h.importCalls).toEqual([expect.objectContaining({ scope: 'conversation' })]);
      expect(h.importCalls[0].opts).toMatchObject({ cid: CID });
      // The renderer only ever hands the File objects to preload; no path
      // string is visible on this side of the bridge.
      expect(JSON.stringify(h.importCalls[0].opts)).not.toContain('/Users/');

      h.releaseImport();
      await done;

      expect(h.uploads).toEqual([]);
      expect(file.arrayBufferReads).toBe(0);
      expect(h.chips.get(CID)).toEqual([expect.objectContaining({
        name: 'report.csv',
        displayName: 'report.csv',
        kind: 'text',
        bytes: file.size,
        reused: false,
        sha256: sha256Hex(file.bytes!),
        status: 'ready',
      })]);
      expect(h.clicks).toEqual([{
        name: 'chat_attachment_upload',
        payload: { source: sourceName, target: 'conversation', file_count: 1 },
      }]);
      expect(h.events).toEqual([{
        name: 'chat_attachment_upload_result',
        payload: {
          source: sourceName, target: 'conversation', file_count: 1,
          result: 'success', uploaded_count: 1, failed_count: 0,
        },
      }]);
      expect(h.alerts).toEqual([]);
    },
  );

  it('keeps the base64 upload for a path-less clipboard File (negative control)', async () => {
    const h = loadHarness();
    const blob = fakeFile('screenshot.png', { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) });

    const done = h.upload(CID, [blob], 'paste');
    h.releaseImport();
    await done;

    // Preload was consulted (it is the only place that knows about paths) and
    // reported nothing resolvable, so the byte route ran unchanged.
    expect(h.importCalls).toHaveLength(1);
    expect(h.uploads).toEqual([expect.objectContaining({
      url: `/api/conversations/${encodeURIComponent(CID)}/attachments/upload`,
      name: 'screenshot.png',
    })]);
    expect(new Uint8Array(h.uploads[0].body as ArrayBuffer)).toEqual(blob.bytes);
    expect(blob.arrayBufferReads).toBe(1);
    expect(h.chips.get(CID)).toEqual([expect.objectContaining({
      name: 'screenshot.png', kind: 'image', dataUrl: 'blob:screenshot.png',
      sha256: sha256Hex(blob.bytes!), status: 'ready',
    })]);
    expect(h.events).toEqual([expect.objectContaining({
      payload: expect.objectContaining({ result: 'success', uploaded_count: 1, failed_count: 0 }),
    })]);
  });

  it('splits one mixed drop into both routes under a single click/result telemetry pair', async () => {
    const h = loadHarness();
    const osFile = fakeFile('notes.md', { localPath: '/tmp/notes.md' });
    const blob = fakeFile('pasted.png', { bytes: new Uint8Array([1, 2, 3, 4]) });

    const done = h.upload(CID, [blob, osFile], 'drop');
    h.releaseImport();
    await done;

    expect(h.importCalls[0].files).toEqual([blob, osFile]);
    expect(h.uploads.map((u) => u.name)).toEqual(['pasted.png']);
    expect(osFile.arrayBufferReads).toBe(0);
    expect(h.chips.get(CID)!.map((c) => [c.name, c.status])).toEqual([
      ['notes.md', 'ready'],
      ['pasted.png', 'ready'],
    ]);
    expect(h.clicks).toHaveLength(1);
    expect(h.events).toEqual([{
      name: 'chat_attachment_upload_result',
      payload: {
        source: 'drop', target: 'conversation', file_count: 2,
        result: 'success', uploaded_count: 2, failed_count: 0,
      },
    }]);
  });

  it('shows the same rejection outcome whether main refuses the file on the path route or the byte route', async () => {
    const reject = { ok: false, error: 'errors.file_too_large_mb' };
    const viaPath = loadHarness({
      importResult: (files, resolved) => ({
        ok: true,
        files: resolved.map((index) => ({ index, name: files[index].name, ...reject })),
      }),
    });
    const viaBytes = loadHarness({ uploadResult: () => reject });
    const osFile = fakeFile('huge.zip', { localPath: '/tmp/huge.zip' });
    const blob = fakeFile('huge.zip');

    const pathDone = viaPath.upload(CID, [osFile], 'drop');
    viaPath.releaseImport();
    await pathDone;
    const bytesDone = viaBytes.upload(CID, [blob], 'drop');
    viaBytes.releaseImport();
    await bytesDone;

    for (const h of [viaPath, viaBytes]) {
      expect(h.chips.get(CID)).toEqual([]);
      expect(h.alerts).toEqual([
        'chat.attach_rejected_prefix:'
        + JSON.stringify({ list: 'chat.attach_upload_fail:' + JSON.stringify({ name: 'huge.zip', reason: 'errors.file_too_large_mb' }) }),
      ]);
      expect(h.events).toEqual([expect.objectContaining({
        payload: expect.objectContaining({ result: 'failure', uploaded_count: 0, failed_count: 1 }),
      })]);
    }
  });

  it('lets a path-imported chip dedupe a later identical clipboard paste, like a byte-uploaded chip does', async () => {
    const h = loadHarness();
    const bytes = new TextEncoder().encode('same content');
    const osFile = fakeFile('a.txt', { localPath: '/tmp/a.txt', bytes });
    const pasted = fakeFile('b.txt', { bytes });

    const first = h.upload(CID, [osFile], 'drop');
    h.releaseImport();
    await first;
    await h.upload(CID, [pasted], 'paste');

    expect(h.uploads).toEqual([]);
    expect(h.chips.get(CID)!.map((c) => c.name)).toEqual(['a.txt']);
    expect(h.events[1]).toEqual({
      name: 'chat_attachment_upload_result',
      payload: expect.objectContaining({ source: 'paste', result: 'skipped', uploaded_count: 0, failed_count: 0 }),
    });
  });

  it('falls back to the byte upload when preload cannot resolve paths at all', async () => {
    const h = loadHarness({ preloadSupportsPaths: false });
    const osFile = fakeFile('legacy.md', { localPath: '/tmp/legacy.md' });

    await h.upload(CID, [osFile], 'drop');

    expect(h.importCalls).toEqual([]);
    expect(h.uploads.map((u) => u.name)).toEqual(['legacy.md']);
    expect(h.chips.get(CID)).toEqual([expect.objectContaining({ name: 'legacy.md', status: 'ready' })]);
  });

  it('keeps an error chip when the path import reply is lost so the send preflight can reconcile', async () => {
    const h = loadHarness({ importReject: new Error('ipc reply lost') });
    const osFile = fakeFile('kept.md', { localPath: '/tmp/kept.md' });

    const done = h.upload(CID, [osFile], 'drop');
    h.releaseImport();
    await done;

    expect(h.chips.get(CID)).toEqual([expect.objectContaining({ name: 'kept.md', status: 'error' })]);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toContain('ipc reply lost');
    expect(h.events).toEqual([expect.objectContaining({
      payload: expect.objectContaining({ result: 'failure', uploaded_count: 0, failed_count: 1 }),
    })]);
  });

  it('still rejects unsupported extensions before either route runs', async () => {
    const h = loadHarness();
    const osFile = fakeFile('tool.exe', { localPath: '/tmp/tool.exe' });

    await h.upload(CID, [osFile], 'drop');

    expect(h.importCalls).toEqual([]);
    expect(h.uploads).toEqual([]);
    expect(h.chips.get(CID)).toBeUndefined();
    expect(h.alerts[0]).toContain('chat.attach_unsupported');
    expect(h.events).toEqual([expect.objectContaining({
      payload: expect.objectContaining({ result: 'failure', uploaded_count: 0, failed_count: 1 }),
    })]);
  });
});
