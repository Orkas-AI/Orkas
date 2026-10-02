'use strict';

const {requestFetch,requestFailureCode,httpFailure}=require('./commerce-request-context.cjs');
const {readBody}=require('./storefront-admin-api.cjs');
let contracts,actions,validator;
const inputSchemas=new Map(),attributeSchemas=new Map(),checks=new Map();
const source=()=>contracts ||= require('./commercelayer-api-contracts.cjs');
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
function attach(schema,mode,ids){return {...schema,$defs:Object.fromEntries(ids.map(id=>[id,source().definitions[mode][id]]))};}
function inputFor(name,row){if(!inputSchemas.has(name))inputSchemas.set(name,attach(row.input_schema,row.risk,row.input_definitions));return inputSchemas.get(name);}
function actionsFor(){return actions ||= Object.fromEntries(Object.entries(source().methods).map(([name,row])=>[name,{risk:row.risk,description:row.description,input_schema:inputFor(name,row)}]));}
const isNative=name=>Object.hasOwn(source().methods,name);
function check(schema,value,code,message){
  if(!validator){const {AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv');validator=new AjvJsonSchemaValidator();}
  let validate=checks.get(schema);if(!validate){validate=validator.getValidator(schema);checks.set(schema,validate);}
  if(!validate(value).valid)fail(code,message);
}
// This is the published query grammar, never a free-text intent classifier.
const MATCHERS=['eq','eq_or_null','not_eq','not_eq_or_null','matches','does_not_match','matches_any','matches_all','does_not_match_any','does_not_match_all','lt','lteq','gt','gteq','present','blank','null','not_null','in','in_or_null','not_in','not_in_or_null','lt_any','lteq_any','gt_any','gteq_any','lt_all','lteq_all','gt_all','gteq_all','not_eq_all','start','not_start','start_any','start_all','not_start_any','not_start_all','end','not_end','end_any','end_all','not_end_any','not_end_all','cont','not_cont','cont_any','not_cont_any','cont_all','not_cont_all','i_cont','not_i_cont','i_cont_any','not_i_cont_any','i_cont_all','not_i_cont_all','jcont','true','false'].sort((a,b)=>b.length-a.length);
function readable(type){return !!source().resources[type] && isNative('GET /'+type);}
function fieldAllowed(type,field,mode,separator,depth=0){
  const resource=source().resources[type];if(!resource || depth>6)return false;
  if(field==='id' || resource.fields[field]?.[mode])return true;
  for(const [name,relation]of Object.entries(resource.relationships))if(relation[mode] && relation.target && field.startsWith(name+separator) && fieldAllowed(relation.target,field.slice(name.length+separator.length),mode,separator,depth+1))return true;
  return false;
}
function included(type,path){
  let current=type;const segments=path.split('.');if(segments.length>6)return false;
  for(const segment of segments){const relation=source().resources[current]?.relationships[segment];if(!relation?.target || !readable(relation.target))return false;current=relation.target;}
  return true;
}
function queryString(row,q={}){
  const query=new URLSearchParams();
  for(const association of q.include || []){if(!included(row.target,association))fail('E_BAD_INPUT','Unknown Commerce Layer relationship inclusion');}
  if(q.include)query.set('include',q.include.join(','));
  for(const [type,fields]of Object.entries(q.fields || {})){
    if(!readable(type) || fields.some(field=>!['id','type'].includes(field) && !source().resources[type].fields[field]?.fetchable && !source().resources[type].relationships[field]))fail('E_BAD_INPUT','Unknown Commerce Layer sparse field');
    query.set('fields['+type+']',fields.join(','));
  }
  for(const sort of q.sort || [])if(!fieldAllowed(row.target,sort.replace(/^-/,''),'sortable','.'))fail('E_BAD_INPUT','Unknown Commerce Layer sorting field');
  if(q.sort)query.set('sort',q.sort.join(','));
  for(const [key,value]of Object.entries(q.page || {}))query.set('page['+key+']',String(value));
  for(const [key,value]of Object.entries(q.filter || {})){
    if(key==='q'){
      for(const [predicate,raw]of Object.entries(value)){
        const matcher=MATCHERS.find(m=>predicate.endsWith('_'+m));
        const fields=matcher?predicate.slice(0,-matcher.length-1).split('_or_'):[];
        if(!fields.length || fields.some(field=>!fieldAllowed(row.target,field,'filterable','_')))fail('E_BAD_INPUT','Unknown Commerce Layer filter predicate; the API would ignore unsupported filters');
        query.set('filter[q]['+predicate+']',Array.isArray(raw)?raw.join(','):String(raw));
      }
    }else query.set('filter['+key+']',Array.isArray(value)?value.join(','):String(value));
  }
  return query.size?'?'+query.toString():'';
}
const PRIVATE_FIELDS=new Set(['accesstoken','refreshtoken','authorization','password','customerpassword','clientsecret','apikey','secretkey','credentials','privatekey','cookie','cardnumber','cvv','cvc']);
function clean(value,secrets){
  if(typeof value==='string'){for(const secret of secrets)if(secret)value=value.split(secret).join('[redacted]');return value;}
  if(Array.isArray(value))return value.map(child=>clean(child,secrets));
  if(!object(value))return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!PRIVATE_FIELDS.has(key.replace(/[_-]/g,'').toLowerCase())).map(([key,child])=>[key,clean(child,secrets)]));
}
function attributesFor(type){
  if(!attributeSchemas.has(type)){const row=source().resources[type].response_attributes;attributeSchemas.set(type,attach(row.schema,'output',row.definitions));}
  return attributeSchemas.get(type);
}
function resourceValid(value,type){
  if(!object(value) || typeof value.id!=='string' || !value.id || typeof value.type!=='string' || (type && value.type!==type) || !source().resources[value.type])fail('E_TOOL_CALL_UPSTREAM','Commerce Layer returned an invalid resource identity');
  if(value.attributes!==undefined)check(attributesFor(value.type),value.attributes,'E_TOOL_CALL_UPSTREAM','Commerce Layer returned invalid resource attributes');
  if(value.relationships!==undefined && !object(value.relationships))fail('E_TOOL_CALL_UPSTREAM','Commerce Layer returned invalid resource relationships');
  for(const [name,link]of Object.entries(value.relationships || {})){
    if(!object(link))fail('E_TOOL_CALL_UPSTREAM','Commerce Layer returned invalid relationship linkage');
    const relation=source().resources[value.type].relationships[name];
    if(link.data===undefined || !relation)continue;
    if(relation.many?!Array.isArray(link.data):Array.isArray(link.data))fail('E_TOOL_CALL_UPSTREAM','Commerce Layer returned invalid relationship cardinality');
    for(const identifier of Array.isArray(link.data)?link.data:link.data===null?[]:[link.data]){
      if(!object(identifier) || typeof identifier.id!=='string' || !identifier.id || typeof identifier.type!=='string' || (relation.target && identifier.type!==relation.target))fail('E_TOOL_CALL_UPSTREAM','Commerce Layer returned invalid relationship identity');
    }
  }
}
function outcome(row,data,p){
  if(!object(data))fail('E_TOOL_CALL_UPSTREAM','Commerce Layer returned an invalid JSON:API document');
  if(Array.isArray(data.errors) && data.errors.length)fail('E_TOOL_CALL_UPSTREAM','Commerce Layer returned a business error; inspect resource state before retrying');
  if(!Object.hasOwn(data,'data'))fail('E_TOOL_CALL_UPSTREAM','Commerce Layer omitted the resource acknowledgement');
  const expectedMany=row.method==='GET' && row.many;
  if(expectedMany){if(!Array.isArray(data.data))fail('E_TOOL_CALL_UPSTREAM','Commerce Layer omitted the resource collection');for(const value of data.data)resourceValid(value,row.target);}
  else if(data.data===null){if(!row.relationship || row.method!=='GET')fail('E_TOOL_CALL_UPSTREAM','Commerce Layer omitted the requested resource');}
  else {resourceValid(data.data,row.target);if(!row.relationship && row.method!=='POST' && p.path && data.data.id!==Object.values(p.path)[0])fail('E_TOOL_CALL_UPSTREAM','Commerce Layer returned a different resource acknowledgement');}
  if(data.included!==undefined){if(!Array.isArray(data.included))fail('E_TOOL_CALL_UPSTREAM','Commerce Layer returned invalid included resources');data.included.forEach(value=>resourceValid(value));}
  const records=Array.isArray(data.data)?data.data:data.data?[data.data]:[];
  return records.some(record=>{
    const attrs=record.attributes || {};
    if(Number.isInteger(attrs.errors_count) && attrs.errors_count>0)return true;
    if(['imports','exports','cleanups'].includes(record.type) && ['failed','interrupted'].includes(attrs.status))return true;
    return ['authorizations','captures','refunds','voids'].includes(record.type) && attrs.succeeded===false;
  });
}
async function execute(config,name,p={},owners){
  if(config.provider!=='commerce_layer')fail('E_BAD_INPUT','Unsupported Commerce Layer provider');
  const row=source().methods[name];if(!row)fail('E_BAD_INPUT','Unknown Commerce Layer merchant action');
  let encoded;try{encoded=JSON.stringify(p);}catch{fail('E_BAD_INPUT','Invalid Commerce Layer action parameters');}
  if(!encoded || Buffer.byteLength(encoded)>256*1024)fail('E_BAD_INPUT','Invalid or oversized Commerce Layer action parameters');
  check(inputFor(name,row),p,'E_BAD_INPUT','Invalid Commerce Layer action parameters; check the described fields and types');
  let route=row.path;for(const [key,value]of Object.entries(p.path || {}))route=route.replace('{'+key+'}',encodeURIComponent(value));
  if(/[{}]/.test(route))fail('E_BAD_INPUT','Missing Commerce Layer resource identifier');
  if(p.body?.data?.id && p.path && p.body.data.id!==Object.values(p.path)[0])fail('E_BAD_INPUT','Commerce Layer body and path resource identifiers must match');
  const query=queryString(row,p.query),base=owners.base(config);
  if(base!=='https://'+config.metadata.organization_slug+'.commercelayer.io' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(config.metadata.organization_slug))fail('E_BAD_INPUT','Invalid Commerce Layer organization binding');
  const token=await owners.token(config),deadline=AbortSignal.timeout(60000),headers={accept:'application/vnd.api+json',authorization:'Bearer '+token};
  const init={method:row.method,headers,redirect:'error',signal:deadline};
  if(p.body!==undefined){headers['content-type']='application/vnd.api+json';init.body=JSON.stringify(p.body);}
  let response,text;
  try{response=await requestFetch(base+'/api'+route+query,init);}catch(error){fail(requestFailureCode(error,deadline),'Commerce Layer request failed; inspect resource state before retrying an uncertain write');}
  if(!response.ok)throw httpFailure(response.status,'Commerce Layer request failed (HTTP '+response.status+')');
  if(!row.statuses.includes(response.status))fail('E_TOOL_CALL_UPSTREAM','Commerce Layer returned an unexpected acknowledgement status');
  try{text=await readBody(response);}catch(error){if(error?.code==='E_CONNECTOR_RESPONSE_TOO_LARGE')fail('E_TOOL_CALL_UPSTREAM','Commerce Layer response is too large');fail(requestFailureCode(error,deadline),'Commerce Layer response could not be read');}
  if(response.status===204){if(text)fail('E_TOOL_CALL_UPSTREAM','Commerce Layer returned an invalid empty acknowledgement');return {data:null,status:'acknowledged'};}
  let data;try{data=JSON.parse(text);}catch{fail('E_TOOL_CALL_UPSTREAM','Commerce Layer returned invalid JSON');}
  const failed=outcome(row,data,p),result=clean(data,[token,config.credentials.client_secret]);
  for(const value of [...(Array.isArray(result.data)?result.data:result.data?[result.data]:[]),...(result.included || [])]){
    // Structured counters and states remain; provider diagnostics can echo secrets.
    if(value.attributes){delete value.attributes.errors_log;delete value.attributes.error_log;}
  }
  return {data:result,...(failed?{status:'partial_or_failed'}:row.risk!=='R'?{status:'acknowledged'}:{})};
}
module.exports={actionsFor,isNative,execute};
