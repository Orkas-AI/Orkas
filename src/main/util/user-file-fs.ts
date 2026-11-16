import * as fs from 'node:fs';
import * as path from 'node:path';

function archiveRoot(filename: string): string | undefined {
  let end = 0;
  for (const segment of filename.split(path.sep)) {
    end += segment.length;
    if (segment.toLowerCase().endsWith('.asar')) return filename.slice(0, end);
    end++;
  }
  return undefined;
}

const applicationArchive = archiveRoot(path.resolve(__dirname));
let physicalFs: typeof fs | undefined;

/** User paths describe physical files, not Electron's implicit archive mounts.
 * Keep this module's own packaged resources on Electron's normal filesystem.
 * Selection is local to each operation; never toggle process.noAsar while
 * concurrent application-resource reads may be running. Node needs no adapter. */
export function fileSystemForPath(filename: string): typeof fs {
  if (!process.versions.electron || !filename.toLowerCase().includes('.asar')) return fs;
  const archive = archiveRoot(path.resolve(filename));
  if (!archive || (applicationArchive && (process.platform === 'win32'
    ? archive.toLowerCase() === applicationArchive.toLowerCase()
    : archive === applicationArchive))) return fs;
  return physicalFs ??= require('original-fs') as typeof fs;
}
