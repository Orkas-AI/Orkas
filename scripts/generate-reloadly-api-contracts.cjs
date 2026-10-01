'use strict';

// Offline generation from the current official per-product OpenAPI downloads.
const fs = require('node:fs'), path = require('node:path');
const evidence = require('../test/fixtures/connectors/official-contracts/reloadly-20261001.json');
const methods = {};
const object = () => ({ type: 'object', properties: {}, additionalProperties: false });
const PURCHASES = new Set(['/topups', '/topups-async', '/orders', '/pay']);
function convert(value, definitions, seen = new Set()) {
  if (!value || typeof value !== 'object') return value;
  if (value.$ref) {
    const name = value.$ref.split('/').pop();
    if (seen.has(name) || !definitions[name]) throw new Error('Unresolved or cyclic Reloadly input');
    return convert(definitions[name], definitions, new Set([...seen, name]));
  }
  const out = {};
  for (const key of ['type', 'description', 'required', 'enum', 'default', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems']) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  if (value.properties) out.properties = Object.fromEntries(Object.entries(value.properties).map(([key, item]) => [key, convert(item, definitions, seen)]));
  if (value.items) out.items = convert(value.items, definitions, seen);
  for (const key of ['oneOf', 'anyOf', 'allOf']) if (value[key]) out[key] = value[key].map(item => convert(item, definitions, seen));
  if (value.type === 'object') out.additionalProperties = value.additionalProperties ?? !value.properties;
  if (value.type === 'array' && out.maxItems === undefined) out.maxItems = 100;
  if (value.type === 'string' && out.maxLength === undefined) out.maxLength = 4096;
  if (value.nullable && typeof out.type === 'string') out.type = [out.type, 'null'];
  return out;
}
for (const [product, entry] of Object.entries(evidence.products)) {
  const model = entry.model;
  for (const [route, item] of Object.entries(model.paths)) {
    if (route === '/oauth/token') continue;
    for (const method of ['get', 'post']) {
      const op = item[method]; if (!op) continue;
      const input = object(), wire = [];
      for (const parameter of op.parameters || []) {
        if (parameter.in === 'header') continue;
        if (!['path', 'query'].includes(parameter.in)) throw new Error('Unsupported Reloadly parameter location');
        const schema = convert(parameter.schema, model.components.schemas);
        if (parameter.in === 'path' && parameter.name === 'phone') Object.assign(schema, { type: 'string', minLength: 1, maxLength: 32, pattern: '^\\+?[0-9]+$' });
        if (parameter.in === 'path' && schema.type === 'integer') {
          delete schema.type;
          schema.anyOf = [{ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, { type: 'string', minLength: 1, maxLength: 128, pattern: '^[1-9][0-9]*$' }];
        }
        if (parameter.in === 'query' && parameter.name === 'size') Object.assign(schema, { minimum: 1, maximum: 100, default: 20 });
        if (parameter.in === 'query' && parameter.name === 'page') Object.assign(schema, { minimum: 1 });
        const group = input.properties[parameter.in] ||= object();
        group.properties[parameter.name] = schema;
        if (parameter.required) (group.required ||= []).push(parameter.name);
        wire.push({ location: parameter.in, name: parameter.name });
      }
      const content = op.requestBody?.content;
      if (content) {
        const json = content['application/json'];
        if (!json?.schema) throw new Error('Unsupported Reloadly request media');
        input.properties.body = convert(json.schema, model.components.schemas);
        (input.required ||= []).push('body');
      }
      for (const location of ['path', 'query']) if (input.properties[location]?.required?.length) (input.required ||= []).push(location);
      const purchase = PURCHASES.has(route), paidLookup = route.includes('mnp-lookup');
      if (purchase) {
        const body = input.properties.body, key = product === 'utilities' ? 'referenceId' : 'customIdentifier';
        body.required = [...new Set([...(body.required || []), key])];
        Object.assign(body.properties[key], { minLength: 3, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$' });
        if (product === 'airtime') {
          body.required = body.required.filter(name => name !== 'recipientPhone');
          body.anyOf = [{ required: ['recipientPhone'] }, { required: ['recipientEmail'] }];
        }
      }
      const responseContent = op.responses['200']?.content;
      if (!responseContent) throw new Error('Missing Reloadly response contract');
      const accept = Object.keys(responseContent).find(media => media.startsWith('application/com.reloadly.')) || 'application/json';
      if (route.endsWith('/cards')) input.properties.redemption_version = { type: 'integer', enum: [1, 2], default: 2, description: 'Gift-card redemption response version; version 2 supports redemption URLs.' };
      const stem = op.operationId.includes('/') ? op.operationId.slice(op.operationId.indexOf('/') + 1) : op.operationId;
      const name = product + '.' + (paidLookup ? 'number-lookup-' + method : stem);
      if (methods[name]) throw new Error('Duplicate Reloadly operation');
      methods[name] = { product, method: method.toUpperCase(), path: route, operation_id: op.operationId,
        risk: purchase || paidLookup || route.endsWith('/cards') ? 'H' : 'R', purchase, paid_lookup: paidLookup,
        description: op.summary || op.description, input_schema: input, wire, accept, source_url: entry.url };
    }
  }
}
const output = "'use strict';\n// Generated by scripts/generate-reloadly-api-contracts.cjs; do not edit.\nmodule.exports=" + JSON.stringify({ methods }) + ';\n';
fs.writeFileSync(path.resolve(__dirname, '../bin/reloadly-api-contracts.cjs'), output);
console.log(JSON.stringify({ operations: Object.keys(methods).length }));
