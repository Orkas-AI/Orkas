#!/usr/bin/env node
'use strict';

/** Interactive authorization driver for reviewed official provider CLIs.
 * This file accepts no model/user command arguments: every executable, package and OAuth scope
 * is pinned by Orkas-owned constants below. */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MANIFESTS = Object.freeze({
  wecom: Object.freeze({
    package: '@wecom/cli@1.2.0',
    integrity: 'sha512-GaVCie2We3EWrOiIYlXp5FpjznikbS1oShFyZjIz2uDDdQlkbA8CJzjhzrAzRgIDU/oaxpmEucp9WHN/yiuzuQ==',
    executable: 'wecom-cli',
    domains: Object.freeze([
      'calendar', 'chat', 'contact', 'disk', 'doc', 'identity', 'mail', 'media', 'message',
      'meeting', 'sheet', 'smartpage', 'smartsheet', 'todo',
    ]),
    login: () => [['auth', 'init', '--noninteractive', '--no-browser']],
    verify: ['identity', 'whoami'],
  }),
  lark: Object.freeze({
    package: '@larksuite/cli@1.0.93',
    integrity: 'sha512-QARcHz96pfEzzRZdjXene5h9fJ46lCu5q2TWx+blLyOIXEPuJwi6bT+RT9hPOsKFW+bbGYvamU8LpD6FsIa5ew==',
    executable: 'lark-cli',
    domains: Object.freeze([
      'approval', 'attendance', 'base', 'calendar', 'contact', 'docs', 'drive', 'im',
      'mail', 'markdown', 'mindnotes', 'minutes', 'note', 'okr', 'sheets', 'slides',
      'task', 'vc', 'wiki',
    ]),
    login: (env) => [
      ['config', 'init', '--new', '--name', env.ORKAS_LOCAL_CLI_PROFILE, '--brand', env.ORKAS_LOCAL_CLI_BRAND],
      [
        'auth', 'login', '--profile', env.ORKAS_LOCAL_CLI_PROFILE,
        '--domain', JSON.parse(env.ORKAS_LOCAL_CLI_ALLOWED_DOMAINS_JSON).join(','),
      ],
    ],
    verify: (env) => [
      'auth', 'status', '--profile', env.ORKAS_LOCAL_CLI_PROFILE, '--verify', '--json',
    ],
  }),
  dingtalk: Object.freeze({
    package: 'dingtalk-workspace-cli@1.0.61',
    integrity: 'sha512-lYLLqE3jDRqzf3ekjaOnBqD222fsbRkEiO4GsR6k8aMiybEUTQDr7BC9/4Wtm2KeL+PiukBqfZ9EFULS22jdBA==',
    executable: 'dws',
    domains: Object.freeze([
      'agoal', 'aisearch', 'aitable', 'attendance', 'calendar', 'chat', 'contact', 'ding',
      'doc', 'drive', 'hrbrain', 'live', 'mail', 'minutes', 'oa', 'recruit', 'report',
      'sheet', 'todo', 'whiteboard', 'wiki',
    ]),
    // Orkas opens the validated device link so repeated output cannot launch duplicate tabs.
    login: () => [['auth', 'login', '--device', '--no-browser']],
    verify: ['auth', 'status', '--format', 'json'],
  }),
  xero: Object.freeze({
    package: '@xeroapi/xero-command-line@0.0.7',
    integrity: 'sha512-H0GITjyzP7Zek/6zinvpOjY/Ed7nyf21c9n+hzi81lTFrRp/foMRwL6Gx7IktsOyeo0DSJ4Y/y6VqNrwyiodEA==',
    executable: 'xero',
    domains: Object.freeze([
      'accounts', 'bank-transactions', 'contact-groups', 'contacts', 'credit-notes',
      'currencies', 'invoices', 'items', 'manual-journals', 'org', 'payments', 'quotes',
      'reports', 'tax-rates', 'tracking',
    ]),
    login: (env) => [
      ['profile', 'add', env.ORKAS_LOCAL_CLI_PROFILE],
      [
        'login', '--profile', env.ORKAS_LOCAL_CLI_PROFILE, '--scope',
        [
          'accounting.contacts', 'accounting.settings', 'accounting.invoices',
          'accounting.payments', 'accounting.banktransactions', 'accounting.manualjournals',
          'accounting.reports.balancesheet.read', 'accounting.reports.profitandloss.read',
          'accounting.reports.trialbalance.read', 'accounting.reports.aged.read',
        ].join(' '),
      ],
    ],
    verify: (env) => ['org', 'details', '--profile', env.ORKAS_LOCAL_CLI_PROFILE, '--json'],
  }),
});

function fail(error) {
  // Provider output already reached the host. Do not append a wrapper exit summary to
  // that error message; keep a fallback for spawn failures and commands with no output.
  if (!error || error.outputForwarded !== true) {
    process.stderr.write(`[Orkas] ${error && error.message ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
}

function run(node, npxCli, packageSpec, args, env, allowExisting = false, offline = true) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [npxCli, ...(offline ? ['--offline'] : []), '-y', packageSpec, ...args], {
      cwd: env.ORKAS_LOCAL_CLI_WORK_DIR,
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let outputForwarded = false;
    for (const [source, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      source.on('data', () => { outputForwarded = true; });
      source.pipe(target, { end: false });
    }
    const forward = (signal) => {
      try { child.kill(signal); } catch { /* child already exited */ }
    };
    process.once('SIGTERM', forward);
    process.once('SIGINT', forward);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      process.removeListener('SIGTERM', forward);
      process.removeListener('SIGINT', forward);
      if (code === 0 || allowExisting) resolve();
      else reject(Object.assign(new Error(`official CLI exited with ${code ?? signal ?? 'unknown'}`), {
        outputForwarded,
      }));
    });
  });
}

function commandSucceeds(node, npxCli, manifest, args, env, runner = spawnSync) {
  const result = runner(
    node,
    [npxCli, '--offline', '-y', manifest.package, ...args],
    {
      cwd: env.ORKAS_LOCAL_CLI_WORK_DIR,
      env,
      stdio: 'ignore',
      timeout: 60_000,
      windowsHide: true,
    },
  );
  return !result.error && result.status === 0;
}

function larkAuthorizationReady(node, npxCli, manifest, env, runner = spawnSync) {
  const verify = manifest.verify(env);
  const result = runner(
    node,
    [npxCli, '--offline', '-y', manifest.package, ...verify],
    {
      cwd: env.ORKAS_LOCAL_CLI_WORK_DIR,
      env,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    },
  );
  if (result.error) return false;
  try {
    const status = JSON.parse(String(result.stdout || ''));
    return status?.identities?.user?.available === true
      && status?.identities?.user?.verified === true;
  } catch {
    return false;
  }
}

function wecomAuthorizationReady(node, npxCli, manifest, env, runner = spawnSync) {
  const result = runner(
    node,
    [npxCli, '--offline', '-y', manifest.package, ...manifest.verify],
    {
      cwd: env.ORKAS_LOCAL_CLI_WORK_DIR,
      env,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    },
  );
  if (result.error) return false;
  try {
    const identity = JSON.parse(String(result.stdout || ''));
    return typeof identity?.extra_identity_context === 'string'
      && identity.extra_identity_context.length > 0;
  } catch {
    return false;
  }
}

function dingtalkAuthorizationReady(node, npxCli, manifest, env, runner = spawnSync) {
  const result = runner(
    node,
    [npxCli, '--offline', '-y', manifest.package, ...manifest.verify],
    {
      cwd: env.ORKAS_LOCAL_CLI_WORK_DIR,
      env,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    },
  );
  if (result.error) return false;
  try {
    const status = JSON.parse(String(result.stdout || ''));
    return status?.success === true && status?.authenticated === true;
  } catch {
    return false;
  }
}

async function authorizeSingleStep(node, npxCli, manifest, env, authorizationReady, dependencies = {}) {
  const execute = dependencies.execute
    || ((args) => run(node, npxCli, manifest.package, args, env));
  const ready = dependencies.authorizationReady
    || (() => authorizationReady(node, npxCli, manifest, env));

  if (ready()) return;
  let loginError = null;
  try {
    await execute(manifest.login(env)[0]);
  } catch (error) {
    loginError = error;
  }
  if (ready()) return;
  if (loginError) throw loginError;
  throw new Error('official CLI authorization did not produce a verified identity');
}

async function authorizeLark(node, npxCli, manifest, env, dependencies = {}) {
  const execute = dependencies.execute
    || ((args) => run(node, npxCli, manifest.package, args, env));
  const profileConfigured = dependencies.profileConfigured
    || (() => commandSucceeds(
      node,
      npxCli,
      manifest,
      ['config', 'show', '--profile', env.ORKAS_LOCAL_CLI_PROFILE],
      env,
    ));
  const authorizationReady = dependencies.authorizationReady
    || (() => larkAuthorizationReady(node, npxCli, manifest, env));

  if (authorizationReady()) return;
  const commands = manifest.login(env);
  if (!profileConfigured()) {
    await execute(commands[0]);
    if (authorizationReady()) return;
  }

  let loginError = null;
  try {
    await execute(commands[1]);
  } catch (error) {
    loginError = error;
  }
  if (authorizationReady()) return;
  if (loginError) throw loginError;
  throw new Error('official CLI authorization did not produce a verified user identity');
}

function verifyRegistryIntegrity(node, npxCli, manifest, env, runner = spawnSync) {
  const npmCli = path.join(path.dirname(npxCli), 'npm-cli.js');
  if (path.basename(npxCli) !== 'npx-cli.js' || !fs.existsSync(npmCli)) {
    throw new Error('bundled npm integrity verifier is unavailable');
  }
  const result = runner(node, [npmCli, 'view', manifest.package, 'dist.integrity', '--json'], {
    cwd: env.ORKAS_LOCAL_CLI_WORK_DIR,
    env,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error('unable to verify the official CLI package integrity; check the network and retry');
  }
  let observed = '';
  try { observed = JSON.parse(String(result.stdout || '')); }
  catch { observed = String(result.stdout || '').trim(); }
  if (observed !== manifest.integrity) throw new Error('official CLI registry integrity does not match the Orkas pin');
}

function writeIntegrityMarker(manifest, env) {
  const marker = String(env.ORKAS_LOCAL_CLI_INTEGRITY_MARKER || '');
  const runtimeDir = String(env.ORKAS_LOCAL_CLI_RUNTIME_DIR || '');
  if (!marker || path.dirname(marker) !== runtimeDir) throw new Error('invalid local CLI integrity marker path');
  const temp = `${marker}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ package: manifest.package, integrity: manifest.integrity })}\n`, {
    encoding: 'utf8', mode: 0o600,
  });
  fs.renameSync(temp, marker);
}

function assertIntegrityMarker(manifest, env) {
  const marker = String(env.ORKAS_LOCAL_CLI_INTEGRITY_MARKER || '');
  const runtimeDir = String(env.ORKAS_LOCAL_CLI_RUNTIME_DIR || '');
  if (!marker || path.dirname(marker) !== runtimeDir) throw new Error('invalid local CLI integrity marker path');
  let stored;
  try { stored = JSON.parse(fs.readFileSync(marker, 'utf8')); }
  catch { throw new Error('official CLI is not installed by Orkas; reconnect and install it first'); }
  if (!stored || stored.package !== manifest.package || stored.integrity !== manifest.integrity) {
    throw new Error('official CLI package integrity marker does not match the Orkas pin');
  }
}

async function main() {
  const provider = String(process.env.ORKAS_LOCAL_CLI_PROVIDER || '');
  const manifest = MANIFESTS[provider];
  const node = String(process.env.ORKAS_NODE || '');
  const npxCli = String(process.env.ORKAS_LOCAL_CLI_NPX_CLI || '');
  if (!manifest || !node || !npxCli) throw new Error('invalid local CLI authorization environment');
  const runtimeDir = String(process.env.ORKAS_LOCAL_CLI_RUNTIME_DIR || '');
  const workDir = String(process.env.ORKAS_LOCAL_CLI_WORK_DIR || '');
  if (!path.isAbsolute(runtimeDir) || path.resolve(workDir) !== path.join(runtimeDir, 'work')) {
    throw new Error('invalid local CLI work directory');
  }
  if (process.env.ORKAS_LOCAL_CLI_PACKAGE !== manifest.package) {
    throw new Error('local CLI package pin mismatch');
  }
  if (process.env.ORKAS_LOCAL_CLI_PACKAGE_INTEGRITY !== manifest.integrity) {
    throw new Error('local CLI package integrity mismatch');
  }
  if (process.env.ORKAS_LOCAL_CLI_EXECUTABLE !== manifest.executable) {
    throw new Error('local CLI executable mismatch');
  }
  let configuredDomains;
  try { configuredDomains = JSON.parse(process.env.ORKAS_LOCAL_CLI_ALLOWED_DOMAINS_JSON || '[]'); }
  catch { configuredDomains = []; }
  if (JSON.stringify(configuredDomains) !== JSON.stringify(manifest.domains)) {
    throw new Error('local CLI domain policy mismatch');
  }
  if (provider === 'lark' && !['feishu', 'lark'].includes(process.env.ORKAS_LOCAL_CLI_BRAND)) {
    throw new Error('invalid Lark/Feishu brand');
  }

  if (process.env.ORKAS_LOCAL_CLI_INSTALL_ONLY === '1') {
    verifyRegistryIntegrity(node, npxCli, manifest, process.env);
    await run(node, npxCli, manifest.package, ['--help'], process.env, false, false);
    writeIntegrityMarker(manifest, process.env);
    return;
  }

  assertIntegrityMarker(manifest, process.env);
  // The host's session-start event owns progress; stdout/stderr carry provider output.
  // The pinned Lark CLI starts discovery on Feishu, reads tenant_brand from the scanned account,
  // and persists the final Feishu/Lark brand in the profile. Orkas therefore does not ask the
  // user to choose a region before starting the official flow.
  if (provider === 'lark') {
    await authorizeLark(node, npxCli, manifest, process.env);
  } else if (provider === 'wecom') {
    await authorizeSingleStep(
      node, npxCli, manifest, process.env, wecomAuthorizationReady,
    );
  } else if (provider === 'dingtalk') {
    await authorizeSingleStep(
      node, npxCli, manifest, process.env, dingtalkAuthorizationReady,
    );
  } else {
    const commands = manifest.login(process.env);
    for (let index = 0; index < commands.length; index++) {
      // Xero profile creation may report that the deterministic profile already exists during
      // reauthorization; the subsequent login plus identity read remains the source of truth.
      await run(node, npxCli, manifest.package, commands[index], process.env,
        provider === 'xero' && index === 0);
    }
    const verify = typeof manifest.verify === 'function' ? manifest.verify(process.env) : manifest.verify;
    await run(node, npxCli, manifest.package, verify, process.env);
  }
  writeIntegrityMarker(manifest, process.env);
  process.stdout.write(`[Orkas] ${process.env.ORKAS_LOCAL_CLI_MESSAGE_DONE || 'Authorization complete. You can close this terminal.'}\n`);
}

module.exports = {
  MANIFESTS,
  assertIntegrityMarker,
  authorizeLark,
  authorizeSingleStep,
  commandSucceeds,
  dingtalkAuthorizationReady,
  larkAuthorizationReady,
  main,
  run,
  verifyRegistryIntegrity,
  wecomAuthorizationReady,
  writeIntegrityMarker,
};

if (require.main === module) {
  main().catch(fail);
}
