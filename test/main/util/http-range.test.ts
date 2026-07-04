import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseByteRange,
  ifNoneMatchMatches,
  serveFileRange,
} from '../../../src/main/util/http-range';

// `parseByteRange` is a header parser feeding the `chat-media://` / `kb-file://`
// protocol handlers, so it follows the §9 "set A / set B" discipline:
//   - set A: the request shapes Chromium's <video>/<audio>/PDFium actually send
//            (`bytes=N-`, `bytes=N-M`, suffix `bytes=-N`), each must yield a
//            clamped {start,end} or 'unsatisfiable';
//   - set B: look-alike strings (wrong unit, multi-range, inverted, junk,
//            missing `=`) that must be treated as "no range" → null, so the
//            handler falls back to a plain 200 instead of mis-slicing.

describe('parseByteRange › set A — real range shapes', () => {
  it('open-ended `bytes=N-` covers N..EOF (Chromium media probe shape)', () => {
    expect(parseByteRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=500-', 2000)).toEqual({ start: 500, end: 1999 });
  });

  it('closed `bytes=N-M` is inclusive on both ends', () => {
    expect(parseByteRange('bytes=500-999', 2000)).toEqual({ start: 500, end: 999 });
    expect(parseByteRange('bytes=0-0', 100)).toEqual({ start: 0, end: 0 });
  });

  it('clamps the end down to EOF when M runs past the file', () => {
    expect(parseByteRange('bytes=500-99999', 2000)).toEqual({ start: 500, end: 1999 });
  });

  it('suffix `bytes=-N` selects the last N bytes', () => {
    expect(parseByteRange('bytes=-500', 2000)).toEqual({ start: 1500, end: 1999 });
  });

  it('suffix larger than the file collapses to the whole file', () => {
    expect(parseByteRange('bytes=-5000', 2000)).toEqual({ start: 0, end: 1999 });
  });

  it('tolerates whitespace around the unit, `=` and `-`', () => {
    expect(parseByteRange('  bytes = 0 - 10 ', 100)).toEqual({ start: 0, end: 10 });
  });
});

describe('parseByteRange › set A — unsatisfiable but well-formed', () => {
  it('start at or past EOF → unsatisfiable (caller returns 416)', () => {
    expect(parseByteRange('bytes=2000-3000', 2000)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=2000-', 2000)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=5000-', 2000)).toBe('unsatisfiable');
  });

  it('zero-length suffix `bytes=-0` → unsatisfiable', () => {
    expect(parseByteRange('bytes=-0', 100)).toBe('unsatisfiable');
  });
});

describe('parseByteRange › set B — look-alikes that must NOT be honoured', () => {
  it('absent / empty header → null', () => {
    expect(parseByteRange(undefined, 100)).toBeNull();
    expect(parseByteRange(null, 100)).toBeNull();
    expect(parseByteRange('', 100)).toBeNull();
  });

  it('a unit other than `bytes` → null', () => {
    expect(parseByteRange('items=0-10', 100)).toBeNull();
  });

  it('missing `=` separator → null', () => {
    expect(parseByteRange('bytes 0-10', 100)).toBeNull();
  });

  it('multi-range comma list → null (we never emit multipart/byteranges)', () => {
    expect(parseByteRange('bytes=0-10,20-30', 100)).toBeNull();
  });

  it('inverted range (start > end) → null', () => {
    expect(parseByteRange('bytes=10-5', 100)).toBeNull();
  });

  it('empty on both sides `bytes=-` → null', () => {
    expect(parseByteRange('bytes=-', 100)).toBeNull();
  });

  it('non-numeric / non-integer offsets → null', () => {
    expect(parseByteRange('bytes=abc-def', 100)).toBeNull();
    expect(parseByteRange('bytes=1.5-2.5', 100)).toBeNull();
  });
});

describe('parseByteRange › degenerate totals', () => {
  it('a zero-byte entity has nothing to range over → null (serve empty 200)', () => {
    expect(parseByteRange('bytes=0-', 0)).toBeNull();
    expect(parseByteRange('bytes=-10', 0)).toBeNull();
  });

  it('a non-finite or negative total → null', () => {
    expect(parseByteRange('bytes=0-', Number.NaN)).toBeNull();
    expect(parseByteRange('bytes=0-', -5)).toBeNull();
  });
});

// ── ifNoneMatchMatches ─────────────────────────────────────────────────────
// The 304 short-circuit's gate. It only decides "the client already holds these
// exact bytes"; same set A / set B discipline — a header that means "I have this
// version" must match, a look-alike that doesn't must NOT (else we'd 304 a
// changed file and the renderer would keep showing the stale image — the very
// bug this revalidation contract exists to prevent).
describe('ifNoneMatchMatches › matches that must 304', () => {
  it('an exact ETag echo matches', () => {
    expect(ifNoneMatchMatches('"123-456"', '"123-456"')).toBe(true);
  });

  it('the `*` wildcard matches any current ETag', () => {
    expect(ifNoneMatchMatches('*', '"123-456"')).toBe(true);
  });

  it('a weak `W/` prefix on either side still matches (stable on-disk validator)', () => {
    expect(ifNoneMatchMatches('W/"123-456"', '"123-456"')).toBe(true);
    expect(ifNoneMatchMatches('"123-456"', 'W/"123-456"')).toBe(true);
  });

  it('finds the ETag inside a comma-separated list', () => {
    expect(ifNoneMatchMatches('"aaa-1", "123-456" , W/"bbb-2"', '"123-456"')).toBe(true);
  });
});

describe('ifNoneMatchMatches › non-matches that must revalidate (200/206)', () => {
  it('a different ETag (file overwritten → new mtime/size) does NOT match', () => {
    expect(ifNoneMatchMatches('"123-456"', '"999-456"')).toBe(false);
    expect(ifNoneMatchMatches('"123-456"', '"123-789"')).toBe(false);
  });

  it('absent / empty header → false', () => {
    expect(ifNoneMatchMatches(null, '"123-456"')).toBe(false);
    expect(ifNoneMatchMatches(undefined, '"123-456"')).toBe(false);
    expect(ifNoneMatchMatches('', '"123-456"')).toBe(false);
  });

  it('an empty current ETag (no mtime known) never matches', () => {
    expect(ifNoneMatchMatches('"123-456"', '')).toBe(false);
    expect(ifNoneMatchMatches('*', '')).toBe(false);
  });
});

// ── serveFileRange ─────────────────────────────────────────────────────────
// The Response builder behind chat-media:// / kb-file:// / chat-app://. The
// freshness contract (no-cache + (mtime,size) ETag + conditional 304, with
// Range fetches deliberately exempt from 304) is what stops an image
// regenerated to the same path from showing its previous bytes in the bubble.
describe('serveFileRange', () => {
  const CONTENT = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'; // 26 bytes
  let filePath: string;
  let size: number;
  let etag: string;

  const makeReq = (headers: Record<string, string> = {}) =>
    new Request('https://media.test/file', { headers });

  beforeAll(() => {
    filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'serve-file-range-')), 'asset.bin');
    fs.writeFileSync(filePath, CONTENT);
    const st = fs.statSync(filePath);
    size = st.size;
    etag = `"${Math.floor(st.mtimeMs)}-${st.size}"`;
  });

  afterAll(() => {
    try { fs.rmSync(path.dirname(filePath), { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('full GET: 200 with no-cache, the (mtime,size) ETag, and the whole body', async () => {
    const st = fs.statSync(filePath);
    const resp = serveFileRange(makeReq(), filePath, 'application/octet-stream', size, st.mtimeMs);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('Cache-Control')).toBe('no-cache');
    expect(resp.headers.get('Accept-Ranges')).toBe('bytes');
    expect(resp.headers.get('ETag')).toBe(etag);
    expect(resp.headers.get('Content-Length')).toBe(String(size));
    expect(await resp.text()).toBe(CONTENT);
  });

  it('matching If-None-Match on a full GET → 304, ETag echoed, empty body', async () => {
    const st = fs.statSync(filePath);
    const resp = serveFileRange(
      makeReq({ 'If-None-Match': etag }), filePath, 'application/octet-stream', size, st.mtimeMs,
    );
    expect(resp.status).toBe(304);
    expect(resp.headers.get('ETag')).toBe(etag);
    expect(resp.headers.get('Cache-Control')).toBe('no-cache');
    expect((await resp.arrayBuffer()).byteLength).toBe(0);
  });

  it('stale If-None-Match (overwritten in place) → 200 fresh bytes, NOT 304', async () => {
    // The regression guard for the reported bug: the cached copy carries the
    // previous file version's ETag, which no longer matches → serve fresh.
    const st = fs.statSync(filePath);
    const resp = serveFileRange(
      makeReq({ 'If-None-Match': '"0-0"' }), filePath, 'application/octet-stream', size, st.mtimeMs,
    );
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe(CONTENT);
  });

  it('Range GET → 206 with Content-Range and exactly the sliced bytes', async () => {
    const st = fs.statSync(filePath);
    const resp = serveFileRange(
      makeReq({ Range: 'bytes=0-3' }), filePath, 'application/octet-stream', size, st.mtimeMs,
    );
    expect(resp.status).toBe(206);
    expect(resp.headers.get('Content-Range')).toBe(`bytes 0-3/${size}`);
    expect(resp.headers.get('Content-Length')).toBe('4');
    expect(await resp.text()).toBe('ABCD');
  });

  it('a matching If-None-Match on a Range GET still streams 206 (no 304 on partial fetch)', async () => {
    // Media probes pair Range with If-Range; a 304 here would strand <video>.
    const st = fs.statSync(filePath);
    const resp = serveFileRange(
      makeReq({ Range: 'bytes=0-3', 'If-None-Match': etag }),
      filePath, 'application/octet-stream', size, st.mtimeMs,
    );
    expect(resp.status).toBe(206);
    expect(await resp.text()).toBe('ABCD');
  });

  it('unsatisfiable range → 416 with a `bytes */total` Content-Range', async () => {
    const st = fs.statSync(filePath);
    const resp = serveFileRange(
      makeReq({ Range: 'bytes=99999-' }), filePath, 'application/octet-stream', size, st.mtimeMs,
    );
    expect(resp.status).toBe(416);
    expect(resp.headers.get('Content-Range')).toBe(`bytes */${size}`);
  });

  it('no mtime → no ETag, so a conditional request is ignored and the body is served', async () => {
    const resp = serveFileRange(
      makeReq({ 'If-None-Match': '"anything"' }), filePath, 'application/octet-stream', size,
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get('ETag')).toBeNull();
    expect(await resp.text()).toBe(CONTENT);
  });

  it('a mid-stream read error fires the onStreamError hook', async () => {
    const missing = path.join(path.dirname(filePath), 'does-not-exist.bin');
    let captured: Error | undefined;
    const resp = serveFileRange(
      makeReq(), missing, 'application/octet-stream', 10, 123, (err) => { captured = err; },
    );
    // Consuming the body pulls from the (failing) read stream; the error
    // propagates to both the web stream (rejects) and our error listener.
    await expect(resp.arrayBuffer()).rejects.toThrow();
    expect(captured).toBeInstanceOf(Error);
  });
});
