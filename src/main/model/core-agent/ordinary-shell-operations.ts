import * as fs from 'node:fs';
import * as path from 'node:path';
import { tokenize } from '../../../core-agent/src/sandbox/shell-words';
import { isVerifiedPublicMaterial } from '../../util/public-material';
import type { RiskCategory } from './bash-risk';

interface Context {
  cwd: string;
  platform: NodeJS.Platform;
  canWrite: (file: string) => boolean;
  isProduced: (file: string) => boolean;
  ownsTree: (file: string) => boolean;
}

/** Deliberately narrower than the risk parser: exemption needs a complete,
 * literal, single invocation. No wrappers, pipelines, substitutions, redirects,
 * assignments or cwd changes can inherit proof from one harmless constituent. */
function literalInvocation(command: string): string[] | undefined {
  if (command.length > 8_000 || /[\r\n$`*?{}\[\]#%!~]/.test(command)) return;
  const tokens = tokenize(command);
  if (!tokens.length || tokens.some(t => t.type !== 'word')) return;
  return tokens.map(t => t.value);
}

function projectInstall(cmd: string, args: string[], ctx: Context): boolean {
  const conda = ['conda', 'mamba', 'micromamba'].includes(cmd);
  if (!(conda && ['create', 'install', 'update', 'remove'].includes(args[0]))
    && !(cmd === 'cargo' && ['install', 'uninstall'].includes(args[0]))) return false;
  const targetFlags = conda ? ['-p', '--prefix'] : ['--root'];
  let target: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (targetFlags.includes(arg)) {
      if (target || !args[i + 1] || args[i + 1].startsWith('-')) return false;
      target = path.resolve(ctx.cwd, args[++i]); continue;
    }
    if ((conda ? ['-y', '--yes', '--quiet'] : ['--locked', '--offline', '--quiet', '--force']).includes(arg)) continue;
    if (arg.startsWith('-') || !/^[a-zA-Z0-9_.=<>+-]+$/.test(arg)) return false;
  }
  return !!target && target !== ctx.cwd && ctx.canWrite(target);
}

function previewable(file: string): boolean {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || (st.mode & 0o111) !== 0 || st.nlink !== 1) return false;
    const head = Buffer.alloc(8);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
    const ext = path.extname(file).toLowerCase();
    return ext === '.pdf' && head.subarray(0, 5).toString() === '%PDF-'
      || ext === '.png' && head.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || ['.jpg', '.jpeg'].includes(ext) && head[0] === 255 && head[1] === 216 && head[2] === 255;
  } catch { return false; }
}

/** Host proofs only subtract the reason established for this entire command.
 * Custom policy, unknown paths, scope and read-only-root gates still run. */
export function ordinaryBashReasons(command: string, ctx: Context): Set<RiskCategory> {
  const exempt = new Set<RiskCategory>();
  // Command text cannot prove the network destination after DNS resolution,
  // redirects or client configuration; retain the network approval gate.
  // PowerShell arrays and splatting are not literal native argument vectors.
  if (ctx.platform === 'win32' && /[,@]/.test(command)) return exempt;
  const words = literalInvocation(command);
  if (!words) return exempt;
  const [raw, ...args] = words;
  const cmd = raw.toLowerCase().replace(/\.exe$/, '');
  if (projectInstall(cmd, args, ctx)) exempt.add('system_package_change');
  if (cmd === 'git' && args.length === 3 && args[0] === 'branch' && args[1] === '-d'
    && /^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(args[2])) exempt.add('destructive');
  const readArgs = cmd === 'get-content'
    ? args.filter(arg => !['-literalpath', '-path', '-raw'].includes(arg.toLowerCase())) : args;
  if (['cat', 'get-content'].includes(cmd) && readArgs.length > 0 && readArgs.length <= 16
    && readArgs.every(arg => !arg.startsWith('-') && isVerifiedPublicMaterial(path.resolve(ctx.cwd, arg)))) exempt.add('sensitive_path');
  const fileArg = ['open', 'xdg-open'].includes(cmd) && args.length === 1 ? args[0]
    : cmd === 'gio' && args.length === 2 && args[0] === 'open' ? args[1]
      : cmd === 'start-process' && args.length === 2 && args[0].toLowerCase() === '-filepath' ? args[1] : undefined;
  if (fileArg && !fileArg.startsWith('-')
    && (!/^[a-z][a-z0-9+.-]*:/i.test(fileArg) || path.isAbsolute(fileArg))) {
    const file = path.resolve(ctx.cwd, fileArg);
    if (ctx.canWrite(file) && ctx.isProduced(file) && previewable(file)) exempt.add('external_mutation');
  }
  if (cmd === 'rm' && ['-rf', '-fr', '-r', '-R'].includes(args[0]) && args.length === 2
    && !args[1].startsWith('-')) {
    const target = path.resolve(ctx.cwd, args[1]);
    if (target !== ctx.cwd && ctx.canWrite(target) && ctx.ownsTree(target)) exempt.add('destructive');
  }
  if (cmd === 'remove-item' && ctx.platform === 'win32') {
    const lower = args.map(arg => arg.toLowerCase());
    const index = lower.findIndex(arg => arg === '-literalpath' || arg === '-path');
    const flags = lower.filter((_arg, i) => i !== index && i !== index + 1);
    if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('-')
      && flags.includes('-recurse') && flags.every(arg => ['-recurse', '-force'].includes(arg))) {
      const target = path.resolve(ctx.cwd, args[index + 1]);
      if (target !== ctx.cwd && ctx.canWrite(target) && ctx.ownsTree(target)) exempt.add('destructive');
    }
  }
  return exempt;
}
