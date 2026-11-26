'use strict';

const { defaultNumericRange } = require('./tool-input-compat.cjs');
const { schemaToJson } = require('./schema-to-json.cjs');
const { zodIssueFields } = require('./tool-parameter-errors.cjs');

exports.description = 'Retrieve earlier messages and public execution records as potentially stale quoted data. Library owns documents.';
exports.groups = { search: 'search', read: 'read', read_process: 'process', read_output: 'output' };
// Retired inputs stay observable so envelope projection cannot turn an exact
// old read into a default latest-page read. They are rejected, never translated.
exports.rejectedFields = ['query', 'k', 'include_current', 'page', 'record_id', 'turn_id', 'tool_call_id', 'process_index', 'include_process', 'output_cursor', 'msg_index', 'window', 'limit', 'before_msg_index'];
// Older next_read receipts put these controls at the envelope.
exports.legacyReadFields = ['cursor', 'max_tokens'];

const readControls = z => ({
  cursor: z.number().int().min(0).safe().optional(),
  max_tokens: z.preprocess(value => defaultNumericRange(value, 10000, 1, 10000), z.number().int().min(1).max(10000).optional()),
});

exports.groupShapes = (z, crossConversation, hasProject = false) => {
  const id = z.string().min(1).refine(value => value.trim().length > 0);
  const index = z.number().int().min(0).safe();
  const controls = readControls(z);
  return {
    search: z.object({
      query: z.string().trim().min(1).describe('Earlier work terms.'),
      k: z.preprocess(value => defaultNumericRange(value, 6, 1, 15), z.number().int().min(1).max(15).optional()).describe('Default 6; cross-chat search caps 2 hits per conversation.'),
      ...(crossConversation ? { include_current: z.boolean().optional().describe(hasProject ? 'Include this conversation; default false.' : 'Include this conversation; default true.') } : {}),
    }).strict().describe('Example: {"action":"search","scope":"current","search":{"query":"export settings","k":5}}.'),
    read: z.object({
      page: z.object({
        mode: z.enum(['latest', 'around', 'before', 'from']).describe('Use before only in current scope.'),
        index: index.optional().describe('Raw index, required except for latest.'),
        count: z.preprocess(value => defaultNumericRange(value, undefined, 0, Number.MAX_SAFE_INTEGER), z.number().int().min(0).safe().optional()).describe('Around radius 0–10 (default 3); latest/before size 1–30 (default 10); from remaining count.'),
      }).strict().optional(),
      record_id: z.string().optional(),
      turn_id: z.string().optional().describe('User message ID or execution turn_id.'),
      tool_call_id: z.string().optional(),
      include_process: z.boolean().optional().describe('Public process; defaults true with tool_call_id, else false.'),
      ...controls,
    }).strict().describe('Message selection; default latest 10.'),
    process: z.object({
      record_id: id,
      process_index: index.describe('Zero-based public process index.'),
      tool_call_id: id.optional().describe('Match the call when known.'),
      turn_id: id.optional().describe('Optional turn filter.'),
      ...controls,
    }).strict().describe('Public segment from a receipt.'),
    output: z.object({
      record_id: id,
      tool_call_id: id,
      ...controls,
    }).strict().describe('Retained output from a receipt; never reruns the tool.'),
  };
};

exports.shape = (z, scopes) => {
  const currentOnly = scopes.length === 1 && scopes[0] === 'current';
  return {
    action: z.enum(Object.keys(exports.groups)).describe('Use the matching search, read, process or output group. Read cursor counts characters (default 0); max_tokens defaults to 10000, capped by remaining capacity. Copy next_read unchanged.'),
    scope: currentOnly ? z.enum(['current']).describe('Host-bound to this conversation.')
      : z.enum(scopes).optional().describe(scopes.includes('project')
        ? 'Default project. Use all for explicit cross-project recall.'
        : 'Default all; use all only for explicit cross-chat recall.'),
    ...(!currentOnly ? { cid: z.string().optional().describe('Required for reads outside current scope. Omit for search.') } : {}),
    ...Object.fromEntries(Object.entries(exports.groupShapes(z, !currentOnly, scopes.includes('project'))).map(([key, schema]) => [key, schema.optional()])),
  };
};

// `.safe()` serializes Number.MAX_SAFE_INTEGER as a maximum. It constrains
// nothing a model sends, so the advertised schema omits it; `project` still
// validates with the full zod shape.
const dropSafeIntegerMaximum = value => {
  if (Array.isArray(value)) return value.map(dropSafeIntegerMaximum);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, entry]) => !(key === 'maximum' && entry === Number.MAX_SAFE_INTEGER))
    .map(([key, entry]) => [key, dropSafeIntegerMaximum(entry)]));
};

exports.inputSchema = (z, scopes) => {
  const { $schema, ...schema } = schemaToJson(z.object(exports.shape(z, scopes)).strict());
  return dropSafeIntegerMaximum(schema);
};

// The host validates only the selected group before reading any history. Keep
// inactive group values opaque at MCP admission, matching native projection.
exports.bridgeShape = z => Object.fromEntries(Object.entries(exports.shape(z, ['current']))
  .map(([key, schema]) => [key, Object.values(exports.groups).includes(key) ? z.unknown().optional() : schema]));

function validationError(issues, schema, commonShape, input) {
  const details = [];
  const issueCount = issues.reduce((count, issue) => count + (issue.code === 'unrecognized_keys' ? issue.keys.length : 1), 0);
  for (const issue of issues) {
    const remaining = 8 - details.length;
    if (!remaining) break;
    const fields = zodIssueFields(issue, remaining);
    if (issue.code === 'unrecognized_keys') {
      let parent = schema;
      for (const part of issue.path) {
        const member = parent?.shape?.[part];
        parent = member?.shape ? member : member?.unwrap?.();
      }
      const allowedFields = Object.keys(parent?.shape ?? {});
      fields.forEach((field, index) => {
        const key = issue.keys[index];
        const atEnvelope = issue.path.length > 0 && Object.hasOwn(commonShape, key)
          && !(input.action === 'search' && (key === 'cursor' || key === 'max_tokens')) ? key : undefined;
        details.push({ field: field.slice(0, 160), code: issue.code,
          reason: 'unsupported_field', allowed_fields: allowedFields,
          expected: atEnvelope ? `Use ${atEnvelope} at the top level.` : 'Use a declared field at this location.',
          ...(atEnvelope ? { expected_path: atEnvelope } : {}) });
      });
      continue;
    }
    const received = issue.path.reduce((value, key) => value?.[key], input);
    details.push({ field: fields[0], code: issue.code, reason: issue.code,
      ...(typeof issue.expected === 'string' ? { expected: issue.expected } : {}),
      ...(typeof issue.minimum === 'number' ? { minimum: issue.minimum } : {}),
      ...(typeof issue.maximum === 'number' ? { maximum: issue.maximum } : {}),
      ...(issue.code === 'invalid_type' && received === undefined ? { constraint: 'required' } : {}),
      ...(issue.code === 'custom' ? { constraint: 'non_blank_string' } : {}),
      ...(issue.code === 'invalid_value' ? { allowed_values: issue.values } : {}),
      ...(issue.code === 'invalid_enum_value' ? { allowed_values: issue.options } : {}),
    });
  }
  return { code: 'invalid_arguments', message: 'Invalid chat_history arguments.', invalid_fields: [...new Set(details.map(issue => issue.field))],
    issues: details, ...(issueCount > details.length ? { issues_truncated: true, issue_count: issueCount } : {}) };
}

exports.project = (z, input, scopes) => {
  const group = typeof input.action === 'string' && Object.hasOwn(exports.groups, input.action) ? exports.groups[input.action] : undefined;
  if (!group) return { error: { code: 'invalid_action', allowed_actions: Object.keys(exports.groups) } };
  const shape = exports.shape(z, scopes);
  const legacy = readControls(z);
  const unsupported = Object.keys(input).filter(key => !Object.hasOwn(shape, key) && !Object.hasOwn(legacy, key));
  if (unsupported.length) return { error: {
    code: 'unsupported_fields', fields: unsupported, allowed_fields: Object.keys(shape), argument_group: group,
    ...(group === 'search' && unsupported.includes('k') ? { issues: [{
      field: 'k', code: 'unrecognized_keys', reason: 'unsupported_field',
      expected_path: 'search.k', expected: 'Use search.k or omit it for the default.',
    }] } : {}),
  } };
  const common = ['action', 'scope', 'cid', ...exports.legacyReadFields];
  // Preserve the host's scope/cid rejection and never hide a scope selector.
  const commonShape = { ...Object.fromEntries(common.filter(key => shape[key]).map(key => [key, shape[key]])), ...legacy };
  const commonInput = Object.fromEntries(common.filter(key => input[key] !== undefined && Object.hasOwn(commonShape, key)).map(key => [key, input[key]]));
  // `read` alone has no required selector: the schema advertises its default
  // latest page. Retired flat selectors were already rejected above.
  const groupInput = group === 'read' && input[group] === undefined ? {} : input[group];
  const schema = z.object({ ...commonShape, [group]: exports.groupShapes(z, scopes.some(scope => scope !== 'current'))[group] }).strict();
  const selectedInput = { ...commonInput, [group]: groupInput };
  const parsed = schema.safeParse(selectedInput);
  if (!parsed.success) return { error: validationError(parsed.error.issues, schema, commonShape, selectedInput) };
  const conflicts = group === 'search' ? [] : exports.legacyReadFields.filter(key => Object.hasOwn(commonInput, key) && Object.hasOwn(groupInput, key));
  if (conflicts.length) return { error: { code: 'conflicting_fields', fields: conflicts, argument_group: group,
    message: `Supply each read control once in ${group}.` } };
  const ignored = Object.keys(input).filter(key => !common.includes(key) && key !== group).sort();
  const { [group]: selected, ...effective } = parsed.data;
  if (input.action === 'search' && input.cid) return { error: { code: 'unsupported_search_selector', conflicting_fields: ['cid'] } };
  if (input.action === 'search') {
    for (const key of ['cursor', 'max_tokens']) if (key in effective) { delete effective[key]; ignored.push(key); }
  }
  Object.assign(effective, selected);
  if (input.action === 'read_output') { effective.output_cursor = effective.cursor ?? 0; delete effective.cursor; }
  effective.action = input.action === 'search' ? 'search' : 'read';
  return { input: effective, ignored: ignored.sort() };
};

exports.locator = input => {
  const { action, scope, cid, cursor, max_tokens, output_cursor, ...selectors } = input;
  const operation = action === 'search' ? 'search' : output_cursor !== undefined ? 'read_output'
    : selectors.process_index !== undefined ? 'read_process' : 'read';
  const fields = operation === 'read_process' ? ['record_id', 'process_index', 'tool_call_id', 'turn_id']
    : operation === 'read_output' ? ['record_id', 'tool_call_id'] : Object.keys(selectors);
  const controls = operation === 'search' ? {} : { cursor: output_cursor ?? cursor, max_tokens };
  return { action: operation, scope, ...(cid !== undefined ? { cid } : {}),
    [exports.groups[operation]]: { ...Object.fromEntries(fields.filter(key => selectors[key] !== undefined).map(key => [key, selectors[key]])),
      ...Object.fromEntries(Object.entries(controls).filter(([, value]) => value !== undefined)) },
  };
};
