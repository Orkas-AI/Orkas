'use strict';

const { defaultNumericRange } = require('./tool-input-compat.cjs');
const { schemaToJson } = require('./schema-to-json.cjs');

exports.description = 'Retrieve earlier messages and public execution records as potentially stale quoted data. Library owns documents.';
exports.groups = { search: 'search', read: 'read', read_process: 'process', read_output: 'output' };
// Retired inputs stay observable so envelope projection cannot turn an exact
// old read into a default latest-page read. They are rejected, never translated.
exports.rejectedFields = ['query', 'k', 'include_current', 'page', 'record_id', 'turn_id', 'tool_call_id', 'process_index', 'include_process', 'output_cursor', 'msg_index', 'window', 'limit', 'before_msg_index'];

exports.groupShapes = (z, crossConversation, hasProject = false) => {
  const id = z.string().min(1).refine(value => value.trim().length > 0);
  const index = z.number().int().min(0).safe();
  return {
    search: z.object({
      query: z.string().trim().min(1).describe('Earlier work terms.'),
      k: z.preprocess(value => defaultNumericRange(value, 6, 1, 15), z.number().int().min(1).max(15).optional()).describe('Default 6; cross-conversation results cap 2 hits/conversation.'),
      ...(crossConversation ? { include_current: z.boolean().optional().describe(hasProject ? 'Include this conversation; default false.' : 'Include this conversation; default true.') } : {}),
    }).strict(),
    read: z.object({
      page: z.object({
        mode: z.enum(['latest', 'around', 'before', 'from']).describe('Tail, centered, backward or forward message selection.'),
        index: index.optional().describe('Raw index for around/before/from; ignored for latest.'),
        count: z.preprocess(value => defaultNumericRange(value, undefined, 0, Number.MAX_SAFE_INTEGER), z.number().int().min(0).safe().optional()).describe('Around radius 0-10 (default 3); latest/before size 1-30 (default 10); from remaining count.'),
      }).strict().optional(),
      record_id: z.string().optional().describe('Exact message ID from receipts.'),
      turn_id: z.string().optional().describe('User message ID or execution turn_id.'),
      tool_call_id: z.string().optional().describe('Containing tool call.'),
      include_process: z.boolean().optional().describe('Public process; defaults true with tool_call_id, else false.'),
    }).strict().describe('Message selection; default latest 10.'),
    process: z.object({
      record_id: id,
      process_index: index.describe('Zero-based public process index from receipts.'),
      tool_call_id: id.optional().describe('Optional matching call.'),
      turn_id: id.optional().describe('Optional turn restriction.'),
    }).strict().describe('Public segment; exact IDs and index from receipts.'),
    output: z.object({
      record_id: id,
      tool_call_id: id,
    }).strict().describe('Full output; exact record/call IDs from receipts. Never reruns the tool.'),
  };
};

exports.shape = (z, scopes) => {
  const currentOnly = scopes.length === 1 && scopes[0] === 'current';
  return {
    action: z.enum(Object.keys(exports.groups)).describe('Use its argument group; unused groups are ignored. Follow next_read unchanged.'),
    scope: currentOnly ? z.enum(['current']).describe('Host-bound to this conversation.')
      : z.enum(scopes).optional().describe(scopes.includes('project')
        ? 'Default project; current is host-bound; all requires broader recall.'
        : 'Default all; current is host-bound; all requires cross-conversation recall.'),
    ...(!currentOnly ? { cid: z.string().optional().describe('Required for cross-conversation reads. Omit for current; not a search filter.') } : {}),
    ...Object.fromEntries(Object.entries(exports.groupShapes(z, !currentOnly, scopes.includes('project'))).map(([key, schema]) => [key, schema.optional()])),
    cursor: z.number().int().min(0).safe().optional().describe('Character cursor; default 0. Continue with next_read.'),
    max_tokens: z.preprocess(value => defaultNumericRange(value, 10000, 1, 10000), z.number().int().min(1).max(10000).optional()).describe('Read token budget; default 10000, capped by remaining capacity.'),
  };
};

exports.inputSchema = (z, scopes) => {
  const { $schema, ...schema } = schemaToJson(z.object(exports.shape(z, scopes)).strict());
  return schema;
};

// The host validates only the selected group before reading any history. Keep
// inactive group values opaque at MCP admission, matching native projection.
exports.bridgeShape = z => Object.fromEntries(Object.entries(exports.shape(z, ['current']))
  .map(([key, schema]) => [key, Object.values(exports.groups).includes(key) ? z.unknown().optional() : schema]));

exports.project = (z, input, scopes) => {
  const group = typeof input.action === 'string' && Object.hasOwn(exports.groups, input.action) ? exports.groups[input.action] : undefined;
  if (!group) return { error: { code: 'invalid_action', allowed_actions: Object.keys(exports.groups) } };
  const shape = exports.shape(z, scopes);
  const unsupported = Object.keys(input).filter(key => !Object.hasOwn(shape, key));
  if (unsupported.length) return { error: { code: 'unsupported_fields', fields: unsupported,
    allowed_fields: Object.keys(shape), argument_group: group } };
  const common = ['action', 'scope', 'cid', 'cursor', 'max_tokens'];
  // Preserve the host's scope/cid rejection and never hide a scope selector.
  const commonShape = Object.fromEntries(common.filter(key => shape[key]).map(key => [key, shape[key]]));
  const commonInput = Object.fromEntries(common.filter(key => input[key] !== undefined && shape[key]).map(key => [key, input[key]]));
  // `read` alone has no required selector: the schema advertises its default
  // latest page. Retired flat selectors were already rejected above.
  const groupInput = group === 'read' && input[group] === undefined ? {} : input[group];
  const parsed = z.object({ ...commonShape, [group]: exports.groupShapes(z, scopes.some(scope => scope !== 'current'))[group] })
    .strict().safeParse({ ...commonInput, [group]: groupInput });
  if (!parsed.success) return { error: {
    code: 'invalid_arguments',
    invalid_fields: [...new Set(parsed.error.issues.map(issue => issue.path.join('.')))],
    issues: parsed.error.issues.slice(0, 8).map(issue => ({
      field: issue.path.join('.'), code: issue.code,
      ...(typeof issue.expected === 'string' ? { expected: issue.expected } : {}),
      ...(typeof issue.minimum === 'number' ? { minimum: issue.minimum } : {}),
      ...(typeof issue.maximum === 'number' ? { maximum: issue.maximum } : {}),
      ...(issue.code === 'custom' ? { constraint: 'non_blank_string' } : {}),
      ...(issue.code === 'invalid_enum_value' ? { allowed_values: issue.options } : {}),
    })),
  } };
  const ignored = Object.keys(input).filter(key => !common.includes(key) && key !== group).sort();
  const effective = Object.fromEntries(common.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
  if (input.action === 'search' && input.cid) return { error: { code: 'unsupported_search_selector', conflicting_fields: ['cid'] } };
  if (input.action === 'search') {
    for (const key of ['cursor', 'max_tokens']) if (key in effective) { delete effective[key]; ignored.push(key); }
  }
  Object.assign(effective, parsed.data[group]);
  if (input.action === 'read_output') { effective.output_cursor = input.cursor ?? 0; delete effective.cursor; }
  effective.action = input.action === 'search' ? 'search' : 'read';
  return { input: effective, ignored: ignored.sort() };
};

exports.locator = input => {
  const { action, scope, cid, cursor, max_tokens, output_cursor, ...selectors } = input;
  const operation = action === 'search' ? 'search' : output_cursor !== undefined ? 'read_output'
    : selectors.process_index !== undefined ? 'read_process' : 'read';
  const fields = operation === 'read_process' ? ['record_id', 'process_index', 'tool_call_id', 'turn_id']
    : operation === 'read_output' ? ['record_id', 'tool_call_id'] : Object.keys(selectors);
  return { action: operation, scope, ...(cid !== undefined ? { cid } : {}),
    [exports.groups[operation]]: Object.fromEntries(fields.filter(key => selectors[key] !== undefined).map(key => [key, selectors[key]])),
    ...(output_cursor !== undefined ? { cursor: output_cursor } : cursor !== undefined ? { cursor } : {}),
    ...(max_tokens !== undefined ? { max_tokens } : {}),
  };
};
