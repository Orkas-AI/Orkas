import * as fs from 'node:fs';
import * as path from 'node:path';

import { isPathAllowed } from './path-sandbox';

export type ProtocolFileResult =
  | { ok: true; absPath: string; relPath: string; stat: fs.Stats }
  | { ok: false; status: 400 | 403 | 404; error: 'bad_request' | 'forbidden' | 'not_found' };

/**
 * Resolve a custom-protocol pathname under one filesystem root. The final
 * containment check follows symlinks, unlike lexical path.resolve checks.
 */
export function resolveContainedProtocolFile(
  requestUrl: string,
  expectedScheme: string,
  rootPath: string,
): ProtocolFileResult {
  let relPath = '';
  try {
    const url = new URL(requestUrl);
    if (url.protocol !== `${expectedScheme.replace(/:$/, '')}:`) {
      return { ok: false, status: 400, error: 'bad_request' };
    }
    relPath = decodeURIComponent(url.pathname || '').replace(/^\/+/, '');
  } catch {
    return { ok: false, status: 400, error: 'bad_request' };
  }
  if (!relPath || relPath.includes('\0')) {
    return { ok: false, status: 400, error: 'bad_request' };
  }

  const root = path.resolve(rootPath);
  const absPath = path.resolve(root, relPath);
  if (!isPathAllowed(absPath, [root])) {
    return { ok: false, status: 403, error: 'forbidden' };
  }

  let stat: fs.Stats;
  try { stat = fs.statSync(absPath); }
  catch { return { ok: false, status: 404, error: 'not_found' }; }
  if (!stat.isFile()) return { ok: false, status: 404, error: 'not_found' };
  return { ok: true, absPath, relPath, stat };
}
