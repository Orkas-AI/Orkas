'use strict';

const storefront=require('./storefront-admin-api.cjs');
const {requestFetch,requestFailureCode,httpFailure}=require('./commerce-request-context.cjs');
let contracts,actions,validator;
const checks=new Map(),source=()=>contracts ||= require('./shoplazza-api-contracts.cjs');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const isNative=name=>Object.hasOwn(source().methods,name);
function actionsFor(){return actions ||= Object.fromEntries(Object.entries(source().methods).map(([name,r])=>[name,{risk:r.risk,description:r.description,input_schema:r.input_schema}]));}
function validate(row,p){
  let serialized;try{serialized=JSON.stringify(p);}catch{fail('E_BAD_INPUT','Invalid Shoplazza parameters');}
  if(!serialized||Buffer.byteLength(serialized)>256*1024)fail('E_BAD_INPUT','Invalid or oversized Shoplazza parameters');
  if(!validator){const {AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv');validator=new AjvJsonSchemaValidator();}
  let check=checks.get(row);if(!check){check=validator.getValidator(row.input_schema);checks.set(row,check);}
  if(!check(p).valid)fail('E_BAD_INPUT','Invalid Shoplazza parameters; check the described fields and types');
  const cap={R:100,W:25,H:10,D:10}[row.risk];
  function walk(value,schema,depth=0){
    if(depth>64)fail('E_BAD_INPUT','Shoplazza parameters are too deeply nested');
    if(schema?.$ref)schema=row.input_schema.$defs[schema.$ref.slice('#/$defs/'.length)];
    if(schema?.['x-integer-format']){const n=BigInt(value),unsigned=schema['x-integer-format']==='uint64';if(n<(unsigned?0n:-9223372036854775808n)||n>(unsigned?18446744073709551615n:9223372036854775807n)||(schema['x-integer-minimum']!==undefined&&n<BigInt(schema['x-integer-minimum']))||(schema['x-integer-maximum']!==undefined&&n>BigInt(schema['x-integer-maximum'])))fail('E_BAD_INPUT','Shoplazza integer is outside the published range');}
    if(Array.isArray(value)){if(value.length>cap)fail('E_BAD_INPUT','Shoplazza input exceeds the existing host batch limit');for(const item of value)walk(item,schema?.items,depth+1);}
    else if(object(value))for(const [key,item]of Object.entries(value))walk(item,schema?.properties?.[key]||schema?.additionalProperties,depth+1);
  }
  walk(p,row.input_schema);
  for(const value of Object.values(p.path||{}))if(typeof value==='string'&&(value==='.'||value==='..'||/[\u0000-\u001f\u007f]/.test(value)))fail('E_BAD_INPUT','Invalid Shoplazza resource identifier');
  return serialized;
}
// Node >=22.12 and packaged Electron expose the original numeric source.
// The official client preserves json.Number; decode according to the published
// response type so double/scientific values are never mistaken for integer IDs.
class IntegerToken{constructor(text){this.text=text;}}
function parse(text,row){
  const body=JSON.parse(text,(_key,value,context)=>typeof value==='number'&&!Number.isSafeInteger(value)&&/^-?[0-9]+$/.test(context.source)?new IntegerToken(context.source):value);
  function restore(value,field){
    if(value instanceof IntegerToken)return field?.type==='number'?Number(value.text):value.text;
    if(field?.type==='integer'&&typeof value==='number'&&!Number.isSafeInteger(value))fail('E_TOOL_CALL_UPSTREAM','Shoplazza returned an integer that cannot be represented exactly');
    if(Array.isArray(value))return value.map(item=>restore(item,field?.items));
    if(!object(value))return value;
    const fields=field?.schema?source().response_schemas[field.schema]?.fields:field?.fields;
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,restore(item,fields?.find(f=>f.name===key)||field?.items)]));
  }
  if(object(body))body.data=restore(body.data,{fields:row.response_fields});
  return body;
}
// Emit validated 64-bit decimal input as numeric JSON, matching the official Go
// client json.Marshal(json.Number); do not round through JavaScript Number.
function wireJSON(value,schema,defs){
  if(schema?.$ref)schema=defs[schema.$ref.slice('#/$defs/'.length)];
  if(schema?.['x-integer-format'])return String(value);
  if(Array.isArray(value))return '['+value.map(item=>wireJSON(item,schema?.items,defs)).join(',')+']';
  if(object(value))return '{'+Object.entries(value).map(([key,item])=>JSON.stringify(key)+':'+wireJSON(item,schema?.properties?.[key]||schema?.additionalProperties,defs)).join(',')+'}';
  return JSON.stringify(value);
}
const privateKeys=new Set(['accesstoken','refreshtoken','clientsecret','authorization','password','cookie']);
function redact(value,token){
  if(typeof value==='string')return value.split(token).join('[redacted]');
  if(Array.isArray(value))return value.map(item=>redact(item,token));
  if(!object(value))return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!privateKeys.has(key.replace(/[_-]/g,'').toLowerCase())).map(([key,item])=>[key,redact(item,token)]));
}
function validType(value,field){
  if(field.schema==='google.protobuf.Value')return true;
  if(field.type==='array')return Array.isArray(value);
  if(field.type==='object')return object(value);
  if(field.type==='integer')return Number.isSafeInteger(value)||(['int64','uint64'].includes(field.format)&&typeof value==='string'&&/^-?[0-9]+$/.test(value));
  return typeof value===field.type&&(field.type!=='number'||Number.isFinite(value));
}
function acknowledge(config,name,row,p,data){
  const pagination=new Set(['cursor','pre_cursor','next_cursor','has_more','total','count','total_count','last_updated_at']);
  const business=row.response_fields.filter(f=>!pagination.has(f.name));
  const required=business.length?business:row.response_fields;
  if(required.length&&!required.some(f=>Object.hasOwn(data,f.name)))fail('E_TOOL_CALL_UPSTREAM','Shoplazza omitted the business acknowledgement');
  for(const f of row.response_fields){
    if(!Object.hasOwn(data,f.name))continue;
    if(!validType(data[f.name],f))fail('E_TOOL_CALL_UPSTREAM','Shoplazza returned an invalid business resource');
    if(f.has_id&&object(data[f.name])){
      const id=data[f.name].id;if(!['string','number'].includes(typeof id)||!String(id)||String(id)==='0')fail('E_TOOL_CALL_UPSTREAM','Shoplazza omitted the resource identifier');
      const expected=p.path?.[f.name.toLowerCase()+'_id']??(row.path.endsWith('/{id}')?p.path?.id:undefined);
      if(expected!==undefined&&String(id)!==String(expected))fail('E_TOOL_CALL_UPSTREAM','Shoplazza returned an unrelated resource');
    }
  }
  if(['shop-detail','shop-update'].includes(name)&&String(data.id)!==config.credentials.identity.shop_id)fail('storefront_binding_mismatch','Shoplazza returned a different store identity');
  if(name==='inventory-level-set')for(const key of ['inventory_item_id','location_id'])if(String(data.inventory_level?.[key])!==String(p.body[key]))fail('E_TOOL_CALL_UPSTREAM','Shoplazza returned an unrelated inventory acknowledgement');
  if(name==='order-cancel'&&data.order?.status!=='cancelled')return 'partial_or_failed';
  if(name==='theme-edit-session-promote'&&(data.conflict===true||data.promoted!==true))return 'partial_or_failed';
  if(name==='comment-batch-create'){
    if(!Number.isSafeInteger(data.success_count)||!Number.isSafeInteger(data.error_count)||data.success_count<0||data.error_count<0||data.success_count+data.error_count!==p.body.comments.length||!Array.isArray(data.error_infos)||data.error_infos.length!==data.error_count)fail('E_TOOL_CALL_UPSTREAM','Shoplazza omitted comment batch acknowledgements');
    const remaining=[...p.body.comments];for(const item of data.error_infos){const index=remaining.findIndex(x=>['product_id','user_name','created_at'].every(key=>x[key]===item?.[key]));if(!object(item)||index<0)fail('E_TOOL_CALL_UPSTREAM','Shoplazza returned an invalid comment batch failure');remaining.splice(index,1);delete item.error_message;}
    if(data.error_count)return 'partial_or_failed';
  }
  if(name==='gift-card-batch-create'){
    const requested=p.body?.gift_cards||[],success=data.success_gift_cards,failed=data.failed_gift_cards;
    if(!Array.isArray(success)||!Array.isArray(failed)||success.length+failed.length!==requested.length)fail('E_TOOL_CALL_UPSTREAM','Shoplazza omitted gift card batch acknowledgements');
    const remaining=new Set(requested.map(x=>x.code));for(const item of [...success,...failed]){if(!object(item)||!remaining.delete(item.code))fail('E_TOOL_CALL_UPSTREAM','Shoplazza returned an unrelated gift card acknowledgement');}
    if(failed.length)return 'partial_or_failed';
  }
  if(name==='procurement-item-batch-create'){
    if(!Array.isArray(data.fail_items))fail('E_TOOL_CALL_UPSTREAM','Shoplazza omitted procurement acknowledgements');
    const remaining=[...p.body.items];for(const item of data.fail_items){const index=remaining.findIndex(x=>object(item)&&x.product_id===item.product_id&&x.variant_id===item.variant_id);if(index<0)fail('E_TOOL_CALL_UPSTREAM','Shoplazza returned an unrelated procurement failure');remaining.splice(index,1);}
    if(data.fail_items.length)return 'partial_or_failed';
  }
  if(name==='theme-edit-session-batch-operations'){
    if(!Array.isArray(data.data)||data.data.length!==p.body.operations.length)fail('E_TOOL_CALL_UPSTREAM','Shoplazza omitted theme batch acknowledgements');
    let partial=false;data.data.forEach((item,index)=>{if(!object(item)||item.op!==p.body.operations[index].op||typeof item.result!=='string')fail('E_TOOL_CALL_UPSTREAM','Shoplazza returned unrelated theme batch acknowledgements');if(item.result!=='success'){partial=true;item.result='failed';}});if(partial)return 'partial_or_failed';
  }
  if(name==='theme-pb-update'&&Array.isArray(data.failures)&&data.failures.length)return 'partial_or_failed';
  if(name==='file-upload-task'&&Array.isArray(data.failure_list)&&data.failure_list.length)return 'partial_or_failed';
  if(['collection-async-create','smart-collection-rule-async-update'].includes(name)){if(typeof data.error_message==='string'&&data.error_message){delete data.error_message;return 'partial_or_failed';}if(typeof data.async_task_id!=='string'||!data.async_task_id)fail('E_TOOL_CALL_UPSTREAM','Shoplazza omitted the asynchronous task acknowledgement');return 'accepted';}
  if(name==='file-create'){if(typeof data.task_id!=='string'||!data.task_id)fail('E_TOOL_CALL_UPSTREAM','Shoplazza omitted the upload task acknowledgement');return 'accepted';}
  return row.risk==='R'?undefined:'acknowledged';
}
async function execute(config,name,p={}){
  const row=source().methods[name];if(!row)fail('E_BAD_INPUT','Unknown Shoplazza merchant action');validate(row,p);storefront.validateBinding(config);
  if(config.provider!=='shoplazza')fail('storefront_binding_mismatch','Invalid Shoplazza connector binding');
  if(name==='shop-update'&&String(p.path.shop_id)!==config.credentials.identity.shop_id)fail('storefront_binding_mismatch','Shoplazza update targets a different store');
  let route=row.path;for(const [key,value]of Object.entries(p.path||{}))route=route.replace('{'+key+'}',encodeURIComponent(String(value)));
  if(/[{}]/.test(route))fail('E_BAD_INPUT','Missing Shoplazza resource identifier');
  const url=new URL(storefront.apiBase('shoplazza',config.metadata)+route);
  for(const [key,value]of Object.entries(p.query||{}))if(Array.isArray(value))for(const item of value)url.searchParams.append(key,String(item));else url.searchParams.set(key,object(value)?JSON.stringify(value):String(value));
  const token=config.credentials.access_token,deadline=AbortSignal.timeout(60000),init={method:row.method,headers:{accept:'application/json','content-type':'application/json','Access-Token':token},redirect:'error',signal:deadline,...(p.body!==undefined?{body:wireJSON(p.body,row.input_schema.properties.body,row.input_schema.$defs)}:{})};
  let response,text;try{response=await requestFetch(url.toString(),init);}catch(error){fail(requestFailureCode(error,deadline),'Shoplazza request failed; inspect resource state before retrying an uncertain write');}
  if(!response.ok){if([401,403].includes(response.status))throw httpFailure(response.status,'Shoplazza access was denied; check this private app token and the permission required by the action');throw httpFailure(response.status,`Shoplazza request failed (HTTP ${response.status})`);}
  try{text=await storefront.readBody(response);}catch(error){if(error?.code==='E_CONNECTOR_RESPONSE_TOO_LARGE')fail('E_TOOL_CALL_UPSTREAM','Shoplazza response is too large');fail(requestFailureCode(error,deadline),'Shoplazza response could not be read');}
  let body;try{body=parse(text,row);}catch{fail('E_TOOL_CALL_UPSTREAM','Shoplazza returned invalid JSON');}
  if(!object(body)||!(body.code==='Success'||['',0,'0'].includes(body.code)||body.ok===true&&body.code===undefined)||!object(body.data))fail('E_TOOL_CALL_UPSTREAM','Shoplazza returned a business error or omitted its acknowledgement');
  const status=acknowledge(config,name,row,p,body.data);
  return {data:redact(body.data,token),...(status?{status}:{}),...(status==='accepted'?{follow_up:'Read the returned task identifier to verify completion; do not resubmit automatically.'}:{})};
}
module.exports={actionsFor,isNative,execute};
