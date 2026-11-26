import * as fs from 'node:fs';
import * as path from 'node:path';

const LIMIT = 5_000;
type Stamp = { identity: string; version: string; directory: boolean };
function stamp(st: fs.Stats): Stamp | undefined {
  if (st.isSymbolicLink() || (!st.isDirectory() && (!st.isFile() || st.nlink !== 1))) return;
  return { identity: `${st.dev}:${st.ino}:${st.birthtimeMs}`, directory: st.isDirectory(),
    version: `${st.size}:${st.mtimeMs}:${st.ctimeMs}` };
}
function same(a: Stamp | undefined, b: Stamp | undefined): boolean {
  return !!a && !!b && a.identity === b.identity && a.directory === b.directory
    && (a.directory || a.version === b.version);
}

export function producedFileVersion(st: fs.Stats): string | undefined {
  const current = stamp(st);
  return current && !current.directory ? `${current.identity}:${current.version}` : undefined;
}

/** Refine only matching regular files. Finalization may also check a scoped link's target. */
export function readProducedFileVersion(file: string, followFinalLink = false): string | undefined {
  try {
    return producedFileVersion(followFinalLink ? fs.statSync(file) : fs.lstatSync(file));
  } catch { return undefined; }
}
function boundedEntries(dir: string, limit: number): fs.Dirent[] | undefined {
  const handle = fs.opendirSync(dir);
  try {
    const entries: fs.Dirent[] = [];
    let entry: fs.Dirent | null;
    while ((entry = handle.readSync())) {
      if (entries.length >= limit) return;
      entries.push(entry);
    }
    return entries;
  } finally { handle.closeSync(); }
}

/** Metadata sampled only at a host-controlled write boundary. */
class CreationSnapshot {
  readonly nodes = new Map<string, Stamp>();
  readonly missing = new Set<string>();
  node(file: string, st: fs.Stats): void {
    const value = stamp(st);
    if (value && this.nodes.size < LIMIT) this.nodes.set(file, value);
  }
}

/** Per-runner evidence, discarded with its tools; never inferred from a name
 * like build/dist or the UI's broader list of modified/produced files. */
export class TaskFileOwnership {
  private readonly owned = new Map<string, Stamp>();
  beforeWrite(file: string): CreationSnapshot {
    const before = new CreationSnapshot();
    let current = file;
    for (let depth = 0; depth < 64; depth++) {
      try {
        const st = fs.lstatSync(current);
        before.node(current, st);
        if (st.isDirectory()) break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') break;
        before.missing.add(current);
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return before;
  }
  afterWrite(file: string, before: CreationSnapshot): void {
    const after = new CreationSnapshot();
    let current = file;
    for (let depth = 0; depth < 64; depth++) {
      try { after.node(current, fs.lstatSync(current)); } catch { return; }
      if (before.nodes.get(current)?.directory) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const [file, next] of after.nodes) {
      const previous = this.owned.get(file);
      if (before.missing.has(file) || same(previous, before.nodes.get(file))) {
        if (this.owned.size < LIMIT || previous) this.owned.set(file, next);
      } else this.owned.delete(file);
    }
  }
  ownsFile(file: string): boolean {
    try {
      const current = stamp(fs.lstatSync(file));
      return !!current && !current.directory && same(this.owned.get(file), current);
    } catch { return false; }
  }
  canRemoveTree(root: string): boolean {
    let remaining = 512;
    const visit = (file: string, depth: number): boolean => {
      if (--remaining < 0 || depth > 32) return false;
      try {
        const current = stamp(fs.lstatSync(file));
        if (!same(this.owned.get(file), current)) return false;
        if (!current!.directory) return true;
        const entries = boundedEntries(file, remaining);
        return !!entries && entries.every(entry => visit(path.join(file, entry.name), depth + 1));
      } catch { return false; }
    };
    return visit(root, 0);
  }
}
