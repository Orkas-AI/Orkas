'use strict';

const {requestFetch,requestFailureCode,httpFailure}=require('./commerce-request-context.cjs');
const {readBody}=require('./storefront-admin-api.cjs');
let contracts,actions,validator;
const checks=new Map();
const source=()=>contracts ||= require('./amazon-api-contracts.cjs');
const failure=(code,message)=>{throw Object.assign(new Error(message),{code});};
function check(schema,value,code,message) {
  if (!validator) {const {AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv');validator=new AjvJsonSchemaValidator();}
  let validate=checks.get(schema);
  if(!validate){validate=validator.getValidator(schema);checks.set(schema,validate);}
  if(!validate(value).valid) failure(code,message);
}
function actionsFor() {
  return actions ||= Object.fromEntries(Object.entries(source().methods).map(([name,row])=>[name,{risk:row.risk,description:row.description,input_schema:row.input_schema}]));
}
const isNative=name=>Object.hasOwn(source().methods,name);
const MARKET_FIELDS=new Set(['marketplaceId','marketplaceIds','MarketplaceId','MarketplaceIds','marketplace_id','destinationMarketplaces','destinationMarketplaceId']);
const SELLER_FIELDS=new Set(['sellerId','SellerId','seller_id']);
function binding(value,metadata,schema,root=schema) {
  if(!value || typeof value!=='object' || !schema) return;
  if(schema.$ref) schema=root.$defs[schema.$ref.slice('#/$defs/'.length)];
  if(Array.isArray(value)) {for(const item of value)binding(item,metadata,schema.items,root);return;}
  for(const [key,child]of Object.entries(value)){
    const declared=Object.hasOwn(schema.properties || {},key);
    const childSchema=declared ? schema.properties[key] : typeof schema.additionalProperties==='object' ? schema.additionalProperties : null;
    if(!childSchema)continue;
    if(declared && MARKET_FIELDS.has(key)){
      const ids=Array.isArray(child)?child:[child];
      if(!ids.length || ids.some(id=>id!==metadata.marketplace_id)) failure('E_BAD_INPUT','Amazon marketplace does not match this connection');
    }
    if(declared && SELLER_FIELDS.has(key) && child!==metadata.seller_id) failure('E_BAD_INPUT','Amazon seller does not match this connection');
    binding(child,metadata,childSchema,root);
  }
}
function inventoryKeys(p) {
  return p.body.requests.map(item=>{
    if(!['GET','POST'].includes(item.method) || typeof item.uri!=='string' || !item.uri.startsWith('/inventory/')) failure('E_BAD_INPUT','Invalid Amazon inventory batch route');
    const url=new URL(item.uri,'https://sellingpartnerapi.amazon.com');
    if(!['/inventory/update','/inventory/fetch'].includes(url.pathname) || url.origin!=='https://sellingpartnerapi.amazon.com' || url.hash
        || [...url.searchParams.keys()].some(key=>!['locationId','skuId'].includes(key))
        || url.searchParams.getAll('locationId').length!==1 || url.searchParams.getAll('skuId').length!==1
        || !url.searchParams.get('locationId') || !url.searchParams.get('skuId')
        || (url.pathname==='/inventory/update' && (item.method!=='POST' || !Number.isSafeInteger(item.body?.quantity) || item.body.quantity<0))) failure('E_BAD_INPUT','Invalid Amazon inventory batch route or stock');
    return JSON.stringify([url.searchParams.get('locationId'),url.searchParams.get('skuId')]);
  });
}
function validateInput(config,contract,p) {
  let text;try{text=JSON.stringify(p);}catch{failure('E_BAD_INPUT','Invalid Amazon action parameters');}
  if(!text || Buffer.byteLength(text)>256*1024) failure('E_BAD_INPUT','Invalid or oversized Amazon action parameters');
  check(contract.input_schema,p,'E_BAD_INPUT','Invalid Amazon action parameters; check the described fields and types');
  binding(p,config.metadata,contract.input_schema);
  if(p.query?.granularityType==='Marketplace' && p.query.granularityId!==config.metadata.marketplace_id) failure('E_BAD_INPUT','Amazon inventory marketplace does not match this connection');
  for(const value of Object.values(p.path || {})) if(typeof value!=='string' || !value || value==='.' || value==='..' || /[\u0000-\u001f\u007f]/.test(value)) failure('E_BAD_INPUT','Invalid Amazon resource identifier');
  if(contract.operation==='batchInventory'){
    const keys=inventoryKeys(p);
    if(new Set(keys).size!==keys.length) failure('E_BAD_INPUT','Duplicate Amazon inventory resources in one batch');
  }
  if(['getItemOffersBatch','getListingOffersBatch','getFeaturedOfferExpectedPriceBatch','getCompetitiveSummary'].includes(contract.operation)) {
    let keys;try{keys=pricingKeys(contract.operation,p.body.requests);}catch{failure('E_BAD_INPUT','Invalid Amazon batch resource encoding');}
    if(new Set(keys).size!==keys.length)failure('E_BAD_INPUT','Duplicate Amazon pricing resources in one batch');
  }
  if(contract.operation==='getMyFeesEstimates') {
    const ids=p.body.map(item=>item.FeesEstimateRequest?.Identifier);
    if(ids.some(id=>!id) || new Set(ids).size!==ids.length)failure('E_BAD_INPUT','Missing or duplicate Amazon fee estimate identifiers');
  }
  if(contract.operation==='createSubscription' && p.path?.notificationType==='ORDER_STATUS_CHANGE') failure('E_BAD_INPUT','This Amazon notification type has been removed');
  if(contract.operation==='createSubscription' && p.path?.notificationType==='LISTINGS_ITEM_ISSUES_CHANGE' && p.body?.payloadVersion==='1.0') failure('E_BAD_INPUT','This Amazon notification payload version has been removed');
}
const PRIVATE_FIELDS=new Set(['accesstoken','refreshtoken','idtoken','clientsecret','authorization','password','cookie','signature']);
function output(value,credentials,token,contract,cursor=[],privatePaths=new Set(contract.error_prose_paths.map(field=>JSON.stringify(field)))) {
  if(typeof value==='string')return ['client_secret','refresh_token','access_token'].map(key=>credentials[key]).concat(token).filter(Boolean).reduce((text,secret)=>text.split(secret).join('[redacted]'),value);
  if(Array.isArray(value))return value.map(item=>output(item,credentials,token,contract,[...cursor,'*'],privatePaths));
  if(!value || typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!PRIVATE_FIELDS.has(key.replace(/[_-]/g,'').toLowerCase()) && !privatePaths.has(JSON.stringify([...cursor,key]))).map(([key,item])=>[key,output(item,credentials,token,contract,[...cursor,key],privatePaths)]));
}
function atPath(value,path) {
  if(!path.length)return [value];
  if(path[0]==='*')return Array.isArray(value)?value.flatMap(item=>atPath(item,path.slice(1))):[];
  return value && typeof value==='object' && Object.hasOwn(value,path[0])?atPath(value[path[0]],path.slice(1)):[];
}
// Only pinned response field paths own business failure. Dynamic attributes
// cannot masquerade as transport status or error fields.
function businessFailure(contract,value) {
  return contract.outcomes.some(field=>atPath(value,field.path).some(item=>field.kind==='nonempty'
    ? item && typeof item==='object' && Object.keys(item).length>0
    : field.kind==='http' ? !Number.isInteger(item) || item<200 || item>=300 : field.values.includes(item)));
}
function acknowledge(contract,data,status) {
  if(!Object.hasOwn(contract.responses,String(status))) failure('E_TOOL_CALL_UPSTREAM','Amazon returned an unexpected acknowledgement status');
  const expected=contract.responses[String(status)];
  if(expected===null){if(data!==null && (!data || typeof data!=='object' || Array.isArray(data) || Object.keys(data).length))failure('E_TOOL_CALL_UPSTREAM','Amazon returned an invalid empty acknowledgement');return;}
  if(data===null || typeof data!=='object')failure('E_TOOL_CALL_UPSTREAM','Amazon returned a missing business acknowledgement');
  if(businessFailure(contract,data))return;
  check(expected,data,'E_TOOL_CALL_UPSTREAM','Amazon returned an incomplete or invalid business acknowledgement');
  // Several public models make all payload fields optional. A success cannot
  // silently replace the entire business response with an empty object.
  if(!Array.isArray(data) && Object.keys(expected.properties || {}).filter(key=>key!=='errors').length
      && !Object.keys(expected.properties).some(key=>key!=='errors' && Object.hasOwn(data,key))) failure('E_TOOL_CALL_UPSTREAM','Amazon returned a missing business acknowledgement');
}
function pricingKeys(op,items,returned=false) {
  return items.map(item=>op==='getFeaturedOfferExpectedPriceBatch' ? JSON.stringify([item.marketplaceId,item.sku,item.segment || null])
    : op==='getCompetitiveSummary' ? JSON.stringify([item.marketplaceId,item.asin])
    : JSON.stringify([item.MarketplaceId,returned ? item.ASIN || item.SellerSKU : decodeURIComponent(item.uri.split('/')[5])]));
}
function reconcile(contract,p,data) {
  const op=contract.operation;
  if(op==='batchInventory'){
    const wanted=inventoryKeys(p),results=data?.responses;
    if(!Array.isArray(results) || results.length!==wanted.length) failure('E_TOOL_CALL_UPSTREAM','Amazon omitted inventory batch acknowledgements');
    const acknowledged=[];
    for(const item of results){
      if(!Number.isInteger(item.status?.statusCode))failure('E_TOOL_CALL_UPSTREAM','Amazon returned invalid inventory batch status');
      if(item.body?.locationId!==undefined && item.body?.skuId!==undefined)acknowledged.push(JSON.stringify([item.body.locationId,item.body.skuId]));
      else if(item.status.statusCode>=200 && item.status.statusCode<300)failure('E_TOOL_CALL_UPSTREAM','Amazon omitted successful inventory identifiers');
    }
    if(acknowledged.some(key=>!wanted.includes(key)) || new Set(acknowledged).size!==acknowledged.length)failure('E_TOOL_CALL_UPSTREAM','Amazon returned unrelated inventory acknowledgements');
  }
  if(['getItemOffersBatch','getListingOffersBatch','getFeaturedOfferExpectedPriceBatch','getCompetitiveSummary'].includes(op)){
    if(!Array.isArray(data?.responses) || data.responses.length!==p.body.requests.length) failure('E_TOOL_CALL_UPSTREAM','Amazon omitted pricing batch acknowledgements');
    const wanted=pricingKeys(op,p.body.requests),returned=pricingKeys(op,data.responses.map(item=>item.request || {}),true);
    if(returned.some(item=>!wanted.includes(item)) || new Set(returned).size!==returned.length || data.responses.some(item=>!Number.isInteger(item.status?.statusCode)))failure('E_TOOL_CALL_UPSTREAM','Amazon returned unrelated or invalid pricing acknowledgements');
  }
  if(op==='getMyFeesEstimates'){
    if(!Array.isArray(data) || data.length!==p.body.length)failure('E_TOOL_CALL_UPSTREAM','Amazon omitted fee-estimate acknowledgements');
    const wanted=p.body.map(item=>item.FeesEstimateRequest?.Identifier),returned=data.map(item=>item.FeesEstimateIdentifier?.SellerInputIdentifier);
    if(wanted.some(item=>!item) || returned.some(item=>!wanted.includes(item)) || new Set(returned).size!==returned.length)failure('E_TOOL_CALL_UPSTREAM','Amazon returned unrelated fee-estimate acknowledgements');
  }
  if(op==='getOrder' && contract.path.startsWith('/orders/') && data?.order && data.order.orderId!==p.path.orderId)failure('E_TOOL_CALL_UPSTREAM','Amazon order does not match the requested resource');
  if(['putListingsItem','patchListingsItem','deleteListingsItem'].includes(op) && data?.sku!==undefined && data.sku!==p.path.sku)failure('E_TOOL_CALL_UPSTREAM','Amazon listing does not match the requested resource');
}
async function execute(config,name,p={},owners) {
  const contract=source().methods[name];
  if(!contract)failure('E_BAD_INPUT','Unknown Amazon business action');
  validateInput(config,contract,p);
  const base=owners.base(config),query=new URLSearchParams();
  let token;
  try{token=await owners.token(config);}catch(error){if(typeof error?.code==='string')throw error;failure(requestFailureCode(error),'Amazon authorization could not complete');}
  let destination=contract.path;
  const headers={accept:'application/json','x-amz-access-token':token,'x-amz-date':new Date().toISOString().replace(/[:-]|\.\d{3}/g,''),'user-agent':'Orkas/1.8.0 (Language=JavaScript; Platform=Desktop)'};
  for(const wire of contract.wire){
    const value=p[wire.location]?.[wire.name];if(value===undefined)continue;
    if(wire.location==='path')destination=destination.replace('{'+wire.name+'}',encodeURIComponent(value));
    else if(wire.location==='headers')headers[wire.name]=value;
    else if(Array.isArray(value) && wire.collection==='multi')for(const item of value)query.append(wire.name,String(item));
    else query.append(wire.name,Array.isArray(value)?value.join(','):String(value));
  }
  if(/[{}]/.test(destination))failure('E_BAD_INPUT','Missing Amazon resource identifier');
  const deadline=AbortSignal.timeout(60000),init={method:contract.method,headers,redirect:'error',signal:deadline};
  if(p.body!==undefined){headers['content-type']='application/json';init.body=JSON.stringify(p.body);}
  let response,text;
  try{response=await requestFetch(base+destination+(query.size?'?'+query.toString():''),init);}catch(error){failure(requestFailureCode(error,deadline),'Amazon request failed; inspect resource state before retrying an uncertain write');}
  if(!response.ok)throw httpFailure(response.status,`Amazon request failed (HTTP ${response.status})`);
  try{text=await readBody(response);}catch(error){if(error?.code==='E_CONNECTOR_RESPONSE_TOO_LARGE')failure('E_TOOL_CALL_UPSTREAM','Amazon response is too large');failure(requestFailureCode(error,deadline),'Amazon response could not be read');}
  let data=null;try{if(text)data=JSON.parse(text);}catch{failure('E_TOOL_CALL_UPSTREAM','Amazon returned invalid JSON');}
  acknowledge(contract,data,response.status);
  reconcile(contract,p,data);
  const failed=businessFailure(contract,data);
  return {data:output(data,config.credentials,token,contract),...(failed ? {status:'partial_or_failed'} : contract.risk!=='R' ? {status:'acknowledged'} : {})};
}
module.exports={actionsFor,isNative,execute};
