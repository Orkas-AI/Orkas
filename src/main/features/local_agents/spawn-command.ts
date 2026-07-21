import * as path from 'node:path';
import * as os from 'node:os';

export type ResolvedCliCommand = {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

const WINDOWS_COMMAND_SCRIPT_RE = /\.(?:cmd|bat)$/i;
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

/**
 * Resolve one CLI launch without enabling Node's generic `shell:true` path.
 * Native executables are returned unchanged. Windows .cmd/.bat shims are
 * safely quoted and passed through ComSpec, which is required for npm-global
 * CLIs such as claude.cmd and codex.cmd.
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
