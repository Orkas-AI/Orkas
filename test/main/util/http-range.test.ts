import { describe, it, expect } from 'vitest';

import { parseByteRange } from '../../../src/main/util/http-range';

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
