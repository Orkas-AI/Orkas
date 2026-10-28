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
  filesystemPaths: Pick<typeof path, 'relative' | 'isAbsolute' | 'sep'> = path,
  workingDir?: string,
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
    const skillPath = hit.root.startsWith('@skill/');
    const paths = skillPath ? path.posix : filesystemPaths;
    let readPath = hit.path;
    if (!skillPath && workingDir) {
      const relative = filesystemPaths.relative(workingDir, hit.path);
      if (relative !== '..' && !relative.startsWith(`..${filesystemPaths.sep}`)
          && !filesystemPaths.isAbsolute(relative)) readPath = relative || '.';
    }
    return JSON.stringify({
      root,
      path: paths.relative(hit.root, hit.path),
      read_path: readPath,
      name: hit.name,
      size: hit.size,
      mtime: new Date(hit.mtime).toISOString(),
      source: hit.source,
      ...(hit.totalChars !== undefined ? { total_chars: hit.totalChars } : {}),
    });
  });
  return 'Use files[].read_path directly for file tools. files[].path is relative to roots[file.root] (zero-based).\n'
    + `{"roots":${JSON.stringify(roots)},"files":[\n${files.join(',\n')}\n]}`;
}
