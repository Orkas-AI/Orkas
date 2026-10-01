'use strict';
const {requestFetch,requestFailureCode,httpFailure}=require('./commerce-request-context.cjs');
const {readBody}=require('./storefront-admin-api.cjs');
let contracts,actions,validator;
const cache=new Map(),source=()=>contracts ||= require('./qoo10-api-contracts.cjs');
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x),fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const isNative=name=>Object.hasOwn(source().methods,name);
function actionsFor(){return actions ||= Object.fromEntries(Object.entries(source().methods).map(([name,r])=>[name,{risk:r.risk,description:r.description,input_schema:r.input_schema}]));}
function validDate(value){const s=value.slice(0,8),iso=s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8),date=new Date(iso+'T00:00:00Z');return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===iso&&(value.length===8||Number(value.slice(8,10))<24&&Number(value.slice(10,12))<60&&Number(value.slice(12,14))<60);}
function validate(row,p){
 let text;try{text=JSON.stringify(p);}catch{fail('E_BAD_INPUT','Invalid Qoo10 parameters');}if(!text||Buffer.byteLength(text)>256*1024)fail('E_BAD_INPUT','Invalid or oversized Qoo10 parameters');
 if(!validator){const {AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv');validator=new AjvJsonSchemaValidator();}let check=cache.get(row);if(!check){check=validator.getValidator(row.input_schema);cache.set(row,check);}if(!check(p).valid)fail('E_BAD_INPUT','Invalid Qoo10 parameters; check the described fields and types');
 for(const [field,value]of Object.entries(p)){const max=row.input_schema.properties[field]?.['x-maxBytes'];if(max&&typeof value==='string'&&Buffer.byteLength(value)>max)fail('E_BAD_INPUT','Qoo10 content exceeds the documented byte limit');}
 for(const field of row.date_fields)if(p[field]!==undefined&&!validDate(p[field]))fail('E_BAD_INPUT','Invalid Qoo10 calendar date or time');
 const cap={R:100,W:25,H:10,D:10}[row.risk];for(const field of row.row_fields)if(typeof p[field]==='string'){
  const rows=p[field].split('$$').filter(x=>x.trim()),limit=[15757,15758].includes(row.id)?Math.min(cap,({StyleNumber:2,TpoNumber:2,SeasonType:4,MaterialNumber:3,VideoNumber:10,Keyword:10})[field]||cap):cap;
  if(rows.length>limit)fail('E_BAD_INPUT','Qoo10 option rows exceed the documented or host batch limit');
  if(field==='OptionMainimage'&&[15757,15758].includes(row.id)&&rows.some(x=>x.split('||*').length!==2||x.split('||*')[1].length>200))fail('E_BAD_INPUT','Qoo10 option image URL exceeds its documented format or length');
 }
 if(row.id===10029&&Object.entries(p).filter(([k,v])=>/^EnlargedImage[0-9]+$/.test(k)&&v).length>cap)fail('E_BAD_INPUT','Qoo10 images exceed the existing host batch limit');
 if(row.batch){for(const item of p[row.batch.field])if(item.EstShipDt&&!validDate(item.EstShipDt))fail('E_BAD_INPUT','Invalid Qoo10 estimated shipment date');const keys=p[row.batch.field].map(x=>row.batch.kind==='unverified_dictionary'?JSON.stringify([x.ItemCode,x.OptionName,x.OptionValue,x.OptionCode]):x.OrderNo);if(new Set(keys).size!==keys.length)fail('E_BAD_INPUT','Provide each Qoo10 batch target once');}
}
class IntegerToken{constructor(value){this.value=value;}}
function parseJSON(text,row){
 let depth=0,quoted=false,escaped=false;for(const c of text){if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;else if(c==='{'||c==='['){if(++depth>40)fail('E_TOOL_CALL_UPSTREAM','Qoo10 response is too deeply nested');}else if(c==='}'||c===']')depth--;}

 const parsed=JSON.parse(text,(_key,value,context)=>typeof value==='number'&&!Number.isSafeInteger(value)&&/^-?[0-9]+$/.test(context.source)?new IntegerToken(context.source):value);
 function restore(v,path){const type=row.output_types[path.join('$$')];if(v instanceof IntegerToken){if(type!=='Decimal')return v.value;const n=Number(v.value);if(!Number.isFinite(n))fail('E_TOOL_CALL_UPSTREAM','Qoo10 returned an invalid decimal');return n;}if(typeof v==='number'&&(!Number.isFinite(v)||type!=='Decimal'&&Number.isInteger(v)&&!Number.isSafeInteger(v)))fail('E_TOOL_CALL_UPSTREAM','Qoo10 returned an integer that cannot be represented exactly');if(Array.isArray(v))return v.map(x=>restore(x,path));if(object(v))return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,restore(x,[...path,k])]));return v;}return restore(parsed,[]);
}
const credentialKeys=new Set(['certificationkey','giosiscertificationkey','accesstoken','refreshtoken','authorization','password','pwd','clientsecret','cookie']);
function redact(v,key,state){if(typeof v==='string'){if(state&&v.includes(key))state.changed=true;return v.split(key).join('[redacted]');}if(Array.isArray(v))return v.map(x=>redact(x,key,state));if(!object(v))return v;return Object.fromEntries(Object.entries(v).filter(([k])=>{const secret=credentialKeys.has(k.replace(/^@/,'').split(':').pop().replace(/[_-]/g,'').toLowerCase());if(secret&&state)state.changed=true;return !secret;}).map(([k,x])=>[k,redact(x,key,state)]));}
function envelope(body){
 if(!object(body))fail('E_TOOL_CALL_UPSTREAM','Qoo10 returned an invalid result envelope');const code=body.ErrorCode??body.ResultCode;
 if([-90000,-10000,-90002,-90003,-90004,-90005].includes(code))fail('E_TOOL_CALL_AUTH','Qoo10 denied access; check the seller Certification Key and method permissions');
 if(body.ErrorCode!==undefined&&body.ErrorCode!==0||body.ResultCode!==0)fail('E_TOOL_CALL_UPSTREAM','Qoo10 rejected the request; check permissions, parameters and current resource state');
}
function acknowledge(row,p,body){
 envelope(body);const value=body.ResultObject;
 if(row.batch){
  if(row.batch.kind==='unverified_dictionary'){if(!Array.isArray(value)&&!object(value))fail('E_TOOL_CALL_UPSTREAM','Qoo10 omitted its batch response');return 'accepted';}
  const field=row.batch.kind==='confirmation'?'cont_no':'contr_no',requested=p[row.batch.field].map(x=>x.OrderNo);
  if(!Array.isArray(value)||value.length!==requested.length)fail('E_TOOL_CALL_UPSTREAM','Qoo10 omitted individual shipment acknowledgements');
  const seen=new Set();for(const item of value){const id=String(item?.[field]);if(!requested.includes(id)||seen.has(id)||!Number.isSafeInteger(item?.result_cd))fail('E_TOOL_CALL_UPSTREAM','Qoo10 returned incomplete or unrelated shipment acknowledgements');seen.add(id);}return value.some(x=>x.result_cd!==0)?'partial_or_failed':'acknowledged';
 }
 if(row.output_kind==='array'&&!Array.isArray(value))fail('E_TOOL_CALL_UPSTREAM','Qoo10 omitted the requested list');
 if(row.output_kind==='object'&&!object(value))fail('E_TOOL_CALL_UPSTREAM','Qoo10 omitted its business response');
 if(row.id===10008&&(!Array.isArray(value.Items)||!['TotalItems','TotalPages','PresentPage'].every(k=>Number.isSafeInteger(value[k])&&value[k]>=0)))fail('E_TOOL_CALL_UPSTREAM','Qoo10 omitted product pagination');
 if(row.id===10007&&value.some(x=>typeof x.ItemCode!=='string'||p.ItemCode&&x.ItemCode!==p.ItemCode||p.SellerCode&&x.SellerCode!==p.SellerCode))fail('E_TOOL_CALL_UPSTREAM','Qoo10 returned an unrelated product');
 if(row.id===15477&&value.some(x=>String(x.orderNo)!==p.OrderNo))fail('E_TOOL_CALL_UPSTREAM','Qoo10 returned an unrelated order');
 if(row.id===10009){if(typeof value.GdNo!=='string'||!value.GdNo)fail('E_TOOL_CALL_UPSTREAM','Qoo10 omitted the created product identifier');for(const key of ['optionImgResult','InventoryImgResult'])if(Array.isArray(value[key])&&value[key].some(x=>x.isRegistered!==true))return 'partial_or_failed';}
 if(row.id===10056&&(!Number.isSafeInteger(value.SEQ_NO)&&!(typeof value.SEQ_NO==='string'&&/^[0-9]+$/.test(value.SEQ_NO))))fail('E_TOOL_CALL_UPSTREAM','Qoo10 omitted the inquiry reply identifier');
 if(row.output_kind==='undocumented'){if(row.risk==='R'&&value==null)fail('E_TOOL_CALL_UPSTREAM','Qoo10 omitted the requested business result');return row.risk==='R'?undefined:'accepted';}
 return row.risk==='R'?undefined:row.id===10040?'accepted':'acknowledged';
}
function xmlResult(text,key){
 const {XMLParser,XMLValidator,XMLBuilder}=require('fast-xml-parser');if(/<!DOCTYPE|<!ENTITY/i.test(text)||XMLValidator.validate(text)!==true)fail('E_TOOL_CALL_UPSTREAM','Qoo10 returned invalid report XML');
 let parsed;try{parsed=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@',parseTagValue:false,parseAttributeValue:false,ignoreDeclaration:true,maxNestedTags:32}).parse(text);}catch{fail('E_TOOL_CALL_UPSTREAM','Qoo10 returned invalid report XML');}
 const roots=Object.values(parsed);if(roots.length!==1||!object(roots[0]))fail('E_TOOL_CALL_UPSTREAM','Qoo10 omitted the report result');const body=roots[0];
 envelope({...body,ResultCode:body.ResultCode===undefined?undefined:Number(body.ResultCode),...(body.ErrorCode===undefined?{}:{ErrorCode:Number(body.ErrorCode)})});
 if(body.ResultObject===undefined||body.ResultObject==='XmlOnly')fail('E_TOOL_CALL_UPSTREAM','Qoo10 returned a format placeholder instead of report data');
 const state={changed:false},clean=redact(parsed,key,state);if(!state.changed)return text;const output=new XMLBuilder({ignoreAttributes:false,attributeNamePrefix:'@'}).build(clean);if(Buffer.byteLength(output)>1024*1024)fail('E_TOOL_CALL_UPSTREAM','Qoo10 report is too large');return output;
}
async function execute(config,name,p={}){
 const row=source().methods[name];if(!row)fail('E_BAD_INPUT','Unknown Qoo10 merchant action');require('./qoo10-japan-api.cjs').validateBinding(config);validate(row,p);
 const base=require('./qoo10-japan-api.cjs').apiBase(config.provider,config.metadata),key=config.credentials.certification_key,form=new URLSearchParams({returnType:row.xml?'xml':'json'});
 for(const [field,value]of Object.entries(p))form.set(field,Array.isArray(value)?JSON.stringify(value):String(value));if(row.id===10008&&!Object.hasOwn(p,'Page'))form.set('Page','1');
 const deadline=AbortSignal.timeout(60000);let response,text;try{response=await requestFetch(base+'/'+name,{method:'POST',redirect:'error',signal:deadline,headers:{accept:row.xml?'text/xml':'application/json','content-type':'application/x-www-form-urlencoded',QAPIVersion:row.version,GiosisCertificationKey:key},body:form.toString()});}catch(error){fail(requestFailureCode(error,deadline),'Qoo10 request failed; inspect the resource before retrying an uncertain write');}
 if(!response.ok)throw httpFailure(response.status,'Qoo10 request failed; check authorization and current resource state');
 try{text=await readBody(response);}catch(error){fail(error?.code==='E_CONNECTOR_RESPONSE_TOO_LARGE'?'E_TOOL_CALL_UPSTREAM':requestFailureCode(error,deadline),'Qoo10 response could not be read completely');}
 if(row.xml)return {data:xmlResult(text,key),media_type:'text/xml'};
 let body;try{body=parseJSON(text,row);}catch{fail('E_TOOL_CALL_UPSTREAM','Qoo10 returned invalid or imprecise JSON');}const status=acknowledge(row,p,body);
 delete body.ResultMsg;delete body.ErrorMsg;
 return {data:redact(body,key),...(status?{status}:{}),...(status==='accepted'?{follow_up:'The request was accepted. Verify each affected resource before considering the operation complete; do not resubmit automatically.'}:{})};
}
module.exports={actionsFor,isNative,execute};
