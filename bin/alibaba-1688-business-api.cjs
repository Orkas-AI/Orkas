'use strict';
const crypto=require('node:crypto');
const {requestFetch,requestFailureCode,httpFailure}=require('./commerce-request-context.cjs');
const {readBody}=require('./storefront-admin-api.cjs');
let contracts,validator,catalog;const schemas=new Map(),checks=new Map();
const source=()=>contracts ||= require('./alibaba-1688-api-contracts.cjs');
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const shape=s=>s?.$ref?source().definitions[s.$ref.slice(8)]:s;
function schema(row,output=false){const key=row.action+(output?' output':' input');if(!schemas.has(key))schemas.set(key,{...(output?row.response_schema:row.input_schema),$defs:Object.fromEntries((output?row.response_definitions:row.input_definitions).map(k=>[k,source().definitions[k]]))});return schemas.get(key);}
function actionsFor(config){if(config.provider!=='alibaba_1688')fail('E_BAD_INPUT','Invalid 1688 provider');return catalog ||= Object.fromEntries(Object.values(source().methods).map(row=>[row.action,{risk:row.risk,description:row.description,input_schema:schema(row)}]));}
const isNative=name=>Object.hasOwn(source().methods,name);
function check(s,v,code,message){if(!validator){const {AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv');validator=new AjvJsonSchemaValidator();}let f=checks.get(s);if(!f){f=validator.getValidator(s);checks.set(s,f);}if(!f(v).valid)fail(code,message);}
function bounded(value,code){let nodes=0;function walk(v,depth){if(++nodes>50000||depth>40)fail(code,'1688 data exceeds supported complexity');if(Array.isArray(v)||object(v))for(const child of Object.values(v))walk(child,depth+1);}walk(value,0);}
function identity(config){const c=config.credentials;if(config.provider!=='alibaba_1688'||c?.provider!=='alibaba_1688'||! /^[A-Za-z0-9_-]{1,128}$/.test(c.identity?.member_id||'')||! /^[A-Za-z0-9_-]{1,128}$/.test(c.app_key||'')||typeof c.app_secret!=='string'||!c.app_secret)fail('E_TOOL_CALL_AUTH','Reconnect the bound 1688 seller application');return c.identity.member_id;}
function long(v){if(typeof v==='number'){if(!Number.isSafeInteger(v))fail('E_BAD_INPUT','Use an exact decimal string for a large 1688 integer');return String(v);}let n;try{n=BigInt(v);}catch{fail('E_BAD_INPUT','Invalid 1688 integer');}if(n< -9223372036854775808n||n>9223372036854775807n)fail('E_BAD_INPUT','1688 integer exceeds its signed 64-bit range');return v;}
function encode(v,s){s=shape(s);if(s?.['x-1688-long'])return long(v);if(Array.isArray(v))return '['+v.map(x=>encode(x,s?.items)).join(',')+']';if(object(v))return '{'+Object.entries(v).map(([k,x])=>JSON.stringify(k)+':'+encode(x,s?.properties?.[k])).join(',')+'}';return JSON.stringify(v);}
class Numeric{constructor(raw){this.raw=raw;}}
function parse(text,schema){if(typeof text!=='string'||Buffer.byteLength(text)>1048576)fail('E_TOOL_CALL_UPSTREAM','1688 response exceeds supported size');if(typeof schema==='string')schema=rowFor(schema)?.response_schema;const data=JSON.parse(text,(_k,v,context)=>typeof v==='number'&&Math.abs(v)>Number.MAX_SAFE_INTEGER&&context?.source?new Numeric(context.source):v);bounded(data,'E_TOOL_CALL_UPSTREAM');function restore(v,s){s=shape(s);if(v instanceof Numeric)return s?.type==='number'?Number(v.raw):v.raw;if(Array.isArray(v))return v.map(x=>restore(x,s?.items));if(object(v))return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,restore(x,s?.properties?.[k])]));return v;}return restore(data,schema);}
const secretKeys=new Set(['access_token','refresh_token','app_secret','authorization','password']);
function clean(v,secrets){if(typeof v==='string')return secrets.reduce((t,s)=>s?t.split(s).join('[redacted]'):t,v);if(Array.isArray(v))return v.map(x=>clean(x,secrets));if(object(v))return Object.fromEntries(Object.entries(v).filter(([k])=>!secretKeys.has(k)).map(([k,x])=>[k,clean(x,secrets)]));return v;}
function sanitize(data,credentials={}){bounded(data,'E_TOOL_CALL_UPSTREAM');return clean(data,[credentials.access_token,credentials.refresh_token,credentials.app_secret]);}
function packageKey(sourceId,sourceEntryId,value,code){if(!object(value)||typeof value.cpCode!=='string'||!value.cpCode||typeof value.mailNo!=='string'||!value.mailNo)fail(code,'1688 package identity is missing');return JSON.stringify([String(sourceId),String(sourceEntryId),value.cpCode,value.mailNo]);}
function shipmentTargets(p){const expected=[];if(!p.sendGoods.length)fail('E_BAD_INPUT','Review nonempty shipment targets');for(const good of p.sendGoods){if(!good.sendGoodEntries.length)fail('E_BAD_INPUT','Review nonempty shipment entries');for(const entry of good.sendGoodEntries){if(p.multiPackage===true){let packages;try{packages=JSON.parse(entry.extBody);}catch{fail('E_BAD_INPUT','Multi-package extBody must be a JSON package array');}if(!Array.isArray(packages)||!packages.length||packages.length>100)fail('E_BAD_INPUT','Review one to one hundred packages per entry');for(const v of packages)expected.push(packageKey(good.sourceId,entry.sourceEntryId,v,'E_BAD_INPUT'));}}}if(new Set(expected).size!==expected.length)fail('E_BAD_INPUT','Review distinct package targets');return expected;}
const failure=v=>v===false||v==='false';
function acknowledgement(row,data){
 if(!object(data))fail('E_TOOL_CALL_UPSTREAM','1688 returned an invalid response');
 const globalError=['error_code','errorCode','errCode'].some(k=>data[k]!==undefined&&data[k]!==null&&data[k]!==''&&data[k]!==0&&data[k]!=='0');
 const rejected=globalError||['success','succes','isSuccess'].some(k=>failure(data[k]));
 const batch=['alibaba.product.expire','alibaba.product.modifyStock','alibaba.photobank.photo.deleteBatch','alibaba.light.enroll.record.batch.insert'].includes(row.name);
 const shipment=['alibaba.logistics.OpDeliverySendOrder.offline','alibaba.logistics.OpDeliverySendOrder.dummy','alibaba.logistics.officialPickup'].includes(row.name);
 if(rejected&&!(batch&&Array.isArray(data.result)&&data.result.length)&&!(shipment&&(data.result?.sendSuccessList?.length||data.result?.sendFailList?.length)))fail('E_TOOL_CALL_UPSTREAM','1688 rejected the request; inspect resource state before retrying');
 check(schema(row,true),data,'E_TOOL_CALL_UPSTREAM','1688 returned invalid business fields');
 if(row.ack_keys.length&&!row.ack_keys.some(k=>data[k]!==undefined&&data[k]!==null&&(!object(data[k])||Object.keys(data[k]).some(child=>Object.hasOwn(shape(row.response_schema.properties[k])?.properties||{},child)))))fail('E_TOOL_CALL_UPSTREAM','1688 omitted the resource acknowledgement');
 if(!row.ack_keys.length&&!(data.success===true||data.success==='true'||data.isSuccess===true))fail('E_TOOL_CALL_UPSTREAM','1688 omitted the success acknowledgement');
 if(row.receipt_path){const value=row.receipt_path.reduce((v,k)=>v?.[k],data);if(!Array.isArray(value))fail('E_TOOL_CALL_UPSTREAM','1688 omitted the requested resource list');}
 if(row.name==='alibaba.product.get'&&(!object(data.productInfo)||data.productInfo.productID===undefined))fail('E_TOOL_CALL_UPSTREAM','1688 omitted product identity');
 if(batch){if(!Array.isArray(data.result)||!data.result.length)fail('E_TOOL_CALL_UPSTREAM','1688 omitted batch acknowledgements');const key=row.name==='alibaba.light.enroll.record.batch.insert'?'enrollResult':'result';if(data.result.some(v=>typeof v[key]!=='boolean'))fail('E_TOOL_CALL_UPSTREAM','1688 omitted per-resource outcomes');return rejected||data.result.some(v=>v[key]===false);}
 if(['alibaba.logistics.OpDeliverySendOrder.offline','alibaba.logistics.OpDeliverySendOrder.dummy','alibaba.logistics.officialPickup'].includes(row.name)){
  if(!data.result?.logisticsId&&!data.result?.sendSuccessList?.length&&!data.result?.sendFailList?.length)fail('E_TOOL_CALL_UPSTREAM','1688 omitted shipment acknowledgement');
  return rejected||Boolean(data.result?.sendFailList?.length);
 }
 return rejected;
}
function scrub(row,data){for(const k of row.diagnostic_keys)delete data[k];if(['alibaba.product.expire','alibaba.product.modifyStock','alibaba.photobank.photo.deleteBatch'].includes(row.name))for(const v of data.result||[])delete v.desc;if(row.name==='alibaba.logistics.OpDeliverySendOrder.offline')for(const v of [...data.result?.sendFailList||[],...data.result?.sendSuccessList||[]])delete v.errorMessage;}
async function request(config,row,p,token){
 const route=`param2/${row.version}/${row.namespace}/${row.name}/${config.credentials.app_key}`,form={...row.owned};
 for(const [k,v]of Object.entries(p))form[k]=typeof v==='string'?v:encode(v,row.input_schema.properties[k]);
 form.access_token=token;form._aop_timestamp=String(Date.now());
 form._aop_signature=crypto.createHmac('sha1',config.credentials.app_secret).update(route+Object.keys(form).sort().map(k=>k+form[k]).join(''),'utf8').digest('hex').toUpperCase();
 const deadline=AbortSignal.timeout(60000);let response,text;
 try{response=await requestFetch('https://gw.open.1688.com/openapi/'+route,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded;charset=utf-8',accept:'application/json'},body:new URLSearchParams(form).toString(),redirect:'error',signal:deadline});}catch(error){fail(requestFailureCode(error,deadline),'1688 request failed; reconcile an uncertain write before retrying');}
 if(!response.ok)throw httpFailure(response.status,'1688 request failed (HTTP '+response.status+')');
 try{text=await readBody(response);}catch(error){fail(error?.code==='E_CONNECTOR_RESPONSE_TOO_LARGE'?'E_TOOL_CALL_UPSTREAM':requestFailureCode(error,deadline),'1688 response could not be read');}
 let data;try{data=parse(text,row.response_schema);}catch(error){if(error?.code)throw error;fail('E_TOOL_CALL_UPSTREAM','1688 returned invalid JSON');}
 const partial=acknowledgement(row,data);return {data,partial};
}
function rowFor(method){return Object.values(source().methods).find(r=>r.name===method);}
async function execute(config,name,p={},owners){
 const row=source().methods[name];if(!row)fail('E_BAD_INPUT','Unsupported 1688 seller action');
 const member=identity(config);bounded(p,'E_BAD_INPUT');let bytes;try{bytes=JSON.stringify(p);}catch{fail('E_BAD_INPUT','Invalid 1688 parameters');}if(!bytes||Buffer.byteLength(bytes)>262144)fail('E_BAD_INPUT','1688 parameters are too large');
 check(schema(row),p,'E_BAD_INPUT','Invalid 1688 parameters; check the described fields and bounds');
 if(['alibaba.product.expire','alibaba.photobank.photo.deleteBatch','alibaba.light.enroll.record.batch.insert'].includes(row.name)){const ids=row.name==='alibaba.product.expire'?p.productIds:row.name==='alibaba.photobank.photo.deleteBatch'?p.imageIds:p.param.enrollOffers.map(v=>v.offerId);if(!ids.length||new Set(ids.map(String)).size!==ids.length)fail('E_BAD_INPUT','Review distinct nonempty resource targets');}
 // Validate all long values before obtaining or rotating a credential.
 encode(p,row.input_schema);
 if(row.name==='alibaba.product.modifyStock'){
  if(!p.productStockChange.length||p.productStockChange.length>20||new Set(p.productStockChange.map(v=>String(v.productId))).size!==p.productStockChange.length)fail('E_BAD_INPUT','Review one to twenty distinct 1688 products');
  for(const v of p.productStockChange){if(new Set(v.skuStocks.map(x=>x.skuId)).size!==v.skuStocks.length||p.increaceModify===false&&(v.productAmountChange<0||v.skuStocks.some(x=>x.stockChange<0)))fail('E_BAD_INPUT','Absolute stock must be nonnegative and SKU records distinct');}
 }
 const packages=row.name==='alibaba.logistics.OpDeliverySendOrder.offline'?shipmentTargets(p):null;
 if(typeof owners?.token!=='function')fail('E_BAD_INPUT','1688 credential owner is unavailable');
 let token;try{token=await owners.token(config);}catch(error){if(requestFailureCode(error)==='E_TOOL_CALL_CANCELLED')fail('E_TOOL_CALL_CANCELLED','1688 request was cancelled');throw error;}
 if(identity(config)!==member||typeof token!=='string'||!token)fail('E_TOOL_CALL_AUTH','1688 seller grant changed; reconnect');
 if(row.name==='alibaba.trade.cancel'){
  const verified=await request(config,rowFor('alibaba.trade.ec.getOrder.sellerView'),{orderId:p.tradeID},token),base=verified.data.result?.baseInfo;
  if(!base||String(base.idOfStr||base.id)!==String(p.tradeID)||String(base.sellerID)!==member)fail('E_TOOL_CALL_AUTH','1688 did not verify this order belongs to the bound seller');
 }
 const {data,partial}=await request(config,row,p,token);
 if(['alibaba.product.expire','alibaba.product.modifyStock','alibaba.photobank.photo.deleteBatch','alibaba.light.enroll.record.batch.insert'].includes(row.name)){
  const key=row.name==='alibaba.light.enroll.record.batch.insert'?'offerId':row.name==='alibaba.photobank.photo.deleteBatch'?'imageId':'productId';
  const expected=(row.name==='alibaba.light.enroll.record.batch.insert'?p.param.enrollOffers.map(v=>v.offerId):row.name==='alibaba.product.expire'?p.productIds:row.name==='alibaba.product.modifyStock'?p.productStockChange.map(v=>v.productId):p.imageIds).map(String);
  const received=data.result.map(v=>String(v[key]));
  if(expected.length!==received.length||new Set(received).size!==received.length||received.some(id=>!expected.includes(id)))fail('E_TOOL_CALL_UPSTREAM','1688 returned incomplete or unrelated batch outcomes');
 }
 if(row.name==='alibaba.logistics.OpDeliverySendOrder.offline'&&p.multiPackage===true){
  const expected=packages;
  const rows=[...data.result.sendSuccessList||[],...data.result.sendFailList||[]],received=rows.map(v=>{let pack;try{pack=JSON.parse(v.extBody);}catch{fail('E_TOOL_CALL_UPSTREAM','1688 omitted package identity');}return packageKey(v.sourceId,v.sourceEntryId,pack,'E_TOOL_CALL_UPSTREAM');});
  if((data.result.sendSuccessList||[]).some(v=>v.success!==true)||(data.result.sendFailList||[]).some(v=>v.success!==false))fail('E_TOOL_CALL_UPSTREAM','1688 returned inconsistent shipment outcomes');
  if(!expected.length||expected.length!==received.length||new Set(received).size!==received.length||received.some(id=>!expected.includes(id)))fail('E_TOOL_CALL_UPSTREAM','1688 returned incomplete or unrelated shipment outcomes');
 }
 if(row.name==='alibaba.account.basic'&&String(data.result?.memberId||'')!==member)fail('E_TOOL_CALL_AUTH','1688 returned a different seller identity');
 if(row.name==='alibaba.product.get'&&String(data.productInfo.productID)!==String(p.productID))fail('E_TOOL_CALL_UPSTREAM','1688 returned another product');
 if(['alibaba.trade.ec.getOrder.sellerView','alibaba.trade.ec.getOrderList.sellerView','alibaba.trade.getSellerOrderList'].includes(row.name)){
  const records=Array.isArray(data.result)?data.result:[data.result];for(const v of records){if(!object(v?.baseInfo)||!(v.baseInfo.idOfStr||v.baseInfo.id))fail('E_TOOL_CALL_UPSTREAM','1688 omitted order identity');if(String(v.baseInfo.sellerID||'')!==member)fail('E_TOOL_CALL_AUTH','1688 returned another seller order');}
  if(row.name==='alibaba.trade.ec.getOrder.sellerView'&&String(data.result.baseInfo.idOfStr||data.result.baseInfo.id)!==String(p.orderId))fail('E_TOOL_CALL_UPSTREAM','1688 returned another order');
 }
 if(row.name==='alibaba.trade.refund.queryOrderRefundList'&&data.result.opOrderRefundModels.some(v=>v.sellerMemberId!==undefined&&String(v.sellerMemberId)!==member))fail('E_TOOL_CALL_AUTH','1688 returned another seller refund');
 const out=clean(data,[token,config.credentials.refresh_token,config.credentials.app_secret]);scrub(row,out);
 return {data:out,...(partial?{status:'partial_or_failed'}:row.risk!=='R'?{status:'acknowledged'}:{}),...(row.risk!=='R'?{follow_up:'Verify the returned resource outcomes before retrying; the request is never automatically replayed.'}:{})};
}
module.exports={actionsFor,isNative,execute,sanitize,parse};
