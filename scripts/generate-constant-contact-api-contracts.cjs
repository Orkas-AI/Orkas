'use strict';
// Offline conversion of the official merchant scope contract, never arbitrary REST.
const fs=require('node:fs'),path=require('node:path');
const evidence=JSON.parse(fs.readFileSync(path.join(__dirname,'../test/fixtures/connectors/official-contracts/constant-contact-20261001.json'),'utf8'));
const definitions={},methods={},limits={R:100,W:25,H:10,D:10,output:0};
const keys=['type','enum','required','minimum','maximum','exclusiveMinimum','exclusiveMaximum','minLength','maxLength','pattern','minItems','maxItems','uniqueItems','multipleOf'];
const clean=v=>String(v||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
function convert(raw,mode){
 if(!raw||typeof raw!=='object')throw new Error('Missing official schema');
 if(raw.$ref){const id=raw.$ref.slice('#/components/schemas/'.length);if(!raw.$ref.startsWith('#/components/schemas/')||!evidence.model.components.schemas[id])throw new Error('Unresolved official reference');if(!Object.hasOwn(definitions[mode],id)){definitions[mode][id]={};definitions[mode][id]=convert(evidence.model.components.schemas[id],mode);}return {$ref:'#/$defs/'+id};}
 const input=mode!=='output',s=Object.fromEntries(keys.filter(k=>Object.hasOwn(raw,k)&&(input||['type','required'].includes(k))).map(k=>[k,raw[k]]));
 if(input&&raw.description)s.description=clean(raw.description);
 if(raw.properties){s.type||='object';s.properties=Object.fromEntries(Object.entries(raw.properties).filter(([,v])=>!input||!v.readOnly).map(([k,v])=>[k,convert(v,mode)]));if(input&&s.required)s.required=s.required.filter(k=>!raw.properties[k]?.readOnly);s.additionalProperties=input?Object.keys(raw.properties).length===0||raw.additionalProperties===true:true;}
 if(typeof raw.additionalProperties==='object')s.additionalProperties=convert(raw.additionalProperties,mode);else if(raw.additionalProperties!==undefined)s.additionalProperties=input?raw.additionalProperties:true;
 if(raw.items){s.items=convert(raw.items,mode);if(input)s.maxItems=Math.min(s.maxItems??limits[mode],limits[mode]);}
 for(const k of ['oneOf','anyOf','allOf'])if(raw[k])s[!input&&k==='oneOf'?'anyOf':k]=raw[k].map(v=>convert(v,mode));
 if(input&&raw.type==='integer'){s.minimum=Math.max(s.minimum??Number.MIN_SAFE_INTEGER,Number.MIN_SAFE_INTEGER);s.maximum=Math.min(s.maximum??Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER);delete s.minLength;delete s.maxLength;}
 if(input&&raw.type==='string'&&s.maxLength===undefined)s.maxLength=262144;
 if(raw.nullable)return {anyOf:[s,{type:'null'}]};return s;
}
for(const mode of Object.keys(limits))definitions[mode]={};
function closure(s,mode,ids=new Set()){
 if(!s||typeof s!=='object')return ids;if(s.$ref){const id=s.$ref.slice('#/$defs/'.length);if(!ids.has(id)){ids.add(id);closure(definitions[mode][id],mode,ids);}return ids;}
 for(const v of Object.values(s))if(Array.isArray(v))v.forEach(c=>closure(c,mode,ids));else closure(v,mode,ids);return ids;
}
const obj=()=>({type:'object',properties:{},required:[],additionalProperties:false});
for(const row of evidence.inventory){
 if(row.excluded_reason)continue;const o=evidence.model.paths[row.path][row.method.toLowerCase()],input=obj(),wire=[];
 for(const p of [...(evidence.model.paths[row.path].parameters||[]),...(o.parameters||[])]){
  if(!['path','query'].includes(p.in))throw new Error('Unreviewed transport field');
  const group=input.properties[p.in] ||= obj();group.properties[p.name]=convert({...p.schema,description:p.description},row.risk);
  if(p.in==='path')group.properties[p.name].minLength=1;
  if(p.in==='query'&&p.name==='limit'){
   const max=row.path==='/reports/summary_reports/sms_campaign_summaries'?50:Math.min(p.schema.maximum??100,100);
   if(p.schema.type==='integer'){group.properties[p.name].minimum=1;group.properties[p.name].maximum=max;}
   else group.properties[p.name].pattern=max===50?'^(?:[1-9]|[1-4][0-9]|50)$':'^(?:[1-9]|[1-9][0-9]|100)$';
   const size=Math.min(Number(p.schema.default??max),max);group.properties[p.name].default=p.schema.type==='string'?String(size):size;
  }
  // Published array enum is attached to the wrong level; its prose says include=accessible.
  if(row.path==='/social/profiles'&&p.name==='include'){delete group.properties[p.name].enum;group.properties[p.name].items.enum=['accessible'];}
  if(p.required){group.required.push(p.name);if(!input.required.includes(p.in))input.required.push(p.in);}
  // The official activity-history example explicitly repeats this query parameter.
  wire.push({name:p.name,location:p.in,explode:p.name==='tracking_activity_type'?true:p.explode??true,...p.in==='query'&&p.name==='limit'?{default:group.properties[p.name].default}:{}});
 }
 if(o.requestBody){input.properties.body=convert(o.requestBody.content['application/json'].schema,row.risk);if(o.requestBody.required)input.required.push('body');}
 const responses=Object.fromEntries(Object.entries(o.responses).filter(([status])=>/^2\d\d$/.test(status)).map(([status,r])=>[status,status==='204'||!r.content?null:convert(r.content['application/json'].schema,'output')]));
 methods[row.method+' '+row.path]={method:row.method,path:row.path,risk:row.risk,scopes:[...new Set(row.scopes)],description:clean(o.summary)+'. '+(row.risk==='R'?'One explicit page; no automatic pagination.':'Acknowledgement only; inspect state before retrying an uncertain write.'),input_schema:input,input_definitions:[...closure(input,row.risk)],wire,responses,response_definitions:[...new Set(Object.values(responses).flatMap(s=>[...closure(s,'output')]))]};
}
fs.writeFileSync(path.join(__dirname,'../bin/constant-contact-api-contracts.cjs'),"'use strict';\n// Generated from the pinned official Constant Contact specification.\nmodule.exports = "+JSON.stringify({documentation_snapshot:evidence.documentation_snapshot,methods,definitions},null,2)+';\n');
console.log('Generated '+Object.keys(methods).length+' Constant Contact merchant contracts');
