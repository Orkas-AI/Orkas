'use strict';
const seller=require('./marketplace-seller-api.cjs'),storefront=require('./storefront-admin-api.cjs');
const {requestFetch,requestFailureCode,httpFailure}=require('./commerce-request-context.cjs');
let contracts,validator;const schemas=new Map(),checks=new Map(),actions=new Map();
const source=()=>contracts ||= require('./tiktok-shop-api-contracts.cjs');
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const shape=s=>s?.$ref?source().definitions[s.$ref.slice(8)]:s;
function schema(row,output=false){const key=row.action+(output?' output':' input');if(!schemas.has(key)){const s=shape(output?row.response_schema:row.input_schema),ids=output?row.response_definitions:row.input_definitions;schemas.set(key,{...s,$defs:Object.fromEntries(ids.map(id=>[id,source().definitions[id]]))});}return schemas.get(key);}
function country(config){return config.credentials?.identity?.shop_region||(config.metadata?.region==='us'?'US':null);}
function available(row,config){const c=country(config);return !c||(!row.markets||row.markets.includes(c))&&!row.excluded_markets?.includes(c);}
function permitted(row,config){const scopes=config.credentials?.scopes;return !Array.isArray(scopes)||!row.scopes_any.length||row.scopes_any.some(scope=>scopes.includes(scope));}
function actionsFor(config){if(config.provider!=='tiktok_shop'||!['us','row'].includes(config.metadata?.region))fail('E_BAD_INPUT','Invalid TikTok Shop region');const key=JSON.stringify([country(config),config.credentials?.scopes?.slice().sort()||null]);if(!actions.has(key)){if(actions.size>=16)actions.clear();actions.set(key,Object.fromEntries(Object.values(source().methods).filter(row=>available(row,config)&&permitted(row,config)).map(row=>[row.action,{risk:row.risk,description:row.description,input_schema:schema(row)}])));}return actions.get(key);}
function isNative(name){return Object.hasOwn(source().methods,name);}
function check(s,value,code,message){if(!validator){const {AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv');validator=new AjvJsonSchemaValidator();}let v=checks.get(s);if(!v){v=validator.getValidator(s);checks.set(s,v);}if(!v(value).valid)fail(code,message);}
function integer(value){if(typeof value==='number'){if(!Number.isSafeInteger(value))fail('E_BAD_INPUT','Use a decimal string for a large integer');return String(value);}const n=BigInt(value);if(n< -9223372036854775808n||n>9223372036854775807n)fail('E_BAD_INPUT','TikTok Shop integer exceeds its signed 64-bit range');return value;}
function encode(value,s){s=shape(s);if(s?.['x-tiktok-integer'])return integer(value);if(Array.isArray(value))return '['+value.map(v=>encode(v,s?.items)).join(',')+']';if(object(value))return '{'+Object.entries(value).map(([k,v])=>JSON.stringify(k)+':'+encode(v,s?.properties?.[k])).join(',')+'}';return JSON.stringify(value);}
function parse(text){return JSON.parse(text,(_k,value,context)=>typeof value==='number'&&!Number.isSafeInteger(value)&&Math.abs(value)>Number.MAX_SAFE_INTEGER&&context?.source?context.source:value);}
function values(data,parts){if(!parts.length)return[data];if(!data||typeof data!=='object')return[];return parts[0]==='*'?Object.values(data).flatMap(v=>values(v,parts.slice(1))):Object.hasOwn(data,parts[0])?values(data[parts[0]],parts.slice(1)):[];}
function nonempty(v){return Array.isArray(v)?v.length>0:object(v)?Object.keys(v).length>0:v!==undefined&&v!==null&&v!==''&&v!==0&&v!==false;}
const secretsKeys=new Set(['accesstoken','refreshtoken','appsecret','appkey','shopcipher','authorization','cookie','password']);
function clean(value,secrets){if(typeof value==='string')return secrets.reduce((v,s)=>s?v.split(s).join('[redacted]'):v,value);if(Array.isArray(value))return value.map(v=>clean(v,secrets));if(!object(value))return value;return Object.fromEntries(Object.entries(value).filter(([k])=>!secretsKeys.has(k.replace(/[_-]/g,'').toLowerCase())).map(([k,v])=>[k,clean(v,secrets)]));}
function scrubDiagnostic(data,parts){if(!object(data)&&!Array.isArray(data))return;if(parts[0]==='*'){Object.values(data).forEach(v=>scrubDiagnostic(v,parts.slice(1)));return;}if(parts.length>1){scrubDiagnostic(data[parts[0]],parts.slice(1));return;}const key=parts[0];if(!Object.hasOwn(data,key))return;function scrub(v){if(Array.isArray(v))return v.map(scrub);if(!object(v))return typeof v==='string'?'[provider diagnostic omitted]':v;return Object.fromEntries(Object.entries(v).filter(([k])=>!['message','msg','error_message','fail_reason','description','reason'].includes(k)).map(([k,x])=>[k,typeof x==='object'?scrub(x):x]));}data[key]=scrub(data[key]);}
function resource(value){let decoded=String(value);for(let i=0;i<3;i++){let next;try{next=decodeURIComponent(decoded);}catch{break;}if(next===decoded)break;decoded=next;}if(!decoded||decoded==='.'||decoded==='..'||/[\/\\\u0000-\u001f\u007f]/.test(decoded))fail('E_BAD_INPUT','Invalid TikTok Shop resource identifier');return encodeURIComponent(String(value));}
async function execute(config,name,p={}){
 const row=source().methods[name];if(!row||config.provider!=='tiktok_shop')fail('E_BAD_INPUT','Unsupported TikTok Shop merchant action');
 let bytes;try{bytes=JSON.stringify(p);}catch{fail('E_BAD_INPUT','Invalid TikTok Shop parameters');}if(!bytes||Buffer.byteLength(bytes)>262144)fail('E_BAD_INPUT','Invalid or oversized TikTok Shop parameters');
 check(schema(row),p,'E_BAD_INPUT','Invalid TikTok Shop parameters; check the described fields and bounds');seller.validateBinding(config);
 if(!available(row,config)||((row.markets||row.excluded_markets)&&!country(config)))fail('E_BAD_INPUT','This API is not available for the bound shop country');
 const input=shape(row.input_schema),body=p.body??(input.properties.body?{}:undefined);
 if(row.path==='/product/202309/products/{product_id}/inventory/update'){
  if(!body.skus.length||new Set(body.skus.map(s=>s.id)).size!==body.skus.length||body.skus.reduce((n,s)=>n+s.inventory.length,0)>10)fail('E_BAD_INPUT','Review one to ten distinct stock locations');
  for(const sku of body.skus){if(!sku.inventory.length||new Set(sku.inventory.map(v=>v.warehouse_id)).size!==sku.inventory.length)fail('E_BAD_INPUT','Inventory locations must be distinct');
   for(const v of sku.inventory){if(!Number.isSafeInteger(v.quantity)||v.quantity<0||v.quantity>99999)fail('E_BAD_INPUT','Inventory must be a bounded nonnegative whole quantity');if((v.backorder_quantity===undefined)!==(v.handling_time===undefined))fail('E_BAD_INPUT','Provide backorder quantity and handling time together');if(v.backorder_quantity!==undefined&&(!Number.isSafeInteger(v.backorder_quantity)||v.backorder_quantity<0||!Number.isSafeInteger(v.handling_time)||v.handling_time<0))fail('E_BAD_INPUT','Invalid backorder quantity or handling time');}
   if(new Set(sku.inventory.filter(v=>v.handling_time!==undefined).map(v=>v.handling_time)).size>1)fail('E_BAD_INPUT','A SKU must use the same backorder handling time across warehouses');
  }
 }
 if(row.path==='/product/202309/products/{product_id}/prices/update'){
  if(!body.skus.length||new Set(body.skus.map(s=>s.id)).size!==body.skus.length)fail('E_BAD_INPUT','Review distinct SKU prices');
  for(const sku of body.skus){const amounts=[sku.price.amount,sku.price.sale_price].filter(v=>v!==undefined);if(!amounts.length||amounts.some(v=>! /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(v)||Number(v)<=0)||! /^[A-Z]{3}$/.test(sku.price.currency))fail('E_BAD_INPUT','Provide positive decimal prices and a shop currency code');}
 }

 if(row.risk!=='R'&&body&&Object.keys(body).length===0&&Object.keys(shape(input.properties.body)?.properties||{}).length)fail('E_BAD_INPUT','Provide at least one business field for this write');
 const bodyText=body===undefined?undefined:encode(body,input.properties.body);let route=row.path,query={};
 for(const w of row.wire){const v=p[w.location]?.[w.name];if(v===undefined)continue;const s=shape(shape(input.properties[w.location])?.properties[w.name]);
  if(w.location==='path')route=route.replace('{'+w.name+'}',resource(s?.['x-tiktok-integer']?integer(v):v));
  else query[w.name]=Array.isArray(v)?w.array_format==='json'?encode(v,s):v.map(x=>shape(s.items)?.['x-tiktok-integer']?integer(x):String(x)).join(','):s?.['x-tiktok-integer']?integer(v):String(v);
 }
 if(/[{}]/.test(route))fail('E_BAD_INPUT','Missing TikTok Shop resource identifier');
 try{await seller.ensureToken(config);}catch(error){if(requestFailureCode(error)==='E_TOOL_CALL_CANCELLED')fail('E_TOOL_CALL_CANCELLED','TikTok Shop request was cancelled');throw error;}seller.validateBinding(config);const c=config.credentials;
 if(![0,4,5].includes(c.user_type))fail('E_TOOL_CALL_AUTH','Reauthorize with the merchant Seller identity');
 if(Array.isArray(c.scopes)&&row.scopes_any.length&&!row.scopes_any.some(s=>c.scopes.includes(s)))fail('E_TOOL_CALL_AUTH','Enable a described TikTok Shop scope and reauthorize this shop');
 if(!available(row,config))fail('E_TOOL_CALL_AUTH','The refreshed grant does not match the required shop country');
 query={...query,app_key:c.app_key,timestamp:Math.floor(Date.now()/1000),...(row.shop_cipher?{shop_cipher:c.identity.shop_cipher}:{})};
 if(row.owned_query.includes('shop_id'))query.shop_id=c.identity.shop_id;if(row.owned_query.includes('access_token'))query.access_token=c.access_token;
 query.sign=seller.signTikTok(route,query,bodyText,c.app_secret);
 const base=seller.apiBase(config.provider,config.metadata);if(base!=='https://open-api.tiktokglobalshop.com')fail('E_TOOL_CALL_AUTH','Invalid TikTok Shop authority');
 const deadline=AbortSignal.timeout(60000),init={method:row.method,headers:{accept:'application/json','content-type':row.content_type,'x-tts-access-token':c.access_token},redirect:'error',signal:deadline,...(bodyText===undefined?{}:{body:bodyText})};
 let response,text;try{response=await requestFetch(base+route+'?'+new URLSearchParams(query),init);}catch(error){fail(requestFailureCode(error,deadline),'TikTok Shop request failed; reconcile an uncertain write before retrying');}
 if(!response.ok)throw httpFailure(response.status,'TikTok Shop request failed (HTTP '+response.status+')');
 try{text=await storefront.readBody(response);}catch(error){fail(error?.code==='E_CONNECTOR_RESPONSE_TOO_LARGE'?'E_TOOL_CALL_UPSTREAM':requestFailureCode(error,deadline),'TikTok Shop response could not be read');}
 let data;try{data=parse(text);}catch{fail('E_TOOL_CALL_UPSTREAM','TikTok Shop returned invalid JSON');}
 if(!object(data)||!Number.isInteger(data.code))fail('E_TOOL_CALL_UPSTREAM','TikTok Shop omitted its business acknowledgement');
 const businessFailure=data.code!==0;
 if(businessFailure&&!row.error_paths.some(path=>values(data,path).some(nonempty)))fail('E_TOOL_CALL_UPSTREAM','TikTok Shop rejected the request (code '+data.code+'); reconcile state before retrying');
 check(schema(row,true),data,'E_TOOL_CALL_UPSTREAM','TikTok Shop returned an invalid business response');
 const output=shape(row.response_schema),expectedData=shape(output.properties?.data);
 if(expectedData&&!Object.hasOwn(data,'data'))fail('E_TOOL_CALL_UPSTREAM','TikTok Shop omitted business response data');
 if(expectedData?.properties&&Object.keys(expectedData.properties).length&&!row.allow_empty_data&&!Object.keys(expectedData.properties).some(k=>Object.hasOwn(data.data||{},k)))fail('E_TOOL_CALL_UPSTREAM','TikTok Shop omitted the resource acknowledgement');
 const failed=businessFailure||row.error_paths.some(path=>values(data,path).some(nonempty))||row.failure_paths.some(f=>values(data,f.path).some(v=>f.values.includes(v))),pending=row.pending_paths.some(f=>values(data,f.path).some(v=>f.values.includes(v)));
 const result=clean(data,[c.access_token,c.refresh_token,c.app_secret,c.identity.shop_cipher]);delete result.message;for(const path of [...row.error_paths,...row.diagnostic_paths])if(!['failed_conversation_ids','update_failed'].includes(path.at(-1)))scrubDiagnostic(result,path);
 return {data:result,...(failed?{status:'partial_or_failed'}:row.risk!=='R'||pending?{status:'accepted'}:{}),...(row.risk!=='R'||pending?{follow_up:'The platform acknowledged the request. Verify the returned resource or task status before retrying; asynchronous work is not confirmed complete.'}:{})};
}
module.exports={actionsFor,isNative,execute};
