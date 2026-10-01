'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const evidence=JSON.parse(fs.readFileSync(path.join(__dirname,'../test/fixtures/connectors/official-contracts/shopline-20261001.json'),'utf8'));
for(const override of evidence.schema_overrides || []){const parts=override.pointer.slice(1).split('/').map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~'));const target=parts.reduce((v,k)=>v[k],evidence.models[override.source_id]);target.type=override.type;}
const definitions={},methods={},limits={R:100,W:25,H:10,D:10,output:0};
const object=()=>({type:'object',properties:{},required:[],additionalProperties:false});
function convert(raw,mode){
 if(!raw || typeof raw!=='object')throw new Error('Missing official schema');
 const input=mode!=='output',type={long:'integer',double:'number',float:'number',map:'object'}[raw.type]||raw.type||(raw.properties?'object':undefined),s={};
 if(type)s.type=input?type:[...new Set([...(Array.isArray(type)?type:[type]),...(raw.type==='long'?['string']:[]),'null'])];
 if(!input && raw.type==='long'){s.pattern='^-?(?:0|[1-9][0-9]*)$';s.minimum=Number.MIN_SAFE_INTEGER;s.maximum=Number.MAX_SAFE_INTEGER;}
 for(const key of ['enum','required','minimum','maximum','minLength','maxLength','pattern','minItems','maxItems','description'])if(raw[key]!==undefined && (input || key==='required'))s[key]=raw[key];
 if(raw.properties){s.properties=Object.fromEntries(Object.entries(raw.properties).map(([k,v])=>[k,convert(v,mode)]));s.additionalProperties=input?Object.keys(raw.properties).length===0:true;}
 if(raw.items){s.items=convert(raw.items,mode);if(input)s.maxItems=Math.min(raw.maxItems??limits[mode],limits[mode]);}
 if(input && type==='string')s.maxLength=s.maxLength??256*1024;
 if(input && type==='integer'){s.minimum=s.minimum??Number.MIN_SAFE_INTEGER;s.maximum=s.maximum??Number.MAX_SAFE_INTEGER;}
 for(const key of ['oneOf','allOf','anyOf'])if(raw[key])s[key]=raw[key].map(child=>convert(child,mode));
 const serialized=JSON.stringify(s);if(serialized.length>1000 && (s.properties||s.items)){
  const id=mode+'_'+crypto.createHash('sha256').update(serialized).digest('hex').slice(0,24);definitions[id] ||= s;return {$ref:'#/$defs/'+id};
 }
 return s;
}
function closure(s,ids=new Set()){
 if(!s||typeof s!=='object')return ids;
 if(s.$ref){const id=s.$ref.slice('#/$defs/'.length);if(!ids.has(id)){ids.add(id);closure(definitions[id],ids);}}
 for(const [k,v]of Object.entries(s))if(k!=='$ref')if(Array.isArray(v))v.forEach(child=>closure(child,ids));else closure(v,ids);
 return ids;
}
for(const row of evidence.inventory){
 if(row.excluded_reason)continue;
 const op=evidence.models[row.id],input=object(),querySerialization={},pagination={};
 for(const p of op.parameters){
  if(p.in==='header')continue;
  if(!['path','query'].includes(p.in))throw new Error('Unreviewed parameter location');
  const group=input.properties[p.in] ||= object();let schema=convert(p.schema,row.risk);
  if(p.in==='path')schema={...schema,type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9_-]+$'};
  if(p.in==='path'&&p.name==='resource')schema.enum=['products','variants','collections','customers','orders','pages','blogs','articles','shop'];
  const pageBound=p.in==='query' && evidence.pagination_bounds.find(bound=>bound.source_id===row.id&&bound.name===p.name);
  if(pageBound){
   pagination[p.name]={maximum:pageBound.maximum,default:pageBound.default,type:schema.type};
   if(schema.type==='integer')schema={...schema,minimum:1,maximum:pageBound.maximum,default:pageBound.default};
   else if(schema.type==='string')schema={...schema,minLength:1,maxLength:3,pattern:pageBound.maximum===20?'^(?:[1-9]|1[0-9]|20)$':pageBound.maximum===50?'^(?:[1-9]|[1-4][0-9]|50)$':'^(?:[1-9]|[1-9][0-9]|100)$',default:String(pageBound.default)};
   else throw new Error('Unsupported pagination contract');
  }
  group.properties[p.name]=schema;if(p.required){group.required.push(p.name);if(!input.required.includes(p.in))input.required.push(p.in);}
  if(p.in==='query')querySerialization[p.name]={style:p.style||'form',explode:p.explode??false};
 }
 if(op.requestBody){const b=op.requestBody.content['application/json'];if(!b)throw new Error('Unsupported content type');input.properties.body=convert(b.schema,row.risk);if(op.requestBody.required)input.required.push('body');}
 const responses={};for(const [status,response]of Object.entries(op.responses))if(/^2\d\d$/.test(status)){
  const raw=response.content?.['application/json']?.schema,schema=raw?convert(raw,'output'):null;
  responses[status]={schema,definitions:schema?[...closure(schema)]:[],keys:Object.keys(raw?.properties||{})};
 }
 methods[row.action]={method:row.method,path:row.path,risk:row.risk,source_id:row.id,scopes:row.scopes,description:row.title+'. Required scopes: '+(row.scopes.join(', ')||'resource-specific merchant permissions')+'. '+(row.risk==='R'?'One explicit page; no automatic pagination.':'Provider acknowledgement only; inspect state before retrying an uncertain write.'),input_schema:input,input_definitions:[...closure(input)],querySerialization,pagination,responses};
}
fs.writeFileSync(path.join(__dirname,'../bin/shopline-api-contracts.cjs'),"'use strict';\n// Generated offline from pinned official v20260901 operation contracts.\nmodule.exports = "+JSON.stringify({api_version:evidence.api_version,source_sha256:evidence.source_sha256,methods,definitions},null,2)+';\n');
console.log('Generated '+Object.keys(methods).length+' SHOPLINE merchant contracts');
