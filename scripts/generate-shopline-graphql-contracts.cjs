'use strict';
// Offline compiler of current-index SHOPLINE public GraphQL machine documents.
const fs = require('node:fs');
const path = require('node:path');
const evidence = JSON.parse(fs.readFileSync(path.join(__dirname, '../test/fixtures/connectors/official-contracts/shopline-graphql-20261001.json'), 'utf8'));
const models = evidence.models;
const types = Object.fromEntries(Object.values(models).filter(t => !['Query', 'Mutation'].includes(t.kind)).map(t => [t.name, t]));
for (const name of ['String','Int','Float','ID','Boolean','Date','Decimal','Money','UnsignedInt64','URL','URI']) types[name] = { name, kind: 'Scalar' };
const base = t => t.replace(/[\[\]!]/g, '');
const definitions = {};
const object = properties => ({ type: 'object', properties, additionalProperties: false });
function schema(type) {
  if (!type.endsWith('!')) return { anyOf: [nonnull(type), { type: 'null' }] };
  return nonnull(type.slice(0,-1));
}
function nonnull(type) {
  if (type.startsWith('[')) return { type: 'array', items: schema(type.slice(1,-1)), maxItems: 100 };
  const t = types[type];
  if (!t) throw new Error('Missing declared SHOPLINE type: '+type);
  if (t.kind === 'Enum' || t.kind === 'Input') return { $ref: '#/$defs/'+type };
  if (t.kind !== 'Scalar') throw new Error('Output type used as input');
  if (type === 'Int') return { type: 'integer', minimum: -2147483648, maximum: 2147483647 };
  if (type === 'Float') return { type: 'number' };
  if (type === 'Boolean') return { type: 'boolean' };
  if (type === 'ID') return { anyOf: [{type:'string',minLength:1,maxLength:2048},{type:'integer',minimum:Number.MIN_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER}] };
  if (type === 'UnsignedInt64') return {type:'string',pattern:'^(?:0|[1-9][0-9]{0,19})$',maxLength:20};
  return { type: 'string', maxLength: 262144 };
}
function declaredDefault(field) {
  if(field.defaultValue===undefined || field.defaultValue===null || field.defaultValue==='') return undefined;
  let value=JSON.parse(field.defaultValue);
  // Four canonical Boolean arguments are double-quoted in the official docs.
  if(base(field.type)==='Boolean' && (value==='true'||value==='false')) value=value==='true';
  return value;
}
function argumentsSchema(fields) {
  const result = object(Object.fromEntries(fields.map(f => [f.name, {...schema(f.type), ...(declaredDefault(f)!==undefined?{default:declaredDefault(f)}:{}), ...(f.description ? {description:f.description} : {})}])));
  result.required = fields.filter(f => f.type.endsWith('!') && declaredDefault(f)===undefined).map(f => f.name);
  for (const key of ['first','last']) if (result.properties[key]) result.properties[key] = {type:'integer',minimum:1,maximum:100,description:fields.find(f=>f.name===key).description};
  return result;
}
for (const t of Object.values(types)) {
  if (t.kind === 'Enum') definitions[t.name] = {type:'string',enum:t.values};
  if (t.kind === 'Input') definitions[t.name] = argumentsSchema(t.fields||[]);
}
function closure(s, result = new Set()) {
  if (!s || typeof s !== 'object') return result;
  if (s.$ref) { const id = s.$ref.slice(8); if (!result.has(id)) {result.add(id);closure(definitions[id],result);} }
  for (const [key,value] of Object.entries(s)) if (key !== 'description') {
    if (Array.isArray(value)) value.forEach(v=>closure(v,result)); else if (value&&typeof value==='object') closure(value,result);
  }
  return result;
}
definitions.Selection=object({field:{type:'string',pattern:'^[_A-Za-z][_0-9A-Za-z]*$'},arguments:{type:'object'},children:{type:'array',minItems:1,maxItems:100,items:{$ref:'#/$defs/Selection'}},on_type:{type:'string',pattern:'^[_A-Za-z][_0-9A-Za-z]*$'}});
const selection={type:'array',minItems:1,maxItems:100,items:{$ref:'#/$defs/Selection'},description:'Typed output fields and nested arguments; on_type selects a union/interface member. Defaults to a small summary. Maximum depth 8, 100 field nodes, 100 rows per connection and 1000 projected objects. No raw GraphQL.'};
const methods={};
const activeTypes=new Set();
function retain(name){if(activeTypes.has(name))return;activeTypes.add(name);const t=types[name];if(!t)throw new Error('Missing reachable type '+name);for(const f of t.fields||[]){retain(base(f.type));for(const a of f.args||[])retain(base(a.type));}for(const n of t.possible_types||[])retain(n);}
for(const row of evidence.inventory){
 if(row.group!=='ordinary_merchant')continue;
 const root=models[row.id],args=root.args,input=object({arguments:argumentsSchema(args),selection});
 if(input.properties.arguments.required.length)input.required=['arguments'];
 retain(base(root.output_type));for(const a of args)retain(base(a.type));
 const scopes=Array.isArray(row.scope)?row.scope:row.scope?[row.scope]:[];
 methods['GRAPHQL '+root.name]={kind:root.kind.toLowerCase(),root:root.name,risk:row.risk,description:root.description.split('\n')[0].slice(0,180),requirements:scopes.length?scopes:['Existing private-app Admin API grant; exact root scope not stated in the official document'],documentation_url:row.source,input_schema:input,input_definitions:[...closure(input)],args:Object.fromEntries(args.map(a=>[a.name,a.type])),output_type:root.output_type,output_fields:(types[base(root.output_type)].fields||[]).map(f=>({field:f.name,type:f.type})),errors_only_ack:['inventoryAdjustQuantities','inventorySetOnHandQuantities'].includes(root.name)};
}
const output=Object.fromEntries([...activeTypes].filter(n=>types[n].kind!=='Input').sort().map(n=>{const t=types[n];return[n,{kind:t.kind.toUpperCase(),...(t.values?{values:t.values}:{}),...(t.possible_types?{possible_types:t.possible_types}:{}),...(t.fields?{fields:Object.fromEntries(t.fields.map(f=>[f.name,{type:f.type,args:Object.fromEntries((f.args||[]).map(a=>[a.name,{type:a.type,default:declaredDefault(a)??null}])),input_schema:argumentsSchema(f.args||[])}]))}:{})}];}));
for(const name of Object.keys(definitions))if(name!=='Selection'&&!activeTypes.has(name))delete definitions[name];
const result={api_version:evidence.api_version,source_sha256:evidence.source_sha256,methods,definitions,output};
const destination=process.argv[2]||path.join(__dirname,'../bin/shopline-graphql-contracts.cjs');
fs.writeFileSync(destination,"'use strict';\n// Generated offline; see generate-shopline-graphql-contracts.cjs.\nmodule.exports = "+JSON.stringify(result)+';\n');
console.log('Generated '+Object.keys(methods).length+' SHOPLINE GraphQL merchant contracts');
