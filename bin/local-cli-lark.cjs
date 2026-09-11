'use strict';

/** Lark 1.0.93 has two introspection contracts: Cobra help for shortcuts,
 * and JSON schema for API methods. Parse only the documented help sections;
 * prose, examples and another command's help cannot authorize an operation.
 */
const RISKS = new Set(['read', 'write', 'high-risk-write']);
const OWNED_FLAGS = new Set(['help', 'profile', 'format', 'json', 'yes', 'dry-run']);

function contractError() {
  return Object.assign(new Error('official lark-cli command contract is unavailable or incompatible'), {
    code: 'local_cli_contract_invalid',
  });
}

function helpText(result) {
  if (!result || result.ok !== true || typeof result.output !== 'string') throw contractError();
  return result.output.replace(/\r\n/g, '\n');
}

function section(text, heading) {
  const start = text.indexOf(`\n${heading}:\n`);
  if (start < 0) throw contractError();
  return text.slice(start + heading.length + 3).split('\n\n')[0];
}

function assertUsage(text, cliPath, group) {
  const usage = section(text, 'Usage').split('\n').map((line) => line.trim());
  if (!usage.includes(`lark-cli ${cliPath} [flags]`)
      || usage.includes(`lark-cli ${cliPath} [command]`) !== group) throw contractError();
}

function shortcutSchema(result, cliPath) {
  const text = helpText(result);
  assertUsage(text, cliPath, false);
  const risks = text.split('\n').filter((line) => line.startsWith('Risk: '));
  const blocks = text.trim().split('\n\n');
  const riskIndex = blocks.indexOf(risks[0]);
  // Curated shortcuts put risk after the summary; generated shortcuts put it
  // immediately after Flags. Neither examples nor arbitrary trailing prose count.
  const risk = risks.length === 1 && /^Risk: (read|write|high-risk-write)(?: \([^\n]+\))?$/.exec(risks[0]);
  if (!risk || (riskIndex !== 1 && !blocks[riskIndex - 1]?.startsWith('Flags:\n'))) throw contractError();
  const properties = {};
  for (const line of section(text, 'Flags').split('\n')) {
    if (!line.trim()) continue;
    // Cobra columns use 2+ spaces. pflag may replace the type with a backtick
    // placeholder from the description (including punctuation or single spaces).
    const match = /^\s+(?:-[A-Za-z0-9], )?--([a-z][a-z0-9_-]*)(?: (\S+(?: \S+)*))? {2,}(.*)$/.exec(line);
    if (!match) throw contractError();
    const [, flag, cliType, description] = match;
    if (OWNED_FLAGS.has(flag)) continue;
    const type = !cliType ? 'boolean'
      : /^(?:u?int(?:32|64)?|count)$/.test(cliType) ? 'integer'
        : /^(?:float|float32|float64)$/.test(cliType) ? 'number'
          : ['strings', 'stringArray', 'ints'].includes(cliType) ? 'array' : 'string';
    properties[flag.replace(/-/g, '_')] = {
      type, description, flag: `--${flag}`, cliType: cliType || 'bool',
      ...(type === 'array' ? { items: { type: cliType === 'ints' ? 'integer' : 'string' } } : {}),
    };
  }
  return {
    name: cliPath,
    description: text.split('\n')[0],
    inputSchema: { type: 'object', properties, additionalProperties: false },
    _meta: { risk: risk[1], source: 'cli-help' },
  };
}

function capabilityCommands(result, cliPath) {
  const text = helpText(result);
  assertUsage(text, cliPath, true);
  const commands = section(text, 'Available Commands').split('\n').filter((line) => line.trim()).map((line) => {
    const match = /^\s{2}([A-Za-z0-9_+.-]+)\s+(\S.*)$/.exec(line);
    if (!match) throw contractError();
    return { name: `${cliPath} ${match[1]}`, description: match[2] };
  });
  if (!commands.length) throw contractError();
  return commands;
}

function apiSchema(result, canonical) {
  if (!result || typeof result.name !== 'string'
      || result.name.split(/[. ]+/).join('.') !== canonical
      || result.inputSchema?.type !== 'object' || !RISKS.has(result._meta?.risk)) throw contractError();
  return result;
}

function shortcutParameters(parameters, schema, validateLocalFile) {
  const out = {};
  for (const [key, value] of Object.entries(parameters)) {
    const canonical = key.replace(/-/g, '_');
    const property = schema.inputSchema.properties[canonical];
    if (!Object.hasOwn(schema.inputSchema.properties, canonical) || Object.hasOwn(out, canonical)) {
      throw new Error('unknown or duplicate lark-cli parameter; use the parameters returned by describe_action');
    }
    const valid = property.type === 'array' ? Array.isArray(value) && value.every((item) =>
      property.items.type === 'integer' ? Number.isSafeInteger(item) : typeof item === 'string')
      : property.type === 'integer' ? Number.isSafeInteger(value)
        : property.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
          : typeof value === property.type;
    if (!valid) throw new Error(`invalid lark-cli parameter type: ${canonical}; expected ${property.type}`);
    // These are documented input carriers, not ordinary text. Preserve the host's
    // existing file boundary before the provider can expand an @file reference.
    if (property.description.includes('supports @file') && typeof value === 'string') {
      if (value === '-') throw new Error('stdin parameter input is not available through this connector');
      if (value.startsWith('@')) validateLocalFile(value.slice(1));
    }
    out[canonical] = value;
  }
  return out;
}

function parameterArgs(parameters, schema) {
  const args = [];
  for (const [key, value] of Object.entries(parameters)) {
    const property = schema?._meta?.source === 'cli-help' ? schema.inputSchema.properties[key] : null;
    const flag = property?.flag || `--${key.replace(/_/g, '-')}`;
    if (typeof value === 'boolean') args.push(`${flag}=${value}`);
    else if (Array.isArray(value) && schema?._meta?.source === 'cli-help') {
      // pflag stringSlice parses CSV, whereas stringArray preserves each flag verbatim.
      for (const item of value) args.push(flag, property.cliType === 'strings' ? `"${item.replace(/"/g, '""')}"` : String(item));
    } else args.push(flag, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return args;
}

const ERROR_MESSAGES = Object.freeze({
  validation: ['local_cli_invalid_argument', 'official lark-cli rejected the command or parameters; inspect the action and its parameters'],
  authentication: ['connector_reconnect_required', 'official lark-cli account is not authorized; reconnect this connector'],
  authorization: ['connector_permission_denied', 'official lark-cli permission is insufficient for this action'],
  config: ['connector_reconnect_required', 'official lark-cli configuration is unavailable; reconnect this connector'],
  network: ['local_cli_network_failed', 'official lark-cli could not complete the network request'],
  api: ['local_cli_api_failed', 'official lark-cli service could not complete this action'],
  policy: ['local_cli_policy_denied', 'official lark-cli provider policy did not permit this action'],
  internal: ['local_cli_contract_invalid', 'official lark-cli returned an incompatible response'],
  confirmation: ['local_cli_confirmation_required', 'official lark-cli requires confirmation for this action'],
});
const ERROR_SUBTYPES = new Set([
  'invalid_argument', 'command_unavailable', 'missing_scope', 'app_scope_not_applied',
  'access_denied', 'token_missing', 'token_expired', 'token_invalid', 'not_configured',
  'timeout', 'dns', 'tls', 'transport', 'protocol', 'server_error', 'rate_limit',
  'not_found', 'failed_precondition', 'confirmation_required',
]);

function structuredFailure(result) {
  let payload;
  for (const stream of [result.stderr, result.stdout]) {
    try { payload = JSON.parse(stream); } catch { continue; }
    if (payload?.ok === false && Object.hasOwn(ERROR_MESSAGES, payload.error?.type || '')) break;
    payload = null;
  }
  if (payload?.ok !== false || !Object.hasOwn(ERROR_MESSAGES, payload.error?.type || '')) return null;
  const { type, subtype, code } = payload.error;
  const [errorCode, message] = ERROR_MESSAGES[type];
  return Object.assign(new Error(message), {
    code: errorCode,
    provider_error: {
      type,
      ...(ERROR_SUBTYPES.has(subtype) ? { subtype } : {}),
      ...(Number.isSafeInteger(code) ? { code } : {}),
    },
  });
}

module.exports = { shortcutSchema, capabilityCommands, apiSchema, shortcutParameters, parameterArgs, structuredFailure };
