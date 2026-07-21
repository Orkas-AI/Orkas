import * as fs from 'node:fs';
import * as path from 'node:path';

/** Remove an isolated Git fixture on every platform.
 *
 * Git marks loose object files read-only on Windows. Node's recursive
 * `rmSync(..., { force: true })` does not clear that attribute, so fixture
 * cleanup otherwise fails with EPERM even though no process owns a handle.
 */
export function removeGitFixture(root: string): void {
  if (process.platform === 'win32' && fs.existsSync(root)) {
    const pending = [root];
    while (pending.length > 0) {
      const dir = pending.pop()!;
      try { fs.chmodSync(dir, 0o777); } catch { /* best effort */ }
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) pending.push(full);
        else {
          try { fs.chmodSync(full, 0o666); } catch { /* rm reports any real failure */ }
        }
      }
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
}
