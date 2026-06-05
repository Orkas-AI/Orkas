import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

/** sha256 of a file's bytes, hex. Returns undefined on any IO error so callers
 *  fall through to whatever fallback they implement (typically: pretend the
 *  file has no recorded sha — preserves pre-feature behaviour). */
export function sha256OfFile(absPath: string): string | undefined {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  } catch {
    return undefined;
  }
}
