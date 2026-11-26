/** Per-invocation OpenClaw config overlay; original config and credentials stay owned by OpenClaw. */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bindAbort, killProcessTree, spawnCli, stripAnsi, type BackendRunOptions } from './base';

export class OpenClawSetupError extends Error {
  constructor(message: string, readonly status: 'failed' | 'timeout' = 'failed', readonly exitCode?: number) {
    super(`${message} The task did not start.`);
  }
}

/** Forward only the native global profile selectors to the read-only config command. */
function profileArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dev' || args[i].startsWith('--profile=')) result.push(args[i]);
    else if (args[i] === '--profile' && args[i + 1]) result.push(args[i], args[++i]);
  }
  return result;
}

async function configPathForRun(opts: BackendRunOptions): Promise<string> {
  if (opts.signal.aborted) throw new Error('OpenClaw tool setup cancelled.');
  const child = spawnCli(opts.binPath, [...profileArgs(opts.customArgs || []), 'config', 'file'], opts.cwd);
  const detach = bindAbort(child, opts.signal);
  child.stdin.end();
  let stdout = '';
  let overflow = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (overflow) return;
    stdout += chunk;
    if (Buffer.byteLength(stdout) > 16_384) {
      overflow = true;
      killProcessTree(child, 'SIGKILL');
    }
  });
  // Config diagnostics may include credentials. Report only process facts.
  child.stderr.resume();
  const timeoutMs = Math.max(1, Math.min(10_000, opts.timeoutMs,
    opts.deadlineAt === undefined ? Infinity : opts.deadlineAt - Date.now()));
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killProcessTree(child, 'SIGKILL'); }, timeoutMs);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', () => reject(new OpenClawSetupError('Could not start the OpenClaw configuration check.')));
      child.once('close', resolve);
    });
    if (opts.signal.aborted) throw new Error('OpenClaw tool setup cancelled.');
    if (timedOut) throw new OpenClawSetupError('The OpenClaw configuration check timed out.', 'timeout');
    if (overflow) throw new OpenClawSetupError('The OpenClaw configuration check exceeded its output limit.');
    if (code === null) throw new OpenClawSetupError('The OpenClaw configuration check stopped without an exit code.');
    if (code !== 0) throw new OpenClawSetupError(`The OpenClaw configuration check returned exit code ${code}.`, 'failed', code);
    // Native 2026.4.11 may print a doctor notice before the config location.
    // The command's final nonempty line is the path; never select a path from
    // an earlier diagnostic when the final line is invalid.
    const value = stripAnsi(stdout).trim().split(/\r?\n/).at(-1)?.trim();
    if (!value || /[\r\n\0]/.test(value)) {
      throw new OpenClawSetupError('OpenClaw did not return a valid configuration location.');
    }
    // Native `config file` displays home-relative paths as ~, or
    // $OPENCLAW_HOME when that override is set. Expand only these known forms.
    const osHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || os.homedir();
    const configuredHome = process.env.OPENCLAW_HOME?.trim() || osHome;
    const home = path.resolve(opts.cwd, configuredHome.replace(/^~(?=$|[\\/])/, () => osHome));
    const resolved = /^~[\\/]/.test(value)
      ? path.resolve(home, value.slice(2))
      : /^\$OPENCLAW_HOME[\\/]/.test(value) && process.env.OPENCLAW_HOME?.trim()
        ? path.resolve(home, value.slice('$OPENCLAW_HOME/'.length)) : value;
    if (!path.isAbsolute(resolved)) throw new OpenClawSetupError('OpenClaw did not return a valid configuration location.');
    return resolved;
  } finally {
    clearTimeout(timer);
    detach();
  }
}

export async function prepareOpenclawBridge(opts: BackendRunOptions): Promise<{
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}> {
  if (!opts.bridge) return { env: process.env, cleanup() {} };
  const source = await configPathForRun(opts);
  const exists = fs.existsSync(source);
  // OpenClaw confines $include to the active config's directory. A sibling
  // overlay preserves nested includes and profile paths without copying secrets.
  const directory = exists ? path.dirname(source) : path.dirname(opts.bridge.mcpConfigPath);
  const stem = `.orkas-run-${crypto.randomBytes(12).toString('hex')}`;
  const overlay = path.join(directory, `${stem}.json`);
  const reset = path.join(directory, `${stem}-mcp.json`);
  const created: string[] = [];
  const cleanup = () => {
    for (const file of created) { try { fs.unlinkSync(file); } catch { /* Already removed. */ } }
  };
  try {
    if (exists) {
      // Includes concatenate arrays. Reset the reserved Orkas server before
      // applying this run's entry so previous args/env cannot join the new one.
      fs.writeFileSync(reset, JSON.stringify({ mcp: { servers: { orkas: null } } }), { flag: 'wx', mode: 0o600 });
      created.push(reset);
    }
    fs.writeFileSync(overlay, JSON.stringify({
      ...(exists ? { $include: [path.basename(source), path.basename(reset)] } : {}),
      mcp: { servers: { orkas: opts.bridge.server } },
    }), { flag: 'wx', mode: 0o600 });
    created.push(overlay);
    if (opts.signal.aborted) throw new Error('OpenClaw tool setup cancelled.');
    return { env: { ...process.env, OPENCLAW_CONFIG_PATH: overlay }, cleanup };
  } catch {
    cleanup();
    throw new OpenClawSetupError('Orkas could not write the temporary configuration for OpenClaw.');
  }
}
