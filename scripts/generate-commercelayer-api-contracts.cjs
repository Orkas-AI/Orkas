'use strict';

// Generate only pinned provider contracts. The official resource registry fills
// OpenAPI omissions: relationship cardinality, filtering and sorting capabilities.
const fs=require('node:fs'),path=require('node:path');
const evidence=JSON.parse(fs.readFileSync(path.join(__dirname,'../test/fixtures/connectors/official-contracts/commercelayer-20261001.json'),'utf8'));
const model=evidence.model,definitions={},methods={},modes={R:100,W:25,H:10,D:10,output:0};
for(const mode of Object.keys(modes))definitions[mode]={};
function original(ref){if(!ref.startsWith('#/'))throw new Error('External schema is unavailable');return ref.slice(2).split('/').reduce((value,key)=>value?.[key.replace(/~1/g,'/').replace(/~0/g,'~')],model);}
function convert(raw,mode){
  if(typeof raw==='boolean')return raw;
  if(!raw || typeof raw!=='object')throw new Error('Unknown official schema');
  if(raw.$ref){const id=raw.$ref.slice('#/components/schemas/'.length).replaceAll('/','__');if(!Object.hasOwn(definitions[mode],id)){definitions[mode][id]={};definitions[mode][id]=convert(original(raw.$ref),mode);}return {$ref:'#/$defs/'+id};}
  const input=mode!=='output',s=Object.fromEntries(['type','enum','required','minimum','maximum','minLength','maxLength','pattern','minItems','maxItems','description'].filter(k=>Object.hasOwn(raw,k) && (input || ['type'].includes(k))).map(k=>[k,raw[k]]));
  if(raw.properties){s.properties=Object.fromEntries(Object.entries(raw.properties).map(([key,child])=>[key,convert(child,mode)]));s.additionalProperties=input?Object.keys(raw.properties).length===0:true;}
  if(raw.items){s.items=convert(raw.items,mode);if(input)s.maxItems=Math.min(raw.maxItems ?? modes[mode],modes[mode]);}
  if(raw.oneOf)s[input?'oneOf':'anyOf']=raw.oneOf.map(child=>convert(child,mode));
  const types=Array.isArray(s.type)?s.type:[s.type];
  if(input && types.includes('integer')){s.minimum=s.minimum ?? Number.MIN_SAFE_INTEGER;s.maximum=s.maximum ?? Number.MAX_SAFE_INTEGER;}
  if(input && types.includes('string'))s.maxLength=s.maxLength ?? 256*1024;
  return s;
}
function closure(s,mode,ids=new Set()){
  if(!s||typeof s!=='object')return ids;
  if(s.$ref){const id=s.$ref.slice('#/$defs/'.length);if(!ids.has(id)){ids.add(id);closure(definitions[mode][id],mode,ids);}}
  for(const [key,value]of Object.entries(s))if(key!=='$ref')if(Array.isArray(value))value.forEach(child=>closure(child,mode,ids));else closure(value,mode,ids);
  return ids;
}
const obj=()=>({type:'object',properties:{},required:[],additionalProperties:false});
const scalar={type:['string','number','boolean'],maxLength:4096};
const publicResources=Object.fromEntries(Object.entries(evidence.resource_mapping).map(([type,mapping])=>[type,{...evidence.resources[mapping.registry],component:mapping.component}]));
const classMap=Object.fromEntries(Object.entries(evidence.resource_mapping).map(([type,mapping])=>[mapping.component[0].toUpperCase()+mapping.component.slice(1),type]));
for(const meta of Object.values(publicResources))for(const relation of Object.values(meta.relationships))relation.target=classMap[relation.class_name];
function queryFor(resource,many,risk){
  const list={type:'array',items:{type:'string',minLength:1,maxLength:512},maxItems:modes[risk]};
  const meta=publicResources[resource],query=obj();
  query.properties.include={...list,description:'Published relationship paths, optionally nested with dots. Includes only fetchable resource associations.'};
  query.properties.fields={type:'object',additionalProperties:{...list},maxProperties:25,description:'Map resource type to requested attributes or relationships; serialized as fields[type]=field1,field2.'};
  if(many){
    query.properties.page={type:'object',properties:{number:{type:'integer',minimum:1,maximum:1000000},size:{type:'integer',minimum:1,maximum:25}},additionalProperties:false};
    query.properties.sort={...list,description:'Sortable fields (prefix - for descending): '+Object.entries(meta.fields).filter(([,v])=>v.sortable).map(([k])=>k).join(',')+'. Relationships use dot notation.'};
    const filters=Object.fromEntries([...new Set([...meta.filters,...meta.filter_scopes])].filter(k=>k!=='q').map(k=>[k,{anyOf:[scalar,{type:'array',items:scalar,maxItems:100}]}]));
    filters.q={type:'object',additionalProperties:{anyOf:[scalar,{type:'array',items:scalar,maxItems:100}]},maxProperties:100,description:'Official predicates such as field_eq/field_in/field_gteq. Filterable fields: '+Object.entries(meta.fields).filter(([,v])=>v.filterable).map(([k])=>k).join(',')+'. Relationship predicates use underscores; OR fields use _or_.'};
    query.properties.filter={type:'object',properties:filters,additionalProperties:false};
  }
  return query;
}
for(const row of evidence.inventory){
  if(row.excluded_reason)continue;
  const op=model.paths[row.path][row.method.toLowerCase()],input=obj();
  for(const parameter of op.parameters || []){
    if(parameter.in!=='path')throw new Error('Unreviewed caller transport');
    const group=input.properties.path ||= obj();group.properties[parameter.name]={type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9_-]+$'};
    if(parameter.required){group.required.push(parameter.name);if(!input.required.includes('path'))input.required.push('path');}
  }
  if(row.method!=='DELETE'){
    const many=row.method==='GET' && row.many,id='Query__'+row.target+'__'+(many?'list':'single');
    definitions[row.risk][id] ||= queryFor(row.target,many,row.risk);
    input.properties.query={$ref:'#/$defs/'+id};
  }
  if(op.requestBody){input.properties.body=convert(op.requestBody.content['application/vnd.api+json'].schema,row.risk);if(op.requestBody.required)input.required.push('body');}
  methods[row.action]={method:row.method,path:row.path,resource:row.resource,target:row.target,many:row.many,relationship:row.relationship,risk:row.risk,
    description:row.summary+'. '+(row.method==='GET'?'One explicit page; no automatic pagination.':'Provider acknowledgement only; inspect state before retrying an uncertain write.')+' https://docs.commercelayer.io/core-api-reference/'+row.resource,
    input_schema:input,input_definitions:[...closure(input,row.risk)],statuses:Object.keys(op.responses).filter(status=>/^2\d\d$/.test(status)).map(Number)};
}
const responseAttributes={};
for(const [resource,meta] of Object.entries(publicResources)){
  const raw=model.components.schemas[meta.component].properties.data.properties.attributes;
  const schema=convert(raw,'output');responseAttributes[resource]={schema,definitions:[...closure(schema,'output')]};
}
// Descriptive source metadata stays in evidence; runtime keeps only structural
// query and response constraints, with no per-operation graph duplication.
const resources=Object.fromEntries(Object.entries(publicResources).map(([type,meta])=>[type,{fields:Object.fromEntries(Object.entries(meta.fields).map(([name,field])=>[name,{filterable:!!field.filterable,sortable:!!field.sortable,fetchable:!!field.fetchable}])),relationships:Object.fromEntries(Object.entries(meta.relationships).map(([name,rel])=>[name,{target:rel.target,many:rel.type==='has_many',filterable:!!rel.filterable,sortable:!!rel.sortable}])),filters:meta.filters,filter_scopes:meta.filter_scopes,response_attributes:responseAttributes[type]}]));
fs.writeFileSync(path.join(__dirname,'../bin/commercelayer-api-contracts.cjs'),"'use strict';\n// Generated offline from pinned official OpenAPI and resource metadata.\nmodule.exports = "+JSON.stringify({documentation_snapshot:evidence.documentation_snapshot,api_version:evidence.api_version,source_sha256:evidence.source_sha256,methods,definitions,resources},null,2)+';\n');
console.log('Generated '+Object.keys(methods).length+' Commerce Layer merchant contracts');
