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

/** Metadata attached to the existing bounded output scan. An omitted file is
 * not evidence of absence: only a complete parent listing can prove creation. */
export class CreationSnapshot {
  constructor(readonly owner?: symbol) {}
  private listedEntries = 0;
  readonly nodes = new Map<string, Stamp>();
  readonly directories = new Map<string, Set<string>>();
  readonly missing = new Set<string>();
  directory(dir: string, entries: readonly fs.Dirent[]): void {
    if (this.directories.size >= LIMIT || this.listedEntries + entries.length > LIMIT) return;
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) return;
      this.node(dir, st);
      this.directories.set(dir, new Set(entries.map(e => e.name)));
      this.listedEntries += entries.length;
    } catch { /* Unreadable directories cannot establish ownership. */ }
  }
  node(file: string, st: fs.Stats): void {
    const value = stamp(st);
    if (value && this.nodes.size < LIMIT) this.nodes.set(file, value);
  }
  absent(file: string): boolean {
    let current = file;
    for (let depth = 0; depth < 64; depth++) {
      if (this.missing.has(current)) return true;
      const parent = path.dirname(current);
      if (parent === current) return false;
      const entries = this.directories.get(parent);
      if (entries) return !entries.has(path.basename(current));
      current = parent;
    }
    return false;
  }
}

/** Per-runner evidence, discarded with its tools; never inferred from a name
 * like build/dist or the UI's broader list of modified/produced files. */
export class TaskFileOwnership {
  readonly token = Symbol('task-file-ownership');
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
    this.observe(before, after);
  }
  observe(before: CreationSnapshot, after: CreationSnapshot): void {
    for (const [file, next] of after.nodes) {
      const previous = this.owned.get(file);
      if (before.absent(file) || same(previous, before.nodes.get(file))) {
        if (this.owned.size < LIMIT || previous) this.owned.set(file, next);
      } else this.owned.delete(file);
    }
    if (after.directories.size) {
      for (const file of this.owned.keys()) {
        if (after.absent(file)) this.owned.delete(file);
      }
    }
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
