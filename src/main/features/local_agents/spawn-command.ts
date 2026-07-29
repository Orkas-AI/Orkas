import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type ResolvedCliCommand = {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

const WINDOWS_COMMAND_SCRIPT_RE = /\.(?:cmd|bat)$/i;
const WINDOWS_CMD_RE = /\.cmd$/i;
const CMD_META_RE = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Build the environment used for CLI version probes and real runs.
 * Finder-launched macOS apps inherit a minimal PATH, so an npm-installed
 * CLI may be discoverable by absolute path while its `#!/usr/bin/env node`
 * launcher still cannot find Node. Keep the user's existing order, then add
 * the same conventional install roots used by CLI discovery.
 */
export function buildCliSpawnEnv(
  binPath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): NodeJS.ProcessEnv {
  const out = { ...env };
  const delimiter = platform === 'win32' ? ';' : ':';
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const rawPath = env.PATH || env.Path || '';
  const candidates = rawPath.split(delimiter).filter(Boolean);
  candidates.push(pathApi.dirname(binPath));

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || (home ? path.win32.join(home, 'AppData', 'Local') : '');
    const appData = env.APPDATA || (home ? path.win32.join(home, 'AppData', 'Roaming') : '');
    if (appData) candidates.push(path.win32.join(appData, 'npm'));
    if (localAppData) candidates.push(path.win32.join(localAppData, 'Programs', 'nodejs'));
    if (env.VOLTA_HOME) candidates.push(path.win32.join(env.VOLTA_HOME, 'bin'));
    if (env.PNPM_HOME) candidates.push(env.PNPM_HOME);
  } else {
    if (home) {
      candidates.push(pathApi.join(home, '.local', 'bin'));
      candidates.push(pathApi.join(home, '.npm-global', 'bin'));
      candidates.push(pathApi.join(home, 'bin'));
    }
    if (env.NPM_CONFIG_PREFIX) candidates.push(pathApi.join(env.NPM_CONFIG_PREFIX, 'bin'));
    if (env.VOLTA_HOME) candidates.push(pathApi.join(env.VOLTA_HOME, 'bin'));
    if (env.PNPM_HOME) candidates.push(env.PNPM_HOME);
    candidates.push(
      '/opt/homebrew/bin', '/opt/homebrew/sbin',
      '/usr/local/bin', '/usr/local/sbin',
      '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    );
  }

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (!value) continue;
    const key = platform === 'win32' ? value.toLowerCase() : value;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(value);
  }
  out.PATH = merged.join(delimiter);
  return out;
}

function escapeCmdCommand(value: string): string {
  return String(value).replace(CMD_META_RE, '^$1');
}

// Based on the quoting rules used by cross-spawn. A command script must run
// through cmd.exe on Windows; passing raw user/model arguments through a shell
// would make &, |, %, and friends executable shell syntax.
function escapeCmdArgument(value: string, doubleEscapeMetaChars: boolean): string {
  let escaped = String(value);
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, '$1$1');
  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_META_RE, '^$1');
  if (doubleEscapeMetaChars) escaped = escaped.replace(CMD_META_RE, '^$1');
  return escaped;
}

function resolveNodeExecutable(
  binPath: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const explicit = env.ORKAS_TEST_NODE;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const localNode = path.win32.join(path.win32.dirname(binPath), 'node.exe');
  if (fs.existsSync(localNode)) return localNode;

  const rawPath = env.PATH || env.Path || '';
  for (const directory of rawPath.split(';').filter(Boolean)) {
    const candidate = path.win32.join(directory, 'node.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveNpmNodeShim(
  binPath: string,
  powershellShim: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ResolvedCliCommand | null {
  let source = '';
  try {
    source = fs.readFileSync(powershellShim, 'utf8');
  } catch {
    return null;
  }

  const basedir = path.win32.dirname(powershellShim);
  const candidates = Array.from(source.matchAll(/["']\$basedir[\\/]([^"']+)["']/gi))
    .map((match) => path.win32.resolve(basedir, match[1].replace(/\//g, '\\')));
  const entry = candidates.find((candidate) => {
    if (!fs.existsSync(candidate)) return false;
    if (/\.(?:c?js|mjs)$/i.test(candidate)) return true;
    try {
      return /^#![^\r\n]*\bnode(?:\.exe)?\b/i.test(
        fs.readFileSync(candidate, 'utf8').slice(0, 256),
      );
    } catch {
      return false;
    }
  });
  const node = entry ? resolveNodeExecutable(binPath, env) : null;
  return entry && node ? { command: node, args: [entry, ...args] } : null;
}

/**
 * Resolve one CLI launch without enabling Node's generic `shell:true` path.
 * Native executables are returned unchanged. For a standard npm Windows shim,
 * resolve the Node entry from its sibling .ps1 and launch it directly so
 * multiline prompts survive unchanged. Other .cmd/.bat files are safely
 * quoted and passed through ComSpec.
 */
export function resolveCliCommand(
  binPath: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCliCommand {
  if (platform !== 'win32' || !WINDOWS_COMMAND_SCRIPT_RE.test(binPath)) {
    return { command: binPath, args: args.slice() };
  }

  const normalized = path.win32.normalize(binPath);
  const powershellShim = WINDOWS_CMD_RE.test(normalized)
    ? normalized.replace(WINDOWS_CMD_RE, '.ps1')
    : '';
  if (powershellShim && fs.existsSync(powershellShim)) {
    const npmNodeShim = resolveNpmNodeShim(normalized, powershellShim, args, env);
    if (npmNodeShim) return npmNodeShim;
  }

  // npm-generated shims re-parse their `%*` payload once more. Cover both
  // project-local node_modules/.bin and the standard global npm directory.
  const doubleEscape = /(?:node_modules[\\/]\.bin|AppData[\\/]Roaming[\\/]npm)[\\/][^\\/]+\.cmd$/i
    .test(normalized);
  const shellCommand = [
    escapeCmdCommand(normalized),
    ...args.map((arg) => escapeCmdArgument(arg, doubleEscape)),
  ].join(' ');
  return {
    command: env.ComSpec || env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}
