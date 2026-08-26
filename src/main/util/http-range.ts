/**
 * Range parsing + file streaming for the local-media protocol handlers
 * (`chat-media://`, `kb-file://`, `chat-app://`). `parseByteRange` decides the
 * status family; `serveFileRange` turns a resolved file into the actual
 * Range-aware, revalidatable `Response`. Both live here (not in `index.ts`) so
 * the `set A / set B` discipline and the cache/304 contract are unit-testable
 * without booting Electron — see `test/main/util/http-range.test.ts`.
 *
 * `parseByteRange` — single-range `Range: bytes=...` header parsing:
 * Chromium's `<video>` / `<audio>` element only ever sends simple `bytes=N-`
 * (and occasionally `bytes=N-M` / suffix `bytes=-N`) ranges, so we honour
 * exactly that family and treat anything fancier (multi-range comma lists,
 * units other than `bytes`, malformed syntax) as "no range". The contract is
 * intentionally three-valued so the caller can pick the right status code:
 *
 *   - `null`            → no usable Range header. Caller serves the full
 *                         entity with `200` (still advertise `Accept-Ranges`).
 *   - `'unsatisfiable'` → a well-formed `bytes` range that selects no byte in
 *                         `[0, total)`. Caller returns `416` with a
 *                         `Content-Range` of `bytes` + `*` + `/` + total.
 *   - `{ start, end }`  → inclusive byte offsets clamped to `[0, total-1]`.
 *                         Caller returns `206` with
 *                         `Content-Range: bytes start-end/total` and a body of
 *                         exactly `end - start + 1` bytes.
 *
 * `total <= 0` (e.g. a zero-byte file) always yields `null` — there is nothing
 * to range over and an empty `200` is friendlier than a `416`.
 *
 * Why a dedicated module with fixtures: Range parsing is the kind of
 * pattern-matching code that breaks silently when a guard is widened — the
 * accepted-shape set (`set A`) and the look-alike-reject set (`set B`) are
 * pinned by `test/main/util/http-range.test.ts`.
 */

import * as fs from 'node:fs';
import { Readable } from 'node:stream';

export interface ByteRange {
  /** First byte offset to send, inclusive. */
  start: number;
  /** Last byte offset to send, inclusive. */
  end: number;
}

export type FileRangeHeaderKind = 'none' | 'ignored' | 'satisfiable' | 'unsatisfiable';

/**
 * Privacy-safe response metadata for protocol diagnostics. Deliberately omits
 * the URL and resolved file path: callers can log this object in feedback
 * bundles without exposing a user's filenames or directory layout.
 */
export interface FileRangeResponseDiagnostic {
  requestMethod: string;
  rangeHeaderKind: FileRangeHeaderKind;
  status: 200 | 206 | 304 | 416;
  totalBytes: number;
  responseBytes: number;
  rangeStart?: number;
  rangeEnd?: number;
  cacheRevalidated: boolean;
  prepareDurationMs: number;
}

export interface FileRangeStreamDiagnostic {
  outcome: 'completed' | 'failed' | 'closed_before_end';
  bytesRead: number;
  durationMs: number;
}

export function parseByteRange(
  header: string | null | undefined,
  total: number,
): null | 'unsatisfiable' | ByteRange {
  if (!header || !Number.isFinite(total) || total <= 0) return null;

  // One range only: `bytes=` then `START-END`, either side optionally empty.
  // A comma list, a non-`bytes` unit, or any other junk fails this match and
  // is treated as "no range" (serve the full entity).
  const m = /^\s*bytes\s*=\s*([0-9]*)\s*-\s*([0-9]*)\s*$/.exec(header);
  if (!m) return null;
  const startStr = m[1];
  const endStr = m[2];
  if (startStr === '' && endStr === '') return null; // `bytes=-` is meaningless

  if (startStr === '') {
    // Suffix range: the final `endStr` bytes of the entity.
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix)) return null;
    if (suffix === 0) return 'unsatisfiable'; // `bytes=-0`
    return { start: Math.max(0, total - suffix), end: total - 1 };
  }

  const start = Number(startStr);
  if (!Number.isFinite(start)) return null;
  if (start >= total) return 'unsatisfiable'; // first requested byte past EOF

  let end = endStr === '' ? total - 1 : Number(endStr);
  if (!Number.isFinite(end)) return null;
  if (end < start) return null; // inverted range → ignore the header entirely
  if (end > total - 1) end = total - 1; // clamp to EOF
  return { start, end };
}

/**
 * Match a request's `If-None-Match` against our current ETag for the 304
 * short-circuit. Honours the `*` wildcard and comma-separated lists, and
 * ignores weak (`W/`) prefixes — for a local file served off disk the
 * `(mtime,size)` validator is stable, so a weak match is as good as a strong
 * one for "the client already has these exact bytes".
 */
export function ifNoneMatchMatches(header: string | null | undefined, etag: string): boolean {
  if (!header || !etag) return false;
  const trimmed = header.trim();
  if (trimmed === '*') return true;
  const strip = (s: string) => s.trim().replace(/^W\//, '');
  const want = strip(etag);
  return trimmed.split(',').some((tok) => strip(tok) === want);
}

/**
 * Stream a file on disk back through a `protocol.handle` callback with HTTP
 * Range support — shared by `kb-file://`, `chat-media://`, and `chat-app://`.
 *
 * Why this exists: a `protocol.handle` reply that returns `200` + a
 * `Content-Length` but no `Accept-Ranges` makes Chromium treat the resource
 * as non-seekable. For `<video preload="metadata">` that is fatal — Chromium's
 * metadata probe fetches only the head of the file and then *cancels* its
 * request; when playback later runs past that prefetched head buffer it has no
 * way to resume (the resource is "not range-capable" and the original request
 * is gone), so the `<video>` freezes a few seconds in with no error in the UI.
 * Advertising `Accept-Ranges: bytes` + honouring `206` requests is the fix; it
 * also makes seeking work and lets PDFium fetch only the pages it shows.
 *
 * The body is a lazy `fs.createReadStream` (not `fs.readFileSync`), so a 200 MB
 * video doesn't spike RSS by 200 MB.
 *
 * `totalSize` is the caller's already-statted byte length, so we don't `stat`
 * the file a second time. `mtimeMs` (also already statted) drives the ETag so
 * the cache can revalidate instead of serving stale bytes — see below.
 *
 * Freshness — `no-cache` + ETag instead of a `max-age` window: every file
 * these protocols serve lives under a STABLE url but can be rewritten in place
 * (a portrait re-generated to the same path, a chat artifact re-rendered, a KB
 * file edited). A time-based TTL meant the renderer's `<img>` kept showing the
 * previous bytes until the window lapsed — e.g. regenerating the host portrait
 * left the old image in the chat bubble. `no-cache` makes Chromium revalidate
 * before reusing its copy; the `(mtime,size)` ETag lets an unchanged file still
 * answer `304` so videos/PDFs aren't re-streamed needlessly.
 *
 * `onStreamError` is invoked if the read stream errors mid-flight (best-effort
 * logging hook; the partial response is already in flight, nothing to recover).
 * `onResponsePrepared` receives bounded, path-free metadata immediately before
 * the response is returned. `onStreamFinished` measures the lazy file stream,
 * including early closes that commonly mean the consumer cancelled a request.
 * All hooks are observational: a hook failure must never break media delivery.
 */
export function serveFileRange(
  request: Request,
  absPath: string,
  contentType: string,
  totalSize: number,
  mtimeMs?: number,
  onStreamError?: (err: Error, diagnostic: FileRangeStreamDiagnostic) => void,
  onResponsePrepared?: (diagnostic: FileRangeResponseDiagnostic) => void,
  onStreamFinished?: (diagnostic: FileRangeStreamDiagnostic) => void,
): Response {
  const startedAt = Date.now();
  const etag = typeof mtimeMs === 'number' && Number.isFinite(mtimeMs)
    ? `"${Math.floor(mtimeMs)}-${totalSize}"`
    : '';
  const baseHeaders: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    ...(etag ? { ETag: etag } : {}),
  };
  const rangeHeader = request.headers.get('Range');
  const range = parseByteRange(rangeHeader, totalSize);
  const rangeHeaderKind: FileRangeHeaderKind = !rangeHeader
    ? 'none'
    : range === null
      ? 'ignored'
      : range === 'unsatisfiable'
        ? 'unsatisfiable'
        : 'satisfiable';
  const notifyPrepared = (
    status: FileRangeResponseDiagnostic['status'],
    responseBytes: number,
    selectedRange?: ByteRange,
  ) => {
    if (!onResponsePrepared) return;
    try {
      onResponsePrepared({
        requestMethod: request.method || 'GET',
        rangeHeaderKind,
        status,
        totalBytes: totalSize,
        responseBytes,
        ...(selectedRange ? { rangeStart: selectedRange.start, rangeEnd: selectedRange.end } : {}),
        cacheRevalidated: status === 304,
        prepareDurationMs: Math.max(0, Date.now() - startedAt),
      });
    } catch {
      // Diagnostics must not affect a protocol response.
    }
  };

  // Conditional revalidation for full (non-Range) GETs: when the client's
  // cached ETag still matches the current (mtime,size) it may reuse its copy.
  // Skipped for Range requests — media probes pair Range with If-Range, and a
  // 304 on a partial fetch would strand the `<video>` (see the Range note
  // above), so partial requests always stream fresh 206 bytes.
  if (etag && range === null && ifNoneMatchMatches(request.headers.get('If-None-Match'), etag)) {
    const response = new Response(null, { status: 304, headers: baseHeaders });
    notifyPrepared(304, 0);
    return response;
  }

  if (range === 'unsatisfiable') {
    const response = new Response('requested range not satisfiable', {
      status: 416,
      headers: { ...baseHeaders, 'Content-Range': `bytes */${totalSize}` },
    });
    notifyPrepared(416, 0);
    return response;
  }

  const nodeStream = range
    ? fs.createReadStream(absPath, { start: range.start, end: range.end })
    : fs.createReadStream(absPath);
  let streamSettled = false;
  const finishStream = (outcome: FileRangeStreamDiagnostic['outcome'], err?: Error) => {
    if (streamSettled) return;
    streamSettled = true;
    const diagnostic: FileRangeStreamDiagnostic = {
      outcome,
      bytesRead: nodeStream.bytesRead,
      durationMs: Math.max(0, Date.now() - startedAt),
    };
    if (err) {
      try { onStreamError?.(err, diagnostic); } catch { /* diagnostics only */ }
    }
    try { onStreamFinished?.(diagnostic); } catch { /* diagnostics only */ }
  };
  nodeStream.once('end', () => { finishStream('completed'); });
  nodeStream.on('error', (err) => {
    finishStream('failed', err as Error);
  });
  nodeStream.once('close', () => { finishStream('closed_before_end'); });
  const body = Readable.toWeb(nodeStream) as unknown as ReadableStream;

  if (range) {
    const response = new Response(body, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes ${range.start}-${range.end}/${totalSize}`,
        'Content-Length': String(range.end - range.start + 1),
      },
    });
    notifyPrepared(206, range.end - range.start + 1, range);
    return response;
  }
  const response = new Response(body, {
    headers: { ...baseHeaders, 'Content-Length': String(totalSize) },
  });
  notifyPrepared(200, totalSize);
  return response;
}
