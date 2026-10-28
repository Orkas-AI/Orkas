/** Host-only CLI maintenance. Fixed commands target the detected installation;
 * renderer input never supplies executable paths, packages, flags or scripts.
 * Automatic maintenance requires verified installation ownership. Unsupported
 * installations fail without modifying another executable or configuration.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import { buildCliSpawnEnv, resolveCliCommand } from './spawn-command.js';
import { killProcessTree } from './backends/base.js';
import { resolveCli, invalidateCache, type LocalCliType, type LocalCliEntry } from './registry.js';
import { detectVersionResult, checkMinVersion, cliVersionAtLeast } from './version.js';
import { whichBin } from './which.js';
import { createLogger } from '../../logger.js';
import { sanitizeLogTextForUpload } from '../../util/log-sanitize.js';
import { redactPaths } from '../../util/redact.js';

const log = createLogger('local-cli-upgrade');

const PACKAGES: Record<LocalCliType, readonly string[]> = {
  codex: ['@openai/codex'], claude: ['@anthropic-ai/claude-code'],
  opencode: ['opencode-ai', '@opencode/cli'], openclaw: ['openclaw'], hermes: [],
};
export type CliUpgradePlan = { method: 'native' | 'npm' | 'brew' | 'unavailable'; command?: string; args?: string[] };
export type CliUpgradeInfo = { type: LocalCliType; version: string | null; can_upgrade: boolean; method: CliUpgradePlan['method'] };
type CliUpgradeOutcome = CliUpgradeInfo & { ok: boolean; outcome?: 'upgraded' | 'up_to_date'; error_code?: 'failed' | 'timeout' | 'output_limit' | 'verification_failed' | 'changed_installation' | 'unavailable'; error_detail?: string; entry?: LocalCliEntry };
export type CliUpgradeResult = CliUpgradeOutcome & { operation_id: number; duration_ms: number };
let operationCounter = 0;
const inFlight = new Map<LocalCliType, Promise<CliUpgradeResult>>();
type CommandFailureDiagnostic =
  | { phase: 'spawn'; spawn_code: string }
  | { phase: 'exit'; exit_code: number | null; signal: string };

/** Help capture stays private. Explicit maintenance may return a redacted failure
 * tail to the local UI only; output never enters logs or telemetry. */
export function runUpgradeCommand(command: string, args: string[], timeoutMs: number, capture: boolean | 'failure' = false): Promise<{ ok: boolean; text: string; error?: 'failed' | 'timeout' | 'output_limit'; error_detail?: string; diagnostic?: CommandFailureDiagnostic }> {
  return new Promise(resolve => {
    const launch = resolveCliCommand(command, args);
    let settled = false; let bytes = 0; let text = '';
    let tail = ''; let tailTruncated = false;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    let timer: NodeJS.Timeout | undefined;
    const child = spawn(launch.command, launch.args, {
      cwd: os.homedir(), env: buildCliSpawnEnv(command), stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true, windowsVerbatimArguments: launch.windowsVerbatimArguments,
      detached: process.platform !== 'win32',
    });
    const finish = (ok: boolean, error?: 'failed' | 'timeout' | 'output_limit', kill = false, diagnostic?: CommandFailureDiagnostic) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      let detail = '';
      if (!ok && capture === 'failure') {
        // Drop a partial leading line before redaction so a cut credential cannot
        // lose its field/prefix and escape the existing privacy filters.
        const firstLineEnd = tail.indexOf('\n');
        const completeTail = tailTruncated ? (firstLineEnd < 0 ? '' : tail.slice(firstLineEnd + 1)) : tail;
        const clean = stripVTControlCharacters(completeTail).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
        detail = redactPaths(sanitizeLogTextForUpload(clean)).trim();
        if (detail && (detail.length > 8192 || tailTruncated)) {
          let start = Math.max(0, detail.length - 8191);
          // Keep the tail within its UI budget without splitting a UTF-16 pair.
          const first = detail.charCodeAt(start);
          if (start > 0 && first >= 0xdc00 && first <= 0xdfff) start++;
          detail = '…' + detail.slice(start);
        }
        if (!detail && diagnostic) detail = diagnostic.phase === 'spawn'
          ? diagnostic.spawn_code : `exit_code=${diagnostic.exit_code}, signal=${diagnostic.signal}`;
      }
      const done = () => resolve({ ok, text, ...(error ? { error } : {}), ...(detail ? { error_detail: detail } : {}), ...(diagnostic ? { diagnostic } : {}) });
      if (kill) killProcessTree(child, 'SIGKILL', { onComplete: done }); else done();
    };
    const read = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > 1024 * 1024) return finish(false, 'output_limit', true);
      if (capture === true && text.length < 64 * 1024) text += chunk.toString('utf8').slice(0, 64 * 1024 - text.length);
      if (capture === 'failure') {
        tail += decoders[stream].write(chunk);
        if (tail.length > 32 * 1024) { tail = tail.slice(-32 * 1024); tailTruncated = true; }
      }
    };
    child.stdout?.on('data', chunk => read(chunk, 'stdout'));
    child.stderr?.on('data', chunk => read(chunk, 'stderr'));
    child.on('error', (error: NodeJS.ErrnoException) => finish(false, 'failed', false, {
      phase: 'spawn', spawn_code: error.code && Object.hasOwn(os.constants.errno, error.code) ? error.code : 'unknown',
    }));
    child.on('close', (code, signal) => finish(code === 0, code === 0 ? undefined : 'failed', false,
      code === 0 ? undefined : {
        phase: 'exit', exit_code: Number.isSafeInteger(code) ? code : null,
        signal: signal ? (Object.hasOwn(os.constants.signals, signal) ? signal : 'unknown') : 'none',
      }));
    timer = setTimeout(() => finish(false, 'timeout', true), timeoutMs); timer.unref?.();
  });
}

export async function planCliUpgrade(type: LocalCliType, binPath: string): Promise<CliUpgradePlan> {
  const unavailable: CliUpgradePlan = { method: 'unavailable' };
  let real: string;
  try { real = await fs.realpath(binPath); } catch { return unavailable; }
  if (process.platform === 'win32') {
    const launch = resolveCliCommand(binPath, []);
    const nodeEntry = launch.args[0];
    // The resolver also validates extension-less Node entrypoints by shebang.
    if (nodeEntry && launch.command !== binPath && launch.args.length === 1 && path.isAbsolute(nodeEntry)) {
      try { real = await fs.realpath(nodeEntry); } catch { return unavailable; }
    }
  }
  const segments = real.split(path.sep);
  if (segments.some(s => s.endsWith('.app')) && segments.includes('Contents')) return unavailable;
  // Homebrew owns its formula even when it wraps a global npm installation.
  const cellar = segments.indexOf('Cellar'); const cask = segments.indexOf('Caskroom');
  const owner = cellar >= 0 ? cellar : cask;
  const brewNames: Record<LocalCliType, readonly string[]> = {
    codex: ['codex'], claude: ['claude-code'], opencode: ['opencode'], openclaw: ['openclaw'], hermes: [],
  };
  if (owner >= 0 && brewNames[type].includes(segments[owner + 1])) {
    const brew = path.join(segments.slice(0, owner).join(path.sep), 'bin', 'brew');
    try { await fs.access(brew); return { method: 'brew', command: brew, args: ['upgrade', ...(cask >= 0 ? ['--cask'] : []), segments[owner + 1]] }; }
    catch { return unavailable; }
  }
  // Package ownership is established by both package identity and its global layout.
  let dir = path.dirname(real);
  for (let depth = 0; depth < 8; depth++) {
    try {
      const manifest = path.join(dir, 'package.json');
      if ((await fs.stat(manifest)).size > 64 * 1024) return unavailable;
      const pkg = JSON.parse(await fs.readFile(manifest, 'utf8'));
      if (PACKAGES[type].includes(pkg.name)) {
        const parts = dir.split(path.sep); const nm = parts.lastIndexOf('node_modules');
        if (nm >= 0) {
          const parent = parts.slice(0, nm).join(path.sep) || path.parse(dir).root;
          const prefix = path.basename(parent) === 'lib' ? path.dirname(parent) : parent;
          // POSIX global bin is <prefix>/bin; Windows npm shims live at <prefix>.
          const expected = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
          if (await fs.realpath(path.dirname(binPath)) !== await fs.realpath(expected)) return unavailable;
          const npm = await whichBin('npm', { extraDirs: [expected] });
          if (npm) return { method: 'npm', command: npm, args: ['install', '--global', `${pkg.name}@latest`, '--prefix', prefix, '--no-audit', '--no-fund'] };
        }
        return unavailable;
      }
    } catch { /* bounded ancestor walk; no user content is returned */ }
    const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
  }
  const native = (type === 'codex' && segments.includes('standalone') && segments.includes('packages'))
    || (type === 'claude' && segments.includes('claude') && segments.includes('versions'))
    || (type === 'opencode' && segments.includes('.opencode'));
  if (native) {
    const command = type === 'opencode' ? 'upgrade' : 'update';
    const help = await runUpgradeCommand(binPath, ['--help'], 15_000, true);
    // Commander-style help can list aliases in one command token, e.g.
    // Claude Code 2.1.112 advertises "update|upgrade".
    const commandRow = new RegExp(`^[ \\t]*(?:[a-z][a-z0-9-]*\\|)*${command}(?:\\|[a-z][a-z0-9-]*)*(?:[ \\t]|$)`, 'm');
    if (help.ok && commandRow.test(help.text)) {
      return { method: 'native', command: binPath, args: [command] };
    }
    // Some native builds truncate long root help when piped. Probe
    // the short command help and require its exact usage, not a generic exit 0.
    const detail = await runUpgradeCommand(binPath, [command, '--help'], 15_000, true);
    const usage = new RegExp(`^Usage:[ \\t]+${type}[ \\t]+(?:[a-z][a-z0-9-]*\\|)*${command}(?:\\|[a-z][a-z0-9-]*)*(?:[ \\t]|$)`, 'mi');
    if (detail.ok && usage.test(detail.text)) {
      return { method: 'native', command: binPath, args: [command] };
    }
  }
  return unavailable;
}
function info(entry: LocalCliEntry, plan: CliUpgradePlan): CliUpgradeInfo {
  return { type: entry.type, version: entry.fullVersion || entry.version, can_upgrade: !!plan.command,
    method: plan.method };
}
export async function getCliUpgradeInfo(type: LocalCliType): Promise<CliUpgradeInfo> {
  const entry = await resolveCli(type, { force: true });
  return info(entry, entry.path ? await planCliUpgrade(type, entry.path) : { method: 'unavailable' });
}
export function upgradeLocalCli(type: LocalCliType): Promise<CliUpgradeResult> {
  const pending = inFlight.get(type); if (pending) return pending;
  const operationId = ++operationCounter;
  const startedAt = Date.now();
  const job = (async (): Promise<CliUpgradeOutcome> => {
    const entry = await resolveCli(type, { force: true });
    const plan = entry.path ? await planCliUpgrade(type, entry.path) : { method: 'unavailable' as const };
    const metadata = info(entry, plan);
    if (!entry.path || !plan.command || !plan.args) return { ...metadata, ok: false, error_code: 'unavailable' };
    // An external installer may have changed the binding while help was probed.
    const fresh = await resolveCli(type, { force: true });
    if (fresh.path !== entry.path || fresh.fullVersion !== entry.fullVersion || fresh.version !== entry.version) {
      return { ...metadata, ok: false, error_code: 'changed_installation' };
    }
    const result = await runUpgradeCommand(plan.command, plan.args, 10 * 60_000, 'failure');
    invalidateCache(type);
    if (!result.ok) {
      // Only explicit maintenance logs one bounded receipt. Capability probes
      // remain quiet; paths, arguments, output and raw errors are never logged.
      log.warn('CLI upgrade command failed', {
        cli: type, method: plan.method, reason: result.error || 'failed',
        ...(result.diagnostic || { phase: 'limit' }),
      });
      return { ...metadata, ok: false, error_code: result.error || 'failed',
        ...(result.error_detail ? { error_detail: result.error_detail } : {}) };
    }
    // Verify the original entry point, not a newly discovered higher-priority install.
    const probe = await detectVersionResult(entry.path);
    if (probe.status !== 'success' || checkMinVersion(type, probe.version)
      || (entry.version && !cliVersionAtLeast(probe.version, entry.version))) {
      return { ...metadata, ok: false, error_code: 'verification_failed' };
    }
    const after = await resolveCli(type, { force: true });
    if (after.path !== entry.path || after.version !== probe.version || !after.available) {
      return { ...metadata, ok: false, error_code: 'changed_installation' };
    }
    // A successful updater may be a no-op. Compare verified versions only
    // after all health/identity checks, preserving prerelease distinctions.
    const current = info(after, plan);
    return { ...current, ok: true, outcome: metadata.version === current.version ? 'up_to_date' : 'upgraded', entry: after };
  })().then(result => ({ ...result, operation_id: operationId, duration_ms: Date.now() - startedAt }));
  inFlight.set(type, job);
  void job.finally(() => { if (inFlight.get(type) === job) inFlight.delete(type); }).catch(() => {});
  return job;
}
