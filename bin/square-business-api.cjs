'use strict';

const {requestFetch,requestFailureCode,httpFailure}=require('./commerce-request-context.cjs');
const {readBody}=require('./storefront-admin-api.cjs');
let contracts,actions,validator;
const checks=new Map(),inputSchemas=new Map(),responseSchemas=new Map();
const source=()=>contracts ||= require('./square-api-contracts.cjs');
const failure=(code,message)=>{throw Object.assign(new Error(message),{code});};
function withDefinitions(schema,mode,ids) {
  return {...schema,$defs:Object.fromEntries(ids.map(id=>[id,source().definitions[mode][id]]))};
}
function inputFor(name,row) {
  if(!inputSchemas.has(name))inputSchemas.set(name,withDefinitions(row.input_schema,row.risk,row.input_definitions));
  return inputSchemas.get(name);
}
function actionsFor() {
  return actions ||= Object.fromEntries(Object.entries(source().methods).map(([name,row])=>[name,{risk:row.risk,description:row.description,input_schema:inputFor(name,row)}]));
}
const isNative=name=>Object.hasOwn(source().methods,name);
function check(schema,value,code,message) {
  if(!validator){const {AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv');validator=new AjvJsonSchemaValidator();}
  let validate=checks.get(schema);
  if(!validate){validate=validator.getValidator(schema);checks.set(schema,validate);}
  if(!validate(value).valid)failure(code,message);
}
function atPath(value,parts) {
  if(!parts.length)return [value];
  if(parts[0]==='*')return value && typeof value==='object' ? Object.values(value).flatMap(item=>atPath(item,parts.slice(1))) : [];
  return value && typeof value==='object' && Object.hasOwn(value,parts[0]) ? atPath(value[parts[0]],parts.slice(1)) : [];
}
function removePath(value,parts) {
  if(!value || typeof value!=='object')return;
  if(parts[0]==='*'){for(const item of Object.values(value))removePath(item,parts.slice(1));return;}
  if(parts.length===1){delete value[parts[0]];return;}
  removePath(value[parts[0]],parts.slice(1));
}
const PRIVATE_FIELDS=new Set(['accesstoken','refreshtoken','authorization','password','cookie','signaturekey']);
function output(value,token) {
  if(typeof value==='string')return token ? value.split(token).join('[redacted]') : value;
  if(Array.isArray(value))return value.map(item=>output(item,token));
  if(!value || typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!PRIVATE_FIELDS.has(key.replace(/[_-]/g,'').toLowerCase())).map(([key,item])=>[key,output(item,token)]));
}
function validateInput(name,row,p) {
  let encoded;try{encoded=JSON.stringify(p);}catch{failure('E_BAD_INPUT','Invalid Square action parameters');}
  if(!encoded || Buffer.byteLength(encoded)>256*1024)failure('E_BAD_INPUT','Invalid or oversized Square action parameters');
  check(inputFor(name,row),p,'E_BAD_INPUT','Invalid Square action parameters; check the described fields and types');
  for(const id of Object.values(p.path || {}))if(typeof id!=='string' || !id || id==='.' || id==='..' || /[\u0000-\u001f\u007f]/.test(id))failure('E_BAD_INPUT','Invalid Square resource identifier');
  const mapping=row.bulk_mapping,limit=row.risk==='R' ? 100 : row.risk==='W' ? 25 : 10;
  if(mapping && p.body?.[mapping[0]]){
    const values=p.body[mapping[0]],count=Array.isArray(values) ? values.length : Object.keys(values).length;
    if(!count || count>limit)failure('E_BAD_INPUT','Square bulk input exceeds the existing host batch limit');
    if(Array.isArray(values) && new Set(values).size!==count)failure('E_BAD_INPUT','Duplicate Square bulk resource identifiers');
  }
  if(row.multipart){
    const bytes=Buffer.from(p.body.image_file,'base64');
    if(!bytes.length || bytes.toString('base64')!==p.body.image_file || bytes[0]!==0xff || bytes[1]!==0xd8)failure('E_BAD_INPUT','Square upload requires canonical base64 JPEG data');
  }
}
function failurePresent(row,data) {
  return row.error_paths.some(parts=>atPath(data,parts).some(item=>item && typeof item==='object' && Object.keys(item).length>0));
}
function acknowledge(name,row,data,status) {
  if(!Object.hasOwn(row.responses,String(status)))failure('E_TOOL_CALL_UPSTREAM','Square returned an unexpected acknowledgement status');
  const expected=row.responses[String(status)];
  if(expected===null){if(data!==null && (!data || typeof data!=='object' || Array.isArray(data) || Object.keys(data).length))failure('E_TOOL_CALL_UPSTREAM','Square returned an invalid empty acknowledgement');return;}
  if(!data || typeof data!=='object')failure('E_TOOL_CALL_UPSTREAM','Square returned a missing business acknowledgement');
  const key=name+' '+status;
  if(!responseSchemas.has(key))responseSchemas.set(key,withDefinitions(expected,'output',row.response_definitions));
  check(responseSchemas.get(key),data,'E_TOOL_CALL_UPSTREAM','Square returned an incomplete or invalid business acknowledgement');
  const root=expected.$ref ? source().definitions.output[expected.$ref.slice('#/$defs/'.length)] : expected;
  const businessKeys=Object.keys(root.properties || {}).filter(key=>key!=='errors');
  if(row.risk!=='R' && !failurePresent(row,data) && businessKeys.length && !businessKeys.some(key=>Object.hasOwn(data,key)))failure('E_TOOL_CALL_UPSTREAM','Square omitted the submitted business acknowledgement');
}
// Bulk maps have provider-defined correlation keys. Merchant custom attributes
// and error-looking business fields never own transport failure classification.

function reconcile(row,p,data,status) {
  const mapping=row.bulk_mapping,field=mapping?.[0];
  if(!field || !p.body?.[field])return;
  const requested=Array.isArray(p.body[field]) ? p.body[field] : Object.keys(p.body[field]);
  const results=data[mapping[1]];
  if(!results && Array.isArray(data.errors) && data.errors.length)return;
  if(!results || typeof results!=='object' || Array.isArray(results))failure('E_TOOL_CALL_UPSTREAM','Square omitted bulk resource acknowledgements');
  const returned=Object.keys(results);
  if(returned.length!==requested.length || returned.some(id=>!requested.includes(id)))failure('E_TOOL_CALL_UPSTREAM','Square returned missing or unrelated bulk acknowledgements');
  const shape=s=>s?.$ref ? source().definitions.output[s.$ref.slice('#/$defs/'.length)] : s;
  const entry=shape(shape(row.responses[String(status)]).properties[mapping[1]].additionalProperties);
  const businessKeys=Object.keys(entry.properties || {}).filter(key=>key!=='errors');
  for(const result of Object.values(results))if(businessKeys.length && !result.errors?.length && !businessKeys.some(key=>Object.hasOwn(result,key)))failure('E_TOOL_CALL_UPSTREAM','Square omitted a bulk item business acknowledgement');
}
async function execute(config,name,p={},owners) {
  const row=source().methods[name];
  if(!row)failure('E_BAD_INPUT','Unknown Square merchant action');
  validateInput(name,row,p);
  let route=row.path;
  const query=new URLSearchParams();
  for(const wire of row.wire){
    const value=p[wire.location]?.[wire.name];if(value===undefined)continue;
    if(wire.location==='path')route=route.replace('{'+wire.name+'}',encodeURIComponent(value));
    else if(Array.isArray(value) && wire.explode)for(const item of value)query.append(wire.name,String(item));
    else query.append(wire.name,Array.isArray(value)?value.join(','):String(value));
  }
  if(/[{}]/.test(route))failure('E_BAD_INPUT','Missing Square resource identifier');
  const token=config.credentials.access_token,deadline=AbortSignal.timeout(row.multipart ? 600000 : 60000);
  const headers={accept:'application/json',authorization:'Bearer '+token,'square-version':source().api_version};
  const init={method:row.method,headers,signal:deadline,redirect:'error'};
  if(row.multipart){
    const form=new FormData();form.append('request',new Blob([JSON.stringify(p.body.request)],{type:'application/json; charset=utf-8'}),'request.json');
    form.append('image_file',new Blob([Buffer.from(p.body.image_file,'base64')],{type:'image/jpeg'}),'upload.jpg');init.body=form;
  }else if(p.body!==undefined){headers['content-type']='application/json';init.body=JSON.stringify(p.body);}
  let response,text;
  try{response=await requestFetch(owners.base(config)+route+(query.size?'?'+query.toString():''),init);}catch(error){failure(requestFailureCode(error,deadline),'Square request failed; inspect resource state before retrying an uncertain write');}
  if(!response.ok)throw httpFailure(response.status,`Square request failed (HTTP ${response.status})`);
  try{text=await readBody(response);}catch(error){if(error?.code==='E_CONNECTOR_RESPONSE_TOO_LARGE')failure('E_TOOL_CALL_UPSTREAM','Square response is too large');failure(requestFailureCode(error,deadline),'Square response could not be read');}
  let data=null;try{if(text)data=JSON.parse(text);}catch{failure('E_TOOL_CALL_UPSTREAM','Square returned invalid JSON');}
  acknowledge(name,row,data,response.status);reconcile(row,p,data,response.status);
  const failed=failurePresent(row,data),clean=output(data,token);
  for(const parts of row.error_prose_paths)removePath(clean,parts);
  return {data:clean,...(failed ? {status:'partial_or_failed'} : row.risk!=='R' ? {status:'acknowledged'} : {})};
}
module.exports={actionsFor,isNative,execute};
