import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export type RepositoryFileList = {
  files: string[];
  backend: 'rg' | 'walk';
  capped: boolean;
};

export type RepositoryGrepHit = {
  path: string;
  line: number;
  column: number;
  text: string;
  before: Array<{ line: number; text: string }>;
  after: Array<{ line: number; text: string }>;
};

export type RepositoryGrepResult = {
  available: boolean;
  hits: RepositoryGrepHit[];
  scannedBackend: 'rg' | 'fallback';
  capped: boolean;
  error?: string;
};

const COMMAND_OUTPUT_MAX_BYTES = 24 * 1024 * 1024;
const DEFAULT_FALLBACK_EXCLUDES = [
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  'target',
  '__pycache__',
  '.venv',
  '.git',
];
const DEFAULT_FALLBACK_FILE_GLOBS = ['*.min.js', '*.min.css', '*.map'];

type CommandResult = {
  ok: boolean;
  code: number | null;
  stderr: string;
  unavailable: boolean;
  capped: boolean;
};

export async function listRepositoryFiles(
  root: string,
  maxFiles: number,
  opts: { includeIgnored?: boolean; signal?: AbortSignal } = {},
): Promise<RepositoryFileList> {
  const args = [
    '--files',
    '--hidden',
    '--null',
    '--glob',
    '!.git/**',
    ...(opts.includeIgnored ? ['--no-ignore'] : []),
  ];
  for (const dir of DEFAULT_FALLBACK_EXCLUDES) args.push('--glob', `!${dir}/**`);
  for (const glob of DEFAULT_FALLBACK_FILE_GLOBS) args.push('--glob', `!${glob}`);
  const relative: string[] = [];
  const result = await runStreamingRecords(
    'rg',
    args,
    root,
    '\0',
    (record) => {
      if (record) relative.push(record);
      return relative.length > maxFiles;
    },
    opts.signal,
  );
  if (result.ok) {
    return {
      files: relative.slice(0, maxFiles).map((file) => path.resolve(root, file)),
      backend: 'rg',
      capped: result.capped || relative.length > maxFiles,
    };
  }
  return { files: [], backend: 'walk', capped: false };
}

export async function grepRepository(
  root: string,
  input: {
    pattern: string;
    regex: boolean;
    caseSensitive: boolean;
    contextLines: number;
    maxResults: number;
    includeGlobs: string[];
    excludeGlobs: string[];
    includeIgnored?: boolean;
    signal?: AbortSignal;
  },
): Promise<RepositoryGrepResult> {
  const args = [
    '--json',
    '--hidden',
    '--line-number',
    '--column',
    '--color',
    'never',
    '--glob',
    '!.git/**',
    ...(input.regex ? [] : ['--fixed-strings']),
    ...(input.caseSensitive ? [] : ['--ignore-case']),
    ...(input.contextLines > 0 ? ['--context', String(input.contextLines)] : []),
    ...(input.includeIgnored ? ['--no-ignore'] : []),
  ];
  for (const glob of input.includeGlobs) args.push('--glob', glob);
  for (const glob of input.excludeGlobs) args.push('--glob', `!${glob}`);
  for (const dir of DEFAULT_FALLBACK_EXCLUDES) args.push('--glob', `!${dir}/**`);
  for (const glob of DEFAULT_FALLBACK_FILE_GLOBS) args.push('--glob', `!${glob}`);
  args.push('--regexp', input.pattern, '.');
  const matches: Array<{ path: string; line: number; column: number; text: string }> = [];
  const contextByPath = new Map<string, Map<number, string>>();
  const result = await runStreamingRecords(
    'rg',
    args,
    root,
    '\n',
    (rawLine) => {
      if (!rawLine) return false;
      let record: any;
      try { record = JSON.parse(rawLine); } catch { return false; }
      if (record?.type !== 'match' && record?.type !== 'context') return false;
      const relativePath = record?.data?.path?.text;
      const text = String(record?.data?.lines?.text ?? '').replace(/\r?\n$/, '').slice(0, 4_000);
      const line = Number(record?.data?.line_number);
      if (typeof relativePath !== 'string' || !Number.isFinite(line)) return false;
      const absolutePath = path.resolve(root, relativePath);
      if (record.type === 'context') {
        let contexts = contextByPath.get(absolutePath);
        if (!contexts) {
          contexts = new Map();
          contextByPath.set(absolutePath, contexts);
        }
        contexts.set(line, text);
        return false;
      }
      const first = Array.isArray(record?.data?.submatches) ? record.data.submatches[0] : undefined;
      matches.push({
        path: absolutePath,
        line,
        column: Number.isFinite(first?.start) ? Number(first.start) + 1 : 1,
        text,
      });
      return matches.length > input.maxResults;
    },
    input.signal,
  );
  if (result.unavailable) {
    return { available: false, hits: [], scannedBackend: 'fallback', capped: false };
  }
  if (!result.ok && result.code !== 1) {
    return {
      available: true,
      hits: [],
      scannedBackend: 'rg',
      capped: false,
      error: result.stderr.trim() || `rg exited with code ${result.code ?? 'null'}`,
    };
  }

  const capped = result.capped || matches.length > input.maxResults;
  const selected = matches.slice(0, input.maxResults);
  return {
    available: true,
    scannedBackend: 'rg',
    capped,
    hits: selected.map((match) => {
      const context = contextByPath.get(match.path);
      const before: Array<{ line: number; text: string }> = [];
      const after: Array<{ line: number; text: string }> = [];
      for (let offset = input.contextLines; offset > 0; offset--) {
        const line = match.line - offset;
        const text = context?.get(line);
        if (text !== undefined) before.push({ line, text: text.slice(0, 240) });
      }
      for (let offset = 1; offset <= input.contextLines; offset++) {
        const line = match.line + offset;
        const text = context?.get(line);
        if (text !== undefined) after.push({ line, text: text.slice(0, 240) });
      }
      return { ...match, before, after };
    }),
  };
}

export function fallbackDirectoryExcluded(name: string): boolean {
  return DEFAULT_FALLBACK_EXCLUDES.includes(name);
}

export function fallbackFileExcluded(name: string): boolean {
  return name.endsWith('.min.js') || name.endsWith('.min.css') || name.endsWith('.map');
}

async function runStreamingRecords(
  command: string,
  args: string[],
  cwd: string,
  delimiter: '\0' | '\n',
  onRecord: (record: string) => boolean,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let stderr: Buffer = Buffer.alloc(0);
    let settled = false;
    let outputExceeded = false;
    let intentionallyStopped = false;
    const finish = (value: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      finish({
        ok: false,
        code: null,
        stderr: (error as Error).message,
        unavailable: true,
        capped: false,
      });
      return;
    }
    const stop = () => {
      intentionallyStopped = true;
      try { child.kill('SIGTERM'); } catch { /* best effort */ }
    };
    const consumeStdout = (data: Buffer) => {
      if (intentionallyStopped || outputExceeded) return;
      pending += decoder.write(data);
      if (pending.length > COMMAND_OUTPUT_MAX_BYTES) {
        outputExceeded = true;
        try { child.kill('SIGTERM'); } catch { /* best effort */ }
        return;
      }
      let boundary = pending.indexOf(delimiter);
      while (boundary >= 0) {
        const record = pending.slice(0, boundary).replace(/\r$/, '');
        pending = pending.slice(boundary + delimiter.length);
        if (onRecord(record)) {
          stop();
          return;
        }
        boundary = pending.indexOf(delimiter);
      }
    };
    child.stdout.on('data', consumeStdout);
    child.stderr.on('data', (data: Buffer) => {
      if (stderr.length >= COMMAND_OUTPUT_MAX_BYTES) return;
      stderr = Buffer.concat([
        stderr,
        data.subarray(0, COMMAND_OUTPUT_MAX_BYTES - stderr.length),
      ]);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        code: null,
        stderr: error.message,
        unavailable: error.code === 'ENOENT',
        capped: intentionallyStopped,
      });
    });
    child.on('close', (code) => {
      if (!intentionallyStopped && !outputExceeded) {
        pending += decoder.end();
        if (pending && !onRecord(pending.replace(/\r$/, ''))) pending = '';
      }
      finish({
        ok: (code === 0 || intentionallyStopped) && !outputExceeded,
        code,
        stderr: outputExceeded
          ? 'repository search output exceeded its bounded capture'
          : stderr.toString('utf8'),
        unavailable: false,
        capped: intentionallyStopped,
      });
    });
  });
}

// ── Ignore-file support for the walk fallback ────────────────────────────
//
// `rg --files` already honours ignore files, so the repository backend needs
// nothing here. The walk fallback (no ripgrep on the machine) previously
// filtered only by a hard-coded directory list, so on those machines
// `search_files` returned build output, logs and local config that the project
// had explicitly ignored — contradicting the tool's own contract and filling
// the model's context with noise.
//
// This is the common subset of gitignore semantics, not the whole spec:
// comments/blank lines, a trailing `/` for directory-only rules, a leading `/`
// anchoring to the file's own directory, `!` negation, and `*` / `?` / `**`
// globs. Nested `.gitignore` files apply to their own subtree, matching git's
// scoping. Character classes, and the rarely-used escaping rules, are not
// interpreted; an unsupported pattern simply fails to match rather than
// throwing, so the walk degrades to "shows a bit more" and never to a crash.

export type IgnoreRule = {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
};

export type IgnoreScope = {
  /** Directory the rules were declared in; patterns resolve relative to it. */
  dir: string;
  rules: IgnoreRule[];
};

function globToRegExpSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**` spans directory separators; `*` stops at one.
        i += 1;
        if (glob[i + 1] === '/') i += 1;
        out += '(?:.*/)?';
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') { out += '[^/]'; continue; }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

export function parseIgnoreRules(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of String(content || '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    if (!line) continue;
    // A pattern containing a slash anywhere (other than a trailing one) is
    // anchored to the declaring directory; a bare name matches at any depth.
    const anchored = line.startsWith('/') || line.slice(0, -1).includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    if (!line) continue;
    const body = globToRegExpSource(line);
    const source = anchored ? `^${body}$` : `^(?:.*/)?${body}$`;
    try { rules.push({ re: new RegExp(source), negate, dirOnly }); }
    catch { /* unsupported pattern: skip rather than fail the whole walk */ }
  }
  return rules;
}

/** Read `<dir>/.gitignore`, returning null when absent or unreadable. */
export function readIgnoreScope(dir: string): IgnoreScope | null {
  let content: string;
  try { content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'); }
  catch { return null; }
  const rules = parseIgnoreRules(content);
  return rules.length ? { dir, rules } : null;
}

/** Last matching rule wins, exactly like git, so a later `!pattern` re-includes. */
export function isIgnoredByScopes(
  absPath: string,
  isDir: boolean,
  scopes: readonly IgnoreScope[],
): boolean {
  let ignored = false;
  for (const scope of scopes) {
    const rel = path.relative(scope.dir, absPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const posix = rel.split(path.sep).join('/');
    for (const rule of scope.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (!rule.re.test(posix)) continue;
      ignored = !rule.negate;
    }
  }
  return ignored;
}
