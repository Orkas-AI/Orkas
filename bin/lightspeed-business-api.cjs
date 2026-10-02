'use strict';
const {requestFetch,requestFailureCode,httpFailure}=require('./commerce-request-context.cjs');
const {readBody}=require('./storefront-admin-api.cjs');
let contracts,actions,validator;
const checks=new Map(),resolved=new WeakMap(),source=()=>contracts ||= require('./lightspeed-api-contracts.cjs');
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const isNative=name=>Object.hasOwn(source().methods,name);
function actionsFor(){return actions ||= Object.fromEntries(Object.entries(source().methods).map(([name,row])=>[name,{risk:row.risk,description:row.description,input_schema:row.input_schema}]));}
function inputSchema(schema,defs,value){if(schema?.$ref)schema=defs[schema.$ref.slice('#/$defs/'.length)];if(schema?.anyOf&&!schema['x-integer-format']&&value!==null)schema=inputSchema(schema.anyOf.find(x=>x.type!=='null'),defs,value);return schema;}
function validate(row,p){
  let text;try{text=JSON.stringify(p);}catch{fail('E_BAD_INPUT','Invalid Lightspeed parameters');}
  if(!text||Buffer.byteLength(text)>256*1024)fail('E_BAD_INPUT','Invalid or oversized Lightspeed parameters');
  if(!validator){const {AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv');validator=new AjvJsonSchemaValidator();}
  let check=checks.get(row);if(!check){check=validator.getValidator(row.input_schema);checks.set(row,check);}
  if(!check(p).valid)fail('E_BAD_INPUT','Invalid Lightspeed parameters; check the described fields and types');
  const cap={R:100,W:25,H:10,D:10}[row.risk];
  function walk(value,schema,depth=0){
    if(depth>64)fail('E_BAD_INPUT','Lightspeed parameters are too deeply nested');schema=inputSchema(schema,row.input_schema.$defs,value);
    if(schema?.['x-integer-format']&&value!==null){const n=BigInt(value);if(n< -9223372036854775808n||n>9223372036854775807n||schema['x-integer-minimum']!==undefined&&n<BigInt(schema['x-integer-minimum'])||schema['x-integer-maximum']!==undefined&&n>BigInt(schema['x-integer-maximum']))fail('E_BAD_INPUT','Lightspeed integer is outside the published range');}
    if(Array.isArray(value)){if(value.length>cap)fail('E_BAD_INPUT','Lightspeed input exceeds the existing host batch limit');for(const item of value)walk(item,schema?.items,depth+1);}
    else if(object(value))for(const [key,item]of Object.entries(value))walk(item,schema?.properties?.[key]||schema?.additionalProperties,depth+1);
  }walk(p,row.input_schema);
  for(const value of Object.values(p.path||{}))if(typeof value==='string'&&(!value||value==='.'||value==='..'||/[\u0000-\u001f\u007f]/.test(value)))fail('E_BAD_INPUT','Invalid Lightspeed resource identifier');
  if(row.path==='/loyalty/adjustments/bulk'&&p.body.adjustments.some(x=>Object.hasOwn(x,'credit')===Object.hasOwn(x,'debit')))fail('E_BAD_INPUT','Provide exactly one credit or debit for each loyalty adjustment');
  if(row.path==='/consignments/{consignment_id}/bulk'&&p.body.some(x=>x.count==null&&x.received==null))fail('E_BAD_INPUT','Each consignment product requires count or received');
}
function wireJSON(value,schema,defs){
  schema=inputSchema(schema,defs,value);if(schema?.['x-integer-format']&&value!==null)return String(value);
  if(Array.isArray(value))return '['+value.map(x=>wireJSON(x,schema?.items,defs)).join(',')+']';
  if(object(value))return '{'+Object.entries(value).map(([k,x])=>JSON.stringify(k)+':'+wireJSON(x,schema?.properties?.[k]||schema?.additionalProperties,defs)).join(',')+'}';
  return JSON.stringify(value);
}
function outputSchema(raw){
  if(!raw||typeof raw!=='object')return raw;
  if(resolved.has(raw))return resolved.get(raw);
  if(raw.$ref){const s=outputSchema(source().response_schemas[raw.$ref.split('/').pop()]);resolved.set(raw,s);return s;}
  if(raw.allOf){const s={...raw,properties:{...raw.properties}};resolved.set(raw,s);for(const branch of raw.allOf){const b=outputSchema(branch);Object.assign(s.properties,b.properties);s.type ||= b.type;}delete s.allOf;return s;}
  return raw;
}
class IntegerToken{constructor(text){this.text=text;}}
function parse(text,schema){
  const parsed=JSON.parse(text,(_key,value,context)=>typeof value==='number'&&!Number.isSafeInteger(value)&&/^-?[0-9]+$/.test(context.source)?new IntegerToken(context.source):value);
  function restore(value,raw){let s=outputSchema(raw);if(s?.anyOf||s?.oneOf)s=outputSchema((s.anyOf||s.oneOf).find(branch=>typeOK(value,branch)));
    if(value instanceof IntegerToken){if(s?.type==='number'){const n=Number(value.text);if(!Number.isFinite(n))fail('E_TOOL_CALL_UPSTREAM','Lightspeed returned an invalid number');return n;}return value.text;}
    if(typeof value==='number'&&(!Number.isFinite(value)||s?.type==='integer'&&!Number.isSafeInteger(value)))fail('E_TOOL_CALL_UPSTREAM','Lightspeed returned a number that cannot be represented exactly');
    if(Array.isArray(value))return value.map(x=>restore(x,s?.items));
    if(object(value))return Object.fromEntries(Object.entries(value).map(([k,x])=>[k,restore(x,s?.properties?.[k]||s?.additionalProperties)]));return value;
  }return restore(parsed,schema);
}
const privateKeys=new Set(['accesstoken','refreshtoken','clientsecret','authorization','password','cookie','idtoken']);
function redact(value,token){
  if(typeof value==='string')return value.split(token).join('[redacted]');
  if(Array.isArray(value))return value.map(x=>redact(x,token));
  if(!object(value))return value;
  return Object.fromEntries(Object.entries(value).filter(([k])=>!privateKeys.has(k.replace(/[_-]/g,'').toLowerCase())).map(([k,x])=>[k,redact(x,token)]));
}
function typeOK(value,raw){const s=outputSchema(raw);if(!s)return true;if(s.anyOf||s.oneOf)return (s.anyOf||s.oneOf).some(branch=>typeOK(value,branch));if(value===null)return s.nullable===true;
  if(s.type==='array')return Array.isArray(value);if(s.type==='object'||s.properties)return object(value);
  if(s.type==='integer')return Number.isSafeInteger(value)||s.format==='int64'&&typeof value==='string'&&/^-?[0-9]+$/.test(value);
  return !s.type||typeof value===s.type;
}
function decimal(value){
  if(typeof value!=='string'||!/^[-+]?[0-9]+(?:\.[0-9]+)?$/.test(value))return value;
  const negative=value[0]==='-',parts=value.replace(/^[-+]/,'').split('.'),whole=parts[0].replace(/^0+(?=.)/,''),fraction=(parts[1]||'').replace(/0+$/,'');
  return (negative&&(whole!=='0'||fraction)?'-':'')+whole+(fraction?'.'+fraction:'');
}
function acknowledge(row,p,body,response){
  if(!typeOK(body,response.schema))fail('E_TOOL_CALL_UPSTREAM','Lightspeed returned an invalid business response');
  if(object(body)&&(body.error!==undefined||row.path!=='/loyalty/adjustments/bulk'&&Array.isArray(body.errors)&&body.errors.length))fail('E_TOOL_CALL_UPSTREAM','Lightspeed returned a business error');
  const s=outputSchema(response.schema),props=s?.properties;
  if(props?.data&&!Object.hasOwn(body,'data'))fail('E_TOOL_CALL_UPSTREAM','Lightspeed omitted its business data');
  if(props&&Object.keys(props).length&&!Object.keys(props).some(k=>Object.hasOwn(body,k)))fail('E_TOOL_CALL_UPSTREAM','Lightspeed omitted its business acknowledgement');
  if(props)for(const [key,raw]of Object.entries(props))if(Object.hasOwn(body,key)&&!typeOK(body[key],raw))fail('E_TOOL_CALL_UPSTREAM','Lightspeed returned an invalid business resource');
  const data=object(body)&&Object.hasOwn(body,'data')?body.data:body,resourceSchema=outputSchema(props?.data||s);
  if(object(data)&&resourceSchema?.properties?.id){if(!['string','number'].includes(typeof data.id)||!String(data.id)||typeof data.id==='number'&&!Number.isSafeInteger(data.id))fail('E_TOOL_CALL_UPSTREAM','Lightspeed omitted the resource identifier');}
  const last=/\{([^{}]+)\}$/.exec(row.path)?.[1];
  if(last&&row.method!=='POST'&&object(data)&&data.id!==undefined&&!['card_number','transaction_id'].includes(last)&&String(data.id)!==String(p.path[last]))fail('E_TOOL_CALL_UPSTREAM','Lightspeed returned an unrelated resource');
  if(row.path==='/retailer'&&object(data)&&data.domain_prefix&&data.domain_prefix+'.retail.lightspeed.app'!==p.__storeDomain)fail('E_TOOL_CALL_AUTH','Lightspeed returned a different store identity');
  if(row.path==='/products'&&row.method==='POST'&&(!Array.isArray(data)||!data.length||data.some(x=>typeof x!=='string'||!x)))fail('E_TOOL_CALL_UPSTREAM','Lightspeed omitted the created product identifiers');
  if(row.path==='/customer_taxes/bulk'){
    const a=data?.results?.successful,b=data?.results?.failed,summary=data?.summary,requested=p.body.customer_tax;
    if(!Array.isArray(a)||!Array.isArray(b)||a.length+b.length!==requested.length||summary?.total_processed!==requested.length||summary?.success_count!==a.length||summary?.error_count!==b.length)fail('E_TOOL_CALL_UPSTREAM','Lightspeed omitted customer tax batch acknowledgements');
    const seen=new Set();for(const item of [...a,...b]){if(!Number.isSafeInteger(item.index)||seen.has(item.index)||!requested[item.index]||item.customer_id!==requested[item.index].customer_id||item.tax_id!==requested[item.index].tax_id)fail('E_TOOL_CALL_UPSTREAM','Lightspeed returned an unrelated customer tax acknowledgement');seen.add(item.index);}
    for(const item of b)if(Array.isArray(item.errors))item.errors=item.errors.map(x=>({code:x.code}));if(b.length)return 'partial_or_failed';
  }
  if(row.path==='/loyalty/adjustments/bulk'){
    if(!Array.isArray(body.applied)||!Array.isArray(body.errors)||body.applied.length+body.errors.length!==p.body.adjustments.length)fail('E_TOOL_CALL_UPSTREAM','Lightspeed omitted loyalty batch acknowledgements');
    const remaining=p.body.adjustments.map(x=>x.customer_id);for(const x of [...body.applied,...body.errors]){const index=remaining.indexOf(x.customer_id);if(index<0)fail('E_TOOL_CALL_UPSTREAM','Lightspeed returned an unrelated loyalty acknowledgement');remaining.splice(index,1);}
    for(const x of body.errors)delete x.error;if(body.errors.length)return 'partial_or_failed';
  }
  if(row.path==='/stock_adjustments'&&row.method==='POST'){
    if(!Array.isArray(data)||data.length!==p.body.stock_adjustments.length)fail('E_TOOL_CALL_UPSTREAM','Lightspeed omitted stock adjustment acknowledgements');
    data.forEach((x,i)=>{if(!x.id||['product_id','outlet_id'].some(k=>x[k]!==p.body.stock_adjustments[i][k])||decimal(x.quantity)!==decimal(p.body.stock_adjustments[i].quantity))fail('E_TOOL_CALL_UPSTREAM','Lightspeed returned unrelated stock adjustments');});
  }
  if(row.path==='/consignments/{consignment_id}/bulk'){
    if(!object(data)||Object.keys(data).length!==p.body.length||p.body.some(x=>!object(data[x.product_id])))fail('E_TOOL_CALL_UPSTREAM','Lightspeed omitted consignment product acknowledgements');
  }
  if(row.path==='/promocode/bulk'&&row.method==='DELETE'){if(!Array.isArray(body))fail('E_TOOL_CALL_UPSTREAM','Lightspeed omitted remaining promo codes');if(body.some(x=>typeof x!=='string'||!p.body.includes(x))||new Set(body).size!==body.length)fail('E_TOOL_CALL_UPSTREAM','Lightspeed returned unrelated remaining promo codes');if(body.length)return 'partial_or_failed';}
  if(row.method==='DELETE'&&row.path.startsWith('/gift_cards/by_')&&data.status!=='VOIDED')return 'partial_or_failed';
  if(row.method==='PUT'&&row.path==='/sales/{sale_id}'&&Object.hasOwn(p.body,'state')&&data.state!==p.body.state)return 'partial_or_failed';
  if(row.path==='/registers/{register_id}/actions/open'&&data.is_open!==true||row.path==='/registers/{register_id}/actions/close'&&data.is_open!==false)return 'partial_or_failed';
  if(object(data)&&typeof data.job_id==='string'&&data.job_id)return 'accepted';
  if(body===false)return 'partial_or_failed';
  return row.risk==='R'?undefined:'acknowledged';
}
async function execute(config,name,p={}){
  const row=source().methods[name];if(!row)fail('E_BAD_INPUT','Unknown Lightspeed merchant action');validate(row,p);p={...p,query:{...row.defaults.query,...p.query},...(Object.keys(row.defaults.body).length?{body:{...row.defaults.body,...p.body}}:{})};
  const domain=config.metadata?.store_domain,token=config.credentials?.access_token;
  if(config.provider!=='lightspeed'||config.credentials?.provider!=='lightspeed'||!(/^[a-z0-9][a-z0-9-]{0,62}\.retail\.lightspeed\.app$/).test(domain||'')||typeof token!=='string'||token.length<8||token.length>4096||/[\s\u0000-\u001f\u007f]/.test(token))fail('E_TOOL_CALL_AUTH','Invalid Lightspeed store or Personal Token binding');
  let route=row.path;for(const [key,value]of Object.entries(p.path||{}))route=route.replace('{'+key+'}',encodeURIComponent(String(value)));if(/[{}]/.test(route))fail('E_BAD_INPUT','Missing Lightspeed resource identifier');
  const url=new URL('https://'+domain+'/api/'+source().version+route);for(const field of row.wire){if(field.in!=='query'||!Object.hasOwn(p.query||{},field.name))continue;const value=p.query[field.name];if(Array.isArray(value)&&field.explode)for(const item of value)url.searchParams.append(field.name,String(item));else url.searchParams.set(field.name,Array.isArray(value)?value.join(','):String(value));}
  const deadline=AbortSignal.timeout(60000),media=[...new Set(Object.values(row.responses).map(r=>r.media).filter(Boolean))].join(', '),init={method:row.method,headers:{accept:media||'application/json',authorization:'Bearer '+token},signal:deadline,redirect:'error'};
  if(p.body!==undefined){init.headers['content-type']='application/json';init.body=wireJSON(p.body,row.input_schema.properties.body,row.input_schema.$defs);}
  let response,text;try{response=await requestFetch(url.toString(),init);}catch(error){fail(requestFailureCode(error,deadline),'Lightspeed request failed; inspect resource state before retrying an uncertain write');}
  if(!response.ok)throw httpFailure(response.status,[401,403].includes(response.status)?'Lightspeed access was denied; check the Personal Token permissions and required store module':`Lightspeed request failed (HTTP ${response.status})`);
  const expected=row.responses[response.status];if(!expected)fail('E_TOOL_CALL_UPSTREAM','Lightspeed returned an undocumented acknowledgement status');
  try{text=await readBody(response);}catch(error){if(error?.code==='E_CONNECTOR_RESPONSE_TOO_LARGE')fail('E_TOOL_CALL_UPSTREAM','Lightspeed response is too large');fail(requestFailureCode(error,deadline),'Lightspeed response could not be read');}
  if(response.status===204||!expected.media&&(!text.trim()||text.trim()==='{}'))return {data:text.trim()?{}:null,...(row.risk!=='R'?{status:'acknowledged'}:{})};
  if(expected.media==='text/html'||expected.media==='text/plain'){if(!text.trim())fail('E_TOOL_CALL_UPSTREAM','Lightspeed omitted the requested document');return {data:redact(text,token),media_type:expected.media};}
  let body;try{body=parse(text,expected.schema);}catch{fail('E_TOOL_CALL_UPSTREAM','Lightspeed returned an invalid JSON response');}
  const status=acknowledge(row,{...p,__storeDomain:domain},body,expected);
  return {data:redact(body,token),...(status?{status:response.status===207?'partial_or_failed':status}:response.status===207?{status:'partial_or_failed'}:{}),...(status==='accepted'?{follow_up:'Inspect the returned job and resource state to verify completion; do not resubmit automatically.'}:{})};
}
module.exports={actionsFor,isNative,execute};
