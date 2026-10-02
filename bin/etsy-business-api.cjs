'use strict';

const {requestFetch,requestFailureCode,httpFailure}=require('./commerce-request-context.cjs');
const {readBody}=require('./storefront-admin-api.cjs');
let contracts,actions,validator;
const checks=new Map(),schemas=new Map();
const source=()=>contracts ||= require('./etsy-api-contracts.cjs');
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
function schemaFor(name,row,outputStatus){
  const key=name+' '+(outputStatus??'input');
  if(!schemas.has(key)){
    const mode=outputStatus===undefined?row.risk:'output',root=outputStatus===undefined?row.input_schema:row.responses[String(outputStatus)],ids=outputStatus===undefined?row.input_definitions:row.response_definitions;
    schemas.set(key,{...root,$defs:Object.fromEntries(ids.map(id=>[id,source().definitions[mode][id]]))});
  }
  return schemas.get(key);
}
function actionsFor(){return actions ||= Object.fromEntries(Object.entries(source().methods).map(([name,row])=>[name,{risk:row.risk,description:row.description,input_schema:schemaFor(name,row)}]));}
const isNative=name=>Object.hasOwn(source().methods,name);
function check(schema,value,code,message){
  if(!validator){const {AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv');validator=new AjvJsonSchemaValidator();}
  let test=checks.get(schema);if(!test){test=validator.getValidator(schema);checks.set(schema,test);}
  if(!test(value).valid)fail(code,message);
}
const PRIVATE_FIELDS=new Set(['accesstoken','refreshtoken','sharedsecret','authorization','password','cookie']);
function output(value,secrets){
  if(typeof value==='string'){for(const secret of secrets)if(secret)value=value.split(secret).join('[redacted]');return value;}
  if(Array.isArray(value))return value.map(item=>output(item,secrets));
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!PRIVATE_FIELDS.has(key.replace(/[_-]/g,'').toLowerCase())).map(([key,item])=>[key,output(item,secrets)]));
}
function validateInput(name,row,p){
  let encoded;try{encoded=JSON.stringify(p);}catch{fail('E_BAD_INPUT','Invalid Etsy action parameters');}
  if(!encoded||Buffer.byteLength(encoded)>256*1024)fail('E_BAD_INPUT','Invalid or oversized Etsy action parameters');
  check(schemaFor(name,row),p,'E_BAD_INPUT','Invalid Etsy action parameters; check the described fields and types');
  for(const value of Object.values(p.path||{}))if(typeof value==='string'&&(!value||value==='.'||value==='..'||/[\u0000-\u001f\u007f]/.test(value)))fail('E_BAD_INPUT','Invalid Etsy resource identifier');
  for(const field of row.binary){const value=p.body?.[field];if(value===undefined||value===null)continue;const bytes=Buffer.from(value,'base64');if(!bytes.length||bytes.toString('base64')!==value)fail('E_BAD_INPUT','Etsy upload requires canonical base64 data');}
  if(row.media==='multipart/form-data'&&p.body.name!==undefined&&/[\/\\\u0000-\u001f\u007f]/.test(p.body.name))fail('E_BAD_INPUT','Etsy upload requires a plain file name');
  if(p.query?.listing_ids&&(!p.query.listing_ids.length||new Set(p.query.listing_ids).size!==p.query.listing_ids.length))fail('E_BAD_INPUT','Etsy listing batch requires unique identifiers');
}
// Etsy's URL Syntax overrides OpenAPI's omitted explode default: query and
// form arrays are comma-separated, never repeated keys (which lose IDs).
const encodedValue=value=>value===null?'':Array.isArray(value)?value.join(','):String(value);
function acknowledge(name,row,data,status){
  if(!Object.hasOwn(row.responses,String(status)))fail('E_TOOL_CALL_UPSTREAM','Etsy returned an unexpected acknowledgement status');
  const expected=row.responses[String(status)];
  if(expected===null){if(data!==null)fail('E_TOOL_CALL_UPSTREAM','Etsy returned an invalid empty acknowledgement');return;}
  if(!data||typeof data!=='object'||Array.isArray(data))fail('E_TOOL_CALL_UPSTREAM','Etsy returned a missing business acknowledgement');
  // ErrorSchema owns the root error envelope. Merchant description/review text
  // and error-looking nested custom values remain ordinary business data.
  if(Object.hasOwn(data,'error'))fail('E_TOOL_CALL_UPSTREAM','Etsy returned a business error');
  check(schemaFor(name,row,status),data,'E_TOOL_CALL_UPSTREAM','Etsy returned an invalid business acknowledgement');
  const root=expected.$ref?source().definitions.output[expected.$ref.slice('#/$defs/'.length)]:expected;
  if(root.properties&&!Object.keys(root.properties).some(key=>Object.hasOwn(data,key)))fail('E_TOOL_CALL_UPSTREAM','Etsy omitted the business acknowledgement');
  if(root.properties?.results&&(!Array.isArray(data.results)||!Number.isInteger(data.count)||data.count<0))fail('E_TOOL_CALL_UPSTREAM','Etsy omitted page results or count');
}
const LISTING_BATCHES=new Set(['getListingsByListingIds','getListingsInventoryByListingIds','getListingsShippingByListingIds']);
async function execute(config,name,p={},owners){
  const row=source().methods[name];if(!row)fail('E_BAD_INPUT','Unknown Etsy merchant action');
  validateInput(name,row,p);
  let route=row.path;
  for(const binding of row.bindings){
    const value=binding==='shop_id'?config.metadata.shop_id:config.credentials.identity?.user_id;
    if(!/^[1-9][0-9]{0,18}$/.test(String(value||'')))fail('E_TOOL_CALL_AUTH','Etsy merchant binding is invalid; reconnect this connector');
    route=route.replace('{'+binding+'}',encodeURIComponent(String(value)));
  }
  const query=new URLSearchParams();
  for(const wire of row.wire){const value=p[wire.location]?.[wire.name];if(value===undefined)continue;if(wire.location==='path')route=route.replace('{'+wire.name+'}',encodeURIComponent(String(value)));else query.append(wire.name,encodedValue(value));}
  if(/[{}]/.test(route))fail('E_BAD_INPUT','Missing Etsy resource identifier');
  const apiKey=owners.apiKey(config),token=await owners.token(config);
  const granted=new Set(String(config.credentials.scope||'').split(/[ ,]+/).filter(Boolean));
  if(row.scopes.some(scope=>!granted.has(scope)))fail('E_TOOL_CALL_AUTH','Etsy authorization is missing a required scope; reconnect this connector');
  const deadline=AbortSignal.timeout(row.media==='multipart/form-data'?600000:60000),headers={accept:'application/json',authorization:'Bearer '+token,'x-api-key':apiKey};
  const init={method:row.method,headers,signal:deadline,redirect:'error'};
  if(row.media==='multipart/form-data'){
    const form=new FormData();for(const [key,value]of Object.entries(p.body)){
      if(row.binary.includes(key)){if(value!==null)form.append(key,new Blob([Buffer.from(value,'base64')],{type:'application/octet-stream'}),p.body.name||'upload.bin');}
      else form.append(key,encodedValue(value));
    }init.body=form;
  }else if(row.media==='application/json'){headers['content-type']='application/json; charset=utf-8';init.body=JSON.stringify(p.body);}
  else if(row.media==='application/x-www-form-urlencoded'){headers['content-type']=row.media+'; charset=utf-8';init.body=new URLSearchParams(Object.entries(p.body).map(([key,value])=>[key,encodedValue(value)])).toString();}
  let response,text;
  try{response=await requestFetch('https://openapi.etsy.com'+route+(query.size?'?'+query.toString():''),init);}catch(error){fail(requestFailureCode(error,deadline),'Etsy request failed; inspect resource state before retrying an uncertain write');}
  if(!response.ok)throw httpFailure(response.status,`Etsy request failed (HTTP ${response.status})`);
  try{text=await readBody(response);}catch(error){if(error?.code==='E_CONNECTOR_RESPONSE_TOO_LARGE')fail('E_TOOL_CALL_UPSTREAM','Etsy response is too large');fail(requestFailureCode(error,deadline),'Etsy response could not be read');}
  let data=null;try{if(text)data=JSON.parse(text);}catch{fail('E_TOOL_CALL_UPSTREAM','Etsy returned invalid JSON');}
  acknowledge(name,row,data,response.status);
  const clean=output(data,[token,config.credentials.refresh_token,config.credentials.shared_secret,apiKey]);
  if(LISTING_BATCHES.has(name)){
    const requested=p.query.listing_ids,returned=data.results.map(item=>item.listing_id);
    if(returned.some(id=>!requested.includes(id))||new Set(returned).size!==returned.length)fail('E_TOOL_CALL_UPSTREAM','Etsy returned unrelated or duplicate batch resources');
    const missing=requested.filter(id=>!returned.includes(id));
    if(missing.length)return {data:clean,status:'partial_or_failed',missing_listing_ids:missing};
  }
  return {data:clean,...(row.risk!=='R'?{status:'acknowledged'}:{})};
}
module.exports={actionsFor,isNative,execute};
