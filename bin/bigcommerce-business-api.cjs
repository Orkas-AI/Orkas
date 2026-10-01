'use strict';

const storefront=require('./storefront-admin-api.cjs');
const {requestFetch,requestFailureCode,httpFailure}=require('./commerce-request-context.cjs');
let contracts,actions,validator;
const checks=new Map(),inputSchemas=new Map(),responseSchemas=new Map();
const source=()=>contracts ||= require('./bigcommerce-api-contracts.cjs');
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
function attach(schema,mode,ids){return {...schema,$defs:Object.fromEntries(ids.map(id=>[id,source().definitions[mode][id]]))};}
function inputFor(name,row){if(!inputSchemas.has(name))inputSchemas.set(name,attach(row.input_schema,row.risk,row.input_definitions));return inputSchemas.get(name);}
function actionsFor(){return actions ||= Object.fromEntries(Object.entries(source().methods).map(([name,row])=>[name,{risk:row.risk,description:row.description,input_schema:inputFor(name,row)}]));}
const isNative=name=>Object.hasOwn(source().methods,name);
function check(schema,value,code,message){
  if(!validator){const {AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv');validator=new AjvJsonSchemaValidator();}
  let validate=checks.get(schema);if(!validate){validate=validator.getValidator(schema);checks.set(schema,validate);}
  if(!validate(value).valid)fail(code,message);
}
const PRIVATE_FIELDS=new Set(['accesstoken','refreshtoken','authorization','password','cookie','clientsecret','cardnumber','cvv','cvc','paymentinstrumenttoken']);
function clean(value,token){
  if(typeof value==='string')return value.split(token).join('[redacted]');
  if(Array.isArray(value))return value.map(item=>clean(item,token));
  if(!value || typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!PRIVATE_FIELDS.has(key.replace(/[_-]/g,'').toLowerCase())).map(([key,item])=>[key,clean(item,token)]));
}
const shape=s=>s?.$ref?source().definitions.output[s.$ref.slice('#/$defs/'.length)]:s;
function valuesAt(data,parts){
  if(!parts.length)return [data];
  if(!data || typeof data!=='object')return [];
  if(parts[0]==='*')return Object.values(data).flatMap(item=>valuesAt(item,parts.slice(1)));
  return Object.hasOwn(data,parts[0])?valuesAt(data[parts[0]],parts.slice(1)):[];
}
function hideErrors(data,parts){
  if(!data || typeof data!=='object')return;
  if(parts[0]==='*'){Object.values(data).forEach(item=>hideErrors(item,parts.slice(1)));return;}
  if(parts.length===1){if(data[parts[0]] && typeof data[parts[0]]==='object')data.error_count=Object.keys(data[parts[0]]).length;delete data[parts[0]];return;}
  hideErrors(data[parts[0]],parts.slice(1));
}
function businessFailure(row,data){
  return row.error_paths.some(parts=>valuesAt(data,parts).some(value=>value && typeof value==='object' && Object.keys(value).length))
    || row.failed_count_paths.some(parts=>valuesAt(data,parts).some(value=>Number.isInteger(value) && value>0))
    || row.failed_status_paths.some(({path,values})=>valuesAt(data,path).some(value=>values.includes(value)));
}
function acknowledge(name,row,data,status,p){
  if(!Object.hasOwn(row.responses,String(status)))fail('E_TOOL_CALL_UPSTREAM','BigCommerce returned an unexpected acknowledgement status');
  const expected=row.responses[String(status)];
  if(expected===null){if(data!==null)fail('E_TOOL_CALL_UPSTREAM','BigCommerce returned an invalid empty acknowledgement');return false;}
  const projected=Boolean(p.query && (Object.hasOwn(p.query,'include_fields') || Object.hasOwn(p.query,'exclude_fields')));
  const cacheKey=name+' '+status+(projected?' projection':'');
  if(!responseSchemas.has(cacheKey)){
    let schema=attach(expected,'output',row.response_definitions);
    if(projected){
      schema=structuredClone(schema);
      const deref=s=>s?.$ref?schema.$defs[s.$ref.slice('#/$defs/'.length)]:s;
      const root=deref(schema),resource=deref(root?.properties?.data || root),item=deref(resource?.items || resource);
      // Field projections deliberately omit resource fields; retain required ID
      // and nested field types while keeping the response envelope intact.
      if(item?.required)item.required=item.required.filter(key=>key==='id');
    }
    responseSchemas.set(cacheKey,schema);
  }
  check(responseSchemas.get(cacheKey),data,'E_TOOL_CALL_UPSTREAM','BigCommerce returned an incomplete or invalid business acknowledgement');
  const root=shape(expected),partial=businessFailure(row,data);
  const keys=Object.keys(root?.properties || {}).filter(key=>!['errors','meta'].includes(key));
  if(row.risk!=='R' && !partial && keys.length && !keys.some(key=>Object.hasOwn(data || {},key)))fail('E_TOOL_CALL_UPSTREAM','BigCommerce omitted the submitted business acknowledgement');
  // Collection writes return one acknowledgement per submitted root resource.
  // Explicit partial metadata owns failure; no retry fills missing resources.
  if(row.risk!=='R' && Array.isArray(p.body) && root?.properties?.data && Array.isArray(data?.data)){
    if(!partial && data.data.length!==p.body.length)fail('E_TOOL_CALL_UPSTREAM','BigCommerce returned incomplete batch acknowledgements');
    if(data.meta?.total!==undefined && data.meta.total!==p.body.length)fail('E_TOOL_CALL_UPSTREAM','BigCommerce returned unrelated batch acknowledgement totals');
    if(Number.isInteger(data.meta?.success) && data.meta.success!==data.data.length)fail('E_TOOL_CALL_UPSTREAM','BigCommerce returned inconsistent batch acknowledgement counts');
    if(Number.isInteger(data.meta?.success) && Number.isInteger(data.meta?.failed) && data.meta.success+data.meta.failed!==p.body.length)fail('E_TOOL_CALL_UPSTREAM','BigCommerce returned incomplete batch acknowledgement counts');
  }
  if(row.path.startsWith('/v3/inventory/adjustments/') && (typeof data?.transaction_id!=='string' || !data.transaction_id))fail('E_TOOL_CALL_UPSTREAM','BigCommerce omitted the inventory transaction acknowledgement');
  return partial;
}
async function execute(config,name,p={}){
  if(config.provider!=='bigcommerce')fail('E_BAD_INPUT','Unsupported BigCommerce merchant provider');
  storefront.validateBinding(config);
  const row=source().methods[name];if(!row)fail('E_BAD_INPUT','Unknown BigCommerce merchant action');
  let encoded;try{encoded=JSON.stringify(p);}catch{fail('E_BAD_INPUT','Invalid BigCommerce action parameters');}
  if(!encoded || Buffer.byteLength(encoded)>256*1024)fail('E_BAD_INPUT','Invalid or oversized BigCommerce action parameters');
  check(inputFor(name,row),p,'E_BAD_INPUT','Invalid BigCommerce action parameters; check the described fields and types');
  let route=row.path;const query=new URLSearchParams();
  const headers={accept:'application/json','X-Auth-Token':config.credentials.access_token};
  for(const wire of row.wire){
    const value=p[wire.location]?.[wire.name];if(value===undefined)continue;
    if(wire.location==='path'){
      if(!['string','number'].includes(typeof value) || !String(value) || ['.','..'].includes(String(value)) || /[\u0000-\u001f\u007f]/.test(String(value)))fail('E_BAD_INPUT','Invalid BigCommerce resource identifier');
      route=route.replace('{'+wire.name+'}',encodeURIComponent(String(value)));
    }else if(wire.location==='header')headers[wire.name]=value;
    else if(Array.isArray(value) && wire.explode)value.forEach(item=>query.append(wire.name,String(item)));
    else query.append(wire.name,Array.isArray(value)?value.join(','):String(value));
  }
  if(/[{}]/.test(route))fail('E_BAD_INPUT','Missing BigCommerce resource identifier');
  const deadline=AbortSignal.timeout(60000),init={method:row.method,headers,signal:deadline,redirect:'error'};
  if(p.body!==undefined){headers['content-type']='application/json';init.body=JSON.stringify(p.body);}
  let response,text;
  try{response=await requestFetch(storefront.apiBase('bigcommerce',config.metadata)+route+(query.size?'?'+query.toString():''),init);}catch(error){fail(requestFailureCode(error,deadline),'BigCommerce request failed; inspect resource state before retrying an uncertain write');}
  if(!response.ok && !row.partial_http.includes(response.status))throw httpFailure(response.status,'BigCommerce request failed (HTTP '+response.status+')');
  try{text=await storefront.readBody(response);}catch(error){if(error?.code==='E_CONNECTOR_RESPONSE_TOO_LARGE')fail('E_TOOL_CALL_UPSTREAM','BigCommerce response is too large');fail(requestFailureCode(error,deadline),'BigCommerce response could not be read');}
  let data=null;try{if(text)data=JSON.parse(text);}catch{fail('E_TOOL_CALL_UPSTREAM','BigCommerce returned invalid JSON');}
  const failed=acknowledge(name,row,data,response.status,p) || row.partial_http.includes(response.status),result=clean(data,config.credentials.access_token);
  // Error schemas are untyped provider prose, not merchant custom fields.
  for(const parts of row.error_paths)hideErrors(result,parts);
  return {data:result,...(failed?{status:'partial_or_failed'}:row.risk!=='R'?{status:'acknowledged'}:{}),...(row.path.startsWith('/v3/inventory/adjustments/')?{follow_up:'Inventory is processed asynchronously. Read inventory to verify final quantities; do not automatically resubmit.'}:{})};
}
module.exports={actionsFor,isNative,execute};
