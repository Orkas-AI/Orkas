import * as fs from 'node:fs';
import * as path from 'node:path';

// Bound the complete directory before the synchronous validator reads it.
// Symlinks are rejected: the scan must not escape the staged resource.
export function checkDirectoryBudget(root: string): void {
  if (!fs.lstatSync(root).isDirectory() || !fs.statSync(path.join(root, 'SKILL.md')).isFile()) throw new Error('scan directory');
  let bytes = 0;
  let count = 0;
  function walk(dir: string, depth: number): void {
    if (depth > 32) throw new Error('scan limit');
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++count > 512) throw new Error('scan limit');
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('scan link');
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile()) {
        bytes += fs.statSync(file).size;
        if (bytes > 2 * 1024 * 1024) throw new Error('scan limit');
      } else throw new Error('scan file');
    }
  }
  walk(root, 0);
}
