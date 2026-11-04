#!/usr/bin/env node
'use strict';

/** Interactive authorization driver for reviewed official provider CLIs.
 * This file accepts no model/user command arguments. Executables and packages are pinned;
 * incremental scopes come from verified grants and structured provider recovery state. */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const permissions = require('./local-cli-permissions.cjs');
const larkPermissionContract = require('./local-cli-lark-permission-contract.json');

function larkScopeRequirements(env) {
  const domains = JSON.parse(env.ORKAS_LOCAL_CLI_ALLOWED_DOMAINS_JSON || '[]');
  return domains.map(domain => {
    const requirement = larkPermissionContract.domains[domain];
    if (!requirement) throw new Error('unsupported local CLI permission domain');
    return requirement;
  });
}

function larkRequiredScopes(env) {
  return [...new Set(larkScopeRequirements(env).flatMap(({ all, any }) =>
    [...all, ...any.map(group => group[0])]))].sort();
}

// Only declared API alternatives count as equivalent. Shortcut preflight
// scopes remain exact requirements; prefixes cannot establish equivalence.
function larkScopeEvidence(env, granted) {
  const requirements = larkScopeRequirements(env);
  const exact = new Set(requirements.flatMap(({ all }) => all));
  const groups = requirements.flatMap(({ any }) => any);
  const actual = new Set(granted);
  const evidence = new Set(granted);
  for (const scope of new Set(groups.map(group => group[0]))) {
    if (!exact.has(scope) && groups.filter(group => group[0] === scope)
      .every(group => group.some(alternative => actual.has(alternative)))) evidence.add(scope);
  }
  return [...evidence];
}

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
        '--scope', larkRequiredScopes(env).join(' '),
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
    let stderr = '';
    let overflow = false;
    const captureLimit = captureStdout === 'tee' ? 512 * 1024 : 64 * 1024;
    for (const [source, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      if (captureStdout && source === child.stderr) source.on('data', chunk => {
        if (stderr.length + chunk.length <= 64 * 1024) stderr += chunk.toString();
      });
      if (captureStdout && source === child.stdout) {
        source.on('data', chunk => {
          if (!overflow && stdout.length + chunk.length <= captureLimit) stdout += chunk.toString();
          else { overflow = true; stdout = ''; }
        });
        if (captureStdout !== 'tee') continue;
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
        outputForwarded, exitCode: code, signal,
        ...(captureStdout && !overflow ? { stdout, stderr } : {}),
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

function larkUserScopes(node, npxCli, manifest, env, runner = spawnSync, requireReport = true) {
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
    const reported = typeof user?.scope === 'string' || Array.isArray(user?.scope);
    const scopes = typeof user?.scope === 'string' ? user.scope.split(/\s+/).filter(Boolean)
      : Array.isArray(user?.scope) ? user.scope : [];
    return user?.available === true && user?.verified === true
      ? reported && scopes.every(permissions.isScopeName) ? scopes : requireReport ? null : [] : null;
  } catch {
    return null;
  }
}

function larkAuthorizationReady(node, npxCli, manifest, env, runner = spawnSync, requiredScopes = []) {
  const scopes = larkUserScopes(node, npxCli, manifest, env, runner, requiredScopes.length > 0);
  return scopes !== null && requiredScopes.every((scope) => scopes.includes(scope));
}

function checkLarkPermissions(node, npxCli, manifest, env, runner = spawnSync) {
  if (manifest.package !== larkPermissionContract.package) return false;
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
  permissions.recordUserScopeCheck(env, larkScopeEvidence(env, scopes), pending, larkRequiredScopes(env));
  // A stored token can retain its scope list after app permissions are revoked.
  // Check app eligibility independently; this endpoint exposes user scopes only.
  const current = permissions.readPermissionRequest(env);
  try {
    const result = runner(node, [npxCli, '--offline', '-y', manifest.package,
      'auth', 'scopes', '--profile', env.ORKAS_LOCAL_CLI_PROFILE, '--json'], {
      cwd: env.ORKAS_LOCAL_CLI_WORK_DIR, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024, windowsHide: true,
    });
    if (!result.error && result.status === 0) {
      try {
        const report = JSON.parse(String(result.stdout || ''));
        const enabled = report.userScopes === null && report.count === 0 ? [] : report.userScopes;
        if (report.tokenType === 'user' && Array.isArray(enabled)
          && enabled.every(permissions.isScopeName)) {
          permissions.recordLarkAppScopeCheck(env, current, larkScopeEvidence(env, enabled), larkRequiredScopes(env));
        }
      } catch { /* An unavailable app report preserves existing evidence. */ }
    }
  } catch { /* An unavailable app query cannot invalidate a verified user grant. */ }
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

function checkWecomPermissions(node, npxCli, manifest, env, runner = spawnSync) {
  const pending = permissions.readPermissionRequest(env);
  let result;
  const verified = wecomAuthorizationReady(node, npxCli, manifest, env, (...args) => {
    result = runner(...args);
    return result;
  });
  // A permission denial on identity discovery is connector-level evidence.
  // Identity success alone cannot clear a historical business-permission gap.
  const denial = result && permissions.structuredPermissionFailure(result, 'wecom');
  if (denial) {
    denial.provider_error.identity_denied = true;
    permissions.rememberPermissionRequest(denial, env);
  } else if (verified) permissions.recordWecomIdentityCheck(env, pending);
  return verified;
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
  const permissionRecovery = pending && (pending.scopes.length || pending.pat_scopes?.length
    || pending.admin_required || pending.connector_level || pending.plan_missing || pending.identity_denied);
  if (!permissionRecovery && ready()) return;
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
    if (pending?.identity_denied && !pending.connector_level && !pending.scopes.length && !pending.pat_scopes?.length) {
      permissions.recordWecomIdentityCheck(env, pending);
    } else if (permissionRecovery) throw new Error('requested permissions could not be verified');
    return;
  }
  if (loginError) throw loginError;
  throw new Error('official CLI authorization did not produce a verified identity');
}

function dingtalkPermissionPlan(output) {
  try {
    const receipt = JSON.parse(output);
    const data = receipt?.data || receipt?.result;
    if (receipt?.dry_run === true || receipt?.success !== true || typeof data?.allGranted !== 'boolean') return null;
    const pending = data.pendingScopes === undefined ? [] : data.pendingScopes;
    const skipped = data.skippedScopes === undefined ? [] : data.skippedScopes;
    if (![pending, skipped].every(scopes => Array.isArray(scopes) && scopes.every(permissions.isScopeName))) return null;
    return { complete: data.allGranted && !pending.length && !skipped.length,
      missing: [...new Set([...pending, ...skipped])] };
  } catch { return null; }
}

function dingtalkPlanArgs(manifest) {
  return ['pat', 'chmod', '--domains', manifest.domains.join(','), '--grant-type', 'permanent', '--dry-run', '--format', 'json'];
}

function checkDingtalkPermissions(node, npxCli, manifest, env, runner = spawnSync) {
  const pending = permissions.readPermissionRequest(env);
  const result = runner(node, [npxCli, '--offline', '-y', manifest.package, ...dingtalkPlanArgs(manifest)], {
    cwd: env.ORKAS_LOCAL_CLI_WORK_DIR, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0) return false;
  const plan = dingtalkPermissionPlan(String(result.stdout || ''));
  if (!plan) return false;
  permissions.recordDingtalkPermissionCheck(env, pending, plan, manifest.domains);
  return true;
}

function dingtalkBatchProductUnavailable(error) {
  // DWS 1.0.61 prints API failures through errors.PrintJSON on stderr.
  // Only this exact PAT planning code is a capability gap. Process cancellation,
  // network errors, prose and nested business data cannot establish that fact.
  if (error?.exitCode !== 1 || error.signal || typeof error.stderr !== 'string'
    || error.stderr.length > 64 * 1024) return false;
  try {
    const receipt = JSON.parse(error.stderr);
    const body = receipt?.error;
    return receipt?.success !== true && receipt?.ok !== true
      && body?.code === 1 && body.category === 'api' && body.server_key === 'pat'
      && body.server_error_code === 'PAT_BATCH_PRODUCT_NOT_FOUND';
  } catch { return false; }
}

// Identity and PAT grants are separate. Use the pinned domain batch route for
// initial consent; never treat repeating OAuth login as a full PAT receipt.
async function authorizeDingtalk(node, npxCli, manifest, env, dependencies = {}) {
  const execute = dependencies.execute
    || ((args, capture = false) => run(node, npxCli, manifest.package, args, env, false, true, capture));
  const ready = dependencies.authorizationReady
    || (() => dingtalkAuthorizationReady(node, npxCli, manifest, env));
  const pending = permissions.readPermissionRequest(env);
  // Always enter official authorization when explicitly requested, including
  // cached administrator restrictions. There is no Orkas pre-authorization gate.
  await execute(manifest.login(env)[0]);
  if (!ready()) throw new Error('official CLI authorization did not produce a verified identity');
  const scopes = pending?.pat_scopes || [];
  const grantArgs = ['pat', 'chmod', ...scopes, '--domains', manifest.domains.join(','), '--grant-type', 'permanent', '--yes'];
  let grantError;
  let output;
  try {
    // One consent execution supplies both interactive output and a structured
    // receipt; do not repeat the grant merely to change its presentation.
    output = await execute([...grantArgs, '--format', 'json'], 'tee');
  } catch (error) { grantError = error; }
  if (dingtalkBatchProductUnavailable(grantError)) {
    const current = permissions.readPermissionRequest(env);
    permissions.recordDingtalkPermissionCheck(env, current,
      { complete: false, missing: [] }, manifest.domains);
    if (!ready()) throw new Error('official CLI authorization did not produce a verified identity');
    const outstanding = permissions.readPermissionRequest(env);
    // Initial connection may retain a verified partial identity. An explicit
    // outstanding scope/identity recovery still has not been satisfied.
    if (!outstanding?.plan_missing || outstanding.scopes.length || outstanding.pat_scopes?.length || outstanding.connector_level
      || outstanding?.identity_denied || outstanding?.unresolved_access) throw grantError;
    return;
  }
  let receipt;
  try { receipt = JSON.parse(output); } catch { /* no verified receipt */ }
  const denial = permissions.structuredPermissionFailure({ status: 1,
    stdout: grantError?.stdout || output || '', stderr: grantError?.stderr || '' }, 'dingtalk');
  if (denial) permissions.rememberPermissionRequest(denial, env);
  if (grantError && !denial) throw grantError;
  const data = receipt?.data || receipt?.result;
  const granted = [...(Array.isArray(data?.grantedScopes) ? data.grantedScopes : []),
    ...(Array.isArray(data?.alreadyGrantedScopes) ? data.alreadyGrantedScopes : [])].filter(permissions.isScopeName);
  if (pending && receipt?.success === true) permissions.recordPatScopeGrant(env, pending, granted);
  const expected = permissions.readPermissionRequest(env);
  let planOutput;
  try { planOutput = await execute(dingtalkPlanArgs(manifest), true); }
  catch { /* A failed read-only check cannot erase known evidence. */ }
  const plan = dingtalkPermissionPlan(planOutput);
  if (plan) permissions.recordDingtalkPermissionCheck(env, expected, plan, manifest.domains);
  // Confirmed permission denial can leave a usable partial identity. A cancel,
  // network failure or other error remains a failed authorization attempt.
  if (pending && (pending.scopes.length || (pending.unresolved_access && pending.connector_level))) {
    throw new Error('requested permissions could not be verified');
  }
  if (pending && !plan?.complete && (receipt?.success !== true || !scopes.every(scope => granted.includes(scope)))) {
    throw new Error('requested permissions are still unavailable');
  }
}

async function authorizeLark(node, npxCli, manifest, env, dependencies = {}) {
  if (manifest.package && manifest.package !== larkPermissionContract.package) {
    throw new Error('local CLI permission contract pin mismatch');
  }
  const execute = dependencies.execute
    || ((args) => run(node, npxCli, manifest.package, args, env, false, true, 'tee'));
  const profileConfigured = dependencies.profileConfigured
    || (() => commandSucceeds(node, npxCli, manifest,
      ['config', 'show', '--profile', env.ORKAS_LOCAL_CLI_PROFILE], env));
  const authorizationReady = dependencies.authorizationReady
    || (() => larkAuthorizationReady(node, npxCli, manifest, env));
  const authorizationScopes = dependencies.authorizationScopes
    || (() => larkUserScopes(node, npxCli, manifest, env));
  const pending = permissions.readPermissionRequest(env);
  const ready = authorizationReady();
  const commands = manifest.login(env);
  let identityBeforeLogin = ready;
  if (!ready && !profileConfigured()) {
    await execute(commands[0]);
    identityBeforeLogin = authorizationReady();
  }
  // Connect/Reauthorize is an explicit full request, even for a valid old
  // identity. Page-entry checks never enter this interactive driver.
  const existing = identityBeforeLogin ? authorizationScopes() : [];
  if (identityBeforeLogin && !existing) throw new Error('current user permissions could not be verified');
  const requested = [...new Set([...larkRequiredScopes(env), ...(existing || []), ...(pending?.scopes || [])])].sort();
  const args = [...commands[1]];
  const scopeIndex = args.indexOf('--scope');
  if (scopeIndex >= 0) args[scopeIndex + 1] = requested.join(' ');
  else args.push('--scope', requested.join(' '));
  args.push('--json');
  let output;
  let loginError;
  try { output = await execute(args); }
  catch (error) { loginError = error; output = error.stdout; }
  const completed = String(output || '').split('\n').some(line => {
    try {
      const receipt = JSON.parse(line);
      return receipt.event === 'authorization_complete' && Array.isArray(receipt.requested)
        && receipt.requested.every(permissions.isScopeName) && requested.every(scope => receipt.requested.includes(scope))
        && Array.isArray(receipt.granted) && receipt.granted.every(permissions.isScopeName);
    }
    catch { return false; }
  });
  if (!authorizationReady()) {
    if (loginError) throw loginError;
    throw new Error('official CLI authorization did not produce a verified user identity');
  }
  // A cancelled recovery with an old valid token is not a new authorization.
  // The pinned CLI emits authorization_complete even for nonzero partial grants.
  if (loginError && !completed) throw loginError;
  const granted = authorizationScopes();
  if (granted) permissions.recordUserScopeCheck(env, larkScopeEvidence(env, granted), pending, requested);
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
    const verified = provider === 'lark' ? checkLarkPermissions(node, npxCli, manifest, process.env)
      : provider === 'dingtalk' ? checkDingtalkPermissions(node, npxCli, manifest, process.env)
        : provider === 'wecom' ? checkWecomPermissions(node, npxCli, manifest, process.env) : true;
    if (!verified) {
      throw new Error('local CLI permission verification unavailable');
    }
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
  checkDingtalkPermissions,
  checkWecomPermissions,
  dingtalkPermissionPlan,
  larkRequiredScopes,
  larkScopeEvidence,
  main,
  run,
  verifyRegistryIntegrity,
  wecomAuthorizationReady,
  writeIntegrityMarker,
};

if (require.main === module) {
  main().catch(fail);
}
