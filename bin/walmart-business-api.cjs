'use strict';
const crypto=require('node:crypto');
const storefront=require('./storefront-admin-api.cjs');
const {requestFetch,requestFailureCode,httpFailure}=require('./commerce-request-context.cjs');
let contracts,validator,nativeNames;const actionCache=new Map(),schemas=new Map(),checks=new Map();
const source=()=>contracts ||= require('./walmart-api-contracts.cjs');
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function attach(s,ids){return {...s,$defs:Object.fromEntries(ids.map(id=>[id,source().definitions[id]]))};}
function input(row){const key=row.market+' '+row.action;if(!schemas.has(key))schemas.set(key,attach(row.input_schema,row.input_definitions));return schemas.get(key);}
function binding(config){
 const market=config.metadata?.market,environment=config.metadata?.environment||'live';
 if(config.provider!=='walmart'||!['us','ca','mx','cl'].includes(market)||!['live','sandbox'].includes(environment)||(environment==='sandbox'&&market!=='us'))fail('E_BAD_INPUT','Invalid Walmart market or environment binding');
 return {market,environment};
}
function actionsFor(config){const {market,environment}=binding(config),key=market+' '+environment;if(!actionCache.has(key))actionCache.set(key,Object.fromEntries(Object.values(source().methods).filter(row=>row.market===market&&row.environments.includes(environment)).map(row=>[row.action,{risk:row.risk,description:row.description,input_schema:input(row)}])));return actionCache.get(key);}
function isNative(name){nativeNames ||= new Set(Object.values(source().methods).map(row=>row.action));return nativeNames.has(name);}
function check(schema,value,code,message){
 if(!validator){const {AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv');validator=new AjvJsonSchemaValidator();}
 let validate=checks.get(schema);if(!validate){validate=validator.getValidator(schema);checks.set(schema,validate);}if(!validate(value).valid)fail(code,message);
}
function shape(s){return s?.$ref?source().definitions[s.$ref.slice('#/$defs/'.length)]:s;}
function field(s,key){s=shape(s);if(!s)return undefined;return s.properties?.[key]||s.items||(object(s.additionalProperties)?s.additionalProperties:undefined)||[...s.allOf||[],...s.anyOf||[],...s.oneOf||[]].map(v=>field(v,key)).find(Boolean);}
class NumericToken{constructor(text){this.text=text;}}
function numericKind(schema,seen=new Set()){
 const s=shape(schema);if(!s||seen.has(s))return[];seen.add(s);
 return [s['x-walmart-int64']?'int64':s.type,...[...s.allOf||[],...s.anyOf||[],...s.oneOf||[]].flatMap(v=>numericKind(v,seen))].filter(Boolean);
}
function parse(text,schema){
 const parsed=JSON.parse(text,(_key,value,context)=>typeof value==='number'&&Math.abs(value)>Number.MAX_SAFE_INTEGER&&context?.source?new NumericToken(context.source):value);
 function restore(v,s){
  s=shape(s);if(v instanceof NumericToken){const kinds=numericKind(s);return kinds.includes('number')&&!kinds.includes('int64')?Number(v.text):v.text;}
  if(Array.isArray(v))return v.map(x=>restore(x,field(s,'*')));if(!object(v))return v;return Object.fromEntries(Object.entries(v).map(([key,x])=>[key,restore(x,field(s,key))]));
 }
 return restore(parsed,schema);
}
const privateFields=new Set(['accesstoken','refreshtoken','clientsecret','authorization','password','cookie','cardnumber','cvv','cvc']);
function clean(value,secrets){if(typeof value==='string')return secrets.reduce((v,s)=>s?v.split(s).join('[redacted]'):v,value);if(Array.isArray(value))return value.map(v=>clean(v,secrets));if(!object(value))return value;return Object.fromEntries(Object.entries(value).filter(([key])=>!privateFields.has(key.replace(/[_-]/g,'').toLowerCase())).map(([key,v])=>[key,clean(v,secrets)]));}
function values(data,parts){if(!parts.length)return[data];if(!data||typeof data!=='object')return[];return parts[0]==='*'?Object.values(data).flatMap(v=>values(v,parts.slice(1))):Object.hasOwn(data,parts[0])?values(data[parts[0]],parts.slice(1)):[];}
function nonempty(v){return Array.isArray(v)?v.length>0:object(v)?Object.values(v).some(nonempty):v!==null&&v!==undefined&&v!==''&&v!==false&&v!==0;}
function errorFailure(value){
 if(Array.isArray(value))return value.some(errorFailure);if(!object(value))return nonempty(value);
 if(['INFO','WARN'].includes(value.severity))return false;
 const nested=['errors','error','ingestionError','ingestionErrors'].filter(k=>Object.hasOwn(value,k));
 return nested.length?nested.some(k=>errorFailure(value[k])):nonempty(value);
}
function diagnostics(data,parts){
 if(!data||typeof data!=='object')return;
 if(parts[0]==='*'){Object.values(data).forEach(v=>diagnostics(v,parts.slice(1)));return;}
 if(parts.length>1){diagnostics(data[parts[0]],parts.slice(1));return;}
 const key=parts[0];if(!Object.hasOwn(data,key))return;
 function safe(v,nested=false){if(Array.isArray(v))return v.map(x=>safe(x,nested));if(!object(v))return typeof v==='string'&&!nested?'[provider diagnostic omitted]':v;return Object.fromEntries(Object.entries(v).filter(([k])=>!['description','message','info','details','errorDescription','errorMessage','cause'].includes(k)).map(([k,x])=>[k,safe(x,true)]));}
 data[key]=safe(data[key]);
}
function acknowledge(row,data,status,p){
 if(!Object.hasOwn(row.responses,String(status)))fail('E_TOOL_CALL_UPSTREAM','Walmart returned an undocumented acknowledgement status');
 const expected=row.responses[String(status)];if(expected===null){if(data!==null)fail('E_TOOL_CALL_UPSTREAM','Walmart returned an invalid empty acknowledgement');return false;}
 const key=row.market+' '+row.action+' response '+status;if(!schemas.has(key))schemas.set(key,attach(expected,row.response_definitions));
 check(schemas.get(key),data,'E_TOOL_CALL_UPSTREAM','Walmart returned an invalid business response');
 const failed=row.error_paths.some(parts=>values(data,parts).some(errorFailure))||row.failure_paths.some(f=>values(data,f.path).some(v=>f.kind==='positive'?typeof v==='number'&&v>0:f.values.includes(v)));
 const root=shape(expected),keys=Object.keys(root?.properties||{});
 if(object(data)&&keys.length&&!keys.some(k=>Object.hasOwn(data,k)))fail('E_TOOL_CALL_UPSTREAM','Walmart omitted the business acknowledgement');
 if(row.async&&!failed&&(typeof data?.feedId!=='string'||!data.feedId)&&row.path!=='/v3/reports/reportRequests')fail('E_TOOL_CALL_UPSTREAM','Walmart omitted the feed acknowledgement');
 if(row.method==='PUT'&&row.path==='/v3/inventory'&&!failed){if(data.sku!==p.body?.sku||data.sku!==p.query?.sku||data.quantity?.amount!==p.body?.quantity?.amount)fail('E_TOOL_CALL_UPSTREAM','Walmart returned unrelated inventory acknowledgement');}
 if(row.method==='PUT'&&row.path==='/v3/inventories/{sku}') {
  const submitted=p.body?.inventories?.nodes,received=data?.nodes;
  if(!Array.isArray(received)||received.length!==submitted.length||data.sku!==p.path.sku||new Set(received.map(v=>v.shipNode)).size!==received.length||received.some(v=>!submitted.some(x=>x.shipNode===v.shipNode)))fail('E_TOOL_CALL_UPSTREAM','Walmart returned incomplete or unrelated inventory acknowledgements');
  if(!failed&&received.some(v=>v.status!=='Success'))fail('E_TOOL_CALL_UPSTREAM','Walmart omitted successful node acknowledgements');
 }
 if(row.path.includes('/orders/{purchaseOrderId}')&&data?.order?.purchaseOrderId!==undefined&&String(data.order.purchaseOrderId)!==String(p.path?.purchaseOrderId))fail('E_TOOL_CALL_UPSTREAM','Walmart returned an unrelated order acknowledgement');
 return failed;
}
async function execute(config,name,p={},owners){
 const {market,environment}=binding(config),row=source().methods[market+' '+name];if(!row||!row.environments.includes(environment))fail('E_BAD_INPUT','Walmart action is not available for the bound market or environment');
 if(typeof owners?.base!=='function'||typeof owners?.token!=='function')fail('E_BAD_INPUT','Walmart credential owner is unavailable');
 const base=owners.base(config),expectedBase=environment==='sandbox'?'https://sandbox.walmartapis.com':'https://marketplace.walmartapis.com';if(base!==expectedBase)fail('E_BAD_INPUT','Invalid Walmart API authority');
 let encoded;try{encoded=JSON.stringify(p);}catch{fail('E_BAD_INPUT','Invalid Walmart parameters');}if(!encoded||Buffer.byteLength(encoded)>262144)fail('E_BAD_INPUT','Invalid or oversized Walmart parameters');
 check(input(row),p,'E_BAD_INPUT','Invalid Walmart parameters; check the described market-specific fields and types');
 if(row.method==='PUT'&&['/v3/inventory','/v3/inventories/{sku}'].includes(row.path)){const quantities=row.path==='/v3/inventory'?[p.body?.quantity]:p.body?.inventories?.nodes?.map(v=>v.inputQty);if(!quantities?.length||quantities.some(v=>v?.unit!=='EACH'||!Number.isSafeInteger(v.amount)||v.amount<0||v.amount>1000000000))fail('E_BAD_INPUT','Walmart inventory quantities must be bounded nonnegative whole units');}
 if(row.method==='PUT'&&row.path==='/v3/inventory'&&p.body?.sku!==p.query?.sku)fail('E_BAD_INPUT','Walmart inventory SKU must match the request SKU');
 let route=row.path;const query=new URLSearchParams(row.fixed_query),headers={accept:'application/json','WM_MARKET':market,'WM_QOS.CORRELATION_ID':crypto.randomUUID(),'WM_SVC.NAME':'Walmart Marketplace'};
 if(row.owned_headers.includes('wm_global_version')||market!=='us')headers.WM_GLOBAL_VERSION='3.1';if(environment==='sandbox')headers.WM_SANDBOX='v2';
 for(const wire of row.wire){const value=p[wire.location]?.[wire.name]??wire.default;if(value===undefined)continue;
  if(wire.location==='path'){
   let decoded=String(value);try{decoded=decodeURIComponent(decoded);}catch{}
   if(!['string','number'].includes(typeof value)||!String(value)||/(?:^|[\/\\])\.{1,2}(?:[\/\\]|$)/.test(decoded)||/[\u0000-\u001f\u007f]/.test(String(value)))fail('E_BAD_INPUT','Invalid Walmart resource identifier');route=route.replace('{'+wire.name+'}',encodeURIComponent(String(value)));
  }else if(wire.location==='header')headers[wire.name]=value;
  else if(Array.isArray(value)){if(wire.style==='form'&&wire.explode)value.forEach(v=>query.append(wire.name,String(v)));else query.append(wire.name,value.join(wire.style==='spaceDelimited'?' ':wire.style==='pipeDelimited'?'|':','));}
  else if(object(value)){const entries=Object.entries(value);if(entries.some(([,v])=>v!==null&&typeof v==='object'))fail('E_BAD_INPUT','Unsupported nested Walmart query value');if(wire.style==='deepObject')entries.forEach(([k,v])=>query.append(wire.name+'['+k+']',String(v)));else if(wire.style==='form'&&wire.explode)entries.forEach(([k,v])=>query.append(k,String(v)));else if(wire.style==='form')query.append(wire.name,entries.flatMap(([k,v])=>[k,String(v)]).join(','));else fail('E_BAD_INPUT','Unsupported Walmart query serialization');}
  else query.append(wire.name,String(value));
 }
 if(/[{}]/.test(route))fail('E_BAD_INPUT','Missing Walmart resource identifier');
 const token=await owners.token(config);if(typeof token!=='string'||!token||/[\r\n]/.test(token))fail('E_TOOL_CALL_AUTH','Invalid Walmart access token');headers['WM_SEC.ACCESS_TOKEN']=token;
 // Legacy US/global operation definitions sometimes require Basic in addition
 // to the access-token header; both derive from this same bound seller grant.
 if(row.owned_headers.includes('authorization'))headers.Authorization='Basic '+Buffer.from(config.credentials.client_id+':'+config.credentials.client_secret).toString('base64');
 const deadline=AbortSignal.timeout(60000),init={method:row.method,headers,signal:deadline,redirect:'error'};if(p.body!==undefined){headers['content-type']='application/json';init.body=JSON.stringify(p.body);}
 let response,text;try{response=await requestFetch(base+route+(query.size?'?'+query.toString():''),init);}catch(error){fail(requestFailureCode(error,deadline),'Walmart request failed; reconcile resource state before retrying an uncertain write');}
 if(!response.ok)throw httpFailure(response.status,'Walmart request failed (HTTP '+response.status+')');
 try{text=await storefront.readBody(response);}catch(error){if(error?.code==='E_CONNECTOR_RESPONSE_TOO_LARGE')fail('E_TOOL_CALL_UPSTREAM','Walmart response is too large');fail(requestFailureCode(error,deadline),'Walmart response could not be read');}
 let data=null;try{if(text)data=parse(text,row.responses[String(response.status)]);}catch{fail('E_TOOL_CALL_UPSTREAM','Walmart returned invalid JSON');}
 const failed=acknowledge(row,data,response.status,p)||[206,207].includes(response.status),result=clean(data,[token,config.credentials.client_secret]);for(const parts of row.error_paths)diagnostics(result,parts);
 const pending=row.pending_paths.some(f=>values(data,f.path).some(v=>f.values.includes(v)));
 return {data:result,...(failed?{status:'partial_or_failed'}:row.async||pending?{status:'accepted'}:row.risk!=='R'?{status:'acknowledged'}:{}),...(row.async||pending?{follow_up:'Processing may be asynchronous. Read the returned feed/report ID or resource state to verify completion; do not automatically resubmit.'}:{})};
}
module.exports={actionsFor,isNative,execute};
