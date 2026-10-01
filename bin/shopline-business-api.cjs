'use strict';
const storefront=require('./storefront-admin-api.cjs');
const {requestFetch,requestFailureCode,httpFailure}=require('./commerce-request-context.cjs');
let contracts,actions,validator;
const schemas=new Map(),checks=new Map();
const source=()=>contracts ||= require('./shopline-api-contracts.cjs');
const object=v=>v!==null && typeof v==='object' && !Array.isArray(v);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
function attached(s,ids){return {...s,$defs:Object.fromEntries(ids.map(id=>[id,source().definitions[id]]))};}
function inputFor(name,row){if(!schemas.has(name))schemas.set(name,attached(row.input_schema,row.input_definitions));return schemas.get(name);}
function actionsFor(){return actions ||= Object.fromEntries(Object.entries(source().methods).map(([name,row])=>[name,{risk:row.risk,description:row.description,input_schema:inputFor(name,row)}]));}
const isNative=name=>Object.hasOwn(source().methods,name);
function check(schema,value,code,message){
 if(!validator){const {AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv');validator=new AjvJsonSchemaValidator();}
 let validate=checks.get(schema);if(!validate){validate=validator.getValidator(schema);checks.set(schema,validate);}
 if(!validate(value).valid)fail(code,message);
}
const secrets=new Set(['accesstoken','refreshtoken','authorization','password','passwordconfirmation','passwordhash','clientsecret','apikey','secretkey','privatekey','cookie','cardnumber','cvv','cvc']);
function clean(value,token){
 if(typeof value==='string')return value.split(token).join('[redacted]');
 if(Array.isArray(value))return value.map(v=>clean(v,token));
 if(!object(value))return value;
 return Object.fromEntries(Object.entries(value).filter(([key])=>!secrets.has(key.replace(/[_-]/g,'').toLowerCase())).map(([k,v])=>[k,clean(v,token)]));
}
const failures=['user_errors','errors','fail_metafields','check_errors','failed_records'];
const nonempty=value=>Array.isArray(value)?value.length>0:object(value)?Object.keys(value).length>0:!!value;
function outcome(row,data,response,p){
 if(!object(data))fail('E_TOOL_CALL_UPSTREAM','SHOPLINE returned an invalid resource acknowledgement');
 if(response.keys.length && !response.keys.some(k=>Object.hasOwn(data,k) && data[k]!==null))fail('E_TOOL_CALL_UPSTREAM','SHOPLINE omitted the requested resource acknowledgement');
 if(!response.keys.length && Object.keys(data).length)fail('E_TOOL_CALL_UPSTREAM','SHOPLINE returned an unexpected acknowledgement body');
 const failed=failures.some(k=>nonempty(data[k])) || (['5rc2u3kx4pctpghd','5j2hfyn8v4eqnh2p'].includes(row.source_id) && ['CREATE_PART_FAIL','CREATE_ALL_FAIL','UPDATE_PART_FAIL','UPDATE_ALL_FAIL'].includes(data.task_status)) || (['VObwvwC8','pemID5y8'].includes(row.source_id) && ['FAILED','EXPIRED'].includes(data.status));
 if(row.source_id==='zHCaVw80'){
  const count=(data.metafields?.length||0)+(data.fail_metafields?.length||0);
  if(count!==(p.body.metafields?.length||0))fail('E_TOOL_CALL_UPSTREAM','SHOPLINE omitted batch acknowledgements; inspect metafields before retrying');
 }
 return failed;
}
// Node >=22.12 and packaged Electron expose each original numeric token.
// Restore documented doubles as numbers and integer identifiers as exact text.
class IntegerToken{constructor(text){this.text=text;}}
function parseLossless(text,schema){
 const parsed=JSON.parse(text,(_key,value,context)=>typeof value==='number'&&!Number.isSafeInteger(value)&&/^-?(?:0|[1-9][0-9]*)$/.test(context.source)?new IntegerToken(context.source):value);
 function restore(value,declared){
  while(declared?.$ref)declared=source().definitions[declared.$ref.slice('#/$defs/'.length)];
  if(value instanceof IntegerToken)return (Array.isArray(declared?.type)?declared.type:[declared?.type]).includes('number')?Number(value.text):value.text;
  if(Array.isArray(value))return value.map(item=>restore(item,declared?.items));
  if(!object(value))return value;
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,restore(item,declared?.properties?.[key]||(object(declared?.additionalProperties)?declared.additionalProperties:undefined))]));
 }
 return restore(parsed,schema);
}
function safeDiagnostics(data){
 for(const key of failures)if(nonempty(data[key])){
  const raw=data[key];data[key+'_count']=Array.isArray(raw)?raw.length:1;
  if(['fail_metafields','failed_records'].includes(key)&&Array.isArray(raw))data[key]=raw.map(item=>Object.fromEntries(Object.entries(item).filter(([field])=>['key','namespace','owner_id','owner_resource','variant_id','error_code'].includes(field))));
  else delete data[key];
 }
 // Only the two documented bulk-task envelopes use reason as provider diagnostics.
}
async function execute(config,name,p={}){
 if(config.provider!=='shopline')fail('E_BAD_INPUT','Unsupported SHOPLINE provider');storefront.validateBinding(config);
 const row=source().methods[name];if(!row)fail('E_BAD_INPUT','Unknown SHOPLINE merchant action');
 let encoded;try{encoded=JSON.stringify(p);}catch{fail('E_BAD_INPUT','Invalid SHOPLINE parameters');}
 if(!encoded||Buffer.byteLength(encoded)>256*1024)fail('E_BAD_INPUT','Invalid or oversized SHOPLINE parameters');
 check(inputFor(name,row),p,'E_BAD_INPUT','Invalid SHOPLINE parameters; check the described fields and types');
 let path=row.path;for(const [key,value]of Object.entries(p.path||{}))path=path.replace('{'+key+'}',encodeURIComponent(value));
 if(/[{}]/.test(path))fail('E_BAD_INPUT','Missing SHOPLINE resource identifier');
 const url=new URL(storefront.apiBase(config.provider,config.metadata)+path);
 const query={...p.query};for(const [name,bound]of Object.entries(row.pagination))if(query[name]===undefined)query[name]=bound.type==='string'?String(bound.default):bound.default;
 for(const [key,value]of Object.entries(query)){
  if(Array.isArray(value)&&row.querySerialization[key].explode)value.forEach(item=>url.searchParams.append(key,String(item)));
  else url.searchParams.set(key,Array.isArray(value)?value.join(','):String(value));
 }
 const token=config.credentials.access_token,deadline=AbortSignal.timeout(60000),init={method:row.method,headers:{accept:'application/json','content-type':'application/json; charset=utf-8',Authorization:'Bearer '+token},redirect:'error',signal:deadline};
 if(p.body!==undefined)init.body=JSON.stringify(p.body);
 let response,text;try{response=await requestFetch(url.toString(),init);}catch(error){fail(requestFailureCode(error,deadline),'SHOPLINE request failed; inspect state before retrying an uncertain write');}
 if(!response.ok)throw httpFailure(response.status,'SHOPLINE request failed (HTTP '+response.status+')');
 const expected=row.responses[response.status];if(!expected)fail('E_TOOL_CALL_UPSTREAM','SHOPLINE returned an undocumented acknowledgement status');
 try{text=await storefront.readBody(response);}catch(error){if(error?.code==='E_CONNECTOR_RESPONSE_TOO_LARGE')fail('E_TOOL_CALL_UPSTREAM','SHOPLINE response is too large');fail(requestFailureCode(error,deadline),'SHOPLINE response could not be read');}
 let data;if(!text && !expected.schema)data={};else try{data=parseLossless(text,expected.schema);}catch{fail('E_TOOL_CALL_UPSTREAM','SHOPLINE returned invalid JSON');}
 if(expected.schema){const key=name+'__response__'+response.status;if(!schemas.has(key))schemas.set(key,attached(expected.schema,expected.definitions));check(schemas.get(key),data,'E_TOOL_CALL_UPSTREAM','SHOPLINE returned an invalid resource shape');}
 const failed=outcome(row,data,expected,p),result=clean(data,token);safeDiagnostics(result);
 if(['VObwvwC8','pemID5y8'].includes(row.source_id))delete result.reason;
 const next=[];for(const match of (response.headers.get('link')||'').matchAll(/<([^>]+)>\s*;\s*rel="?next"?/g))try{const link=new URL(match[1]);if(link.origin===url.origin&&link.pathname===url.pathname){const cursor=link.searchParams.get('page_info');if(cursor&&cursor.length<=2048)next.push(cursor);}}catch{}
 return {data:result,...(failed?{status:'partial_or_failed'}:row.risk!=='R'?{status:'acknowledged'}:{}),...(next.length?{next_cursor:next[0]}:{})};
}
module.exports={actionsFor,isNative,execute};
