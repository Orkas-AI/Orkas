'use strict';
const {requestFetch,requestFailureCode,httpFailure}=require('./commerce-request-context.cjs');
const {readBody}=require('./storefront-admin-api.cjs');
let contracts,actions,validator;
const checks=new Map(),schemas=new Map(),responseSchemas=new Map();
const source=()=>contracts ||= require('./ebay-api-contracts.cjs');
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const grants=config=>new Set(String(config.credentials?.scope || '').split(/[ ,]+/).filter(Boolean));
const allowed=(row,config)=>row.scopes.some(scope=>grants(config).has(scope));
function withDefs(s,mode,ids){return {...s,$defs:Object.fromEntries(ids.map(id=>[id,source().definitions[mode][id]]))};}
function input(name,row){if(!schemas.has(name))schemas.set(name,withDefs(row.input_schema,row.risk,row.input_definitions));return schemas.get(name);}
function actionsFor(config){
 actions ||= Object.fromEntries(Object.entries(source().methods).map(([name,row])=>[name,{risk:row.risk,description:row.description,input_schema:input(name,row)}]));
 return Object.fromEntries(Object.entries(actions).filter(([name])=>allowed(source().methods[name],config)));
}
const isNative=name=>Object.hasOwn(source().methods,name);
function check(schema,value,code,message){
 if(!validator){const {AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv');validator=new AjvJsonSchemaValidator();}
 if(!checks.has(schema))checks.set(schema,validator.getValidator(schema));if(!checks.get(schema)(value).valid)fail(code,message);
}
function at(value,parts){
 if(!parts.length)return [value];if(!value||typeof value!=='object')return [];
 if(parts[0]==='*')return Object.values(value).flatMap(v=>at(v,parts.slice(1)));
 return Object.hasOwn(value,parts[0])?at(value[parts[0]],parts.slice(1)):[];
}
function remove(value,parts){
 if(!value||typeof value!=='object')return;
 if(parts[0]==='*'){for(const v of Object.values(value))remove(v,parts.slice(1));return;}
 if(parts.length===1)delete value[parts[0]];else remove(value[parts[0]],parts.slice(1));
}
const PRIVATE=new Set(['accesstoken','refreshtoken','authorization','password','cookie','signingprivatekey','signingkeyjwe']);
function output(v,secretValues){
 if(typeof v==='string'){for(const token of secretValues)if(token)v=v.split(token).join('[redacted]');return v;}
 if(Array.isArray(v))return v.map(x=>output(x,secretValues));
 if(!v||typeof v!=='object')return v;
 return Object.fromEntries(Object.entries(v).filter(([k])=>!PRIVATE.has(k.replace(/[_-]/g,'').toLowerCase())).map(([k,x])=>[k,output(x,secretValues)]));
}
function bind(schema,value,defs,config){
 if(value===undefined||value===null)return;
 if(schema.$ref){bind(defs[schema.$ref.slice('#/$defs/'.length)],value,defs,config);return;}
 if(schema.type==='array'){for(const v of value)bind(schema.items,v,defs,config);return;}
 if(schema.type!=='object')return;
 for(const [key,child]of Object.entries(schema.properties||{})){
  if(!Object.hasOwn(value,key))continue;
  if(['marketplaceId','marketplace_id'].includes(key)&&value[key]!==config.metadata.marketplace_id)fail('E_BAD_INPUT','eBay marketplace does not match the connected account binding');
  if(key==='locale'&&String(value[key]).replace('_','-')!==config.metadata.content_language)fail('E_BAD_INPUT','eBay locale does not match the connected account binding');
  bind(child,value[key],defs,config);
 }
 // Typed maps are business-owned keys; only their declared value schemas bind.
 if(typeof schema.additionalProperties==='object')for(const [key,v]of Object.entries(value))if(!Object.hasOwn(schema.properties||{},key))bind(schema.additionalProperties,v,defs,config);
}
function bulkRequests(row,p){
 if(!row.bulk)return [];
 const requests=p.body[row.bulk.request];
 if(!row.bulk.expand_offers)return requests.map(r=>({...r,...Object.fromEntries(Object.entries(row.bulk.request_aliases||{}).map(([k,source])=>[k,r[source]]))}));
 return requests.flatMap(r=>[
  ...(r.shipToLocationAvailability? [{sku:r.sku}]:[]),
  ...(r.offers||[]).map(o=>({sku:r.sku,offerId:o.offerId})),
 ]);
}
const identity=(bulk,v)=>JSON.stringify(bulk.expand_offers ? (v.offerId?['offer',v.offerId]:['sku',v.sku]) : bulk.keys.map(k=>v[k]??null));
function validate(name,row,p,config){
 let text;try{text=JSON.stringify(p);}catch{fail('E_BAD_INPUT','Invalid eBay action parameters');}
 if(!text||Buffer.byteLength(text)>262144)fail('E_BAD_INPUT','Invalid or oversized eBay action parameters');
 const schema=input(name,row);check(schema,p,'E_BAD_INPUT','Invalid eBay parameters; check the described fields and types');bind(schema,p,schema.$defs,config);
 for(const v of Object.values(p.path||{}))if(!v||v==='.'||v==='..'||/[\u0000-\u001f\u007f]/.test(v))fail('E_BAD_INPUT','Invalid eBay resource identifier');
 if(row.bulk){
  const requested=bulkRequests(row,p),keys=requested.map(v=>identity(row.bulk,v));
  if(!requested.length||requested.length>(row.risk==='R'?100:row.risk==='W'?25:10)||new Set(keys).size!==keys.length)fail('E_BAD_INPUT','Invalid or duplicate eBay bulk resources');
  if(requested.some(v=>row.bulk.expand_offers ? !(typeof (v.offerId||v.sku)==='string'&&(v.offerId||v.sku)) : row.bulk.keys.some(k=>!row.bulk.optional_keys?.includes(k)&&(typeof v[k]!=='string'||!v[k]))))fail('E_BAD_INPUT','Missing eBay bulk correlation identifiers');
 }
}
function failed(row,data){
 return row.error_paths.some(p=>at(data,p).some(v=>v&&typeof v==='object'&&Object.keys(v).length))
  ||row.status_paths.some(p=>at(data,p).some(v=>!Number.isInteger(v)||v<200||v>=300));
}
function reconcile(row,p,data){
 if(!row.bulk)return;
 const b=row.bulk,results=data?.[b.response],requested=bulkRequests(row,p);
 if(!Array.isArray(results)||results.length!==requested.length)fail('E_TOOL_CALL_UPSTREAM','eBay omitted bulk resource acknowledgements');
 const returned=results.map(v=>{const matches=requested.map((r,i)=>({r,i})).filter(({r})=>b.expand_offers?identity(b,r)===identity(b,v):b.keys.every(k=>r[k]===undefined&&b.optional_keys?.includes(k)||r[k]===v[k]));return matches.length===1?matches[0].i:-1;});
 if(new Set(returned).size!==returned.length||returned.includes(-1))fail('E_TOOL_CALL_UPSTREAM','eBay returned missing, duplicate or unrelated bulk acknowledgements');
 for(const item of results){
  if(!Number.isInteger(item.statusCode))fail('E_TOOL_CALL_UPSTREAM','eBay omitted a bulk item status');
  if(item.statusCode>=200&&item.statusCode<300&&!item.errors?.length&&b.success_field&&!item[b.success_field])fail('E_TOOL_CALL_UPSTREAM','eBay omitted a bulk item business acknowledgement');
 }
}
async function execute(config,name,p={},owners){
 const row=source().methods[name];if(!row)fail('E_BAD_INPUT','Unknown eBay merchant action');
 if(!allowed(row,config))fail('E_TOOL_CALL_AUTH','This eBay operation is unavailable with the connected grant');
 validate(name,row,p,config);
 let route=row.path;const query=new URLSearchParams();
 for(const wire of row.wire){const v=p[wire.location]?.[wire.name];if(v===undefined)continue;
  if(wire.location==='path')route=route.replace('{'+wire.name+'}',encodeURIComponent(v));
  else if(Array.isArray(v)&&wire.explode)for(const item of v)query.append(wire.name,String(item));else query.append(wire.name,Array.isArray(v)?v.join(','):String(v));}
 if(/[{}]/.test(route))fail('E_BAD_INPUT','Missing eBay resource identifier');
 const signal=AbortSignal.timeout(60000);let token;
 try{token=await owners.token(config);}catch(e){
  const code=requestFailureCode(e,signal);
  fail(code==='E_TOOL_CALL_NETWORK'&&['E_TOOL_CALL_AUTH','E_TOOL_CALL_RATE_LIMIT','E_BAD_INPUT','E_TOOL_CALL_UPSTREAM'].includes(e?.code)?e.code:code,'eBay authorization could not be refreshed');
 }
 if(!allowed(row,config))fail('E_TOOL_CALL_AUTH','The refreshed eBay grant does not permit this operation');
 const base=owners.base(config),url=base+route+(query.size?'?'+query.toString():'');
 const headers={accept:'application/json',authorization:'Bearer '+token,'Content-Language':config.metadata.content_language,'Accept-Language':config.metadata.content_language,'X-EBAY-C-MARKETPLACE-ID':config.metadata.marketplace_id};
 const init={method:row.method,headers,signal,redirect:'error'};if(p.body!==undefined){headers['content-type']='application/json';init.body=JSON.stringify(p.body);}
 let response,text;
 try{response=await requestFetch(url,init);}catch(e){fail(requestFailureCode(e,signal),'eBay request failed; inspect resource state before retrying an uncertain write');}
 if(!response.ok)throw httpFailure(response.status,`eBay request failed (HTTP ${response.status})`);
 try{text=await readBody(response);}catch(e){if(e?.code==='E_CONNECTOR_RESPONSE_TOO_LARGE')fail('E_TOOL_CALL_UPSTREAM','eBay response is too large');fail(requestFailureCode(e,signal),'eBay response could not be read');}
 const expected=row.responses[String(response.status)];if(!expected)fail('E_TOOL_CALL_UPSTREAM','eBay returned an unexpected acknowledgement status');
 let data=null;try{if(text)data=JSON.parse(text);}catch{fail('E_TOOL_CALL_UPSTREAM','eBay returned invalid JSON');}
 let location;
 if(expected.location){
  const raw=response.headers?.get('location');let parsed;try{parsed=new URL(raw);}catch{}
  const prefix=route.replace(/\/$/,'')+'/';
  if(!parsed||parsed.origin!==base||!parsed.pathname.startsWith(prefix)||parsed.pathname.length<=prefix.length||parsed.username||parsed.password||parsed.search||parsed.hash)fail('E_TOOL_CALL_UPSTREAM','eBay omitted a valid created-resource acknowledgement');
  location=parsed.href;
 }
 if(expected.schema){
  // Header-only creations are explicitly documented as empty object responses.
  if(data===null&&location&&expected.schema.type==='object'&&!expected.schema.properties)data={};
  const key=name+' '+response.status;if(!responseSchemas.has(key))responseSchemas.set(key,withDefs(expected.schema,'output',row.response_definitions));
  check(responseSchemas.get(key),data,'E_TOOL_CALL_UPSTREAM','eBay returned an invalid business acknowledgement');
  const shape=expected.schema.$ref?source().definitions.output[expected.schema.$ref.slice('#/$defs/'.length)]:expected.schema;
  const business=Object.keys(shape.properties||{}).filter(k=>!['errors','warnings'].includes(k));
  if(row.risk!=='R'&&!location&&!failed(row,data)&&business.length&&!business.some(k=>Object.hasOwn(data,k)))fail('E_TOOL_CALL_UPSTREAM','eBay omitted the submitted business acknowledgement');
 }else if(data!==null&&(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length))fail('E_TOOL_CALL_UPSTREAM','eBay returned an invalid empty acknowledgement');
 reconcile(row,p,data);const partial=failed(row,data)||response.status===207;
 const sanitized=output(data,[token,config.credentials.refresh_token,config.credentials.client_secret]);for(const parts of row.error_prose_paths)remove(sanitized,parts);
 return {data:sanitized,...(location?{location}:{}),...(partial?{status:'partial_or_failed'}:row.risk!=='R'?{status:'acknowledged'}:{})};
}
module.exports={actionsFor,isNative,execute};
