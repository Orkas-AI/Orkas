'use strict';
// Offline conversion of the pinned official TikTok Shop API metadata.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const evidence=JSON.parse(fs.readFileSync(path.join(__dirname,'../test/fixtures/connectors/official-contracts/tiktok-shop-20261001.json'),'utf8'));
const definitions={},methods={},repairs=[];
const object=()=>({type:'object',properties:{},required:[],additionalProperties:false});
const owned=new Set(['app_key','sign','timestamp','shop_cipher','access_token','shop_id']);
const integer={anyOf:[{type:'integer',minimum:Number.MIN_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER},{type:'string',pattern:'^-?(?:0|[1-9][0-9]*)$',maxLength:20}],'x-tiktok-integer':true};
function intern(schema){const id='s'+crypto.createHash('sha256').update(JSON.stringify(schema)).digest('hex').slice(0,24);definitions[id] ||= schema;return {$ref:'#/$defs/'+id};}
function compact(schema){for(const [k,v]of Object.entries(schema.properties||{}))schema.properties[k]=compact(v);if(schema.items)schema.items=compact(schema.items);return intern(schema);}
function closure(s,ids=new Set()){if(!s||typeof s!=='object')return ids;if(s.$ref){const id=s.$ref.slice(8);if(!ids.has(id)){ids.add(id);closure(definitions[id],ids);}}for(const[k,v]of Object.entries(s))if(k!=='$ref')if(Array.isArray(v))v.forEach(x=>closure(x,ids));else closure(v,ids);return ids;}
function tree(fields,input,risk,id,location){
 const root=object(),stack=[root],paths=new Map();root.additionalProperties=!input;
 for(const f of fields||[]){
  const match=/^(\^*)([^\^]+)$/.exec(f.name);if(!match)throw Error('Invalid field '+id+':'+f.name);const depth=match[1].length,key=match[2];
  const parent=stack[depth];if(!parent||parent.type!=='object')throw Error('Invalid parent '+id+':'+location+':'+f.name);
  if(input&&depth===0&&location==='query'&&owned.has(key))continue;
  let s;if(f.type==='object'||f.type==='[]object'){s=object();s.additionalProperties=!input;if(f.type.startsWith('[]'))s={type:'array',items:s};}
  else {const t=f.type.replace(/^\[\]/,'');s=t==='int'?structuredClone(integer):{type:{string:'string',bool:'boolean'}[t]};if(!s.type&&!s.anyOf)throw Error('Unsupported type '+f.type);if(f.type.startsWith('[]'))s={type:'array',items:s};}
  if(input&&s.type==='array')s.maxItems=risk==='R'?100:risk==='W'?25:10;
  if(input&&s.type==='string')s.maxLength=262144;
  if(input&&f.desc)s.description=f.desc;
  if(input&&id==='6503068fc20ad60284b38858'&&['quantity','backorder_quantity','handling_time'].includes(key))s={type:'integer',minimum:0,maximum:key==='quantity'?99999:Number.MAX_SAFE_INTEGER,description:f.desc};
  if(input&&['page_size','pageSize','limit'].includes(key)&&f.type==='int')s={type:'integer',minimum:1,maximum:100,description:f.desc};
  if(input&&location==='body'&&depth===0&&key==='replicated_products')s={not:{},description:'Cross-shop replicas are outside the bound-shop authorization.'};
  if(Object.hasOwn(parent.properties,key))throw Error('Duplicate field '+id+':'+location+':'+f.name);
  parent.properties[key]=s;if(f.required==='Y')parent.required.push(key);
  stack.length=depth+1;stack[depth+1]=s.items?.type==='object'?s.items:s.type==='object'?s:undefined;
  const parentPath=depth?paths.get(parent):[];paths.set(s,[...parentPath,key]);if(s.items)paths.set(s.items,[...parentPath,key,'*']);
 }
 return root;
}
for(const row of evidence.inventory){
 if(row.excluded_reason)continue;const m=evidence.models[row.document_id],input=object(),wire=[];
 for(const location of ['path','query','body']){
  let fields=m['request_'+location+'_param']||[];
  // Keep the blocked replica property but do not parse its unreachable children.
  if(location==='body'){let blocked=false;fields=fields.filter(f=>{if(!f.name.startsWith('^'))blocked=f.name==='replicated_products';return !blocked||f.name==='replicated_products';});}
  if(!fields.length)continue;const group=tree(fields,true,row.risk,row.document_id,location);if(!Object.keys(group.properties).length)continue;
  input.properties[location]=group;if(group.required.length)input.required.push(location);
  if(location!=='body')for(const[name,s]of Object.entries(group.properties)){
   const f=fields.find(f=>f.name===name),sample=new URL(m.query||'https://open-api.tiktokglobalshop.com').searchParams.get(name);
   if(f.type.startsWith('[]')) {
    if(!sample)throw Error('Missing array wire evidence '+row.document_id+':'+name);
    if(f.type==='[]int'&&row.document_id!=='6ab9f3aa7272ae04a0284ced')throw Error('Unaudited integer array wire');
    if(['69c3070c66dee40493fdfe2e','6a86ed79c6ee7e04d0e8f6b6'].includes(row.document_id))s.maxItems=1;
    else if(f.type==='[]string'&&!sample.includes(','))throw Error('Missing multiple-value CSV evidence '+row.document_id+':'+name);
    if(f.type==='[]string')Object.assign(s.items,{minLength:1,pattern:'^[^,\\r\\n]*$'});
   }
   wire.push({location,name,array_format:f.type==='[]int'?'json':'csv'});
  }
 }
 const output=tree(m.response_param,false,row.risk,row.document_id,'output'),errorPaths=[],diagnosticPaths=[],failurePaths=[],pendingPaths=[];
 function inspect(s,cursor=[]){if(s.items)inspect(s.items,[...cursor,'*']);for(const[k,v]of Object.entries(s.properties||{})){
  if(['errors','error','failed_items','failed_conversation_ids','update_failed'].includes(k))errorPaths.push([...cursor,k]);
  if(['fail_reason','fail_reasons'].includes(k))diagnosticPaths.push([...cursor,k]);
  if(k==='is_success')failurePaths.push({path:[...cursor,k],values:[false]});
  if(k==='placement_task_status'){failurePaths.push({path:[...cursor,k],values:['Failed']});pendingPaths.push({path:[...cursor,k],values:['Executing']});}
  if(k==='task_status')pendingPaths.push({path:[...cursor,k],values:['PROCESSING']});
  inspect(v,[...cursor,k]);
 }}inspect(output);
 let sample;try{sample=JSON.parse(m.response_body);}catch{throw Error('Invalid official response example '+row.document_id);}
 const emptyData=sample?.data&&typeof sample.data==='object'&&Object.keys(sample.data).length===0;
 const inputSchema=compact(input),responseSchema=compact(output);
 methods[row.action]={...row,input_schema:inputSchema,input_definitions:[...closure(inputSchema)],response_schema:responseSchema,response_definitions:[...closure(responseSchema)],wire,owned_query:(m.request_query_param||[]).filter(f=>owned.has(f.name)).map(f=>f.name),content_type:row.document_id==='69d76e0b795c1404903d2c6e'?'multipart/form-data':'application/json',diagnostic_paths:diagnosticPaths,error_paths:errorPaths,failure_paths:failurePaths,pending_paths:pendingPaths,allow_empty_data:!!emptyData,description:row.title+'. '+(row.scope_requirement||'Scopes (any): '+row.scopes_any.join(', '))+'. '+(row.markets?'Shop countries: '+row.markets.join(', ')+'. ':'')+(row.market_requirement||'')+' '+m.env_desc+' '+row.field_gaps.join(' ')+' One bounded request; no automatic pagination, replay, or file download. '+row.source_url};
}
fs.writeFileSync(path.join(__dirname,'../bin/tiktok-shop-api-contracts.cjs'),"'use strict';\n// Generated from pinned official TikTok Shop metadata; load only on provider use.\nmodule.exports = "+JSON.stringify({documentation_snapshot:evidence.documentation_snapshot,methods,definitions,source_repairs:repairs})+';\n');
console.log(JSON.stringify({operations:Object.keys(methods).length,definitions:Object.keys(definitions).length,repairs}));
