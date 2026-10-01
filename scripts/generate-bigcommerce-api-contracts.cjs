'use strict';

// Offline conversion of the pinned current official specifications. Contracts
// remain provider-owned actions behind the existing commerce MCP meta-tools.
const fs=require('node:fs'),path=require('node:path');
const evidence=JSON.parse(fs.readFileSync(path.join(__dirname,'../test/fixtures/connectors/official-contracts/bigcommerce-20261001.json'),'utf8'));
const definitions={},methods={};
const allowed=['type','enum','const','required','minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','minLength','maxLength','pattern','minItems','maxItems','uniqueItems','minProperties','maxProperties','description'];
// The current generated source has two non-ECMAScript regex typos.
const patternRepairs={'[a-zA-Z0-9_\\ -]':'[a-zA-Z0-9_ -]','^\\+?[1-9]\\d{1,14}(x\\d{1-5})?$':'^\\+?[1-9]\\d{1,14}(x\\d{1,5})?$'};
const modes={R:100,W:25,H:10,D:10,output:0};
function convert(raw,model,mode) {
  if(typeof raw==='boolean')return raw;
  if(!raw || typeof raw!=='object')throw new Error('Invalid official schema');
  const input=mode!=='output';
  if(raw.$ref){
    if(!raw.$ref.startsWith('#/components/schemas/'))throw new Error('Unresolved external official schema');
    const name=raw.$ref.slice('#/components/schemas/'.length),id=model+'__'+name;
    const original=evidence.models[model].components.schemas[name];if(!original)throw new Error('Missing official schema: '+id);
    if(!Object.hasOwn(definitions[mode],id)){definitions[mode][id]={};definitions[mode][id]=convert(original,model,mode);}
    const siblings={...raw};delete siblings.$ref;
    return {$ref:'#/$defs/'+id,...convert(siblings,model,mode)};
  }
  const s=Object.fromEntries(allowed.filter(k=>Object.hasOwn(raw,k) && (input || ['type','required'].includes(k))).map(k=>[k,raw[k]]));
  if(input && s.pattern && patternRepairs[s.pattern])s.pattern=patternRepairs[s.pattern];
  if(raw.properties){
    s.type ||= 'object';s.properties=Object.fromEntries(Object.entries(raw.properties).filter(([,value])=>!input || !value.readOnly).map(([key,value])=>[key,convert(value,model,mode)]));
    if(input && s.required)s.required=s.required.filter(key=>!raw.properties[key]?.readOnly);
    s.additionalProperties=input ? (raw.additionalProperties===true || Object.keys(raw.properties).length===0) : true;
  }
  if(typeof raw.additionalProperties==='object')s.additionalProperties=convert(raw.additionalProperties,model,mode);
  else if(raw.additionalProperties!==undefined)s.additionalProperties=input ? raw.additionalProperties : true;
  if(raw.items){s.items=convert(raw.items,model,mode);if(input)s.maxItems=Math.min(raw.maxItems ?? modes[mode],modes[mode]);}
  for(const key of ['oneOf','anyOf','allOf'])if(raw[key])s[input?key:key==='oneOf'?'anyOf':key]=raw[key].map(child=>convert(child,model,mode));
  if(raw.not)s.not=convert(raw.not,model,mode);
  const types=Array.isArray(raw.type)?raw.type:[raw.type];
  if(input && types.includes('integer')){s.minimum=Math.max(s.minimum ?? Number.MIN_SAFE_INTEGER,Number.MIN_SAFE_INTEGER);s.maximum=Math.min(s.maximum ?? Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER);}
  if(input && types.includes('string') && s.maxLength===undefined)s.maxLength=256*1024;
  return s;
}
for(const mode of Object.keys(modes))definitions[mode]={};
function closure(s,mode,ids=new Set()){
  if(!s || typeof s!=='object')return ids;
  if(s.$ref){const id=s.$ref.slice('#/$defs/'.length);if(!ids.has(id)){ids.add(id);closure(definitions[mode][id],mode,ids);}}
  for(const [key,value]of Object.entries(s))if(key!=='$ref')if(Array.isArray(value))value.forEach(child=>closure(child,mode,ids));else closure(value,mode,ids);
  return ids;
}
const obj=()=>({type:'object',properties:{},required:[],additionalProperties:false});
for(const row of evidence.inventory){
  if(row.excluded_reason)continue;
  const model=evidence.models[row.model],op=model.paths[row.path][row.method.toLowerCase()],input=obj(),wire=[];
  for(const parameter of [...(model.paths[row.path].parameters || []),...(op.parameters || [])]){
    if(parameter.name==='store_hash' && parameter.in==='path')continue;
    if(parameter.in==='header' && ['Accept','Content-Type'].includes(parameter.name) && parameter.schema?.default==='application/json')continue;
    if(!['path','query'].includes(parameter.in) && !(parameter.in==='header' && parameter.name==='X-Correlation-Id'))throw new Error('Unreviewed transport parameter');
    const group=input.properties[parameter.in] ||= obj();group.properties[parameter.name]=convert(parameter.schema,row.model,row.risk);
    if(parameter.description)group.properties[parameter.name].description=parameter.description;
    if(parameter.in==='header')group.properties[parameter.name]={type:'string',pattern:'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'};
    if(parameter.required){group.required.push(parameter.name);if(!input.required.includes(parameter.in))input.required.push(parameter.in);}
    // The official BigCommerce parameter prose defines comma-separated arrays.
    // Its generated specifications omit style/explode; keep the platform CSV wire.
    wire.push({name:parameter.name,location:parameter.in,style:parameter.style || 'form',explode:parameter.explode ?? false});
  }
  if(op.requestBody){input.properties.body=convert(op.requestBody.content['application/json'].schema,row.model,row.risk);if(op.requestBody.required)input.required.push('body');}
  const originalShape=s=>s?.$ref?model.components.schemas[s.$ref.slice('#/components/schemas/'.length)]:s;
  const partialHttp=Object.entries(op.responses).filter(([status,response])=>status==='422' && originalShape(response.content?.['application/json']?.schema)?.properties?.data && originalShape(response.content?.['application/json']?.schema)?.properties?.errors).map(([status])=>Number(status));
  const responses=Object.fromEntries(Object.entries(op.responses).filter(([status])=>/^2\d\d$/.test(status) || partialHttp.includes(Number(status))).map(([status,response])=>[status,status!=='204' && response.content?.['application/json']?.schema ? convert(response.content['application/json'].schema,row.model,'output') : null]));
  if(!Object.keys(responses).length)throw new Error('Missing authoritative acknowledgement');
  const errorPaths=[],failedCountPaths=[],failedStatusPaths=[];
  function responsePaths(s,cursor=[],seen=new Set()){
    if(!s || typeof s!=='object')return;
    if(s.$ref){const id=s.$ref.slice('#/$defs/'.length);if(seen.has(id))return;responsePaths(definitions.output[id],cursor,new Set([...seen,id]));return;}
    for(const key of ['anyOf','oneOf','allOf'])for(const child of s[key] || [])responsePaths(child,cursor,seen);
    if(s.items)responsePaths(s.items,[...cursor,'*'],seen);
    for(const [key,child]of Object.entries(s.properties || {})){
      if(key==='errors'){errorPaths.push([...cursor,key]);continue;}
      if(['failed','failed_items'].includes(key))failedCountPaths.push([...cursor,key]);
      if(child.$ref?.endsWith('__JobResponseDataStatus'))failedStatusPaths.push({path:[...cursor,key],values:['FAILED']});
      if(child.$ref?.endsWith('__ImportExportJobStatus'))failedStatusPaths.push({path:[...cursor,key],values:['failed','aborted']});
      responsePaths(child,[...cursor,key],seen);
    }
  }
  Object.values(responses).forEach(schema=>responsePaths(schema));
  methods[row.action]={operation:row.operation,method:row.method,path:row.path.replace('/stores/{store_hash}',''),risk:row.risk,
    description:op.summary+'. '+(row.risk==='R'?'One explicit page; no automatic pagination.':'Provider acknowledgement only; inspect resource state before retrying an uncertain write.')+' '+row.source_url,
    partial_http:partialHttp,error_paths:errorPaths,failed_count_paths:failedCountPaths,failed_status_paths:failedStatusPaths,
    input_schema:input,input_definitions:[...closure(input,row.risk)],wire,responses,response_definitions:[...new Set(Object.values(responses).flatMap(s=>[...closure(s,'output')]))]};
}
const data={documentation_snapshot:evidence.documentation_snapshot,source_index:evidence.source_index,methods,definitions};
fs.writeFileSync(path.join(__dirname,'../bin/bigcommerce-api-contracts.cjs'),"'use strict';\n// Generated from the pinned official BigCommerce merchant models.\nmodule.exports = "+JSON.stringify(data,null,2)+';\n');
console.log('Generated '+Object.keys(methods).length+' BigCommerce merchant contracts');
