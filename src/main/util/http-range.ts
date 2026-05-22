/**
 * Single-range `Range: bytes=...` header parser for the local-media protocol
 * handlers (`chat-media://`, `kb-file://`).
 *
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

export interface ByteRange {
  /** First byte offset to send, inclusive. */
  start: number;
  /** Last byte offset to send, inclusive. */
  end: number;
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
