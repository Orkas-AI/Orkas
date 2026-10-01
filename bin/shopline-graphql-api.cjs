'use strict';

const { requestFetch, requestFailureCode, httpFailure } = require('./commerce-request-context.cjs');
const storefront = require('./storefront-admin-api.cjs');
const { readBody } = storefront;
let contracts, actions, validator;
const checks = new Map(), schemas = new Map();
const source = () => contracts ||= require('./shopline-graphql-contracts.cjs');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const invalid = () => fail('E_BAD_INPUT', 'Invalid SHOPLINE fields, arguments or selection; check the described contract');
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
function describeOutputType(action, type) {
  const row = source().methods[action];
  if (!Object.hasOwn(source().methods,action) || !row || typeof type !== 'string' || !Object.hasOwn(source().output, type)) invalid();
  const queue = [base(row.output_type)], seen = new Set();
  let reachable = false;
  for (let index = 0; index < queue.length; index++) {
    const name = queue[index];
    if (seen.has(name)) continue;
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
    ...(current.possible_types ? { possible_types: current.possible_types } : {}),
    ...(current.fields ? { fields: Object.fromEntries(Object.entries(current.fields).map(([name, field]) => [name, { type: field.type, arguments: withDefinitions(field.input_schema) }])) } : {}),
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
  checkUnsigned(schema,value);
}
function checkUnsigned(schema,value){
 if(value===null||value===undefined)return;
 if(schema.$ref)return checkUnsigned(source().definitions[schema.$ref.slice(8)],value);
 if(schema.anyOf){const child=schema.anyOf.find(s=>s.type!=='null');if(child)checkUnsigned(child,value);return;}
 if(schema.pattern==='^(?:0|[1-9][0-9]{0,19})$' && BigInt(value)>18446744073709551615n)invalid();
 if(schema.type==='array')for(const item of value)checkUnsigned(schema.items,item);
 if(schema.properties)for(const [key,child]of Object.entries(schema.properties))if(Object.hasOwn(value,key))checkUnsigned(child,value[key]);
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
function defaultSelection(type, depth = 0) {
  const t = source().output[base(type)];
  if (!t || ['SCALAR', 'ENUM'].includes(t.kind)) return undefined;
  if (depth > 2 || !t.fields) return [{ field: '__typename' }];
  if (t.fields.nodes && t.fields.pageInfo) return [
    { field: 'nodes', children: defaultSelection(t.fields.nodes.type, depth + 1) },
    { field: 'pageInfo', children: [{ field: 'hasNextPage' }, { field: 'endCursor' }] },
  ];
  const fields = Object.entries(t.fields);
  const chosen = ['id', 'name', 'title', 'status', 'done', 'count', 'failedCount', 'importedCount', 'codesCount'].filter(n => t.fields[n] && ['SCALAR', 'ENUM'].includes(source().output[base(t.fields[n].type)]?.kind) && !Object.values(t.fields[n].args).some(a => a.type.endsWith('!') && a.default === null)).slice(0, 9);
  if (chosen.length) return chosen.map(field => ({ field }));
  const scalar = fields.filter(([, f]) => ['SCALAR', 'ENUM'].includes(source().output[base(f.type)]?.kind) && !Object.values(f.args).some(a => a.type.endsWith('!') && a.default === null)).slice(0, 4).map(([field]) => ({ field }));
  if (scalar.length) return scalar;
  if (t.fields.translations) return [{field:'translations',children:defaultSelection(t.fields.translations.type,depth+1)}];
  const child = fields.find(([key, f]) => !key.endsWith('Errors') && !f.type.includes('[') && !Object.values(f.args).some(a => a.type.endsWith('!') && a.default === null));
  return child ? [{ field: child[0], children: defaultSelection(child[1].type, depth + 1) }] : [{ field: '__typename' }];
}
function pageArguments(fields, args) {
  const result = { ...args };
  if (Object.hasOwn(fields, 'first') && !Object.hasOwn(result, 'first') && !Object.hasOwn(result, 'last')) result.first = 20;
  for (const key of ['first', 'last']) if (Object.hasOwn(result, key) && (!Number.isInteger(result[key]) || result[key] < 1 || result[key] > 100)) invalid();
  if (result.first !== undefined && result.last !== undefined) invalid();
  return result;
}
function build(name, p = {}) {
  const row = Object.hasOwn(source().methods, name) && source().methods[name];
  if (!row) invalid();
  bounded(p); check(inputFor(name), p);
  let args = pageArguments(Object.fromEntries(Object.keys(row.args).map(k => [k, true])), p.arguments || {});
  checkArguments(row.input_schema.properties.arguments, args);
  const root = source().output[base(row.output_type)];
  let selected = p.selection ? structuredClone(p.selection) : defaultSelection(row.output_type);
  if (row.kind === 'mutation' && root.fields) {
    selected = [...(selected || [])];
    const required = Object.entries(root.fields).filter(([field])=>field!=='userErrors').map(([field,definition])=>({field,...(defaultSelection(definition.type)?{children:defaultSelection(definition.type)}:{})}));
    for (const [field, definition] of Object.entries(root.fields)) if (field === 'userErrors') {
      const errorType = source().output[base(definition.type)];
      required.push({field, children:['field','message','code'].filter(k=>errorType.fields?.[k]).map(field=>({field}))});
    }
    // Business acknowledgement and error fields remain mandatory under any projection.
    function merge(target, additions) {
      for (const node of additions) {
        const found=target.find(n=>n.field===node.field && n.on_type===node.on_type);
        if(!found)target.push(node);
        else if(node.children){found.children=[...(found.children||[])];merge(found.children,node.children);}
      }
    }
    if(row.errors_only_ack && !p.selection)selected=[];
    merge(selected, required);
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
      const def = t.fields && Object.hasOwn(t.fields, field) && t.fields[field];
      if (!def) invalid();
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
  return { query: row.kind + (declarations.length ? '(' + declarations.join(',') + ')' : '') + '{' + row.root + (rootArgs ? '(' + rootArgs + ')' : '') + (selection.text ? '{' + selection.text + '}' : '') + '}', variables, selection: selection.selection, row };
}
function project(type, value, selection) {
  if (value === null) { if (type.endsWith('!')) fail('E_TOOL_CALL_UPSTREAM', 'SHOPLINE returned an incomplete business acknowledgement'); return null; }
  const nullable = type.endsWith('!') ? type.slice(0, -1) : type;
  if(value instanceof IntegerToken)value=nullable==='UnsignedInt64'?value.text:Number(value.text);
  if (nullable.startsWith('[')) {
    if (!Array.isArray(value)) fail('E_TOOL_CALL_UPSTREAM', 'SHOPLINE returned an invalid result collection');
    return value.map(item => project(nullable.slice(1, -1), item, selection));
  }
  const t = source().output[nullable];
  if (t.kind === 'SCALAR' || t.kind === 'ENUM') {
    const valid = nullable === 'UnsignedInt64' ? ((typeof value === 'string' && /^(?:0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n)) : nullable === 'Int' ? Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 : nullable === 'Float' ? typeof value === 'number' && Number.isFinite(value) : nullable === 'Boolean' ? typeof value === 'boolean' : typeof value === 'string';
    if (!valid || (t.kind === 'ENUM' && !t.values.includes(value))) fail('E_TOOL_CALL_UPSTREAM', 'SHOPLINE returned an invalid result field');
    return value;
  }
  if (!isObject(value)) fail('E_TOOL_CALL_UPSTREAM', 'SHOPLINE returned an invalid business acknowledgement');
  const output = {};
  for (const n of selection) {
    if (n.on_type) { if (value.__typename === n.on_type) Object.assign(output, project(n.on_type, value, n.children)); continue; }
    if (!Object.hasOwn(value, n.field)) fail('E_TOOL_CALL_UPSTREAM', 'SHOPLINE omitted a requested result field');
    output[n.field] = n.field === '__typename' ? project('String!', value[n.field], []) : project(n.type, value[n.field], n.children);
  }
  if (t.possible_types?.length && !t.possible_types.includes(output.__typename)) fail('E_TOOL_CALL_UPSTREAM', 'SHOPLINE returned an invalid result type');
  return output;
}
function clean(value, secrets) {
  if (typeof value === 'string') { for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]'); return value; }
  if (Array.isArray(value)) return value.map(v => clean(v, secrets));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, clean(v, secrets)]));
}
// Keep unsafe integer tokens exact until the declared scalar determines the wire type.
class IntegerToken { constructor(text) { this.text=text; } }
function parseBody(text) {
  return JSON.parse(text,(_key,value,context)=>typeof value==='number' && !Number.isSafeInteger(value) && /^-?(?:0|[1-9][0-9]*)$/.test(context.source) ? new IntegerToken(context.source) : value);
}
function errorDetails(errors) {
  return errors.slice(0,100).map(error=>({
    ...(typeof error?.extensions?.code==='string'?{code:error.extensions.code.slice(0,128)}:{}),
    ...(typeof error?.extensions?.classification==='string'?{classification:error.extensions.classification.slice(0,128)}:{}),
    ...(Array.isArray(error?.path)?{path:error.path.filter(p=>typeof p==='string'||Number.isSafeInteger(p)).slice(0,30)}:{}),
  }));
}
async function execute(config,name,p={}) {
  if(config.provider!=='shopline')invalid();
  storefront.validateBinding(config);
  const built=build(name,p),token=config.credentials.access_token,deadline=AbortSignal.timeout(60000);
  const endpoint=new URL(storefront.apiBase(config.provider,config.metadata));
  endpoint.pathname='/admin/graph/'+source().api_version+'/graphql.json';
  let response,text;
  try { response=await requestFetch(endpoint.toString(),{method:'POST',redirect:'error',signal:deadline,headers:{accept:'application/json','content-type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({query:built.query,variables:built.variables})}); }
  catch(error){fail(requestFailureCode(error,deadline),'SHOPLINE request failed; inspect state before retrying an uncertain write');}
  if(!response.ok)throw httpFailure(response.status,'SHOPLINE request failed (HTTP '+response.status+')');
  try{text=await readBody(response);}catch(error){fail(error?.code==='E_CONNECTOR_RESPONSE_TOO_LARGE'?'E_TOOL_CALL_UPSTREAM':requestFailureCode(error,deadline),'SHOPLINE response could not be read');}
  let body;try{body=parseBody(text);}catch{fail('E_TOOL_CALL_UPSTREAM','SHOPLINE returned invalid JSON');}
  if(!isObject(body)||(body.errors!==undefined&&!Array.isArray(body.errors)))fail('E_TOOL_CALL_UPSTREAM','SHOPLINE returned an invalid error envelope');
  const errors=body.errors||[],root=built.row.root;
  if(errors.some(e=>!isObject(e)))fail('E_TOOL_CALL_UPSTREAM','SHOPLINE returned an invalid error acknowledgement');
  const result={data:{}};
  if(isObject(body.data)&&Object.hasOwn(body.data,root))result.data[root]=project(built.row.output_type,body.data[root],built.selection);
  else if(!errors.length)fail('E_TOOL_CALL_UPSTREAM','SHOPLINE omitted the business acknowledgement');
  let errorCount=errors.length;
  if(errors.length)result.graphql_errors=errorDetails(errors);
  const data=result.data[root];
  if(built.row.kind==='mutation' && isObject(data)){
    if(!Array.isArray(data.userErrors)||data.userErrors.some(e=>!isObject(e)))fail('E_TOOL_CALL_UPSTREAM','SHOPLINE omitted the mutation error acknowledgement');
    errorCount+=data.userErrors.length;
    // Retain structured per-item paths/codes; provider diagnostic prose can carry secrets.
    data.userErrors=data.userErrors.map(e=>Object.fromEntries(Object.entries(e).filter(([key])=>['field','code'].includes(key))));
    if(!errorCount&&!built.row.errors_only_ack&&!Object.entries(data).some(([key,value])=>!['userErrors','__typename'].includes(key)&&value!==null))fail('E_TOOL_CALL_UPSTREAM','SHOPLINE returned no business acknowledgement');
    if(!errorCount && ['productVariantsBulkCreate','productVariantsBulkUpdate'].includes(root) && data.productVariants?.length !== p.arguments.variants.length)fail('E_TOOL_CALL_UPSTREAM','SHOPLINE omitted batch variant acknowledgements; inspect variants before retrying');
    if(data.bulkCreation?.failedCount>0)errorCount+=data.bulkCreation.failedCount;
    if(data.job?.done===false||data.bulkCreation?.done===false)result.operation_state='pending';
  }else if(built.row.kind==='mutation'&&!errors.length)fail('E_TOOL_CALL_UPSTREAM','SHOPLINE omitted the mutation acknowledgement');
  if(errorCount){result.status='partial_or_failed';result.error_count=errorCount;}
  else if(built.row.kind==='mutation')result.status='acknowledged';
  // SHOPLINE documents cost-based limiting but does not promise cost extensions.
  // Preserve numeric metadata if present; never infer completion from it.
  const cost=body.extensions?.cost;
  if(isObject(cost)){
    const fields=['requestedQueryCost','actualQueryCost'];
    const safe=Object.fromEntries(fields.filter(k=>Number.isFinite(cost[k])&&cost[k]>=0).map(k=>[k,cost[k]]));
    if(Object.keys(safe).length)result.cost=safe;
  }
  return clean(result,[token]);
}
module.exports={actionsFor,isNative,describeOutputType,build,execute};
