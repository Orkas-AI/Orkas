/**
 * Device-local connector runtime for official user-authorized provider CLIs.
 *
 * The registry, installation, preferences and credentials are device-local. Every device must
 * install and authorize its own CLI profile.
 */
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, shell } from 'electron';

import { t } from '../../i18n';
import { createLogger } from '../../logger';
import * as paths from '../../paths';
import { resolveBackgroundNodeRuntime, withBackgroundNodeEnv } from '../../util/background-node';
import { bundledNpxCli } from '../../util/bundled-runtime';
import { buildChildProxyEnvironment } from '../../util/proxy-dispatcher';
import { safeLocalCliAuthUrl } from '../../util/window-security';
import { getLanguageForUser } from '../config';
import { buildSandboxEnv, killProcessTree } from '../../../core-agent/src/sandbox/executor';
import {
  startInteractiveCliSession,
  waitInteractiveCliSession,
} from '../../model/core-agent/interactive-cli-sessions';
import { LOCAL_CLI_MANIFESTS } from './local-cli-manifest';
import { localCliAuthDiagnostic } from './local-cli-auth-error';
import type { CatalogEntry, LocalCliConfig, Transport } from './types';

export { LOCAL_CLI_MANIFESTS } from './local-cli-manifest';

const LOCAL_CLI_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const log = createLogger('connectors:local-cli');
const LOCAL_CLI_INSTALL_ERROR_CODES = new Set([
  'local_cli_runtime_missing',
  'local_cli_install_registry_unavailable',
  'local_cli_install_integrity_mismatch',
  'local_cli_install_timeout',
  'local_cli_install_failed',
]);

export interface LocalCliInstallStatus {
  installed: boolean;
  runtime_ready: boolean;
  package_name: string;
  package_version: string;
  executable: string;
}

interface LocalCliInstallRunResult {
  exitCode: number | null;
  stderr: string;
  timedOut?: boolean;
}

interface LocalCliInstallRunOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

type LocalCliInstallRunner = (options: LocalCliInstallRunOptions) => Promise<LocalCliInstallRunResult>;

function localCliError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function pcDirForChild(): string {
  return app?.isPackaged
    ? paths.PC_ROOT.replace(/\bapp\.asar\b/, 'app.asar.unpacked')
    : paths.PC_ROOT;
}

function requireLocalCli(entry: CatalogEntry): LocalCliConfig {
  if (entry.auth_mode !== 'local_cli' || !entry.local_cli) {
    throw new Error(`catalog entry ${entry.id} is not an official local-CLI connector`);
  }
  const manifest = LOCAL_CLI_MANIFESTS[entry.local_cli.provider];
  const actual = entry.local_cli;
  const exact = (
    actual.package_name === manifest.package_name
    && actual.package_version === manifest.package_version
    && actual.package_integrity === manifest.package_integrity
    && actual.executable === manifest.executable
    && JSON.stringify(actual.allowed_domains) === JSON.stringify(manifest.allowed_domains)
  );
  if (!exact) throw new Error(`local_cli_manifest_mismatch:${entry.id}`);
  if (actual.provider === 'lark' && !['feishu', 'lark'].includes(actual.brand || '')) {
    throw new Error(`local_cli_brand_missing:${entry.id}`);
  }
  return actual;
}

export function localCliRuntimeDir(uid: string, catalogId: string): string {
  const safeId = String(catalogId || '').trim();
  if (!/^[a-z0-9_-]+$/.test(safeId)) throw new Error('invalid local CLI catalog id');
  return path.join(paths.userLocalConfigDir(uid), 'connector-cli', safeId);
}

export function localCliProfileName(uid: string, catalogId: string): string {
  const digest = crypto.createHash('sha256')
    .update(`${String(uid)}\0${String(catalogId)}`)
    .digest('hex')
    .slice(0, 16);
  return `orkas-${digest}`;
}

function localCliEnv(uid: string, entry: CatalogEntry): Record<string, string> {
  const config = requireLocalCli(entry);
  const runtime = resolveBackgroundNodeRuntime();
  const npxCli = bundledNpxCli();
  if (!npxCli) throw Object.assign(new Error('Bundled npx runtime is required for local CLI connectors.'), {
    code: 'E_BUNDLED_NPX_MISSING',
  });
  const runtimeDir = localCliRuntimeDir(uid, entry.id);
  const workDir = path.join(runtimeDir, 'work');
  const profile = localCliProfileName(uid, entry.id);
  const npmCacheDir = path.join(runtimeDir, 'npm-cache');
  const lang = getLanguageForUser(uid);
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  return withBackgroundNodeEnv({
    ORKAS_LOCAL_CLI_PROVIDER: config.provider,
    ORKAS_LOCAL_CLI_BRAND: config.brand || '',
    ORKAS_LOCAL_CLI_PACKAGE: `${config.package_name}@${config.package_version}`,
    ORKAS_LOCAL_CLI_PACKAGE_INTEGRITY: config.package_integrity,
    ORKAS_LOCAL_CLI_EXECUTABLE: config.executable,
    ORKAS_LOCAL_CLI_ALLOWED_DOMAINS_JSON: JSON.stringify(config.allowed_domains),
    ORKAS_LOCAL_CLI_NPX_CLI: npxCli,
    ORKAS_LOCAL_CLI_RUNTIME_DIR: runtimeDir,
    ORKAS_LOCAL_CLI_WORK_DIR: workDir,
    ORKAS_LOCAL_CLI_INTEGRITY_MARKER: path.join(runtimeDir, '.orkas-cli-integrity.json'),
    ORKAS_LOCAL_CLI_PROFILE: profile,
    ORKAS_UI_LANG: lang,
    ORKAS_LOCAL_CLI_MESSAGE_START: t('connectors.local_cli.auth_start', { cli: config.executable }, lang),
    ORKAS_LOCAL_CLI_MESSAGE_DONE: t('connectors.local_cli.auth_done', undefined, lang),
    ORKAS_LOCAL_CLI_ALLOWED_FILE_ROOTS_JSON: JSON.stringify([
      paths.DEFAULT_USER_WORKSPACE,
      paths.userChatAttachmentsDir(uid),
      paths.userChatAttachmentDraftsDir(uid),
      paths.userToolResultsDir(uid),
    ]),
    WECOM_CLI_CONFIG_DIR: runtimeDir,
    WECOM_CLI_TMP_DIR: path.join(runtimeDir, 'tmp'),
    WECOM_CLI_LOG_DIR: path.join(runtimeDir, 'logs'),
    LARKSUITE_CLI_CONFIG_DIR: runtimeDir,
    DWS_CONFIG_DIR: runtimeDir,
    DWS_AGENT_PRODUCT: 'Orkas',
    DWS_AUDIT: '1',
    DWS_RUNTIME_CONTENT_SCAN: '1',
    DWS_RUNTIME_CONTENT_SCAN_ENFORCE: '1',
    NO_UPDATE_NOTIFIER: '1',
    NPM_CONFIG_CACHE: npmCacheDir,
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    npm_config_cache: npmCacheDir,
    npm_config_update_notifier: 'false',
  }, runtime);
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function hasExactInstalledPackage(runtimeDir: string, config: LocalCliConfig): boolean {
  const marker = readJsonObject(path.join(runtimeDir, '.orkas-cli-integrity.json'));
  const packageSpec = `${config.package_name}@${config.package_version}`;
  if (marker?.package !== packageSpec || marker?.integrity !== config.package_integrity) return false;

  const npxRoot = path.join(runtimeDir, 'npm-cache', '_npx');
  let installs: fs.Dirent[] = [];
  try { installs = fs.readdirSync(npxRoot, { withFileTypes: true }); }
  catch { return false; }
  const packageSegments = config.package_name.split('/');
  for (const install of installs) {
    if (!install.isDirectory()) continue;
    const packageDir = path.join(npxRoot, install.name, 'node_modules', ...packageSegments);
    const packageJson = readJsonObject(path.join(packageDir, 'package.json'));
    if (packageJson?.name !== config.package_name || packageJson?.version !== config.package_version) continue;
    const bin = packageJson.bin;
    const relativeBin = typeof bin === 'string'
      ? bin
      : (bin && typeof bin === 'object' && !Array.isArray(bin)
        ? (bin as Record<string, unknown>)[config.executable]
        : undefined);
    if (typeof relativeBin !== 'string' || !relativeBin) continue;
    const executable = path.resolve(packageDir, relativeBin);
    const relative = path.relative(packageDir, executable);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    try {
      if (fs.statSync(executable).isFile()) return true;
    } catch { /* try another npx cache entry */ }
  }
  return false;
}

export function localCliInstallStatus(uid: string, entry: CatalogEntry): LocalCliInstallStatus {
  const config = requireLocalCli(entry);
  let runtimeReady = false;
  try {
    runtimeReady = !!resolveBackgroundNodeRuntime().executable && !!bundledNpxCli();
  } catch { /* surfaced as a stable renderer-safe status */ }
  return {
    installed: runtimeReady && hasExactInstalledPackage(localCliRuntimeDir(uid, entry.id), config),
    runtime_ready: runtimeReady,
    package_name: config.package_name,
    package_version: config.package_version,
    executable: config.executable,
  };
}

function runLocalCliProcess(options: LocalCliInstallRunOptions): Promise<LocalCliInstallRunResult> {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stderr, timedOut });
    };
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += String(chunk).slice(0, 64 * 1024 - stderr.length);
    });
    child.once('error', (error) => {
      stderr = String(error && error.message ? error.message : error).slice(0, 64 * 1024);
      finish(null);
    });
    child.once('close', (code) => finish(code));
    timer = setTimeout(() => {
      timedOut = true;
      try { killProcessTree(child, 'SIGKILL'); } catch { /* child already exited */ }
      // Prefer close so Windows releases package/config file handles before cleanup.
      timer = setTimeout(() => finish(null), 3000);
      timer.unref?.();
    }, options.timeoutMs);
    timer.unref?.();
  });
}

function classifyLocalCliInstallError(result: LocalCliInstallRunResult): string {
  if (result.timedOut) return 'local_cli_install_timeout';
  const stderr = String(result.stderr || '').toLowerCase();
  if (stderr.includes('does not match') || stderr.includes('integrity mismatch')) {
    return 'local_cli_install_integrity_mismatch';
  }
  if (stderr.includes('unable to verify') || stderr.includes('integrity verifier is unavailable')) {
    return 'local_cli_install_registry_unavailable';
  }
  return 'local_cli_install_failed';
}

const localCliInstallLocks = new Map<string, Promise<LocalCliInstallStatus>>();

/** Download the exact reviewed CLI into the connector-owned npm cache. Never installs globally. */
export function installLocalCli(
  uid: string,
  entry: CatalogEntry,
  options: { runHelper?: LocalCliInstallRunner } = {},
): Promise<LocalCliInstallStatus> {
  const config = requireLocalCli(entry);
  const key = `${uid}\0${entry.id}`;
  const active = localCliInstallLocks.get(key);
  if (active) return active;
  const task = (async () => {
    const before = localCliInstallStatus(uid, entry);
    if (before.installed) return before;
    if (!before.runtime_ready) throw localCliError('local_cli_runtime_missing');

    const runtime = resolveBackgroundNodeRuntime();
    const proxyEnv = await buildChildProxyEnvironment();
    const cwd = localCliRuntimeDir(uid, entry.id);
    // A prior interrupted or tampered npx extraction must not poison every retry. These paths are
    // fully connector-owned; credentials/config elsewhere in runtimeDir are deliberately kept.
    try { fs.rmSync(path.join(cwd, 'npm-cache', '_npx'), { recursive: true, force: true }); }
    catch { throw localCliError('local_cli_install_failed'); }
    try { fs.rmSync(path.join(cwd, '.orkas-cli-integrity.json'), { force: true }); }
    catch { throw localCliError('local_cli_install_failed'); }
    const result = await (options.runHelper || runLocalCliProcess)({
      command: runtime.executable,
      args: [path.join(pcDirForChild(), 'bin/local-cli-auth.cjs')],
      cwd,
      env: buildSandboxEnv({
        ...localCliEnv(uid, entry),
        ...proxyEnv,
        ORKAS_LOCAL_CLI_INSTALL_ONLY: '1',
      }),
      timeoutMs: LOCAL_CLI_INSTALL_TIMEOUT_MS,
    });
    if (result.timedOut || result.exitCode !== 0) throw localCliError(classifyLocalCliInstallError(result));
    const after = localCliInstallStatus(uid, entry);
    if (!after.installed) throw localCliError('local_cli_install_failed');
    return after;
  })().catch((error: unknown) => {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';
    throw LOCAL_CLI_INSTALL_ERROR_CODES.has(code) ? error : localCliError('local_cli_install_failed');
  }).finally(() => {
    localCliInstallLocks.delete(key);
  });
  localCliInstallLocks.set(key, task);
  return task;
}

export function localCliTransport(uid: string, entry: CatalogEntry): Transport {
  requireLocalCli(entry);
  const runtime = resolveBackgroundNodeRuntime();
  return {
    kind: 'stdio',
    command: runtime.executable,
    args: [path.join(pcDirForChild(), 'bin/local-cli-mcp-server.cjs')],
    cwd: localCliRuntimeDir(uid, entry.id),
    env: localCliEnv(uid, entry),
  };
}

/** Open only an official local CLI authorization route in the system browser. */
export async function openLocalCliAuthorizationUrl(raw: unknown): Promise<void> {
  const target = safeLocalCliAuthUrl(raw);
  if (!target) throw localCliError('local_cli_auth_url_invalid');
  try {
    await shell.openExternal(target);
  } catch {
    throw localCliError('local_cli_auth_url_open_failed');
  }
}

export async function authorizeLocalCli(uid: string, entry: CatalogEntry): Promise<void> {
  const config = requireLocalCli(entry);
  if (!localCliInstallStatus(uid, entry).installed) throw localCliError('local_cli_install_required');
  const runtime = resolveBackgroundNodeRuntime();
  const cwd = localCliRuntimeDir(uid, entry.id);
  const proxyEnv = await buildChildProxyEnvironment();
  const lang = getLanguageForUser(uid);
  const displayName = String(lang).startsWith('zh')
    ? (entry.display_name_zh || entry.display_name)
    : (entry.display_name_en || entry.display_name);
  const session = startInteractiveCliSession({
    uid,
    purpose: t('connectors.local_cli.auth_purpose', { connector: displayName }, lang),
    command: runtime.executable,
    args: [path.join(pcDirForChild(), 'bin/local-cli-auth.cjs')],
    cwd,
    // Connector authorization never grants a terminal. Xero additionally needs a setup form.
    presentation: config.provider === 'xero' ? 'connector_input' : 'browser_auth',
    sandboxEnv: { ...localCliEnv(uid, entry), ...proxyEnv },
    maxLifetimeMs: 30 * 60 * 1000,
  });
  const terminal = await waitInteractiveCliSession(uid, session.session_id);
  if (terminal.status !== 'exited' || terminal.exit_code !== 0) {
    const cancelled = terminal.status === 'closed';
    const diagnostic = localCliAuthDiagnostic(cancelled ? '' : terminal.output);
    if (!cancelled) log.warn('Official CLI authorization failed', {
      provider: config.provider, exit_code: terminal.exit_code,
      category: diagnostic.category, provider_exit_code: diagnostic.provider_exit_code,
      has_detail: !!diagnostic.detail,
    });
    throw Object.assign(new Error(`local_cli_authorization_failed:${config.provider}`), {
      code: cancelled ? 'user_cancelled' : 'local_cli_authorization_failed',
      ...(diagnostic.detail ? { authorization_detail: diagnostic.detail } : {}),
    });
  }
}

/** Provider logout is best-effort because some official CLIs only expose local config removal.
 *  The exact connector-owned directory is removed after logout; no parent/glob path is accepted. */
export async function removeLocalCliAuthorization(uid: string, entry: CatalogEntry): Promise<void> {
  const config = requireLocalCli(entry);
  const runtimeDir = localCliRuntimeDir(uid, entry.id);
  const npxCli = bundledNpxCli();
  const runtime = resolveBackgroundNodeRuntime();
  if (npxCli && fs.existsSync(runtimeDir) && localCliInstallStatus(uid, entry).installed) {
    const profile = localCliProfileName(uid, entry.id);
    const providerCommands = config.provider === 'lark'
      ? [['auth', 'logout', '--profile', profile]]
      : config.provider === 'xero'
        ? [['logout', '--profile', profile], ['profile', 'remove', profile]]
        : [['auth', 'logout']];
    for (const providerArgs of providerCommands) {
      try {
        await runLocalCliProcess({
          command: runtime.executable,
          args: [npxCli, '--offline', '-y', `${config.package_name}@${config.package_version}`, ...providerArgs],
          cwd: runtimeDir,
          env: buildSandboxEnv(localCliEnv(uid, entry)),
          timeoutMs: 30_000,
        });
      } catch { /* exact local cleanup below remains authoritative */ }
    }
  }
  try { await fs.promises.rm(runtimeDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
