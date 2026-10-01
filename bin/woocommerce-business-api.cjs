'use strict';

const {requestFetch,requestFailureCode,httpFailure}=require('./commerce-request-context.cjs');
const {readBody}=require('./storefront-admin-api.cjs');
let contracts,actions,validator;
const checks=new Map(),source=()=>contracts ||= require('./woocommerce-api-contracts.cjs');
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function actionsFor(){return actions ||= Object.fromEntries(Object.entries(source().methods).map(([name,row])=>[name,{risk:row.risk,description:row.description,input_schema:row.input_schema}]));}
const isNative=name=>Object.hasOwn(source().methods,name);
function validate(row,p){
  let text;try{text=JSON.stringify(p);}catch{fail('E_BAD_INPUT','Invalid WooCommerce action parameters');}
  if(!text||Buffer.byteLength(text)>256*1024)fail('E_BAD_INPUT','Invalid or oversized WooCommerce action parameters');
  if(!validator){const {AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv');validator=new AjvJsonSchemaValidator();}
  let check=checks.get(row);if(!check){check=validator.getValidator(row.input_schema);checks.set(row,check);}
  if(!check(p).valid)fail('E_BAD_INPUT','Invalid WooCommerce action parameters; check the described fields and types');
  const limit=row.risk==='R'?100:row.risk==='W'?25:10;
  function bounded(value){if(Array.isArray(value)){if(value.length>limit)fail('E_BAD_INPUT','WooCommerce input exceeds the existing host batch limit');for(const item of value)bounded(item);}else if(isObject(value))for(const item of Object.values(value))bounded(item);}
  bounded(p);
  for(const value of Object.values(p.path||{}))if(typeof value==='string'&&(value==='.'||value==='..'||/[\/\\\u0000-\u001f\u007f]/.test(value)))fail('E_BAD_INPUT','Invalid WooCommerce resource identifier');
  if(row.response_kind==='batch'){
    const total=Object.values(p.body).reduce((count,items)=>count+items.length,0);if(!total||total>limit)fail('E_BAD_INPUT','WooCommerce batch must contain 1 to 10 total operations');
    for(const key of ['update','delete']){const ids=(p.body[key]||[]).map(value=>key==='delete'?value:value.id);if(new Set(ids).size!==ids.length)fail('E_BAD_INPUT','Duplicate WooCommerce batch resource identifiers');}
  }
}
const PRIVATE_FIELDS=new Set(['consumerkey','consumersecret','accesstoken','refreshtoken','authorization','password','cookie']);
function output(value,secrets){
  if(typeof value==='string'){for(const secret of secrets)if(secret)value=value.split(secret).join('[redacted]');return value;}
  if(Array.isArray(value))return value.map(item=>output(item,secrets));
  if(!isObject(value))return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!PRIVATE_FIELDS.has(key.replace(/[_-]/g,'').toLowerCase())).map(([key,item])=>[key,output(item,secrets)]));
}
// PHP/WordPress parses bracketed arrays and maps. Repeated plain keys would
// silently lose earlier filters; no caller can override the host or headers.
function addQuery(query,key,value){
  if(Array.isArray(value)){for(let i=0;i<value.length;i++)addQuery(query,key+'['+i+']',value[i]);}
  else if(isObject(value)){for(const [child,item]of Object.entries(value))addQuery(query,key+'['+child+']',item);}
  else query.append(key,value===null?'':String(value));
}
const wpError=value=>isObject(value)&&typeof value.code==='string'&&typeof value.message==='string'&&Number(value.data?.status)>=400;
function acknowledge(row,p,data){
  if(wpError(data))fail('E_TOOL_CALL_UPSTREAM','WooCommerce returned a business error');
  if(row.response_kind==='array'){
    if(!Array.isArray(data))fail('E_TOOL_CALL_UPSTREAM','WooCommerce omitted the resource collection');
    if(row.method==='PUT'&&row.path.endsWith('/locations')){
      if(data.length!==p.body.length||p.body.some(item=>!data.some(result=>result.code===item.code&&result.type===(item.type||'country'))))fail('E_TOOL_CALL_UPSTREAM','WooCommerce returned incomplete shipping locations');
    }return false;
  }
  if(row.response_kind==='string'){if(typeof data!=='string')fail('E_TOOL_CALL_UPSTREAM','WooCommerce returned an invalid resource value');return false;}
  if(!isObject(data))fail('E_TOOL_CALL_UPSTREAM','WooCommerce omitted the business acknowledgement');
  if(row.response_kind==='related'&&(!Array.isArray(data.related_ids)||data.related_ids.some(id=>!Number.isSafeInteger(id)||id<=0)))fail('E_TOOL_CALL_UPSTREAM','WooCommerce omitted related product identifiers');
  if(row.response_kind==='preview'&&(!isObject(data.breakdown)||['subtotal','tax','total','max_refundable'].some(key=>typeof data[key]!=='string')))fail('E_TOOL_CALL_UPSTREAM','WooCommerce omitted the refund preview');
  if(row.response_kind==='batch'){
    let partial=false;
    for(const group of ['create','update','delete']){
      const requested=p.body[group]||[],results=data[group]||[];
      if(!Array.isArray(results)||results.length!==requested.length)fail('E_TOOL_CALL_UPSTREAM','WooCommerce omitted batch acknowledgements');
      for(let i=0;i<results.length;i++){
        const item=results[i],expected=group==='create'?null:group==='delete'?requested[i]:requested[i].id;
        if(!isObject(item))fail('E_TOOL_CALL_UPSTREAM','WooCommerce returned an invalid batch acknowledgement');
        if(isObject(item.error)&&typeof item.error.code==='string'){
          partial=true;item.error={code:item.error.code,...(Number.isInteger(item.error.data?.status)?{data:{status:item.error.data.status}}:{})};
          if(expected!==null&&item.id!==undefined&&item.id!==expected)fail('E_TOOL_CALL_UPSTREAM','WooCommerce returned an unrelated batch failure');
        }else if(!Number.isSafeInteger(item.id)||item.id<=0||(expected!==null&&item.id!==expected))fail('E_TOOL_CALL_UPSTREAM','WooCommerce returned an unrelated batch resource');
      }
    }return partial;
  }
  if(row.ack_key){
    const value=data[row.ack_key];if(row.ack_key==='message'||row.ack_key==='slug'||row.resource==='shipping_methods'){if(typeof value!=='string'||!value.length)fail('E_TOOL_CALL_UPSTREAM','WooCommerce omitted the resource acknowledgement');}
    else if(!Number.isSafeInteger(value)||value<0)fail('E_TOOL_CALL_UPSTREAM','WooCommerce omitted the resource identifier');
    const expected=p.path?.[row.ack_key];if(expected!==undefined&&row.method!=='POST'&&value!==expected)fail('E_TOOL_CALL_UPSTREAM','WooCommerce returned an unrelated resource');
  }else if(!Object.keys(data).length)fail('E_TOOL_CALL_UPSTREAM','WooCommerce returned an empty resource acknowledgement');
  return false;
}
async function execute(config,name,p={},owners){
  const row=source().methods[name];if(!row)fail('E_BAD_INPUT','Unknown WooCommerce merchant action');validate(row,p);
  const base=owners.base(config);let route=row.path;
  for(const [key,value]of Object.entries(p.path||{}))route=route.replace('{'+key+'}',encodeURIComponent(String(value)));
  if(/[{}]/.test(route))fail('E_BAD_INPUT','Missing WooCommerce resource identifier');
  const query=new URLSearchParams();for(const [key,value]of Object.entries(p.query||{}))addQuery(query,key,value);
  const authorization=Buffer.from(config.credentials.consumer_key+':'+config.credentials.consumer_secret).toString('base64');
  const deadline=AbortSignal.timeout(60000),headers={accept:'application/json',authorization:'Basic '+authorization},init={method:row.method,headers,signal:deadline,redirect:'error'};
  if(p.body!==undefined){headers['content-type']='application/json';init.body=JSON.stringify(p.body);}
  let response,text;
  try{response=await requestFetch(base+route+(query.size?'?'+query.toString():''),init);}catch(error){fail(requestFailureCode(error,deadline),'WooCommerce request failed; inspect resource state before retrying an uncertain write');}
  if(!response.ok)throw httpFailure(response.status,`WooCommerce request failed (HTTP ${response.status})`);
  try{text=await readBody(response);}catch(error){if(error?.code==='E_CONNECTOR_RESPONSE_TOO_LARGE')fail('E_TOOL_CALL_UPSTREAM','WooCommerce response is too large');fail(requestFailureCode(error,deadline),'WooCommerce response could not be read');}
  let data;try{data=JSON.parse(text);}catch{fail('E_TOOL_CALL_UPSTREAM','WooCommerce returned invalid JSON');}
  const partial=acknowledge(row,p,data),pagination={};
  for(const [header,key]of [['x-wp-total','total'],['x-wp-totalpages','total_pages']]){const value=response.headers.get(header);if(value!==null){if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))fail('E_TOOL_CALL_UPSTREAM','WooCommerce returned invalid pagination');pagination[key]=Number(value);}}
  return {data:output(data,[config.credentials.consumer_key,config.credentials.consumer_secret,authorization]),...(Object.keys(pagination).length?{pagination}:{}),...(partial?{status:'partial_or_failed'}:row.risk!=='R'?{status:'acknowledged'}:{})};
}
module.exports={actionsFor,isNative,execute};
