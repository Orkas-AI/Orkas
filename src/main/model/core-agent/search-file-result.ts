import * as path from 'node:path';

export interface SearchFileHit {
  /** The scanned root, or its model-visible logical Skill address. */
  root: string;
  path: string;
  name: string;
  size: number;
  mtime: number;
  source: 'attachment' | 'workspace' | 'extra';
  /** Cached metadata only; formatting must never trigger extraction. */
  totalChars?: number;
}

/** Factor out directory prefixes without regrouping or dropping sorted hits.
 * JSON escaping preserves filenames that contain delimiters or newlines. */
export function formatSearchFileResults(
  hits: readonly SearchFileHit[],
  filesystemPaths: Pick<typeof path, 'relative'> = path,
): string {
  const roots: string[] = [];
  const rootIndexes = new Map<string, number>();
  const files = hits.map((hit) => {
    let root = rootIndexes.get(hit.root);
    if (root === undefined) {
      root = roots.length;
      rootIndexes.set(hit.root, root);
      roots.push(hit.root);
    }
    // Logical Skill addresses always use '/', including on Windows hosts.
    const paths = hit.root.startsWith('@skill/') ? path.posix : filesystemPaths;
    return JSON.stringify({
      root,
      path: paths.relative(hit.root, hit.path),
      name: hit.name,
      size: hit.size,
      mtime: new Date(hit.mtime).toISOString(),
      source: hit.source,
      ...(hit.totalChars !== undefined ? { total_chars: hit.totalChars } : {}),
    });
  });
  return 'File paths are relative to roots[file.root] (zero-based); join the root and path to read a file.\n'
    + `{"roots":${JSON.stringify(roots)},"files":[\n${files.join(',\n')}\n]}`;
}
