'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// OAuth scope identifiers are case-sensitive protocol data. DingTalk uses names
// such as Contact.User.Read; preserve their spelling, including uppercase letters.
function isScopeName(value) {
  return typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,255}$/.test(value);
}

// Device-local reauthorization requests shared by official CLI providers.
// Preserve the legacy filename/profile reader; empty scope lists require an
// explicit reauthorize marker. Business calls never log in or replay themselves.
const MAX_PENDING_SCOPES = 50;
function permissionRequestPath(env) {
  return path.isAbsolute(env.ORKAS_LOCAL_CLI_RUNTIME_DIR || '') && env.ORKAS_LOCAL_CLI_PROFILE
    ? path.join(env.ORKAS_LOCAL_CLI_RUNTIME_DIR, '.orkas-user-permissions.json') : null;
}

function readPermissionRequest(env) {
  const file = permissionRequestPath(env);
  if (!file) return null;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 16 * 1024) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.profile !== env.ORKAS_LOCAL_CLI_PROFILE || !Array.isArray(value.scopes)
        || (!value.scopes.length && value.reauthorize !== true) || value.scopes.length > MAX_PENDING_SCOPES
        || !value.scopes.every(isScopeName)
        || (value.pat_scopes !== undefined && (!Array.isArray(value.pat_scopes)
          || value.pat_scopes.length > MAX_PENDING_SCOPES || !value.pat_scopes.every(isScopeName)))) return null;
    return value;
  } catch { return null; }
}

function rememberPermissionRequest(error, env) {
  const failure = error?.provider_error;
  if (error?.code !== 'connector_permission_denied' && failure?.type !== 'authorization') return;
  // Only confirmed user scopes can be requested by Lark's user-login flow.
  const scopes = failure?.identity === 'user' && Array.isArray(failure.missing_scopes)
    ? failure.missing_scopes.filter(isScopeName) : [];
  const patScopes = failure?.identity === 'pat' && Array.isArray(failure.missing_scopes)
    ? failure.missing_scopes.filter(isScopeName) : [];
  const file = permissionRequestPath(env);
  if (!file) return;
  const prior = readPermissionRequest(env);
  const value = { profile: env.ORKAS_LOCAL_CLI_PROFILE, reauthorize: true, revision: randomUUID(), scopes: [...new Set([...(prior?.scopes || []), ...scopes])].sort(),
    unresolved_access: prior?.unresolved_access === true || (scopes.length === 0 && patScopes.length === 0) };
  if (patScopes.length || prior?.pat_scopes?.length) value.pat_scopes = [...new Set([...(prior?.pat_scopes || []), ...patScopes])].sort();
  if (failure?.admin_required || prior?.admin_required) value.admin_required = true;
  // A large provider scope list must not suppress the recovery entry. Use the
  // normal authorization flow when an explicit request exceeds this bound.
  if (value.scopes.length > MAX_PENDING_SCOPES) value.scopes = [];
  if (value.pat_scopes?.length > MAX_PENDING_SCOPES) { value.pat_scopes = []; value.unresolved_access = true; }
  if (value.scopes.length + (value.pat_scopes?.length || 0) > MAX_PENDING_SCOPES) {
    value.scopes = []; value.pat_scopes = []; value.unresolved_access = true;
  }
  if (writePermissionRequest(file, value) && failure) failure.recovery = 'reauthorize';
}

function writePermissionRequest(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
    return true;
  } catch {
    // Preserve the provider failure when local persistence is unavailable.
  } finally {
    try { fs.unlinkSync(temp); } catch { /* no temporary request remains */ }
  }
}

// A token-scope check cannot establish resource visibility or administrator access.
// Do not overwrite a newer business denial observed while the check was running.
function recordUserScopeCheck(env, granted, expected, required) {
  if (!Array.isArray(granted) || !granted.every(isScopeName)) return;
  if (JSON.stringify(readPermissionRequest(env)) !== JSON.stringify(expected)) return;
  const scopes = [...new Set([...(expected?.scopes || []), ...required])].filter(scope => !granted.includes(scope)).sort();
  const unresolved = expected?.unresolved_access === true || (expected && !expected.scopes.length);
  if (!scopes.length && !unresolved) {
    clearPermissionRequest(env, expected);
    return;
  }
  const file = permissionRequestPath(env);
  if (!file || (expected && JSON.stringify(expected.scopes) === JSON.stringify(scopes))) return;
  writePermissionRequest(file, { profile: env.ORKAS_LOCAL_CLI_PROFILE, reauthorize: true,
    revision: randomUUID(), scopes: scopes.length > MAX_PENDING_SCOPES ? [] : scopes,
    unresolved_access: !!unresolved || scopes.length > MAX_PENDING_SCOPES });
}

function clearPermissionRequest(env, expected) {
  const current = readPermissionRequest(env);
  if (current && JSON.stringify(current) === JSON.stringify(expected)) fs.unlinkSync(permissionRequestPath(env));
}

function recordPatScopeGrant(env, expected, granted) {
  if (JSON.stringify(readPermissionRequest(env)) !== JSON.stringify(expected)) return;
  const remaining = (expected.pat_scopes || []).filter(scope => !granted.includes(scope));
  if (!remaining.length && !expected.scopes.length && !expected.unresolved_access) {
    clearPermissionRequest(env, expected);
  } else {
    writePermissionRequest(permissionRequestPath(env), { ...expected, pat_scopes: remaining, revision: randomUUID() });
  }
}


// Inspect only failed protocol envelopes, never business data or error prose.
function structuredPermissionFailure(result, provider) {
  if (result.error) return null;
  const denied = new Set(['authorization', 'permission', 'permission_denied', 'insufficient_scope',
    'missing_scope', 'token_scope_insufficient', 'app_scope_not_applied', 'access_denied', 'forbidden',
    'http_403', 'AuthError', 'PermissionError']);
  let found = false;
  let detail = {};
  for (const stream of [result.stderr, result.stdout]) {
    let payload;
    try { payload = JSON.parse(stream); } catch { continue; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    // DWS 1.0.61 also emits its frozen PAT permission channel without an
    // error wrapper. Do not inspect arbitrary data or authorization URLs.
    if (provider === 'dingtalk' && payload.success === false && [
      'PAT_NO_PERMISSION', 'PAT_LOW_RISK_NO_PERMISSION', 'PAT_MEDIUM_RISK_NO_PERMISSION',
      'PAT_HIGH_RISK_NO_PERMISSION', 'PAT_ORG_POLICY_DENIED', 'PAT_SCOPE_AUTH_REQUIRED', 'PAT_BATCH_AUTH_PENDING',
    ].includes(payload.code)) {
      found = true;
      const oauth = payload.code === 'PAT_SCOPE_AUTH_REQUIRED';
      const data = payload.data;
      const candidates = oauth ? [data?.missingScope] : [data?.scope, ...(Array.isArray(data?.scopes) ? data.scopes : [])];
      // The OAuth channel includes the affected identity; its code alone does
      // not establish that user consent can grant this permission.
      const identity = oauth ? (['user', 'bot', 'tenant'].includes(data?.identity) ? data.identity : undefined) : 'pat';
      detail = { ...(identity ? { identity } : {}), missing_scopes: [...new Set(candidates.filter(isScopeName))],
        ...(payload.code === 'PAT_ORG_POLICY_DENIED' ? { admin_required: true } : {}) };
      break;
    }
    const body = payload.error;
    if (!body || typeof body !== 'object' || Array.isArray(body)) continue;
    if (payload.ok === true || payload.success === true) continue;
    if (result.status === 0 && payload.ok !== false && payload.success !== false && payload.outcome !== 'failure') continue;
    found = [body.type, body.subtype, body.code].some(value => denied.has(value))
      || body.http_status === 403 || body.statusCode === 403;
    // Xero 0.0.7 sanitizes API responses into this fixed status-bearing format.
    if (provider === 'xero' && /^Xero API error \(403\)(?::|$)/.test(body.message || '')) found = true;
    if (found) break;
  }
  if (!found && provider === 'xero' && result.status !== 0) {
    found = /^(?:\s*Error:\s*)?Xero API error \(403\)(?::|\s*$)/m.test(result.stderr || '');
  }
  return found ? Object.assign(new Error('connector permission is insufficient; reauthorize this connector'), {
    code: 'connector_permission_denied', provider_error: { type: 'authorization', ...detail },
  }) : null;
}

module.exports = { isScopeName, readPermissionRequest, rememberPermissionRequest, clearPermissionRequest, recordUserScopeCheck, recordPatScopeGrant, structuredPermissionFailure };
