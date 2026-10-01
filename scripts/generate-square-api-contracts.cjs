'use strict';

// Offline pinned OpenAPI conversion. Shared referenced definitions avoid
// duplicating the catalog graph in every action and each on-demand schema
// contains only its reachable input definitions.
const fs=require('node:fs'),path=require('node:path');
const evidence=JSON.parse(fs.readFileSync(path.join(__dirname,'../test/fixtures/connectors/official-contracts/square-20261001.json'),'utf8'));
const model=evidence.model,sourceDefs=model.components.schemas;
const keys=['type','enum','required','minLength','maxLength','minimum','maximum','minItems','maxItems','uniqueItems','pattern','multipleOf','description'];
const formats=new Set(['date','date-time','uri','email','ipv4','ipv6','hostname','uuid']);
function convert(raw,input,limit) {
  if(raw.$ref){
    const id=raw.$ref.slice('#/components/schemas/'.length);
    if(!sourceDefs[id])throw new Error('Unknown official schema reference');
    const ref={$ref:'#/$defs/'+id};
    return raw.nullable ? {anyOf:[ref,{type:'null'}]} : ref;
  }
  if(raw.allOf || raw.anyOf || raw.oneOf)throw new Error('Unreviewed OpenAPI schema composition');
  const s=Object.fromEntries(keys.filter(k=>Object.hasOwn(raw,k) && (input || ['type','required'].includes(k))).map(k=>[k,raw[k]]));
  if(input && formats.has(raw.format))s.format=raw.format;
  if(raw.type==='object') {
    if(raw.properties)s.properties=Object.fromEntries(Object.entries(raw.properties).filter(([,child])=>!input || !child.readOnly).map(([key,child])=>[key,convert(child,input,limit)]));
    if(input && s.required)s.required=s.required.filter(key=>!raw.properties?.[key]?.readOnly);
    s.additionalProperties=typeof raw.additionalProperties==='object' ? convert(raw.additionalProperties,input,limit) : input ? (raw.additionalProperties===true || !raw.properties) : true;
  }
  if(raw.type==='array') {
    s.items=convert(raw.items,input,limit);
    if(input){s.maxItems=Math.min(s.maxItems ?? limit,limit);if((s.minItems || 0)>s.maxItems)throw new Error('Operation exceeds existing host batch limits');}
  }
  if(input && raw.type==='integer') {s.minimum=Math.max(s.minimum ?? Number.MIN_SAFE_INTEGER,Number.MIN_SAFE_INTEGER);s.maximum=Math.min(s.maximum ?? Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER);}
  if(input && raw.type==='string' && s.maxLength===undefined)s.maxLength=256*1024;
  if(input && raw.format==='binary') {s.minLength=4;s.pattern='^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$';s.description='Canonical base64-encoded JPEG bytes; bounded inline upload. No path or URL.';}
  return raw.nullable ? {anyOf:[s,{type:'null'}]} : s;
}
const modes={R:{input:true,limit:100},W:{input:true,limit:25},H:{input:true,limit:10},D:{input:true,limit:10},output:{input:false,limit:100}};
const definitions=Object.fromEntries(Object.entries(modes).map(([mode,{input,limit}])=>[mode,new Proxy({}, {
  get(cache,id) {
    if(typeof id!=='string' || !Object.hasOwn(sourceDefs,id))return undefined;
    if(!Object.hasOwn(cache,id))cache[id]=convert(sourceDefs[id],input,limit);
    return cache[id];
  }
})]));
function closure(schema,defs,seen=new Set()) {
  if(!schema || typeof schema!=='object')return seen;
  if(schema.$ref){const id=schema.$ref.slice('#/$defs/'.length);if(!seen.has(id)){seen.add(id);closure(defs[id],defs,seen);}return seen;}
  for(const value of Object.values(schema))if(Array.isArray(value))for(const item of value)closure(item,defs,seen);else closure(value,defs,seen);
  return seen;
}
const obj=()=>({type:'object',properties:{},required:[],additionalProperties:false});
const BULK_MAPS={
  BulkCreateCustomers:['customers','responses'],BulkUpdateCustomers:['customers','responses'],
  BulkDeleteCustomers:['customer_ids','responses'],BulkRetrieveCustomers:['customer_ids','responses'],
  BulkCreateTeamMembers:['team_members','team_members'],BulkUpdateTeamMembers:['team_members','team_members'],
  BulkCreateVendors:['vendors','responses'],BulkUpdateVendors:['vendors','responses'],BulkRetrieveVendors:['vendor_ids','responses'],
  BulkUpsertBookingCustomAttributes:['values','values'],BulkDeleteBookingCustomAttributes:['values','values'],
  BulkUpsertLocationCustomAttributes:['values','values'],BulkDeleteLocationCustomAttributes:['values','values'],
  BulkUpsertMerchantCustomAttributes:['values','values'],BulkDeleteMerchantCustomAttributes:['values','values'],
  BulkUpsertOrderCustomAttributes:['values','values'],BulkDeleteOrderCustomAttributes:['values','values'],
  BulkUpsertCustomerCustomAttributes:['values','values'],
  BulkPublishScheduledShifts:['scheduled_shifts','responses'],
  BulkRetrieveBookings:['booking_ids','bookings'],BulkRetrieveChannels:['channel_ids','responses'],
  BulkRetrieveTeamMemberBookingProfiles:['team_member_ids','team_member_booking_profiles'],
};
const methods={};
for(const row of evidence.inventory) {
  if(row.excluded_reason)continue;
  const operation=model.paths[row.path][row.method.toLowerCase()],input=obj(),wire=[],mode=row.risk;
  if(!modes[mode] || methods[row.method+' '+row.path])throw new Error('Unreviewed action');
  for(const parameter of [...(model.paths[row.path].parameters || []),...(operation.parameters || [])]) {
    if(!['path','query'].includes(parameter.in))throw new Error('Unreviewed caller transport parameter');
    const group=input.properties[parameter.in] ||= obj();
    group.properties[parameter.name]=convert(parameter.schema,true,modes[mode].limit);
    if(parameter.required){group.required.push(parameter.name);if(!input.required.includes(parameter.in))input.required.push(parameter.in);}
    wire.push({location:parameter.in,name:parameter.name,style:parameter.style || 'form',explode:parameter.explode ?? true});
  }
  // ListCustomers' documented 1..100 page bound is absent from the model.
  if(row.operation==='ListCustomers'){input.properties.query.properties.limit.minimum=1;input.properties.query.properties.limit.maximum=100;}
  let multipart=false;
  if(operation.requestBody) {
    const content=operation.requestBody.content;
    multipart=Object.hasOwn(content,'multipart/form-data');
    const body=content[multipart ? 'multipart/form-data' : 'application/json'];
    if(!body?.schema || Object.keys(content).length!==1)throw new Error('Unreviewed request media type');
    input.properties.body=convert(body.schema,true,modes[mode].limit);
    if(operation.requestBody.required)input.required.push('body');
    if(multipart){input.properties.body.required=['request','image_file'];}
  }
  const bulkMapping=BULK_MAPS[row.operation];
  if(bulkMapping){
    const body=input.properties.body,shape=body.$ref ? definitions[mode][body.$ref.slice('#/$defs/'.length)] : body;
    const field=shape.properties[bulkMapping[0]],value=field.anyOf ? field.anyOf.find(s=>s.type!=='null') : field;
    if(value.type==='object'){value.minProperties=1;value.maxProperties=modes[mode].limit;}
    else if(value.type==='array'){value.minItems=Math.max(1,value.minItems || 0);value.uniqueItems=true;}
    else throw new Error('Unreviewed bulk request mapping');
  }
  const responses=Object.fromEntries(Object.entries(operation.responses).filter(([status])=>/^2\d\d$/.test(status)).map(([status,response])=>{
    const contents=response.content;
    if(!contents)return [status,null];
    if(!contents['application/json']?.schema)throw new Error('Unreviewed response media type');
    return [status,convert(contents['application/json'].schema,false,100)];
  }));
  if(!Object.keys(responses).length)throw new Error('Missing authoritative acknowledgement');
  const errorPaths=[],prosePaths=[];
  function paths(s,cursor=[],seen=new Set()) {
    if(!s)return;
    if(s.anyOf){for(const child of s.anyOf)paths(child,cursor,seen);return;}
    if(s.$ref){const id=s.$ref.slice('#/$defs/'.length);if(seen.has(id))return;
      if(id==='Error'){errorPaths.push(cursor);prosePaths.push([...cursor,'detail']);return;}
      paths(definitions.output[id],cursor,new Set([...seen,id]));return;
    }
    if(s.type==='array'){paths(s.items,[...cursor,'*'],seen);return;}
    for(const [key,child]of Object.entries(s.properties || {}))paths(child,[...cursor,key],seen);
    if(typeof s.additionalProperties==='object')paths(s.additionalProperties,[...cursor,'*'],seen);
  }
  for(const response of Object.values(responses))paths(response);
  methods[row.method+' '+row.path]={operation:row.operation,method:row.method,path:row.path,risk:mode,stage:row.stage,
    description:operation.description.split(/\n\n/)[0].replace(/\s+/g,' ').slice(0,190)+' '+(mode==='R'?'One explicit page; no automatic pagination.':'Acknowledgement is not completion; inspect state before retrying an uncertain write.')+' '+row.source_url,
    input_schema:input,input_definitions:[...closure(input,definitions[mode])],wire,multipart,responses,response_definitions:[...new Set(Object.values(responses).flatMap(s=>[...closure(s,definitions.output)]))],error_paths:errorPaths,error_prose_paths:prosePaths,
    bulk_mapping:bulkMapping,scopes:(operation.security || []).flatMap(s=>s.oauth2 || [])};
}
for(const mode of Object.keys(definitions)) {
  const used=new Set(Object.values(methods).filter(row=>mode==='output' || row.risk===mode).flatMap(row=>mode==='output'?row.response_definitions:row.input_definitions));
  definitions[mode]=Object.fromEntries(Object.entries(definitions[mode]).filter(([id])=>used.has(id)));
}
const data={documentation_snapshot:evidence.documentation_snapshot,source_commit:evidence.source_commit,api_version:evidence.api_version,methods,definitions,
  excluded_methods:Object.fromEntries(evidence.inventory.filter(row=>row.excluded_reason).map(row=>[row.method+' '+row.path,row.excluded_reason]))};
fs.writeFileSync(path.join(__dirname,'../bin/square-api-contracts.cjs'),"'use strict';\n// Generated offline from the pinned official merchant OpenAPI model.\nmodule.exports = "+JSON.stringify(data,null,2)+';\n');
console.log('Generated '+Object.keys(methods).length+' Square merchant contracts');
