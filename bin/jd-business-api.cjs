'use strict';
const crypto=require('node:crypto');
const {requestFetch,requestFailureCode,httpFailure}=require('./commerce-request-context.cjs');
const {readBody}=require('./storefront-admin-api.cjs');
let contracts,validator,catalog;const schemas=new Map(),checks=new Map();
const source=()=>contracts ||= require('./jd-api-contracts.cjs');
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const shape=s=>s?.$ref?source().definitions[s.$ref.slice(8)]:s;
function schema(row,output=false){const key=row.action+(output?' output':' input');if(!schemas.has(key))schemas.set(key,{...(output?row.response_schema:row.input_schema),$defs:Object.fromEntries((output?row.response_definitions:row.input_definitions).map(k=>[k,source().definitions[k]]))});return schemas.get(key);}
function actionsFor(config){if(config.provider!=='jd_jos')fail('E_BAD_INPUT','Invalid JD seller provider');return catalog ||= Object.fromEntries(Object.values(source().methods).map(row=>[row.action,{risk:row.risk,description:row.description,input_schema:schema(row)}]));}
const isNative=name=>Object.hasOwn(source().methods,name);
function check(s,v,code,message){if(!validator){const {AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv');validator=new AjvJsonSchemaValidator();}let f=checks.get(s);if(!f){f=validator.getValidator(s);checks.set(s,f);}if(!f(v).valid)fail(code,message);}
function bounded(value,code){let nodes=0;function walk(v,depth){if(++nodes>50000||depth>40)fail(code,'JD data exceeds supported complexity');if(Array.isArray(v)||object(v))for(const child of Object.values(v))walk(child,depth+1);}walk(value,0);}
function identity(config){const c=config.credentials;if(config.provider!=='jd_jos'||c?.provider!=='jd_jos'||! /^[0-9]{1,32}$/.test(String(c.identity?.vender_id||''))||! /^[0-9]{1,32}$/.test(String(c.identity?.shop_id||''))||typeof c.app_key!=='string'||!c.app_key||typeof c.app_secret!=='string'||!c.app_secret)fail('E_TOOL_CALL_AUTH','Reconnect the bound JD seller application');return [String(c.identity.vender_id),String(c.identity.shop_id)].join(':');}
const numberPattern=/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
function numeric(v){if(typeof v==='number'){if(!Number.isFinite(v)||Number.isInteger(v)&&!Number.isSafeInteger(v))fail('E_BAD_INPUT','Use an exact decimal string for a large JD number');return String(v);}if(typeof v!=='string'||v.length>128||!numberPattern.test(v)||!Number.isFinite(Number(v)))fail('E_BAD_INPUT','Invalid JD numeric literal');return v;}
function rowFor(method){return source().methods[method.startsWith('api.')?method:'api.'+method];}
function encode(v,s,row,path=[]){s=shape(s);const owned=[...row.owned,...row.fixed].find(x=>x.path.length===path.length&&x.path.every((k,i)=>k===path[i]));if(s?.['x-jd-number']||owned?.type==='Number')return numeric(v);
 if(s?.['x-jd-csv']){const parts=Array.isArray(v)?v:typeof v==='string'?v.split(','):null;if(!parts||parts.length>1000)fail('E_BAD_INPUT','Invalid JD CSV array');const item=shape(s.items);const csv=parts.map(x=>{if(item?.['x-jd-number'])return numeric(x);if(typeof x!=='string'||x.includes(',')||x.length>65536)fail('E_BAD_INPUT','JD CSV values must be strings without commas');return x;}).join(',');return JSON.stringify(csv);}
 if(Array.isArray(v))return '['+v.map(x=>encode(x,s?.items,row,[...path,'*'])).join(',')+']';
 if(object(v))return '{'+Object.entries(v).map(([k,x])=>JSON.stringify(k)+':'+encode(x,s?.properties?.[k]||s?.additionalProperties,row,[...path,k])).join(',')+'}';
 return JSON.stringify(v);
}
function serializeParameters(method,p){const row=rowFor(method);if(!row)fail('E_BAD_INPUT','Unsupported JD parameter contract');bounded(p,'E_BAD_INPUT');return encode(p,row.input_schema,row);}
class ExactNumber{constructor(raw){this.raw=raw;}}
function parse(text){if(typeof text!=='string'||Buffer.byteLength(text)>1048576)fail('E_TOOL_CALL_UPSTREAM','JD response exceeds supported size');let depth=0,nodes=0,quoted=false,escape=false;for(const c of text){if(quoted){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;else if(c==='['||c==='{'){if(++depth>40||++nodes>50000)fail('E_TOOL_CALL_UPSTREAM','JD response exceeds supported complexity');}else if(c===']'||c==='}')depth--;else if(c===','&&++nodes>50000)fail('E_TOOL_CALL_UPSTREAM','JD response exceeds supported complexity');}
 const data=JSON.parse(text,(_k,v,context)=>typeof v==='number'&&Math.abs(v)>Number.MAX_SAFE_INTEGER&&context?.source?new ExactNumber(context.source):v);bounded(data,'E_TOOL_CALL_UPSTREAM');function restore(v){if(v instanceof ExactNumber)return v.raw;if(Array.isArray(v))return v.map(restore);if(object(v))return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,restore(x)]));return v;}return restore(data);}
const secretKeys=new Set(['access_token','refresh_token','app_secret','authorization','password','accessToken','refreshToken']);
function clean(v,secrets){if(typeof v==='string')return secrets.reduce((t,s)=>s?t.split(s).join('[redacted]'):t,v);if(Array.isArray(v))return v.map(x=>clean(x,secrets));if(object(v))return Object.fromEntries(Object.entries(v).filter(([k])=>!secretKeys.has(k)).map(([k,x])=>[k,clean(x,secrets)]));return v;}
function sanitize(data,c={}){bounded(data,'E_TOOL_CALL_UPSTREAM');return clean(data,[c.access_token,c.refresh_token,c.app_secret]);}
function get(value,path){return path.reduce((v,k)=>v?.[k],value);}
function at(value,path,fn){if(!path.length)return fn(value);const[k,...tail]=path;if(k==='*'){if(Array.isArray(value))for(const v of value)at(v,tail,fn);}else if(object(value)&&Object.hasOwn(value,k))at(value[k],tail,fn);}
function set(value,path,v){let parent=value;for(const k of path.slice(0,-1)){if(!object(parent[k]))parent[k]={};parent=parent[k];}parent[path.at(-1)]=v;}
function remove(value,path){if(path.length===1){if(object(value))delete value[path[0]];return;}const[k,...tail]=path;if(k==='*'){if(Array.isArray(value))for(const v of value)remove(v,tail);}else if(object(value))remove(value[k],tail);}
const affirmative=v=>v===true||v==='true';const negative=v=>v===false||v==='false';
function meaningful(v,s,write){s=shape(s);if(s?.anyOf)s=shape(s.anyOf.find(x=>x.type!=='null')||s.anyOf[0]);if(v===null||v===undefined)return false;if(Array.isArray(v))return !write||v.length>0;if(object(v)){const known=Object.keys(s?.properties||{});return known.length?known.some(k=>Object.hasOwn(v,k)&&v[k]!==undefined):Object.keys(v).length>0;}return true;}
function ack(row,data){if(!object(data)||data.error_response)fail('E_TOOL_CALL_UPSTREAM','JD rejected the request; verify permission and resource state before retrying');const envelope=data[row.wrapper];if(!object(envelope))fail('E_TOOL_CALL_UPSTREAM','JD omitted the method response');
 check(schema(row,true),envelope,'E_TOOL_CALL_UPSTREAM','JD returned invalid business fields');
 if(!row.root_keys.some(k=>meaningful(envelope[k],shape(row.response_schema).properties?.[k],row.risk!=='R')))fail('E_TOOL_CALL_UPSTREAM','JD omitted the resource acknowledgement');
 let partial=false;for(const path of row.success){let count=0;at(envelope,path,v=>{count++;if(negative(v))partial=true;else if(!affirmative(v))fail('E_TOOL_CALL_UPSTREAM','JD omitted a success outcome');});if(!path.includes('*')&&!count)fail('E_TOOL_CALL_UPSTREAM','JD omitted the operation outcome');}
 for(const path of row.failure_paths)at(envelope,path,v=>{if((Array.isArray(v)||typeof v==='string')&&v.length)partial=true;});
 for(const c of row.code_checks){const v=get(envelope,c.path);if(!c.accepted.includes(String(v)))fail('E_TOOL_CALL_UPSTREAM','JD rejected the operation; reconcile before retrying');}
 if(row.risk==='R')for(const receipt of row.resource_checks){const value=get(envelope,receipt.path);if(object(value)&&!receipt.keys.some(k=>Object.hasOwn(value,k)&&value[k]!==undefined))fail('E_TOOL_CALL_UPSTREAM','JD omitted the requested business resource');}
 // List resources cannot be replaced by pagination metadata alone.
 if([13568,13315,13305].includes(row.id)&&!Array.isArray(envelope.page?.data))fail('E_TOOL_CALL_UPSTREAM','JD omitted the requested resource list');
 if(row.id===12603&&String(envelope.msg.return_code)==='2')partial=true;
 if(row.id===21574&&String(envelope.returnType?.snUploadResp?.status)!=='1')partial=true;
 if([13301,13320].includes(row.id)&&!get(envelope,[row.id===13301?'sku':'ware',row.id===13301?'skuId':'wareId']))fail('E_TOOL_CALL_UPSTREAM','JD omitted resource identity');
 return {envelope,partial};}
function chinaTimestamp(){return new Date(Date.now()+8*3600000).toISOString().slice(0,19).replace('T',' ');}
async function request(config,row,p,token){const form={method:row.name,app_key:config.credentials.app_key,timestamp:chinaTimestamp(),v:'2.0','360buy_param_json':serializeParameters(row.name,p),...(row.auth?{access_token:token}:{})};form.sign=crypto.createHash('md5').update(config.credentials.app_secret+Object.keys(form).sort().map(k=>k+form[k]).join('')+config.credentials.app_secret,'utf8').digest('hex').toUpperCase();const deadline=AbortSignal.timeout(60000);let response,text;
 try{response=await requestFetch('https://api.jd.com/routerjson',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded;charset=utf-8',accept:'application/json'},body:new URLSearchParams(form).toString(),redirect:'error',signal:deadline});}catch(error){fail(requestFailureCode(error,deadline),'JD request failed; reconcile an uncertain write before retrying');}
 if(!response.ok)throw httpFailure(response.status,'JD request failed (HTTP '+response.status+')');
 try{text=await readBody(response);}catch(error){fail(error?.code==='E_CONNECTOR_RESPONSE_TOO_LARGE'?'E_TOOL_CALL_UPSTREAM':requestFailureCode(error,deadline),'JD response could not be read');}
 let data;try{data=parse(text);}catch(error){if(error?.code)throw error;fail('E_TOOL_CALL_UPSTREAM','JD returned invalid JSON');}return {data,...ack(row,data)};
}
async function execute(config,name,p={},owners){const row=source().methods[name];if(!row)fail('E_BAD_INPUT','Unsupported JD seller action');const bound=identity(config);bounded(p,'E_BAD_INPUT');let bytes;try{bytes=JSON.stringify(p);}catch{fail('E_BAD_INPUT','Invalid JD parameters');}if(!bytes||Buffer.byteLength(bytes)>262144)fail('E_BAD_INPUT','JD parameters are too large');check(schema(row),p,'E_BAD_INPUT','Invalid JD parameters; check the described fields and bounds');serializeParameters(row.name,p);
 if(row.id===21234){const stocks=p.req.skuStocks,ids=stocks.map(v=>String(v.skuId)+':'+String(v.storeId||0));if(new Set(ids).size!==ids.length)fail('E_BAD_INPUT','Review distinct JD SKU and warehouse targets');for(const v of stocks){const n=p.req.updateModel==='fullStockIn'?v.stockNum:v.incrStockNum;if(n===undefined||!numberPattern.test(String(n))||!Number.isInteger(Number(n))||(p.req.updateModel==='fullStockIn'&&Number(n)<0))fail('E_BAD_INPUT','Review the stock quantity for the selected update mode');}}
 if(typeof owners?.token!=='function')fail('E_BAD_INPUT','JD credential owner is unavailable');let token;try{token=await owners.token(config);}catch(error){if(requestFailureCode(error)==='E_TOOL_CALL_CANCELLED')fail('E_TOOL_CALL_CANCELLED','JD request was cancelled');throw error;}if(identity(config)!==bound||typeof token!=='string'||!token)fail('E_TOOL_CALL_AUTH','JD seller grant changed; reconnect');
 const params=JSON.parse(JSON.stringify(p));for(const v of row.fixed)set(params,v.path,v.value);for(const v of row.owned)set(params,v.path,v.value==='access_token'?token:v.value==='app_key'?config.credentials.app_key:config.credentials.identity[v.value]);
 const {data,envelope,partial}=await request(config,row,params,token);
 if(row.id===21234){const results=envelope.returnType?.obj?.updateStockResult;if(Array.isArray(results)){const expected=new Set(p.req.skuStocks.map(v=>String(v.skuId)+':'+String(v.storeId||0))),seen=new Set();for(const v of results){const key=String(v.data)+':'+String(v.storeId||0);if(!expected.has(key)||seen.has(key))fail('E_TOOL_CALL_UPSTREAM','JD returned unrelated or duplicate stock outcomes');seen.add(key);}}}
 if(row.id===12865){const v=envelope.vender_info_result;if(String(v?.vender_id)!==String(config.credentials.identity.vender_id)||String(v?.shop_id)!==String(config.credentials.identity.shop_id))fail('E_TOOL_CALL_AUTH','JD returned a different seller or shop');}
 if([13301,13320].includes(row.id)){const k=row.id===13301?'skuId':'wareId',v=envelope[row.id===13301?'sku':'ware'];if(String(v[k])!==String(p[k]))fail('E_TOOL_CALL_UPSTREAM','JD returned another resource');}
 const output=sanitize(data,{...config.credentials,access_token:token});for(const path of row.diagnostics)remove(output[row.wrapper],path);
 return {data:output,...(partial?{status:'partial_or_failed'}:row.risk!=='R'?{status:row.async||row.receipt_mode?'accepted':'acknowledged'}:{}),...(row.risk!=='R'?{follow_up:row.receipt_mode?'The provider returned a stock acknowledgement with failure details only. Query stock for every requested SKU and warehouse to verify final quantities before any retry.':row.async?'The provider accepted an asynchronous request. Query the resource to obtain the final outcome; do not replay automatically.':'Inspect all returned resource outcomes before retrying; this request is never automatically replayed.'}:{})};
}
module.exports={actionsFor,isNative,execute,serializeParameters,parse,sanitize};
