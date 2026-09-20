import * as fs from 'node:fs';
import * as path from 'node:path';

/** Freeze the file inventory at launch. Only files from this revision can be
 * served; already loaded resources are rechecked before privileged operations.
 * Immutable saved/artifact source remains owned by its existing resolver. */
export function bundleRevision(root: string, required: string[]) {
  const stamps = new Map<string, string>();
  const loaded = new Set(required.map(p => path.resolve(p)));
  let invalid = false;
  let entries = 0;
  const stamp = (file: string) => {
    const s = fs.lstatSync(file);
    return s.isFile() ? [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':') : '';
  };
  function visit(dir: string, depth: number) {
    if (depth > 32) throw new Error('bundle depth limit');
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++entries > 2048) throw new Error('bundle file limit');
      if (item.name.startsWith('.')) continue;
      const file = path.join(dir, item.name);
      if (item.isDirectory()) visit(file, depth + 1);
      else if (item.isFile()) stamps.set(file, stamp(file));
      else throw new Error('unsupported bundle entry');
    }
  }
  visit(path.resolve(root), 0);
  const same = (file: string) => {
    try { return stamps.has(file) && stamps.get(file) === stamp(file); } catch { return false; }
  };
  return {
    valid() {
      if (!invalid) for (const file of loaded) if (!same(file)) { invalid = true; break; }
      return !invalid;
    },
    accept(file: string) {
      file = path.resolve(file);
      if (invalid || !same(file)) { invalid = true; return false; }
      loaded.add(file);
      return true;
    },
  };
}
