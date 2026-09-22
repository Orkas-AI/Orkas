import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/** Freeze the file inventory at launch. Only files from this revision can be
 * served; already loaded resources are rechecked before privileged operations.
 * Immutable saved/artifact source remains owned by its existing resolver. */
export async function bundleRevision(root: string, required: string[]) {
  const stamps = new Map<string, string>();
  const loaded = new Set(required.map(p => path.resolve(p)));
  let invalid = false;
  const stamp = (file: string) => {
    const s = fs.lstatSync(file);
    return s.isFile() ? [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':') : '';
  };
  // Manifest authority and the entry were resolved before the asynchronous
  // inventory. They must not change while that inventory yields to the host.
  const requiredStamps = new Map([...loaded].map(file => [file, stamp(file)]));
  const pending = [path.resolve(root)];
  while (pending.length) {
    const dir = pending.pop()!;
    if (!(await fsp.lstat(dir)).isDirectory()) throw new Error('unsupported bundle entry');
    const directory = await fsp.opendir(dir);
    for await (const item of directory) {
      if (item.name.startsWith('.')) continue;
      const file = path.join(dir, item.name);
      if (item.isDirectory()) pending.push(file);
      else if (item.isFile()) {
        const s = await fsp.lstat(file);
        if (!s.isFile()) throw new Error('unsupported bundle entry');
        stamps.set(file, [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':'));
      } else throw new Error('unsupported bundle entry');
    }
  }
  const same = (file: string) => {
    try { return stamps.has(file) && stamps.get(file) === stamp(file); } catch { return false; }
  };
  for (const [file, original] of requiredStamps) {
    if (!original || stamps.get(file) !== original || !same(file)) throw new Error('bundle changed during launch');
  }
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
