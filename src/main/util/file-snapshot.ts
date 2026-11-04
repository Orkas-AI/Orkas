import * as fsp from 'node:fs/promises';
import type { Stats } from 'node:fs';

function signature(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/** Read-only derived projections, validated on every use rather than by TTL.
 * Keep source parsers/normalizers in their owning feature. Never retain raw
 * documents or secrets when a small projection is sufficient. */
export class FileSnapshotCache<T> {
  private readonly entries = new Map<string, { signature: string; value: T; weight: number }>();
  private readonly pending = new Map<string, { signature: string; run: Promise<T | null> }>();
  private weight = 0;

  constructor(private readonly size: (value: T) => number, private readonly maxEntries = 4096,
    private readonly maxWeight = 8 * 1024 * 1024) {}

  async read(file: string, load: () => Promise<T | null>): Promise<T | null> {
    let before: Stats;
    try { before = await fsp.stat(file); }
    catch {
      this.drop(file);
      // Preserve the owner's handling of missing, malformed or denied sources.
      return load();
    }
    const stamp = signature(before);
    const cached = this.entries.get(file);
    if (cached?.signature === stamp) {
      this.entries.delete(file); this.entries.set(file, cached);
      return cached.value;
    }
    const existing = this.pending.get(file);
    if (existing?.signature === stamp) return existing.run;
    let run!: Promise<T | null>;
    run = (async () => {
      const value = await load();
      const after = await fsp.stat(file).catch(() => null);
      // Atomic replacement or an in-place sync during a read must not publish
      // the old value under a newer file identity, or replace a newer flight.
      if (this.pending.get(file)?.run === run && after && signature(after) === stamp) {
        this.drop(file);
        if (value !== null) {
          const weight = Math.max(1, this.size(value));
          if (weight <= this.maxWeight) {
            this.entries.set(file, { signature: stamp, value, weight });
            this.weight += weight;
            while (this.entries.size > this.maxEntries || this.weight > this.maxWeight) {
              this.drop(this.entries.keys().next().value!);
            }
          }
        }
      }
      return value;
    })();
    this.pending.set(file, { signature: stamp, run });
    try { return await run; }
    finally { if (this.pending.get(file)?.run === run) this.pending.delete(file); }
  }

  private drop(file: string): void {
    const entry = this.entries.get(file);
    if (entry) { this.weight -= entry.weight; this.entries.delete(file); }
  }
}

/** Fixed workers bound source I/O, including cold reads and cache validation. */
export async function mapFileSnapshots<I, O>(items: readonly I[], read: (item: I) => Promise<O>): Promise<O[]> {
  const output = new Array<O>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      output[index] = await read(items[index]);
    }
  }));
  return output;
}
