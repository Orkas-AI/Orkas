import * as path from 'node:path';

export type ResolvedCliCommand = {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

const WINDOWS_COMMAND_SCRIPT_RE = /\.(?:cmd|bat)$/i;
const CMD_META_RE = /([()\][%!^"`<>&|;, *?])/g;

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
