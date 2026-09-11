import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// A CLI turn used to parse the whole canonical log to keep ≤20 user turns
// (2026-08-28 review A-2). The bounded tail read must still hand the compiler
// everything it anchors on: the turn boundary, the stored history cursor and
// enough prior user turns; a missing boundary keeps the whole-log behavior.
let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-cli-tail-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeLog(rows: number): string {
  const file = path.join(tmpDir, 'conv.jsonl');
  const lines: string[] = [];
  for (let i = 0; i < rows; i += 1) {
    const user = i % 2 === 0;
    lines.push(JSON.stringify({
      id: `m${i}`,
      ts: `2026-08-28T00:00:${String(i % 60).padStart(2, '0')}`,
      from: user ? 'user' : 'commander',
      to: [user ? 'commander' : 'user'],
      text: `${user ? 'ask' : 'reply'} ${i} ${'x'.repeat(200)}`,
    }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

describe('_readCliCanonicalTail', () => {
  it('reads a bounded tail that still contains the boundary and 40 prior user turns', async () => {
    const { _readCliCanonicalTailForTest } = await import('../../../../src/main/features/group_chat/bus');
    const file = writeLog(2000);
    const rows = await _readCliCanonicalTailForTest(file, { boundaryId: 'm1998' });
    expect(rows.at(-1)?.id).toBe('m1999');
    expect(rows.some((r) => r.id === 'm1998')).toBe(true);
    const boundaryAt = rows.findIndex((r) => r.id === 'm1998');
    expect(rows.slice(0, boundaryAt).filter((r) => r.from === 'user').length).toBeGreaterThanOrEqual(40);
    expect(rows.length).toBeLessThan(2000 / 2);
    // Chronological, contiguous tail.
    expect(rows.map((r) => Number(r.id.slice(1)))).toEqual(
      Array.from({ length: rows.length }, (_, i) => 2000 - rows.length + i),
    );
  });

  it('extends the tail back to the stored history cursor when it is older than the turn window', async () => {
    const { _readCliCanonicalTailForTest } = await import('../../../../src/main/features/group_chat/bus');
    const file = writeLog(2000);
    const rows = await _readCliCanonicalTailForTest(file, { boundaryId: 'm1998', anchorId: 'm900' });
    expect(rows.some((r) => r.id === 'm900')).toBe(true);
    expect(rows[0].id).toBe(`m${2000 - rows.length}`);
    expect(rows.length).toBeLessThan(2000);
  });

  it('falls back to the whole log when the boundary is absent', async () => {
    const { _readCliCanonicalTailForTest } = await import('../../../../src/main/features/group_chat/bus');
    const file = writeLog(700);
    const rows = await _readCliCanonicalTailForTest(file, { boundaryId: 'missing' });
    expect(rows).toHaveLength(700);
    expect(rows[0].id).toBe('m0');
  });
});
