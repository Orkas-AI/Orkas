'use strict';

const { randomUUID } = require('node:crypto');
const { requestFetch, requestFailureCode, httpFailure } = require('./commerce-request-context.cjs');
const { readBody } = require('./storefront-admin-api.cjs');
let contracts, actions, validator;
const checks = new Map(), schemas = new Map();
const source = () => contracts ||= require('./shopify-api-contracts.cjs');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const invalid = () => fail('E_BAD_INPUT', 'Invalid Shopify fields, arguments or selection; check the described contract');
const base = type => type.replace(/[\[\]!]/g, '');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function inputFor(name) {
  if (!schemas.has(name)) {
    const row = source().methods[name];
    schemas.set(name, { ...row.input_schema, $defs: Object.fromEntries(row.input_definitions.map(id => [id, source().definitions[id]])) });
  }
  return schemas.get(name);
}
function actionsFor() {
  return actions ||= Object.fromEntries(Object.entries(source().methods).map(([name, row]) => [name, {
    risk: row.risk, description: row.description,
    get input_schema() { return inputFor(name); },
    output_type: base(row.output_type), output_fields: row.output_fields, requirements: row.requirements, documentation_url: row.documentation_url,
  }]));
}
const isNative = name => Object.hasOwn(source().methods, name);
const forbiddenOutput = name => Boolean(source().blocked_output_types[name]) || ['DelegateAccessToken', 'StorefrontAccessToken'].includes(name);
function describeOutputType(action, type) {
  const row = source().methods[action];
  if (!row || typeof type !== 'string' || !Object.hasOwn(source().output, type) || forbiddenOutput(type)) invalid();
  const queue = [base(row.output_type)], seen = new Set();
  let reachable = false;
  for (let index = 0; index < queue.length; index++) {
    const name = queue[index];
    if (seen.has(name) || forbiddenOutput(name)) continue;
    seen.add(name);
    if (name === type) { reachable = true; break; }
    const current = source().output[name];
    if (!current) continue;
    queue.push(...Object.values(current.fields || {}).map(field => base(field.type)), ...(current.possible_types || []));
  }
  if (!reachable) invalid();
  function withDefinitions(schema) {
    const ids = new Set();
    function visit(value) {
      if (!value || typeof value !== 'object') return;
      if (value.$ref) { const id = value.$ref.slice(8); if (!ids.has(id)) { ids.add(id); visit(source().definitions[id]); } }
      for (const [key, child] of Object.entries(value)) if (key !== 'description') {
        if (Array.isArray(child)) child.forEach(visit); else if (typeof child === 'object') visit(child);
      }
    }
    visit(schema);
    return { ...schema, $defs: Object.fromEntries([...ids].map(id => [id, source().definitions[id]])) };
  }
  const current = source().output[type];
  return { output_type: type, kind: current.kind,
    ...(current.values ? { enum_values: current.values } : {}),
    ...(current.possible_types ? { possible_types: current.possible_types.filter(name => !forbiddenOutput(name)) } : {}),
    ...(current.fields ? { fields: Object.fromEntries(Object.entries(current.fields).filter(([, field]) => !forbiddenOutput(base(field.type))).map(([name, field]) => [name, { type: field.type, arguments: withDefinitions(field.input_schema) }])) } : {}),
  };
}

function check(schema, value) {
  if (!validator) { const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/ajv'); validator = new AjvJsonSchemaValidator(); }
  let validate = checks.get(schema);
  if (!validate) { validate = validator.getValidator(schema); checks.set(schema, validate); }
  if (!validate(value).valid) invalid();
}
function checkArguments(schema, value) {
  let full = schemas.get(schema);
  if (!full) { full = { ...schema, $defs: source().definitions }; schemas.set(schema, full); }
  check(full, value);
}
function bounded(value) {
  let text;
  try { text = JSON.stringify(value); } catch { invalid(); }
  if (!text || Buffer.byteLength(text) > 256 * 1024) invalid();
  const visit = (item, depth) => {
    if (depth > 30) invalid();
    if (item && typeof item === 'object') for (const v of Object.values(item)) visit(v, depth + 1);
  };
  visit(value, 0);
}
const OWNER_TYPES = new Set(['PRODUCT', 'PRODUCTVARIANT', 'COLLECTION', 'CUSTOMER', 'ORDER', 'DRAFTORDER', 'INVENTORYITEM']);
function ownerGuard(name, args) {
  if (!source().methods[name].owner_guard) return;
  if (['metafieldDefinition', 'metafieldDefinitionDelete', 'metafieldDefinitionPin', 'metafieldDefinitionUnpin'].includes(name) && (Object.hasOwn(args, 'id') || Object.hasOwn(args, 'definitionId'))) invalid();
  let owners = 0;
  function shape(schema) {
    if (schema.$ref) return shape(source().definitions[schema.$ref.slice(8)]);
    if (schema.anyOf) return shape(schema.anyOf.find(s => s.type !== 'null'));
    return schema;
  }
  function walk(value, schema) {
    if (value === null || value === undefined) return;
    const declared = shape(schema);
    if (declared.type === 'array') { value.forEach(item => walk(item, declared.items)); return; }
    // JSON scalars and merchant-controlled metadata are not authority records.
    if (declared.type !== 'object' || !declared.properties) return;
    for (const [key, child] of Object.entries(declared.properties)) {
      if (!Object.hasOwn(value, key)) continue;
      const item = value[key];
      if (key === 'ownerType') {
        if (typeof item !== 'string' || !OWNER_TYPES.has(item.replace(/_/g, ''))) invalid();
        owners++;
      } else if (key === 'ownerId' || (['tagsAdd', 'tagsRemove'].includes(name) && key === 'id')) {
        const matched = typeof item === 'string' && /^gid:\/\/shopify\/([A-Za-z]+)\/[0-9]+$/.exec(item);
        if (!matched || !OWNER_TYPES.has(matched[1].toUpperCase())) invalid();
        owners++;
      } else walk(item, child);
    }
  }
  walk(args, source().methods[name].input_schema.properties.arguments);
  if (!owners) fail('E_BAD_INPUT', 'Shopify owner-dependent operations require an explicit supported merchant owner identifier');
}
function defaultSelection(type, depth = 0) {
  const t = source().output[base(type)];
  if (!t || ['SCALAR', 'ENUM'].includes(t.kind)) return undefined;
  if (depth > 2 || !t.fields) return [{ field: '__typename' }];
  if (t.fields.nodes && t.fields.pageInfo) return [
    { field: 'nodes', children: defaultSelection(t.fields.nodes.type, depth + 1) },
    { field: 'pageInfo', children: [{ field: 'hasNextPage' }, { field: 'endCursor' }] },
  ];
  const fields = Object.entries(t.fields);
  const chosen = ['id', 'name', 'title', 'status', 'done', 'count'].filter(n => t.fields[n] && ['SCALAR', 'ENUM'].includes(source().output[base(t.fields[n].type)]?.kind) && !Object.values(t.fields[n].args).some(a => a.type.endsWith('!') && a.default === null)).slice(0, 4);
  if (chosen.length) return chosen.map(field => ({ field }));
  const scalar = fields.filter(([, f]) => ['SCALAR', 'ENUM'].includes(source().output[base(f.type)]?.kind) && !Object.values(f.args).some(a => a.type.endsWith('!') && a.default === null)).slice(0, 4).map(([field]) => ({ field }));
  if (scalar.length) return scalar;
  const child = fields.find(([key, f]) => !key.endsWith('Errors') && !f.type.includes('[') && !Object.values(f.args).some(a => a.type.endsWith('!') && a.default === null));
  return child ? [{ field: child[0], children: defaultSelection(child[1].type, depth + 1) }] : [{ field: '__typename' }];
}
function pageArguments(fields, args) {
  const result = { ...args };
  if (fields.first && !Object.hasOwn(result, 'first') && !Object.hasOwn(result, 'last')) result.first = 20;
  for (const key of ['first', 'last']) if (Object.hasOwn(result, key) && (!Number.isInteger(result[key]) || result[key] < 1 || result[key] > 100)) invalid();
  if (result.first !== undefined && result.last !== undefined) invalid();
  return result;
}
function build(name, p = {}) {
  const row = source().methods[name];
  if (!row) invalid();
  bounded(p); check(inputFor(name), p);
  let args = pageArguments(Object.fromEntries(Object.keys(row.args).map(k => [k, true])), p.arguments || {});
  checkArguments(row.input_schema.properties.arguments, args); ownerGuard(name, args);
  const root = source().output[base(row.output_type)];
  let selected = p.selection || defaultSelection(row.output_type);
  if (row.kind === 'mutation' && root.fields) {
    selected = [...(selected || [])];
    // Every documented top-level user-error collection is mandatory even when
    // callers choose another result projection. Business text never decides success.
    for (const [field, definition] of Object.entries(root.fields)) if (field.toLowerCase().endsWith('usererrors')) {
      const errorType = source().output[base(definition.type)];
      if (!selected.some(n => n.field === field)) selected.push({ field, children: ['field', 'message', 'code'].filter(k => errorType.fields?.[k]).map(k => ({ field: k })) });
    }
    if (!selected.some(n => n.field && !n.field.toLowerCase().endsWith('usererrors') && n.field !== '__typename')) {
      const defaults = defaultSelection(row.output_type);
      if (defaults?.some(n => n.field !== '__typename')) selected.push(...defaults);
    }
  }
  const variables = {}, declarations = [];
  let nodes = 0, projectedObjects = 0;
  function argumentsText(definitions, values) {
    return Object.entries(values).map(([key, value]) => {
      const type = typeof definitions[key] === 'string' ? definitions[key] : definitions[key]?.type;
      if (!type) invalid();
      const id = 'v' + declarations.length;
      declarations.push('$' + id + ':' + type); variables[id] = value;
      return key + ':$' + id;
    }).join(',');
  }
  const rootArgs = argumentsText(row.args, args);
  function selectionText(type, choice, depth, multiplier) {
    const t = source().output[base(type)];
    if (source().blocked_output_types[base(type)]) invalid();
    if (['SCALAR', 'ENUM'].includes(t.kind)) { if (choice) invalid(); return { text: '', selection: [] }; }
    if (!Array.isArray(choice) || !choice.length || depth > 8) invalid();
    const seen = new Set(), result = [], wire = [];
    for (const n of choice) {
      if (++nodes > 100 || !isObject(n) || Object.keys(n).some(k => !['field', 'arguments', 'children', 'on_type'].includes(k))) invalid();
      if (n.on_type !== undefined) {
        if (n.field !== undefined || n.arguments !== undefined || !t.possible_types?.includes(n.on_type) || seen.has('on:' + n.on_type)) invalid();
        seen.add('on:' + n.on_type);
        const child = selectionText(n.on_type, n.children, depth + 1, multiplier);
        wire.push('... on ' + n.on_type + '{' + child.text + '}'); result.push({ on_type: n.on_type, children: child.selection }); continue;
      }
      const field = n.field;
      if (typeof field !== 'string' || seen.has(field)) invalid(); seen.add(field);
      if (field === '__typename') {
        if (n.arguments || n.children) invalid(); wire.push(field); result.push({ field, type: 'String!' }); continue;
      }
      const def = t.fields?.[field];
      if (!def || ['DelegateAccessToken', 'StorefrontAccessToken'].includes(base(def.type))) invalid();
      const a = pageArguments(def.args, n.arguments || {}); checkArguments(def.input_schema, a);
      const childType = source().output[base(def.type)], composite = !['SCALAR', 'ENUM'].includes(childType.kind);
      let budget = multiplier;
      if (def.type.includes('[') && !['nodes', 'edges'].includes(field) && !a.first && !a.last) budget *= 100;
      if (a.first || a.last) budget *= a.first || a.last;
      if (composite) { projectedObjects += budget; if (projectedObjects > 1000) invalid(); }
      const child = composite ? selectionText(def.type, n.children || defaultSelection(def.type), depth + 1, budget) : selectionText(def.type, n.children, depth + 1, budget);
      const argText = argumentsText(def.args, a);
      wire.push(field + (argText ? '(' + argText + ')' : '') + (child.text ? '{' + child.text + '}' : ''));
      result.push({ field, type: def.type, children: child.selection });
    }
    if (t.possible_types?.length && !seen.has('__typename')) { wire.unshift('__typename'); result.unshift({ field: '__typename', type: 'String!' }); }
    return { text: wire.join(' '), selection: result };
  }
  const selection = selectionText(row.output_type, selected, 0, args.first || args.last || 1);
  let directive = '';
  if (row.idempotency) { variables.idempotencyKey = randomUUID(); declarations.push('$idempotencyKey:String!'); directive = ' @idempotent(key:$idempotencyKey)'; }
  return { query: row.kind + (declarations.length ? '(' + declarations.join(',') + ')' : '') + '{' + name + (rootArgs ? '(' + rootArgs + ')' : '') + directive + (selection.text ? '{' + selection.text + '}' : '') + '}', variables, selection: selection.selection, row };
}
function project(type, value, selection) {
  if (value === null) { if (type.endsWith('!')) fail('E_TOOL_CALL_UPSTREAM', 'Shopify returned an incomplete business acknowledgement'); return null; }
  const nullable = type.endsWith('!') ? type.slice(0, -1) : type;
  if (nullable.startsWith('[')) {
    if (!Array.isArray(value)) fail('E_TOOL_CALL_UPSTREAM', 'Shopify returned an invalid result collection');
    return value.map(item => project(nullable.slice(1, -1), item, selection));
  }
  const t = source().output[nullable];
  if (t.kind === 'SCALAR' || t.kind === 'ENUM') {
    const valid = nullable === 'JSON' ? value !== undefined : nullable === 'Int' ? Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 : nullable === 'Float' ? typeof value === 'number' && Number.isFinite(value) : nullable === 'Boolean' ? typeof value === 'boolean' : typeof value === 'string';
    if (!valid || (t.kind === 'ENUM' && !t.values.includes(value))) fail('E_TOOL_CALL_UPSTREAM', 'Shopify returned an invalid result field');
    return value;
  }
  if (!isObject(value)) fail('E_TOOL_CALL_UPSTREAM', 'Shopify returned an invalid business acknowledgement');
  const output = {};
  for (const n of selection) {
    if (n.on_type) { if (value.__typename === n.on_type) Object.assign(output, project(n.on_type, value, n.children)); continue; }
    if (!Object.hasOwn(value, n.field)) fail('E_TOOL_CALL_UPSTREAM', 'Shopify omitted a requested result field');
    output[n.field] = n.field === '__typename' ? project('String!', value[n.field], []) : project(n.type, value[n.field], n.children);
  }
  if (t.possible_types?.length && !t.possible_types.includes(output.__typename)) fail('E_TOOL_CALL_UPSTREAM', 'Shopify returned an invalid result type');
  return output;
}
function clean(value, secrets) {
  if (typeof value === 'string') { for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]'); return value; }
  if (Array.isArray(value)) return value.map(v => clean(v, secrets));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, clean(v, secrets)]));
}
async function execute(config, name, p = {}, owners) {
  if (config.provider !== 'shopify' || !/^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/.test(config.metadata.shop_domain || '')) invalid();
  const built = build(name, p), token = await owners.token(config), deadline = AbortSignal.timeout(60000);
  let response, text;
  try { response = await requestFetch('https://' + config.metadata.shop_domain + '/admin/api/' + source().api_version + '/graphql.json', { method: 'POST', redirect: 'error', signal: deadline, headers: { accept: 'application/json', 'content-type': 'application/json', 'x-shopify-access-token': token }, body: JSON.stringify({ query: built.query, variables: built.variables }) }); }
  catch (error) { fail(requestFailureCode(error, deadline), 'Shopify request failed; inspect state before retrying an uncertain write'); }
  if (!response.ok) throw httpFailure(response.status, 'Shopify request failed (HTTP ' + response.status + ')');
  try { text = await readBody(response); } catch (error) { fail(error?.code === 'E_CONNECTOR_RESPONSE_TOO_LARGE' ? 'E_TOOL_CALL_UPSTREAM' : requestFailureCode(error, deadline), 'Shopify response could not be read'); }
  let body; try { body = JSON.parse(text); } catch { fail('E_TOOL_CALL_UPSTREAM', 'Shopify returned invalid JSON'); }
  if (body?.errors !== undefined && !Array.isArray(body.errors)) fail('E_TOOL_CALL_UPSTREAM', 'Shopify returned an invalid error envelope');
  if (body?.errors?.length) {
    const codes = body.errors.map(e => e?.extensions?.code);
    fail(codes.includes('THROTTLED') ? 'E_TOOL_CALL_RATE_LIMIT' : codes.includes('ACCESS_DENIED') ? 'E_TOOL_CALL_AUTH' : 'E_TOOL_CALL_UPSTREAM', 'Shopify GraphQL request failed');
  }
  if (!isObject(body?.data) || !Object.hasOwn(body.data, name)) fail('E_TOOL_CALL_UPSTREAM', 'Shopify omitted the business acknowledgement');
  const data = project(built.row.output_type, body.data[name], built.selection);
  if (built.row.kind === 'mutation' && !isObject(data)) fail('E_TOOL_CALL_UPSTREAM', 'Shopify omitted the mutation acknowledgement');
  let errors = 0;
  if (built.row.kind === 'mutation') for (const key of Object.keys(data)) if (key.toLowerCase().endsWith('usererrors')) { errors += data[key].length; delete data[key]; }
  const result = { data: { [name]: clean(data, [token, config.credentials.client_secret, config.credentials.client_id]) } };
  if (built.row.kind === 'mutation') {
    if (!errors && !Object.entries(data).some(([key, value]) => key !== '__typename' && value !== null)) fail('E_TOOL_CALL_UPSTREAM', 'Shopify returned no business acknowledgement');
    result.status = errors ? 'partial_or_failed' : 'acknowledged';
    if (errors) result.error_count = errors;
  }
  const cost = body.extensions?.cost;
  if (cost && ['requestedQueryCost', 'actualQueryCost'].every(k => Number.isFinite(cost[k]) && cost[k] >= 0)) result.cost = { requested: cost.requestedQueryCost, actual: cost.actualQueryCost };
  return result;
}
module.exports = { actionsFor, isNative, describeOutputType, build, execute };
