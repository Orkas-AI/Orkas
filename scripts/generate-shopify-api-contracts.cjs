'use strict';

// Offline compiler for the pinned public 2026-07 schema and reviewed permission
// inventory. Provider operation discovery never grants additional OAuth scopes.
const fs = require('node:fs');
const path = require('node:path');
const evidence = JSON.parse(fs.readFileSync(path.join(__dirname, '../test/fixtures/connectors/official-contracts/shopify-20261001.json'), 'utf8'));
const types = Object.fromEntries(evidence.model.types.filter(t => !t.name.startsWith('__')).map(t => [t.name, t]));
const base = t => t.ofType ? base(t.ofType) : t.name;
const wireType = t => t.kind === 'NON_NULL' ? wireType(t.ofType) + '!' : t.kind === 'LIST' ? '[' + wireType(t.ofType) + ']' : t.name;
const object = properties => ({ type: 'object', properties, additionalProperties: false });
const definitions = {};
function schema(ref) {
  if (ref.kind === 'NON_NULL') return nonnull(ref.ofType);
  return { anyOf: [nonnull(ref), { type: 'null' }] };
}
function nonnull(ref) {
  if (ref.kind === 'LIST') return { type: 'array', items: schema(ref.ofType), maxItems: 250 };
  const t = types[ref.name];
  if (!t) throw new Error('Missing Shopify type');
  if (t.kind === 'ENUM' || t.kind === 'INPUT_OBJECT') return { $ref: '#/$defs/' + t.name };
  if (t.kind !== 'SCALAR') throw new Error('Output type used as an input');
  if (t.name === 'JSON') return {};
  if (t.name === 'Int') return { type: 'integer', minimum: -2147483648, maximum: 2147483647 };
  if (t.name === 'Float') return { type: 'number' };
  if (t.name === 'Boolean') return { type: 'boolean' };
  return { type: 'string', maxLength: 262144, ...(t.name === 'ID' ? { minLength: 1 } : {}) };
}
function defaultValue(value) { try { return JSON.parse(value); } catch { return value; } }
function argumentsSchema(fields) {
  const result = object(Object.fromEntries(fields.map(f => [f.name, { ...schema(f.type), ...(f.defaultValue !== null ? { default: defaultValue(f.defaultValue) } : {}), ...(f.description ? { description: f.description } : {}) }])));
  result.required = fields.filter(f => f.type.kind === 'NON_NULL' && f.defaultValue === null).map(f => f.name);
  return result;
}
for (const t of Object.values(types)) {
  if (t.kind === 'ENUM') definitions[t.name] = { type: 'string', enum: t.enumValues.filter(v => !v.isDeprecated).map(v => v.name) };
  if (t.kind === 'INPUT_OBJECT') {
    const fields = t.inputFields.filter(f => !f.isDeprecated), s = argumentsSchema(fields);
    if (t.isOneOf) {
      s.minProperties = 1; s.maxProperties = 1;
      s.properties = Object.fromEntries(fields.map(f => [f.name, { ...nonnull(f.type.kind === 'NON_NULL' ? f.type.ofType : f.type), ...(f.description ? { description: f.description } : {}) }]));
    }
    // Shopify requires explicit CAS presence even though null disables comparison.
    if (['InventoryAdjustmentInput', 'InventoryChangeInput', 'InventoryMoveQuantityTerminalInput', 'InventoryQuantityInput', 'InventorySetQuantityInput'].includes(t.name)) s.required.push('changeFromQuantity');
    definitions[t.name] = s;
  }
}
function closure(s, result = new Set()) {
  if (!s || typeof s !== 'object') return result;
  if (s.$ref) { const name = s.$ref.slice(8); if (!result.has(name)) { result.add(name); closure(definitions[name], result); } }
  for (const [key, value] of Object.entries(s)) if (key !== 'description') {
    if (Array.isArray(value)) value.forEach(v => closure(v, result)); else if (typeof value === 'object') closure(value, result);
  }
  return result;
}
const selection = { type: 'array', minItems: 1, maxItems: 100, items: { $ref: '#/$defs/Selection' }, description: 'Optional typed output selection. Each node names a public field, its arguments and children; on_type selects a union/interface member. Defaults to a small summary. Maximum depth 8, 100 field nodes and 100 items per connection; no raw GraphQL.' };
definitions.Selection = object({ field: { type: 'string', pattern: '^[_A-Za-z][_0-9A-Za-z]*$' }, arguments: { type: 'object' }, children: { type: 'array', minItems: 1, maxItems: 100, items: { $ref: '#/$defs/Selection' } }, on_type: { type: 'string', pattern: '^[_A-Za-z][_0-9A-Za-z]*$' } });
const methods = {};
for (const row of evidence.inventory) {
  if (row.excluded_reason) continue;
  const root = types[row.kind === 'queries' ? 'QueryRoot' : 'Mutation'].fields.find(f => f.name === row.operation);
  const args = root.args.filter(f => !f.isDeprecated), input = object({ arguments: argumentsSchema(args), selection });
  if (input.properties.arguments.required.length) input.required = ['arguments'];
  const existingBatches = { productVariantsBulkCreate: 'variants', productVariantsBulkUpdate: 'variants', productVariantsBulkDelete: 'variantsIds', publishablePublish: 'input', publishableUnpublish: 'input' };
  const batch = input.properties.arguments.properties[existingBatches[row.operation]];
  if (batch) { const array = batch.anyOf ? batch.anyOf.find(s => s.type === 'array') : batch; array.maxItems = 10; }
  const argumentDefinitions = [...closure(input)];
  methods[row.operation] = { kind: row.kind === 'queries' ? 'query' : 'mutation', risk: row.risk,
    description: (root.description || row.operation).split('\n')[0].slice(0, 140), requirements: row.requirements, documentation_url: row.source,
    input_schema: input, input_definitions: argumentDefinitions, args: Object.fromEntries(args.map(f => [f.name, wireType(f.type)])),
    output_type: wireType(root.type), owner_guard: Boolean(row.owner_guard), idempotency: row.idempotency,
    output_fields: (types[base(root.type)].fields || []).filter(f => !f.isDeprecated && !evidence.blocked_output_types[base(f.type)]).map(f => ({ field: f.name, type: wireType(f.type) })) };
}
// Output fields retain argument types and defaults, not the large explanatory
// graph. Only the chosen operation's input closure is emitted by describe_action.
const output = Object.fromEntries(Object.values(types).filter(t => ['OBJECT', 'INTERFACE', 'UNION', 'SCALAR', 'ENUM'].includes(t.kind)).map(t => [t.name, { kind: t.kind,
  ...(t.enumValues ? { values: t.enumValues.map(v => v.name) } : {}),
  ...(t.possibleTypes ? { possible_types: t.possibleTypes.map(v => v.name) } : {}),
  ...(t.fields ? { fields: Object.fromEntries(t.fields.filter(f => !f.isDeprecated).map(f => [f.name, { type: wireType(f.type), args: Object.fromEntries(f.args.filter(a => !a.isDeprecated).map(a => [a.name, { type: wireType(a.type), default: a.defaultValue }])), input_schema: argumentsSchema(f.args.filter(a => !a.isDeprecated)) }])) } : {}) }]));
const result = { api_version: evidence.api_version, source_sha256: evidence.source_sha256, methods, definitions, output, blocked_output_types: evidence.blocked_output_types,
  excluded_methods: Object.fromEntries(evidence.inventory.filter(r => r.excluded_reason).map(r => [r.operation, r.excluded_reason])) };
fs.writeFileSync(path.join(__dirname, '../bin/shopify-api-contracts.cjs'), "'use strict';\n// Generated offline; see generate-shopify-api-contracts.cjs.\nmodule.exports = " + JSON.stringify(result) + ';\n');
console.log('Generated ' + Object.keys(methods).length + ' Shopify merchant contracts');
