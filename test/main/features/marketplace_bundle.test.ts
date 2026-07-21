import { afterEach, describe, expect, it, vi } from 'vitest';

import AdmZip from 'adm-zip';

import {
  downloadMarketplaceBundle,
  inspectMarketplaceBundle,
  MAX_MARKETPLACE_BUNDLE_ENTRIES,
  MAX_MARKETPLACE_BUNDLE_UNCOMPRESSED_BYTES,
  parseMarketplaceBundle,
  readMarketplaceBundleBody,
  safeRelPath,
} from '../../../src/main/features/marketplace_bundle';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('marketplace bundle downloads', () => {
  it('rejects an oversized declared content length before reading the body', async () => {
    const response = new Response('small', { headers: { 'content-length': '6' } });

    await expect(readMarketplaceBundleBody(response, { maxBytes: 5 }))
      .rejects.toThrow('bundle compressed size exceeds 5 bytes');
  });

  it('enforces the streamed byte count when content length is missing', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
      },
      cancel() { cancelled = true; },
    }));

    await expect(readMarketplaceBundleBody(response, { maxBytes: 5 }))
      .rejects.toThrow('bundle compressed size exceeds 5 bytes');
    expect(cancelled).toBe(true);
  });

  it('treats a smaller content length as advisory and still enforces streamed bytes', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
      },
    }), { headers: { 'content-length': '2' } });

    await expect(readMarketplaceBundleBody(response, { maxBytes: 5 }))
      .rejects.toThrow('bundle compressed size exceeds 5 bytes');
  });

  it('keeps the timeout active while the response body is stalled and cancels it', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { cancelled = true; },
    }))));

    const pending = expect(downloadMarketplaceBundle('test:bundle', 'https://example.test/skill.zip', {
      timeoutMs: 50,
      timeoutMessage: 'bundle body timeout',
      retries: 0,
    })).rejects.toThrow('bundle body timeout');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);

    await pending;
    expect(cancelled).toBe(true);
  });
});

describe('marketplace bundle inspection', () => {
  it('rejects archives over the entry-count limit before use', () => {
    const zip = new AdmZip();
    for (let i = 0; i <= MAX_MARKETPLACE_BUNDLE_ENTRIES; i += 1) {
      zip.addFile(`entries/${i}.txt`, Buffer.alloc(0));
    }

    expect(() => parseMarketplaceBundle(zip.toBuffer()))
      .toThrow(`zip entry count ${MAX_MARKETPLACE_BUNDLE_ENTRIES + 1} exceeds limit ${MAX_MARKETPLACE_BUNDLE_ENTRIES}`);
  });

  it('rejects an archive whose declared uncompressed total exceeds the limit', () => {
    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from('x'));
    const crafted = zip.toBuffer();
    const centralOffset = crafted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(centralOffset).toBeGreaterThanOrEqual(0);
    crafted.writeUInt32LE(MAX_MARKETPLACE_BUNDLE_UNCOMPRESSED_BYTES + 1, centralOffset + 24);

    expect(() => parseMarketplaceBundle(crafted))
      .toThrow(`zip uncompressed total exceeds ${MAX_MARKETPLACE_BUNDLE_UNCOMPRESSED_BYTES} bytes`);
  });

  it('parses and inspects one archive before callers discover or extract entries', () => {
    const zip = new AdmZip();
    zip.addFile('skill-id/SKILL.md', Buffer.from('---\nname: test\n---\n'));

    const parsed = parseMarketplaceBundle(zip.toBuffer());

    expect(inspectMarketplaceBundle(parsed).map(({ relPath }) => relPath))
      .toEqual(['skill-id/SKILL.md']);
  });

  it('rejects absolute, drive-rooted, traversal, and null-byte paths', () => {
    expect(safeRelPath('/tmp/file')).toBeNull();
    expect(safeRelPath('C:\\temp\\file')).toBeNull();
    expect(safeRelPath('../file')).toBeNull();
    expect(safeRelPath('bad\0file')).toBeNull();
    expect(safeRelPath('nested/file')).toBe('nested/file');
  });
});
