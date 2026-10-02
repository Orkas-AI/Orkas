'use strict';
const {requestFetch,requestFailureCode,httpFailure}=require('./commerce-request-context.cjs');
const {readBody}=require('./storefront-admin-api.cjs');
let contracts,actions,validator;const checks=new Map(),responses=new Map();
const source=()=>contracts ||= require('./constant-contact-api-contracts.cjs');
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const attach=(s,mode,ids)=>({...s,$defs:Object.fromEntries(ids.map(id=>[id,source().definitions[mode][id]]))});
function actionsFor(){return actions ||= Object.fromEntries(Object.entries(source().methods).map(([name,row])=>[name,{risk:row.risk,description:row.description,input_schema:attach(row.input_schema,row.risk,row.input_definitions)}]));}
const isNative=name=>Object.hasOwn(source().methods,name);
function check(schema,value,code,message){
 if(!validator){const {AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv');validator=new AjvJsonSchemaValidator();}
 if(!checks.has(schema))checks.set(schema,validator.getValidator(schema));if(!checks.get(schema)(value).valid)fail(code,message);
}
const privateKeys=new Set(['accesstoken','refreshtoken','authorization','password','cookie','clientsecret']);
const receiptKeys={ContactResource:'contact_id',ContactCreateOrUpdateResponse:'contact_id',CustomField:'custom_field_id',ContactListPutPost:'list_id',Tag:'tag_id',EmailCampaign:'campaign_id',EmailCampaignActivity:'campaign_activity_id',ResendToNonOpenersObject:'resend_request_id',SegmentDetail:'segment_id',AutomationCampaign:'id',EventDto:'event_id',PostDto:'campaign_id'};
function clean(v,secrets){if(typeof v==='string'){for(const s of secrets)if(s)v=v.split(s).join('[redacted]');return v;}if(Array.isArray(v))return v.map(x=>clean(x,secrets));if(!v||typeof v!=='object')return v;return Object.fromEntries(Object.entries(v).filter(([k])=>!privateKeys.has(k.replace(/[_-]/g,'').toLowerCase())).map(([k,x])=>[k,clean(x,secrets)]));}
function authorized(config,row){
 if(typeof config.credentials.scope!=='string')return;
 const granted=new Set(config.credentials.scope.split(/[ ,]+/));if(row.scopes.some(s=>!granted.has(s)))fail('E_TOOL_CALL_AUTH','This operation is unavailable with the connected Constant Contact grant');
}
async function execute(config,name,p={},owners){
 const row=source().methods[name];if(config.provider!=='constant_contact'||!row)fail('E_BAD_INPUT','Unknown Constant Contact action');
 let encoded;try{encoded=JSON.stringify(p);}catch{fail('E_BAD_INPUT','Invalid action parameters');}
 if(!encoded||Buffer.byteLength(encoded)>262144)fail('E_BAD_INPUT','Invalid or oversized Constant Contact parameters');
 check(actionsFor()[name].input_schema,p,'E_BAD_INPUT','Invalid Constant Contact fields; check the described contract');authorized(config,row);
 let route=row.path;const query=new URLSearchParams();
 for(const wire of row.wire){const v=p[wire.location]?.[wire.name]??wire.default;if(v===undefined)continue;
  if(wire.location==='path'){if(!String(v)||['.','..'].includes(String(v))||/[\u0000-\u001f\u007f]/.test(String(v)))fail('E_BAD_INPUT','Invalid Constant Contact resource identifier');route=route.replace('{'+wire.name+'}',encodeURIComponent(v));}
  else if(Array.isArray(v)&&wire.explode)v.forEach(x=>query.append(wire.name,String(x)));else query.append(wire.name,Array.isArray(v)?v.join(','):String(v));
 }
 if(/[{}]/.test(route))fail('E_BAD_INPUT','Missing Constant Contact resource identifier');
 const token=await owners.token(config);authorized(config,row);
 const deadline=AbortSignal.timeout(60000),headers={accept:'application/json',authorization:'Bearer '+token},init={method:row.method,headers,signal:deadline,redirect:'error'};
 if(p.body!==undefined){headers['content-type']='application/json';init.body=JSON.stringify(p.body);}
 let response,text;try{response=await requestFetch('https://api.cc.email/v3'+route+(query.size?'?'+query.toString():''),init);}catch(e){fail(requestFailureCode(e,deadline),'Constant Contact request failed; check resource state before retrying an uncertain write');}
 if(!response.ok)throw httpFailure(response.status,'Constant Contact request failed (HTTP '+response.status+')');
 try{text=await readBody(response);}catch(e){if(e?.code==='E_CONNECTOR_RESPONSE_TOO_LARGE')fail('E_TOOL_CALL_UPSTREAM','Constant Contact response is too large');fail(requestFailureCode(e,deadline),'Constant Contact response could not be read');}
 if(!Object.hasOwn(row.responses,String(response.status)))fail('E_TOOL_CALL_UPSTREAM','Constant Contact returned an unexpected acknowledgement status');
 let data=null;try{if(text)data=JSON.parse(text);}catch{fail('E_TOOL_CALL_UPSTREAM','Constant Contact returned invalid JSON');}
 const schema=row.responses[String(response.status)];
 if(schema){const key=name+' '+response.status;if(!responses.has(key))responses.set(key,attach(schema,'output',row.response_definitions));check(responses.get(key),data,'E_TOOL_CALL_UPSTREAM','Constant Contact returned an invalid business acknowledgement');
  const shape=schema.$ref?source().definitions.output[schema.$ref.slice('#/$defs/'.length)]:schema;
  const type=schema.$ref?.slice('#/$defs/'.length),receipt=receiptKeys[type];
  if(row.risk!=='R'&&receipt&&(data?.[receipt]===undefined||data[receipt]===null||String(data[receipt])===''))fail('E_TOOL_CALL_UPSTREAM','Constant Contact omitted the resource receipt');
  if(type==='EmailScheduleResponse'&&(!data.length||data.some(item=>typeof item.scheduled_date!=='string'||!item.scheduled_date)))fail('E_TOOL_CALL_UPSTREAM','Constant Contact omitted the schedule acknowledgement');
  if(row.risk!=='R'&&shape.type==='object'&&Object.keys(shape.properties||{}).length&&!Object.keys(shape.properties).some(k=>Object.hasOwn(data,k)))fail('E_TOOL_CALL_UPSTREAM','Constant Contact omitted the business acknowledgement');
  if(row.risk!=='R'&&row.path.startsWith('/activities/')&&(typeof data?.activity_id!=='string'||!data.activity_id))fail('E_TOOL_CALL_UPSTREAM','Constant Contact omitted the activity receipt');
 }else if(data!==null)fail('E_TOOL_CALL_UPSTREAM','Constant Contact returned an invalid empty acknowledgement');
 if(Array.isArray(data?.failed_registration_ids)){
  const failed=data.failed_registration_ids,requested=p.body?.registration_ids;
  if(!Array.isArray(requested)||new Set(failed).size!==failed.length||failed.some(id=>!requested.includes(id)))fail('E_TOOL_CALL_UPSTREAM','Constant Contact returned unrelated registration failures');
 }
 const responseShape=schema?.$ref?source().definitions.output[schema.$ref.slice('#/$defs/'.length)]:schema;
 const activity=Boolean(responseShape?.properties?.activity_id&&responseShape?.properties?.state);
 const failed=response.status===207||(activity&&(['failed','cancelled','timed_out'].includes(data?.state)||Number(data?.status?.error_count)>0||Number(data?.status?.cannot_add_to_list_count)>0||data?.activity_errors?.length>0))||(row.path==='/social/posts'&&data?.status==='ERROR');
 const safe=clean(data,[token,config.credentials.refresh_token]);
 if(activity&&Array.isArray(safe?.activity_errors)){safe.activity_error_count=safe.activity_errors.length;delete safe.activity_errors;}
 return {data:safe,...(failed?{status:'partial_or_failed'}:row.risk!=='R'?{status:'acknowledged'}:{}),...(row.risk!=='R'&&activity?{follow_up:'This is an asynchronous activity receipt. Read the activity status before retrying; do not automatically resubmit.'}:{})};
}
module.exports={actionsFor,isNative,execute};
