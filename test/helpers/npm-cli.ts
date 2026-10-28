import fs from 'node:fs';
import path from 'node:path';

/** Resolve the installed real npm CLI before fixtures narrow PATH. Node and
 * npm may have separate installation prefixes (for example, Homebrew). */
export function findTestNpmCli(node: string): string | undefined {
  const bin = path.dirname(node);
  const candidates = [
    process.env.npm_execpath,
    path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    try {
      const entry = fs.realpathSync(path.join(directory, 'npm'));
      if (path.basename(entry) === 'npm-cli.js') candidates.push(entry);
    } catch { /* A PATH entry need not contain npm. */ }
    candidates.push(path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  return candidates.find((candidate): candidate is string => !!candidate && fs.existsSync(candidate));
}
