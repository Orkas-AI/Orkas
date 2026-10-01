'use strict';

// Offline conversion of the pinned official Etsy OpenAPI inventory. Describing
// an action loads only its reachable input definitions, not the response graph.
const fs=require('node:fs'),path=require('node:path');
const evidence=JSON.parse(fs.readFileSync(path.join(__dirname,'../test/fixtures/connectors/official-contracts/etsy-20261001.json'),'utf8'));
const model=evidence.model,sourceDefs=model.components.schemas;
const keys=['type','enum','required','minLength','maxLength','minimum','maximum','minItems','maxItems','uniqueItems','pattern','multipleOf','description'];
function convert(raw,input,limit) {
  if(raw.$ref){const id=raw.$ref.slice('#/components/schemas/'.length);if(!sourceDefs[id])throw new Error('Unknown official Etsy schema reference');const s={$ref:'#/$defs/'+id};return raw.nullable?{anyOf:[s,{type:'null'}]}:s;}
  const s=Object.fromEntries(keys.filter(k=>Object.hasOwn(raw,k)&&(input||['type','required'].includes(k))).map(k=>[k,raw[k]]));
  for(const kind of ['oneOf','anyOf','allOf'])if(raw[kind])s[input?kind:kind==='oneOf'?'anyOf':kind]=raw[kind].map(child=>convert(child,input,limit));
  if(raw.type==='object'){
    if(raw.properties)s.properties=Object.fromEntries(Object.entries(raw.properties).filter(([,c])=>!input||!c.readOnly).map(([k,c])=>[k,convert(c,input,limit)]));
    s.additionalProperties=input?raw.additionalProperties===true||!raw.properties:true;
    if(typeof raw.additionalProperties==='object')s.additionalProperties=convert(raw.additionalProperties,input,limit);
    if(input&&s.required)s.required=s.required.filter(k=>!raw.properties?.[k]?.readOnly);
  }
  if(raw.type==='array'){s.items=convert(raw.items,input,limit);if(input)s.maxItems=Math.min(s.maxItems??limit,limit);}
  if(input&&raw.type==='integer'){s.minimum=Math.max(s.minimum??Number.MIN_SAFE_INTEGER,Number.MIN_SAFE_INTEGER);s.maximum=Math.min(s.maximum??Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER);}
  if(input&&raw.type==='string'&&s.maxLength===undefined)s.maxLength=256*1024;
  if(input&&raw.format==='binary'){s.minLength=4;s.pattern='^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$';s.description='Canonical base64 bytes for a bounded inline upload. No local path or URL.';}
  // Etsy URL Syntax explicitly permits decimal numbers to be returned as strings.
  if(!input&&raw.type==='number')s.type=['number','string'];
  return raw.nullable?{anyOf:[s,{type:'null'}]}:s;
}
const modes={R:100,W:25,H:10,D:10},definitions={};
for(const [mode,limit]of Object.entries({...modes,output:100}))definitions[mode]=Object.fromEntries(Object.entries(sourceDefs).map(([k,v])=>[k,convert(v,mode!=='output',limit)]));
function closure(s,defs,seen=new Set()){
  if(!s||typeof s!=='object')return seen;
  if(s.$ref){const id=s.$ref.slice('#/$defs/'.length);if(!seen.has(id)){seen.add(id);closure(defs[id],defs,seen);}return seen;}
  for(const v of Object.values(s))if(Array.isArray(v))for(const child of v)closure(child,defs,seen);else closure(v,defs,seen);
  return seen;
}
const object=()=>({type:'object',properties:{},required:[],additionalProperties:false});
const methods={};
for(const row of evidence.inventory){
  if(row.excluded_reason)continue;
  const op=model.paths[row.path][row.method.toLowerCase()],input=object(),wire=[],bindings=[];
  for(const parameter of op.parameters){
    if(!['path','query'].includes(parameter.in))throw new Error('Unreviewed Etsy transport field');
    if(parameter.in==='path'&&['shop_id','user_id'].includes(parameter.name)){bindings.push(parameter.name);continue;}
    const group=input.properties[parameter.in] ||= object();group.properties[parameter.name]=convert(parameter.schema,true,modes[row.risk]);
    if(parameter.required){group.required.push(parameter.name);if(!input.required.includes(parameter.in))input.required.push(parameter.in);}
    wire.push({location:parameter.in,name:parameter.name});
  }
  let media=null,binary=[];
  if(op.requestBody){
    const content=op.requestBody.content;if(Object.keys(content).length!==1)throw new Error('Unreviewed Etsy request media type');
    media=Object.keys(content)[0];if(!['application/json','application/x-www-form-urlencoded','multipart/form-data'].includes(media))throw new Error('Unreviewed Etsy media type');
    const raw=content[media].schema;input.properties.body=convert(raw,true,modes[row.risk]);input.required.push('body');
    binary=Object.entries(raw.properties||{}).filter(([,s])=>s.format==='binary').map(([k])=>k);
    if(row.operation==='uploadListingFile')input.properties.body.anyOf=[{required:['listing_file_id']},{required:['file','name'],properties:{file:{type:'string',minLength:4},name:{type:'string',minLength:1}}}];
    if(row.operation==='uploadListingImage')input.properties.body.anyOf=[{required:['listing_image_id']},{required:['image'],properties:{image:{type:'string',minLength:4}}}];
    if(row.operation==='uploadListingVideo')input.properties.body.anyOf=[{required:['video_id']},{required:['video','name'],properties:{video:{type:'string',minLength:4},name:{type:'string',minLength:1}}}];
  }
  const responses=Object.fromEntries(Object.entries(op.responses).filter(([code])=>/^2\d\d$/.test(code)).map(([code,response])=>[code,response.content?convert(response.content['application/json'].schema,false,100):null]));
  const description=op.description.split('\n\n').slice(1).join(' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,180);
  methods[row.operation]={method:row.method,path:row.path,risk:row.risk,description:description+' '+(row.risk==='R'?'Returns one page; retain pagination.':'Acknowledgement only; inspect state before retrying uncertain writes.')+' '+row.source_url,input_schema:input,input_definitions:[...closure(input,definitions[row.risk])],wire,bindings,media,binary,responses,response_definitions:[...new Set(Object.values(responses).flatMap(s=>[...closure(s,definitions.output)]))],scopes:(op.security||[]).flatMap(s=>s.oauth2||[])};
}
for(const mode of Object.keys(definitions)){
  const used=new Set(Object.values(methods).filter(row=>mode==='output'||row.risk===mode).flatMap(row=>mode==='output'?row.response_definitions:row.input_definitions));
  definitions[mode]=Object.fromEntries(Object.entries(definitions[mode]).filter(([id])=>used.has(id)));
}
const data={documentation_snapshot:evidence.documentation_snapshot,source_sha256:evidence.source_sha256,methods,definitions,excluded_methods:Object.fromEntries(evidence.inventory.filter(r=>r.excluded_reason).map(r=>[r.operation,r.excluded_reason]))};
fs.writeFileSync(path.join(__dirname,'../bin/etsy-api-contracts.cjs'),"'use strict';\n// Generated offline from the pinned official Etsy OpenAPI model.\nmodule.exports = "+JSON.stringify(data,null,2)+';\n');
console.log('Generated '+Object.keys(methods).length+' Etsy merchant contracts');
