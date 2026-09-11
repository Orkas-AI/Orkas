#!/usr/bin/env node
'use strict';

/** Interactive authorization driver for reviewed official provider CLIs.
 * This file accepts no model/user command arguments. Executables and packages are pinned;
 * incremental scopes come from verified grants and structured provider recovery state. */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const permissions = require('./local-cli-permissions.cjs');

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

function run(node, npxCli, packageSpec, args, env, allowExisting = false, offline = true, captureStdout = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [npxCli, ...(offline ? ['--offline'] : []), '-y', packageSpec, ...args], {
      cwd: env.ORKAS_LOCAL_CLI_WORK_DIR,
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let outputForwarded = false;
    let stdout = '';
    let overflow = false;
    for (const [source, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      if (captureStdout && source === child.stdout) {
        source.on('data', chunk => {
          if (!overflow && stdout.length + chunk.length <= 64 * 1024) stdout += chunk.toString();
          else { overflow = true; stdout = ''; }
        });
        continue;
      }
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
      if (code === 0 || allowExisting) resolve(captureStdout && !overflow ? stdout : undefined);
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

function larkUserScopes(node, npxCli, manifest, env, runner = spawnSync) {
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
  if (result.error || result.status !== 0) return null;
  try {
    const status = JSON.parse(String(result.stdout || ''));
    const user = status?.identities?.user;
    const scopes = typeof user?.scope === 'string' ? user.scope.split(/\s+/)
      : Array.isArray(user?.scope) ? user.scope : [];
    return user?.available === true && user?.verified === true
      ? scopes.filter(permissions.isScopeName) : null;
  } catch {
    return null;
  }
}

function larkAuthorizationReady(node, npxCli, manifest, env, runner = spawnSync, requiredScopes = []) {
  const scopes = larkUserScopes(node, npxCli, manifest, env, runner);
  return scopes !== null && requiredScopes.every((scope) => scopes.includes(scope));
}

function checkLarkPermissions(node, npxCli, manifest, env, runner = spawnSync) {
  const pending = permissions.readPermissionRequest(env);
  let scopeReported = false;
  const scopes = larkUserScopes(node, npxCli, manifest, env, (...args) => {
    const result = runner(...args);
    try {
      const value = JSON.parse(String(result.stdout || '')).identities?.user?.scope;
      scopeReported = typeof value === 'string'
        ? value.split(/\s+/).filter(Boolean).every(permissions.isScopeName)
        : Array.isArray(value) && value.every(permissions.isScopeName);
    } catch { /* An unavailable scope report is not proof of missing permission. */ }
    return result;
  });
  if (scopes === null || !scopeReported) return false;
  permissions.recordUserScopeCheck(env, scopes, pending, ['im:message.send_as_user']);
  return true;
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
  if (result.error || result.status !== 0) return false;
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
  if (result.error || result.status !== 0) return false;
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

  const pending = permissions.readPermissionRequest(env);
  if (!pending && ready()) return;
  let loginError = null;
  try {
    await execute(manifest.login(env)[0]);
  } catch (error) {
    loginError = error;
  }
  if (pending && loginError) throw loginError;
  if (ready()) {
    // Identity verification cannot attest to resource or business permissions.
    // Preserve the advisory request and the existing usable connection.
    if (pending) throw new Error('requested permissions could not be verified');
    return;
  }
  if (loginError) throw loginError;
  throw new Error('official CLI authorization did not produce a verified identity');
}

// DWS login verifies identity only. PAT grants are additive and must acknowledge
// the requested scopes; a successful old login cannot resolve business denial.
async function authorizeDingtalk(node, npxCli, manifest, env, dependencies = {}) {
  const execute = dependencies.execute
    || ((args, capture = false) => run(node, npxCli, manifest.package, args, env, false, true, capture));
  const ready = dependencies.authorizationReady
    || (() => dingtalkAuthorizationReady(node, npxCli, manifest, env));
  const pending = permissions.readPermissionRequest(env);
  if (!pending) return authorizeSingleStep(node, npxCli, manifest, env, dingtalkAuthorizationReady, dependencies);
  const loginNeeded = !ready();
  if (loginNeeded) await execute(manifest.login(env)[0]);
  if (!ready()) throw new Error('official CLI authorization did not produce a verified identity');
  const scopes = pending.pat_scopes || [];
  // Recheck known PAT scopes after administrator changes; a cached policy denial
  // must not permanently prevent a user-initiated recovery attempt.
  if (pending.admin_required && !scopes.length) throw new Error('organization administrator approval is required');
  if (scopes.length) {
    const grantArgs = ['pat', 'chmod', ...scopes, '--grant-type', 'permanent', '--yes'];
    // Table mode lets the official CLI own consent/polling. DWS may return only
    // {ok:true} after consent; repeat the same additive grant in JSON mode to
    // obtain granted/already-granted scope evidence, never a business replay.
    await execute([...grantArgs, '--format', 'table']);
    const output = await execute([...grantArgs, '--format', 'json'], true);
    let receipt;
    try { receipt = JSON.parse(output); } catch { /* no verified grant receipt */ }
    const data = receipt?.data || receipt?.result;
    const granted = [...(Array.isArray(data?.grantedScopes) ? data.grantedScopes : []),
      ...(Array.isArray(data?.alreadyGrantedScopes) ? data.alreadyGrantedScopes : [])];
    if (receipt?.success === true) permissions.recordPatScopeGrant(env, pending, granted);
    if (receipt?.success !== true || !scopes.every(scope => granted.includes(scope))) {
      throw new Error('requested permissions are still unavailable');
    }
  }
  // DWS 1.0.61 declares --scopes but does not read it in auth login. Do not
  // silently claim an OAuth scope or an unknown resource denial was repaired.
  if (pending.scopes.length || pending.unresolved_access || !scopes.length) {
    if (!scopes.length && !loginNeeded) await execute(manifest.login(env)[0]);
    throw new Error('requested permissions could not be verified');
  }
  permissions.clearPermissionRequest(env, pending);
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
    || ((scopes = []) => larkAuthorizationReady(node, npxCli, manifest, env, spawnSync, scopes));
  const pendingPermissions = permissions.readPermissionRequest(env);
  const authorizationScopes = dependencies.authorizationScopes
    || (() => larkUserScopes(node, npxCli, manifest, env));
  const ready = authorizationReady();
  if (ready && !pendingPermissions) return;
  const commands = manifest.login(env);
  if (!ready && !profileConfigured()) {
    await execute(commands[0]);
    if (!pendingPermissions && authorizationReady()) return;
  }
  if (pendingPermissions) {
    const existingScopes = authorizationScopes();
    if (ready && !existingScopes) throw new Error('current user permissions could not be verified');
    const requestedScopes = [...new Set([...(existingScopes || []), ...pendingPermissions.scopes])].sort();
    // A permission failure requires a real interactive login, including when the
    // current token is valid or the provider supplied no missing scope list.
    await execute(pendingPermissions.scopes.length
      ? ['auth', 'login', '--profile', env.ORKAS_LOCAL_CLI_PROFILE, '--scope', requestedScopes.join(' ')]
      : [...commands[1], ...(requestedScopes.length ? ['--scope', requestedScopes.join(' ')] : [])]);
    if (!authorizationReady(requestedScopes)) {
      throw new Error('requested permissions are still unavailable');
    }
    // Verified user scopes cannot establish bot visibility or unknown resource
    // access. Keep that advisory, just as a read-only scope check does.
    if (pendingPermissions.unresolved_access || !pendingPermissions.scopes.length) {
      throw new Error('requested permissions could not be verified');
    }
    permissions.clearPermissionRequest(env, pendingPermissions);
    return;
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
  if (process.env.ORKAS_LOCAL_CLI_CHECK_PERMISSIONS_ONLY === '1') {
    if (provider === 'lark') checkLarkPermissions(node, npxCli, manifest, process.env);
    return;
  }
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
    await authorizeDingtalk(node, npxCli, manifest, process.env);
  } else {
    const pending = permissions.readPermissionRequest(process.env);
    const commands = manifest.login(process.env);
    for (let index = 0; index < commands.length; index++) {
      // Xero profile creation may report that the deterministic profile already exists during
      // reauthorization; the subsequent login plus identity read remains the source of truth.
      await run(node, npxCli, manifest.package, commands[index], process.env,
        provider === 'xero' && index === 0);
    }
    const verify = typeof manifest.verify === 'function' ? manifest.verify(process.env) : manifest.verify;
    await run(node, npxCli, manifest.package, verify, process.env);
    if (pending) permissions.clearPermissionRequest(process.env, pending);
  }
  writeIntegrityMarker(manifest, process.env);
  process.stdout.write(`[Orkas] ${process.env.ORKAS_LOCAL_CLI_MESSAGE_DONE || 'Authorization complete. You can close this terminal.'}\n`);
}

module.exports = {
  MANIFESTS,
  assertIntegrityMarker,
  authorizeLark,
  authorizeDingtalk,
  authorizeSingleStep,
  commandSucceeds,
  dingtalkAuthorizationReady,
  larkAuthorizationReady,
  larkUserScopes,
  checkLarkPermissions,
  main,
  run,
  verifyRegistryIntegrity,
  wecomAuthorizationReady,
  writeIntegrityMarker,
};

if (require.main === module) {
  main().catch(fail);
}
