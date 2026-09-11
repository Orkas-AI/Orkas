#!/usr/bin/env node
'use strict';

/** Governed MCP facade over official provider CLIs.
 *
 * The facade deliberately exposes six stable tools rather than a raw command runner. Every
 * action must belong to a reviewed business domain, is classified against provider schema/help,
 * and can only pass through the matching read/write/high-impact/destructive tool.
 */
const { spawn } = require('node:child_process');
const { killProcessTree } = require('./bridge-skill-runner.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const larkContract = require('./local-cli-lark.cjs');
const permissions = require('./local-cli-permissions.cjs');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const MANIFESTS = Object.freeze({
  wecom: Object.freeze({
    package: '@wecom/cli@1.2.0',
    integrity: 'sha512-GaVCie2We3EWrOiIYlXp5FpjznikbS1oShFyZjIz2uDDdQlkbA8CJzjhzrAzRgIDU/oaxpmEucp9WHN/yiuzuQ==',
    executable: 'wecom-cli',
    domains: Object.freeze([
      'calendar', 'chat', 'contact', 'disk', 'doc', 'identity', 'mail', 'media', 'message',
      'meeting', 'sheet', 'smartpage', 'smartsheet', 'todo',
    ]),
    status: () => ['auth', 'show', '--status'],
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
    status: (env) => ['auth', 'status', '--profile', env.ORKAS_LOCAL_CLI_PROFILE],
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
    status: () => ['auth', 'status', '--format', 'json'],
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
    status: (env) => ['org', 'details', '--profile', env.ORKAS_LOCAL_CLI_PROFILE, '--json'],
  }),
});

const TOOL_POLICIES = Object.freeze({
  list_capabilities: Object.freeze({ risk: 'R', confirmation: 'none', maxBatchSize: 100 }),
  describe_action: Object.freeze({ risk: 'R', confirmation: 'none', maxBatchSize: 1 }),
  execute_read: Object.freeze({ risk: 'R', confirmation: 'none', maxBatchSize: 100 }),
  execute_write: Object.freeze({ risk: 'W', confirmation: 'preview', maxBatchSize: 25 }),
  execute_high_impact: Object.freeze({ risk: 'H', confirmation: 'fresh', maxBatchSize: 10, sensitiveOperation: 'external_or_workflow_change' }),
  execute_destructive: Object.freeze({ risk: 'D', confirmation: 'destructive', maxBatchSize: 10, sensitiveOperation: 'destructive' }),
});

const ACTION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    action: {
      type: 'string',
      description: 'Canonical provider action, for example calendar.events.list or todo task create. Call describe_action first.',
    },
    parameters: {
      type: 'object',
      description: 'Named parameters from describe_action. Local file inputs require absolute paths in Orkas-approved roots; raw CLI flags and output paths are rejected.',
      additionalProperties: true,
    },
  },
  required: ['action'],
  additionalProperties: false,
});

function tool(name, description, inputSchema, annotations) {
  const policy = TOOL_POLICIES[name];
  return {
    name,
    description,
    inputSchema,
    annotations,
    _meta: { orkas: { actionPolicy: policy } },
  };
}

const TOOLS = Object.freeze([
  tool('list_capabilities', 'List reviewed business domains, or progressively inspect the official schema under one returned domain or subgroup path.', {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Optional canonical domain or subgroup path returned by an earlier capability result.',
      },
    },
    additionalProperties: false,
  }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
  tool('describe_action', 'Inspect the official schema/help and Orkas risk classification for one action before executing it.', {
    type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: false,
  }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
  tool('execute_read', 'Execute a schema-verified read-only action.', ACTION_SCHEMA, {
    readOnlyHint: true, destructiveHint: false, openWorldHint: true,
  }),
  tool('execute_write', 'Execute a normal create/update action after preview confirmation.', ACTION_SCHEMA, {
    readOnlyHint: false, destructiveHint: false, openWorldHint: true,
  }),
  tool('execute_high_impact', 'Execute an externally visible communication, approval, sharing, publishing, or workflow action after fresh confirmation.', ACTION_SCHEMA, {
    readOnlyHint: false, destructiveHint: false, openWorldHint: true,
  }),
  tool('execute_destructive', 'Execute a delete/cancel/remove/revoke/withdraw action after destructive confirmation.', ACTION_SCHEMA, {
    readOnlyHint: false, destructiveHint: true, openWorldHint: true,
  }),
]);

const BLOCKED_ROOTS = new Set([
  'api', 'auth', 'config', 'doctor', 'event', 'extension', 'help', 'install', 'mcp',
  'openapi', 'plugin', 'profile', 'schema', 'skill', 'update', 'upgrade', 'version',
  'devapp', 'devdoc', 'pat',
]);
const BLOCKED_PARAMETER_KEYS = /^(?:app[_-]?secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|authorization|config|profile|cwd|directory|dir|output|output[_-]?(?:dir|file|path)|yes|dry[_-]?run)$/i;
const CREDENTIAL_PARAMETER_KEYS = /^(?:app[_-]?secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|api[_-]?key|password|cookie)$/i;
const LOCAL_INPUT_PARAMETER_KEYS = /^(?:file|file[_-]?path|input[_-]?file)$/i;
const DESTRUCTIVE_VERBS = new Set(['cancel', 'clear', 'delete', 'destroy', 'dismiss', 'purge', 'remove', 'reset', 'revoke', 'terminate', 'withdraw']);
const HIGH_IMPACT_VERBS = new Set(['approve', 'assign', 'broadcast', 'forward', 'invite', 'pay', 'publish', 'reject', 'reply', 'refund', 'send', 'share', 'submit', 'transfer']);
const WRITE_VERBS = new Set(['add', 'append', 'archive', 'complete', 'copy', 'create', 'edit', 'import', 'mark', 'move', 'patch', 'restore', 'set', 'start', 'stop', 'update', 'upload']);
const READ_VERBS = new Set(['check', 'count', 'download', 'export', 'find', 'get', 'info', 'instance_view', 'list', 'query', 'read', 'search', 'show', 'status', 'view']);
const MAX_OUTPUT_CHARS = 1024 * 1024;
const MAX_INPUT_CHARS = 256 * 1024;
const MAX_XERO_INPUT_FILE_BYTES = 8 * 1024 * 1024;
const XERO_READ_ACTIONS = new Set([
  'accounts.list', 'bank-transactions.list', 'contact-groups.list', 'contacts.list',
  'credit-notes.list', 'currencies.list', 'invoices.list', 'items.list',
  'manual-journals.list', 'org.details', 'payments.list', 'quotes.list',
  'reports.aged-payables', 'reports.aged-receivables', 'reports.balance-sheet',
  'reports.profit-and-loss', 'reports.trial-balance', 'tax-rates.list',
  'tracking.categories.list',
]);
const XERO_HIGH_IMPACT_ROOTS = new Set([
  'bank-transactions', 'credit-notes', 'invoices', 'manual-journals', 'payments', 'quotes',
]);

function configuredManifest(env = process.env) {
  const provider = String(env.ORKAS_LOCAL_CLI_PROVIDER || '');
  const manifest = MANIFESTS[provider];
  if (!manifest) throw new Error('unsupported local CLI provider');
  if (env.ORKAS_LOCAL_CLI_PACKAGE !== manifest.package) throw new Error('local CLI package pin mismatch');
  if (env.ORKAS_LOCAL_CLI_PACKAGE_INTEGRITY !== manifest.integrity) throw new Error('local CLI package integrity mismatch');
  if (env.ORKAS_LOCAL_CLI_EXECUTABLE !== manifest.executable) throw new Error('local CLI executable mismatch');
  let configuredDomains;
  try { configuredDomains = JSON.parse(env.ORKAS_LOCAL_CLI_ALLOWED_DOMAINS_JSON || '[]'); }
  catch { configuredDomains = []; }
  if (JSON.stringify(configuredDomains) !== JSON.stringify(manifest.domains)) {
    throw new Error('local CLI domain policy mismatch');
  }
  if (!env.ORKAS_NODE || !env.ORKAS_LOCAL_CLI_NPX_CLI || !env.ORKAS_LOCAL_CLI_RUNTIME_DIR
      || path.resolve(String(env.ORKAS_LOCAL_CLI_WORK_DIR || '')) !== path.join(env.ORKAS_LOCAL_CLI_RUNTIME_DIR, 'work')) {
    throw new Error('local CLI runtime is incomplete');
  }
  return { provider, ...manifest };
}

function assertPackageIntegrityMarker(manifest, env = process.env) {
  const marker = String(env.ORKAS_LOCAL_CLI_INTEGRITY_MARKER || '');
  const runtimeDir = String(env.ORKAS_LOCAL_CLI_RUNTIME_DIR || '');
  if (!marker || path.dirname(marker) !== runtimeDir) throw new Error('local CLI integrity marker is unavailable; reconnect this connector');
  let recorded;
  try { recorded = JSON.parse(fs.readFileSync(marker, 'utf8')); }
  catch { throw new Error('local CLI package integrity is unverified; reconnect this connector'); }
  if (recorded?.package !== manifest.package || recorded?.integrity !== manifest.integrity) {
    throw new Error('local CLI package integrity pin changed; reconnect this connector');
  }
}

function actionTokens(value) {
  const action = String(value || '').trim();
  if (!action || action.length > 240 || action.startsWith('-') || !/^[A-Za-z0-9_+.-]+(?:[ .][A-Za-z0-9_+.-]+)*$/.test(action)) {
    throw new Error('invalid action; use the canonical action returned by describe_action');
  }
  const tokens = action.split(/[. ]+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 12) throw new Error('action must include a domain and operation');
  return tokens;
}

function capabilityTokens(value) {
  const candidate = String(value || '').trim();
  if (!candidate || candidate.length > 240 || candidate.startsWith('-') || !/^[A-Za-z0-9_+.-]+(?:[ .][A-Za-z0-9_+.-]+)*$/.test(candidate)) {
    throw new Error('invalid capability path; use a domain or subgroup returned by list_capabilities');
  }
  const tokens = candidate.split(/[. ]+/).filter(Boolean);
  if (tokens.length < 1 || tokens.length > 11) throw new Error('capability path is too deep');
  return tokens;
}

function validateCapabilityPath(value, env = process.env) {
  const manifest = configuredManifest(env);
  const tokens = capabilityTokens(value);
  if (tokens.some((token) => token.startsWith('-'))) throw new Error('raw CLI flags are not allowed in capability path');
  const root = tokens[0].toLowerCase();
  if (BLOCKED_ROOTS.has(root) || !manifest.domains.includes(root)) {
    throw new Error(`capability domain is not allowed: ${root}`);
  }
  return { manifest, tokens, canonical: tokens.join('.'), cliPath: tokens.join(' ') };
}

function validateAction(action, env = process.env) {
  const manifest = configuredManifest(env);
  const tokens = actionTokens(action);
  const root = tokens[0].toLowerCase();
  if (BLOCKED_ROOTS.has(root) || !manifest.domains.includes(root)) {
    throw new Error(`action domain is not allowed: ${root}`);
  }
  if (tokens.some((token) => token.startsWith('-'))) throw new Error('raw CLI flags are not allowed in action');
  return { manifest, tokens, canonical: tokens.join('.'), cliPath: tokens.join(' ') };
}

function riskFromMetadata(value) {
  const seen = new Set();
  const risks = new Set();
  function visit(node) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const [childKey, child] of Object.entries(node)) {
      const normalizedKey = String(childKey).toLowerCase();
      if (/^(?:risk|effect|confirmation|side_effect|operation_type)$/.test(normalizedKey)) {
        const text = String(child).toLowerCase();
        if (/destructive|delete|danger/.test(text)) risks.add('D');
        else if (/high|sensitive|external/.test(text)) risks.add('H');
        else if (/write|mutat|create|update|medium/.test(text)) risks.add('W');
        else if (/read|none|safe|low/.test(text)) risks.add('R');
      }
      visit(child);
    }
  }
  visit(value);
  return ['D', 'H', 'W', 'R'].find((risk) => risks.has(risk)) || '';
}

function classifyAction(action, schema) {
  const metadataRisk = riskFromMetadata(schema);
  const tokens = actionTokens(action).flatMap((token) => token
    .replace(/^\+/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_+-]+/)
    .filter(Boolean));
  let actionRisk = '';
  for (const token of tokens) if (DESTRUCTIVE_VERBS.has(token)) actionRisk = 'D';
  if (!actionRisk) for (const token of tokens) if (HIGH_IMPACT_VERBS.has(token)) actionRisk = 'H';
  if (!actionRisk) for (const token of tokens) if (WRITE_VERBS.has(token)) actionRisk = 'W';
  for (let index = tokens.length - 1; index >= 1; index--) {
    const token = tokens[index];
    if (!actionRisk && (READ_VERBS.has(token) || /^(?:list|get|read|search|find|query|show|check|view)/.test(token))) {
      actionRisk = 'R';
    }
  }
  if (metadataRisk && actionRisk) {
    const rank = { R: 1, W: 2, H: 3, D: 4 };
    return rank[metadataRisk] >= rank[actionRisk] ? metadataRisk : actionRisk;
  }
  if (metadataRisk || actionRisk) return metadataRisk || actionRisk;
  // Unknown verbs fail into the confirmation-heavy lane rather than being mistaken for reads.
  return 'H';
}

function classifyXeroAction(action) {
  const canonical = actionTokens(action).join('.').toLowerCase();
  if (XERO_READ_ACTIONS.has(canonical)) return 'R';
  const tokens = canonical.split('.');
  if (XERO_HIGH_IMPACT_ROOTS.has(tokens[0]) && ['create', 'update'].includes(tokens.at(-1))) return 'H';
  if (['create', 'update'].includes(tokens.at(-1))) return 'W';
  return 'H';
}

function containsDestructiveStatus(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (/status/i.test(key) && /^(?:archived|deleted|voided)$/i.test(String(child))) return true;
    if (containsDestructiveStatus(child, seen)) return true;
  }
  return false;
}

function xeroInputHasDestructiveStatus(filePath) {
  let failure = 'Xero input file could not be fully checked; use a readable UTF-8 JSON file with a simpler structure and try again';
  const oversized = 'Xero input file exceeds 8 MiB; reduce the file size and try again';
  try {
    // Nonblocking open plus fstat rejects non-files without waiting on a FIFO.
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error();
      if (stat.size > MAX_XERO_INPUT_FILE_BYTES) {
        failure = oversized;
        throw new Error();
      }
      // One extra byte detects overflow even if the file grew after fstat.
      const bytes = Buffer.allocUnsafe(MAX_XERO_INPUT_FILE_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = fs.readSync(fd, bytes, { offset: length, length: bytes.length - length, position: null });
        if (read === 0) break;
        length += read;
      }
      if (length > MAX_XERO_INPUT_FILE_BYTES) {
        failure = oversized;
        throw new Error();
      }
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
        .decode(bytes.subarray(0, length));
      return containsDestructiveStatus(JSON.parse(text));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Do not expose filesystem paths, JSON excerpts or decoder errors.
    throw new Error(failure);
  }
}

function invocationRisk(baseRisk, parameters, env = process.env, inspection) {
  const validated = validatedParameters(parameters, env, inspection);
  if (env.ORKAS_LOCAL_CLI_PROVIDER === 'xero') {
    let risk = containsDestructiveStatus(validated) ? 'D' : baseRisk;
    for (const [key, value] of Object.entries(validated)) {
      if (!LOCAL_INPUT_PARAMETER_KEYS.test(key)) continue;
      // Check every file even when another parameter already requires D.
      if (xeroInputHasDestructiveStatus(value)) risk = 'D';
    }
    return risk;
  }
  if (containsDestructiveStatus(validated)) return 'D';
  for (const [key, value] of Object.entries(validated)) {
    if (!LOCAL_INPUT_PARAMETER_KEYS.test(key) || typeof value !== 'string' || /^https:\/\//i.test(value)) continue;
    try {
      const stat = fs.statSync(value);
      if (!stat.isFile() || stat.size > MAX_INPUT_CHARS) continue;
      const payload = JSON.parse(fs.readFileSync(value, 'utf8'));
      if (containsDestructiveStatus(payload)) return 'D';
    } catch { /* The official CLI reports malformed or unreadable payloads after path validation. */ }
  }
  return baseRisk;
}

function allowedFileRoots(env) {
  try {
    const parsed = JSON.parse(env.ORKAS_LOCAL_CLI_ALLOWED_FILE_ROOTS_JSON || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((item) => typeof item === 'string' && path.isAbsolute(item)).map((item) => {
        try { return fs.realpathSync(item); } catch { return path.resolve(item); }
      })
      : [];
  } catch { return []; }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Normalize provider parameter contracts at one boundary. Neither action names
// nor path-looking literal values determine whether the CLI may read a file.
function parameterSchema(inspection) {
  const schema = inspection?.schema || {};
  if (inspection?.provider === 'wecom') return schema.schemas?.[schema.request?.$ref] || schema.request || {};
  if (inspection?.provider === 'dingtalk') return { type: 'object', properties: schema.parameters || {} };
  return schema.inputSchema || {};
}

function fileContract(property, provider) {
  const description = typeof property?.description === 'string' ? property.description : '';
  // Pinned Lark shortcut help is its official introspection format; API methods
  // and WeCom expose binary markers, while DWS also exposes format/input facts.
  const localPath = property?.format === 'binary' || property?.format === 'file-path'
    || property?.['x-wecom-octet-stream'] === true
    || (provider === 'lark' && (description.includes('cwd-relative local path') || description.startsWith('local file path')))
    || (provider === 'dingtalk' && description.startsWith('本地文件路径'));
  const reference = (Array.isArray(property?.input) && property.input.includes('file')) || description.includes('supports @file')
    || (provider === 'dingtalk' && (property?.format === 'json' || description.includes('@file')));
  return {
    localPath, reference,
    url: localPath && description.includes('URL'),
    keyPrefixes: localPath ? ['file', 'img'].filter(prefix => description.includes(`${prefix}_xxx`)) : [],
  };
}

function localInputs(value, env, inspection) {
  const inputs = [];
  const provider = env.ORKAS_LOCAL_CLI_PROVIDER;
  const root = parameterSchema(inspection);
  function visit(raw, property, keys) {
    if (property?.$ref && provider === 'wecom') property = inspection?.schema?.schemas?.[property.$ref] || property;
    const contract = fileContract(property, provider);
    if (Array.isArray(raw)) {
      if (property?.type === 'object') throw new Error('object parameter requires an object');
      raw.forEach((item, index) => visit(item, { ...property, ...property?.items, type: property?.items?.type }, [...keys, index]));
      return;
    }
    if (property?.type === 'object') {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('object parameter requires an object');
      if (property.carrier === '--file') {
        for (const field of property.required || []) {
          if (!Object.hasOwn(raw, field)) throw new Error(`missing binary file field: ${field}`);
        }
        if (Object.keys(raw).some(field => property.properties?.[field]?.format !== 'binary')) {
          throw new Error('unknown binary file field');
        }
      }
      for (const [field, child] of Object.entries(raw)) visit(child, property.properties?.[field], [...keys, field]);
      return;
    }
    if (contract.localPath) {
      if (typeof raw === 'string' && ((contract.url && /^https:\/\//i.test(raw))
        || contract.keyPrefixes.some(prefix => new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(raw)))) return;
      inputs.push({ keys, value: raw });
      return;
    }
    if (typeof raw === 'string' && contract.reference) {
      if (raw === '-' || raw === '@-') throw new Error('stdin input is not available through this connector');
      if (raw.startsWith('@')) inputs.push({ keys, value: raw.slice(1), prefix: '@' });
      return;
    }
    // DWS has legacy @file readers that are absent from some leaf contracts.
    // Fail closed for their ASCII file-reference syntax; literal mentions stay text.
    if (typeof raw === 'string' && provider === 'dingtalk' && /^@[A-Za-z0-9./~_-]/.test(raw)) {
      throw new Error('indirect file input is not declared by this action; use inline content');
    }
    // Xero's existing full-JSON input inspection also serves callers that have
    // no introspection result yet. Do not infer files from arbitrary strings.
    if ((!inspection || provider === 'xero') && LOCAL_INPUT_PARAMETER_KEYS.test(String(keys.at(-1)))) {
      if (typeof raw === 'string' && /^https:\/\//i.test(raw)) return;
      inputs.push({ keys, value: raw });
    }
  }
  for (const [key, raw] of Object.entries(value)) {
    const property = root.properties?.[key] || root.properties?.[key.replace(/-/g, '_')]
      || root.properties?.[key.replace(/_/g, '-')];
    visit(raw, property, [key]);
  }
  return inputs;
}

function approvedInputPath(input, env) {
  if (typeof input !== 'string') throw new Error('local input parameter must be a path or HTTPS URL');
  let candidate;
  let stat;
  try { candidate = fs.realpathSync(input); stat = fs.statSync(candidate); }
  catch { throw new Error('local input file does not exist'); }
  if (!path.isAbsolute(input) || !allowedFileRoots(env).some((root) => isWithin(root, candidate))) {
    throw new Error('local input path is outside Orkas-approved roots');
  }
  if (env.ORKAS_LOCAL_CLI_PROVIDER !== 'xero' && !stat.isFile()) {
    throw new Error('local input must be a regular file');
  }
  return candidate;
}

function validatedParameters(value, env = process.env, inspection) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('parameters must be an object');
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_INPUT_CHARS) throw new Error('parameters are too large');
  const seen = new Set();
  function rejectNestedCredentials(node) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const [key, child] of Object.entries(node)) {
      if (CREDENTIAL_PARAMETER_KEYS.test(key)) {
        throw new Error(`credential parameter is not allowed: ${key}`);
      }
      rejectNestedCredentials(child);
    }
  }
  rejectNestedCredentials(value);
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error('too many parameters');
  const out = {};
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(key) || BLOCKED_PARAMETER_KEYS.test(key)) {
      throw new Error(`parameter is not allowed: ${key}`);
    }
    if (raw === undefined || typeof raw === 'function' || typeof raw === 'symbol') {
      throw new Error(`invalid parameter value: ${key}`);
    }
    out[key] = raw;
  }
  for (const input of localInputs(out, env, inspection)) approvedInputPath(input.value, env);
  return out;
}

async function prepareLocalInputs(parameters, inspection, env, signal) {
  const inputs = localInputs(parameters, env, inspection);
  // Xero reads absolute JSON input and owns full-payload destructive-state
  // inspection. Do not replace that existing contract with a binary upload path.
  if (!inputs.length || inspection.provider === 'xero') return { parameters, cleanup() {} };
  // Provider config trees contain credentials. Lark rejects every upload from
  // that tree, including runtime/work. Stage approved bytes in a private,
  // per-call OS temporary directory and remove it on every terminal outcome.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-cli-input-'));
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  const prepared = structuredClone(parameters);
  try {
    for (const [index, input] of inputs.entries()) {
      throwIfCancelled(signal);
      const source = approvedInputPath(input.value, env);
      const relative = path.join(String(index), path.basename(input.value));
      const destination = path.join(directory, relative);
      fs.mkdirSync(path.dirname(destination), { mode: 0o700 });
      // Bound host staging; stricter media-specific limits belong to the provider.
      const limit = input.prefix ? 8 * 1024 * 1024 : 5 * 1024 * 1024 * 1024;
      const reader = await fs.promises.open(source, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
      try {
        const stat = await reader.stat();
        if (!stat.isFile() || stat.size > limit) throw new Error('local input is not a regular file within the action size limit');
        const current = fs.statSync(source);
        if (approvedInputPath(source, env) !== source || current.dev !== stat.dev || current.ino !== stat.ino) {
          throw new Error('local input changed while opening');
        }
        const writer = await fs.promises.open(destination, 'wx', 0o600);
        try {
          const buffer = Buffer.alloc(1024 * 1024);
          let total = 0;
          while (true) {
            throwIfCancelled(signal);
            const { bytesRead } = await reader.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            total += bytesRead;
            if (total > limit) throw new Error('local input exceeds the action size limit');
            let offset = 0;
            while (offset < bytesRead) {
              const { bytesWritten } = await writer.write(buffer, offset, bytesRead - offset, null);
              if (!bytesWritten) throw new Error('local input staging failed');
              offset += bytesWritten;
            }
          }
          const after = await reader.stat();
          if (after.size !== total || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
            throw new Error('local input changed while copying');
          }
        } finally { await writer.close(); }
      } finally { await reader.close(); }
      let target = prepared;
      for (const key of input.keys.slice(0, -1)) target = target[key];
      target[input.keys.at(-1)] = `${input.prefix || ''}${relative}`;
    }
    return { parameters: prepared, cwd: directory, cleanup };
  } catch (error) {
    cleanup();
    if (error.code === 'E_TOOL_CALL_CANCELLED') throw error;
    throw new Error('local input could not be prepared; check file access and size');
  }
}

function parameterArgs(parameters) {
  const args = [];
  for (const [key, value] of Object.entries(parameters)) {
    const flag = `--${key.replace(/_/g, '-')}`;
    if (value === true) args.push(flag);
    else if (value === false) args.push(flag, 'false');
    else if (value === null) args.push(flag, 'null');
    else if (typeof value === 'object') args.push(flag, JSON.stringify(value));
    else args.push(flag, String(value));
  }
  return args;
}

function redact(value) {
  return String(value || '')
    .replace(/("(?:access|refresh|id)[_-]?token"|"client[_-]?secret"|"api[_-]?key"|"authorization"|"password")\s*:\s*"[^"]*"/gi, '$1:"[redacted]"')
    .replace(/([?&#](?:code|access_token|refresh_token|id_token|client_secret)=)[^&\s"'<>]+/gi, '$1[redacted]')
    .replace(/\b((?:access|refresh|id)[_-]?token|client[_-]?secret|api[_-]?key|authorization|password)\s*[:=]\s*[^\s"'<>]+/gi, '$1=[redacted]')
    .slice(0, MAX_OUTPUT_CHARS);
}

function throwIfCancelled(signal) {
  if (signal?.aborted) {
    if (signal.reason?.name === 'TimeoutError') throw Object.assign(new Error('local CLI call timed out'), { code: 'ETIMEDOUT' });
    throw Object.assign(new Error('local CLI call was cancelled'), { code: 'E_TOOL_CALL_CANCELLED' });
  }
}

function runOfficialProcess(command, args, options) {
  return new Promise((resolve) => {
    let child;
    let timer;
    let settled = false;
    let terminalError;
    const chunks = { stdout: [], stderr: [] };
    const bytes = { stdout: 0, stderr: 0 };
    const finish = (status, error = terminalError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      resolve({
        status, error,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8'),
      });
    };
    const terminate = (code) => {
      if (settled || terminalError) return;
      terminalError = Object.assign(new Error(code), { code });
      clearTimeout(timer);
      killProcessTree(child, 'SIGKILL');
      timer = setTimeout(() => finish(null), 3000);
      timer.unref?.();
    };
    const onAbort = () => terminate('E_TOOL_CALL_CANCELLED');
    try {
      throwIfCancelled(options.signal);
      child = spawn(command, args, {
        cwd: options.cwd, env: options.env,
        detached: process.platform !== 'win32', windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish(null, error);
      return;
    }
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', (data) => {
        if (settled || terminalError) return;
        const remaining = Math.max(0, options.maxBuffer - bytes[stream]);
        if (remaining) chunks[stream].push(data.subarray(0, remaining));
        bytes[stream] += Math.min(data.length, remaining);
        if (data.length > remaining) terminate('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      });
    }
    child.once('error', (error) => finish(null, error));
    child.once('close', (status) => finish(status));
    timer = setTimeout(() => terminate('ETIMEDOUT'), options.timeout);
    timer.unref?.();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

async function runOfficial(args, options = {}, env = process.env) {
  throwIfCancelled(options.signal);
  await options.onProgress?.();
  const manifest = configuredManifest(env);
  const runner = options.runner || runOfficialProcess;
  const result = await runner(env.ORKAS_NODE, [
    env.ORKAS_LOCAL_CLI_NPX_CLI, '--offline', '-y', manifest.package, ...args,
  ], {
    cwd: options.cwd || env.ORKAS_LOCAL_CLI_WORK_DIR,
    env,
    encoding: 'utf8',
    timeout: options.timeoutMs || 60_000,
    maxBuffer: MAX_OUTPUT_CHARS,
    windowsHide: true,
    signal: options.signal,
  });
  throwIfCancelled(options.signal);
  const stdout = redact(result.stdout);
  const permissionError = permissions.structuredPermissionFailure(result, manifest.provider);
  if (manifest.provider === 'lark' && !result.error) {
    const structured = larkContract.structuredFailure(result);
    if (structured && (structured.code === 'connector_permission_denied' || !permissionError)) {
      permissions.rememberPermissionRequest(structured, env);
      throw structured;
    }
  }
  if (permissionError) {
    permissions.rememberPermissionRequest(permissionError, env);
    throw permissionError;
  }
  if (result.error || result.status !== 0) {
    const rawFailure = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join('\n');
    const reconnect = manifest.provider !== 'lark' && /unauthori[sz]ed|not[_ -]?(?:logged|authenticated)|credential|login|reconnect|token expired/i
      .test(rawFailure);
    const failure = new Error(reconnect
      ? `official ${manifest.executable} account is not authorized; reconnect this connector`
      : `official ${manifest.executable} command failed${Number.isInteger(result.status) ? ` (exit ${result.status})` : ''}`);
    failure.code = reconnect ? 'connector_reconnect_required' : 'local_cli_action_failed';
    throw failure;
  }
  const text = stdout.trim();
  if (!text) return { ok: true };
  try { return JSON.parse(text); } catch { return { ok: true, output: text }; }
}

async function assertAuthorized(options = {}, env = process.env) {
  throwIfCancelled(options.signal);
  const manifest = configuredManifest(env);
  if (options.skipPackageIntegrityCheck !== true) assertPackageIntegrityMarker(manifest, env);
  if (env.ORKAS_LOCAL_CLI_SKIP_AUTH_CHECK === '1') return;
  const status = await runOfficial(manifest.status(env), { ...options, timeoutMs: 30_000 }, env);
  const normalized = JSON.stringify(status).toLowerCase();
  if (/unauthori[sz]ed|not[_ -]?(?:logged|authenticated)|"authenticated"\s*:\s*false|"authorized"\s*:\s*false/.test(normalized)) {
    throw new Error(`official ${manifest.executable} account is not authorized; reconnect this connector`);
  }
}

async function inspectAction(action, options = {}, env = process.env) {
  const validated = validateAction(action, env);
  let schema;
  if (validated.manifest.provider === 'wecom') {
    schema = await runOfficial([...validated.tokens, '--schema'], { ...options, timeoutMs: 30_000 }, env);
  } else if (validated.manifest.provider === 'lark') {
    if (validated.tokens.some((token) => token.startsWith('+'))) {
      const help = await runOfficial([...validated.tokens, '--help'], { ...options, timeoutMs: 30_000 }, env);
      schema = larkContract.shortcutSchema(help, validated.cliPath);
    } else {
      schema = larkContract.apiSchema(
        await runOfficial(['schema', validated.canonical], { ...options, timeoutMs: 30_000 }, env),
        validated.canonical,
      );
    }
  } else if (validated.manifest.provider === 'dingtalk') {
    schema = await runOfficial(['schema', '--cli-path', validated.cliPath, '--compact', '-f', 'json'], {
      ...options, timeoutMs: 30_000,
    }, env);
  } else {
    schema = await runOfficial([...validated.tokens, '--help'], { ...options, timeoutMs: 30_000 }, env);
  }
  return {
    provider: validated.manifest.provider,
    action: validated.canonical,
    cli_path: validated.manifest.provider === 'lark' ? schema.name : validated.cliPath,
    risk: validated.manifest.provider === 'xero'
      ? classifyXeroAction(validated.canonical)
      : classifyAction(validated.canonical, schema),
    schema,
  };
}

async function inspectCapabilities(pathValue, options = {}, env = process.env) {
  const validated = validateCapabilityPath(pathValue, env);
  let schema;
  if (validated.manifest.provider === 'wecom') {
    schema = await runOfficial([...validated.tokens, '--schema'], { ...options, timeoutMs: 30_000 }, env);
  } else if (validated.manifest.provider === 'lark') {
    if (validated.tokens.length === 1 || validated.tokens.some((token) => token.startsWith('+'))) {
      const help = await runOfficial([...validated.tokens, '--help'], { ...options, timeoutMs: 30_000 }, env);
      schema = larkContract.capabilityCommands(help, validated.cliPath);
    } else {
      schema = await runOfficial(['schema', validated.canonical], { ...options, timeoutMs: 30_000 }, env);
    }
  } else if (validated.manifest.provider === 'dingtalk') {
    schema = await runOfficial(['schema', validated.cliPath, '--compact', '-f', 'json'], {
      ...options, timeoutMs: 30_000,
    }, env);
  } else {
    schema = await runOfficial([...validated.tokens, '--help'], { ...options, timeoutMs: 30_000 }, env);
  }
  return {
    provider: validated.manifest.provider,
    path: validated.canonical,
    schema,
    guidance: 'Continue with a returned subgroup path, or pass an exact leaf action to describe_action.',
  };
}

function invocationFor(action, parameters, risk, env = process.env, inspection) {
  const validated = validateAction(action, env);
  const params = validatedParameters(parameters, env, inspection);
  return providerInvocation(validated, params, risk, env, inspection);
}

function providerInvocation(validated, params, risk, env, inspection) {
  const args = validated.manifest.provider === 'lark' && inspection
    ? [...inspection.cli_path.split(' '), ...larkContract.parameterArgs(params, inspection.schema)]
    : validated.manifest.provider === 'wecom'
    ? [...validated.tokens, '--json', JSON.stringify(params)]
    : [...validated.tokens, ...parameterArgs(params)];
  if (validated.manifest.provider === 'lark') {
    args.push('--profile', env.ORKAS_LOCAL_CLI_PROFILE, '--format', 'json');
    if (risk !== 'R' && inspection?.schema?._meta?.risk === 'high-risk-write') args.push('--yes');
  } else if (validated.manifest.provider === 'dingtalk') {
    args.push('--format', 'json');
    if (risk !== 'R') args.push('--yes');
  } else if (validated.manifest.provider === 'xero') {
    args.push('--profile', env.ORKAS_LOCAL_CLI_PROFILE, '--json');
  }
  return args;
}

async function executeAction(expectedRisk, args, options = {}, env = process.env) {
  const inspection = await inspectAction(args.action, options, env);
  let parameters = args.parameters;
  const effectiveRisk = invocationRisk(inspection.risk, parameters, env, inspection);
  if (effectiveRisk !== expectedRisk) {
    throw new Error(`action risk mismatch: ${inspection.action} is ${effectiveRisk}, use ${
      effectiveRisk === 'R' ? 'execute_read'
        : effectiveRisk === 'W' ? 'execute_write'
          : effectiveRisk === 'D' ? 'execute_destructive'
            : 'execute_high_impact'
    }`);
  }
  if (inspection.provider === 'lark' && inspection.schema._meta.source === 'cli-help') {
    parameters = larkContract.shortcutParameters(validatedParameters(parameters, env, inspection), inspection.schema,
      (file) => validatedParameters({ file }, env));
  }
  parameters = validatedParameters(parameters, env, inspection);
  const inputs = localInputs(parameters, env, inspection);
  const properties = parameterSchema(inspection).properties || {};
  const transfer = inputs.some(input => !input.prefix)
    || Object.entries(parameters).some(([key, value]) => {
      const property = properties[key] || properties[key.replace(/-/g, '_')];
      return fileContract(property, inspection.provider).url && typeof value === 'string' && /^https:\/\//i.test(value);
    })
    || actionTokens(inspection.action).at(-1).split(/[-_+]/).some(token => ['upload', 'download', 'import', 'export'].includes(token));
  const timeoutMs = transfer ? 10 * 60_000 : 60_000;
  const deadline = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(new DOMException('Execution deadline exceeded', 'TimeoutError')), timeoutMs);
  timer.unref?.();
  // MCP progress is a liveness heartbeat during a bounded transfer, not a
  // completion percentage. Ordinary commands retain their shorter deadline.
  const heartbeat = transfer && options.onProgress ? setInterval(() => { void options.onProgress(); }, 15_000) : null;
  heartbeat?.unref?.();
  let prepared;
  try {
    prepared = await prepareLocalInputs(parameters, inspection, env, signal);
    throwIfCancelled(signal);
    const invocation = providerInvocation(validateAction(inspection.action, env), prepared.parameters, effectiveRisk, env, inspection);
    return {
      action: inspection.action,
      risk: effectiveRisk,
      result: await runOfficial(invocation, { ...options, signal, timeoutMs, ...(prepared.cwd ? { cwd: prepared.cwd } : {}) }, env),
    };
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
    prepared?.cleanup();
  }
}

async function callTool(name, args = {}, options = {}, env = process.env) {
  await assertAuthorized(options, env);
  const manifest = configuredManifest(env);
  if (name === 'list_capabilities') {
    if (args.path != null && String(args.path).trim()) {
      return inspectCapabilities(args.path, options, env);
    }
    return {
      provider: manifest.provider,
      official_cli: manifest.executable,
      domains: manifest.domains,
      execution_tools: ['execute_read', 'execute_write', 'execute_high_impact', 'execute_destructive'],
      guidance: 'Call list_capabilities again with a domain or subgroup path, then call describe_action with an exact leaf action.',
    };
  }
  if (name === 'describe_action') {
    const inspection = await inspectAction(args.action, options, env);
    if (inspection.provider === 'lark') {
      for (const property of Object.values(inspection.schema.inputSchema.properties)) {
        if (fileContract(property, 'lark').localPath && typeof property.description === 'string') {
          property.description = property.description
            .replace('cwd-relative local path', 'absolute local path in Orkas-approved roots')
            .replace(' (absolute paths and .. are rejected)', '');
        }
      }
    }
    return inspection;
  }
  if (name === 'execute_read') return executeAction('R', args, options, env);
  if (name === 'execute_write') return executeAction('W', args, options, env);
  if (name === 'execute_high_impact') return executeAction('H', args, options, env);
  if (name === 'execute_destructive') return executeAction('D', args, options, env);
  throw new Error(`unknown tool: ${name}`);
}

async function main() {
  const lifetime = new AbortController();
  // Official CLIs share profile/token files. Preserve the synchronous adapter's
  // request ordering while leaving the event loop free to receive cancellation.
  let requestTail = Promise.resolve();
  const runInOrder = (task) => {
    const pending = requestTail.then(task);
    requestTail = pending.catch(() => {});
    return pending;
  };
  const server = new Server({ name: 'orkas-official-local-cli', version: '1.0.0' }, { capabilities: { tools: {} } });
  const shutdown = () => {
    lifetime.abort();
    void server.close().catch(() => {});
  };
  process.stdin.once('end', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const signal = AbortSignal.any([lifetime.signal, extra.signal]);
    return runInOrder(async () => {
      await assertAuthorized({ signal });
      return { tools: TOOLS };
    });
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const signal = AbortSignal.any([lifetime.signal, extra.signal]);
      let progress = 0;
      const progressToken = request.params._meta?.progressToken;
      const onProgress = progressToken == null ? undefined : () => extra.sendNotification({
        method: 'notifications/progress', params: { progressToken, progress: ++progress },
      }).catch(() => {});
      const result = await runInOrder(() => callTool(request.params.name, request.params.arguments || {}, { signal, onProgress }));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({
          error_code: error?.provider_error || error?.code === 'local_cli_contract_invalid' ? error.code
            : error?.code === 'connector_reconnect_required'
            || /authoriz|login|credential|reconnect/i.test(String(error && error.message))
            ? 'connector_reconnect_required'
            : 'local_cli_action_failed',
          message: redact(error && error.message ? error.message : String(error)),
          ...(error?.provider_error ? { provider_error: error.provider_error } : {}),
        }) }],
      };
    }
  });
  await server.connect(new StdioServerTransport());
}

module.exports = {
  MANIFESTS,
  TOOLS,
  TOOL_POLICIES,
  actionTokens,
  capabilityTokens,
  validateAction,
  validateCapabilityPath,
  assertPackageIntegrityMarker,
  classifyAction,
  classifyXeroAction,
  invocationRisk,
  redact,
  validatedParameters,
  invocationFor,
  inspectCapabilities,
  inspectAction,
  executeAction,
  callTool,
};

if (require.main === module) {
  main().catch(() => {
    process.stderr.write('local-cli-mcp-server fatal: startup failed\n');
    process.exit(1);
  });
}
