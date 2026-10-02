'use strict';
// Offline generation from pinned official JOS parameter trees and reviewed policy decisions.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const evidencePath=process.argv[2]||path.resolve(__dirname,'../test/fixtures/connectors/official-contracts/jd-20261001.json');
const outputPath=process.argv[3]||path.resolve(__dirname,'../bin/jd-api-contracts.cjs');
const evidence=JSON.parse(fs.readFileSync(evidencePath,'utf8')),definitions={},methods={},issues=[];
const numericPattern='^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$';
const visible=x=>!x.SystemValue&&!x.systemValue&&!x.defaultValue&&!String(x.webPamer).includes('$');
const collection=t=>['java.util.List','java.util.Set','java.util.Arrays'].includes(t);
const scalar=t=>['String','Number','Boolean','Date'].includes(t);
function intern(s){const id='d'+crypto.createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0,20);definitions[id]??=s;return {$ref:'#/$defs/'+id};}
function resolve(s){return s?.$ref?definitions[s.$ref.slice(8)]:s;}
function schemaFor(row,x,output,p,ignoreArray=false){
 const type=x.type||'',children=x.elements||[],description=x.desc||'',array=type.endsWith('[]');let s;
 if(array&&!ignoreArray){s={type:'array',maxItems:1000,items:schemaFor(row,{...x,type:type.slice(0,-2),desc:''},output,p,true)};if(!output&&row.apiMulti===1)s['x-jd-csv']=true;}
 else if(type==='String'||type==='Date')s={type:'string',maxLength:65536};
 else if(type==='Number')s={anyOf:[{type:'number'},{type:'string',pattern:numericPattern,maxLength:128}],'x-jd-number':true};
 else if(type==='Boolean')s=output?{anyOf:[{type:'boolean'},{type:'string',enum:['true','false']}]}:{type:'boolean'};
 else if(collection(type)){
  if(children.length!==1){if(output&&children.length)s={type:'array',items:objectSchema(row,children,true,p+'.*')};else {issues.push({id:row.id,path:p,issue:'collection item schema is not singular'});return {};}}
  else {let child=children[0];if(child.type?.endsWith('[]'))child={...child,type:child.type.slice(0,-2)};s={type:'array',maxItems:1000,items:schemaFor(row,child,output,p+'.*',true)};}
 }
 else if(children.length){
  if(type==='java.util.Map'&&children.length===2&&children[0].webPamer==='key'&&children[1].webPamer==='value')s={type:'object',maxProperties:100,additionalProperties:schemaFor(row,children[1],output,p+'.*')};
  else s=objectSchema(row,children,output,p);
 }else if(output)s={};
 else {issues.push({id:row.id,path:p,issue:'unexpanded input object'});s={type:'object',properties:{},additionalProperties:false};}
 if(description)s={...s,description};
 if(!output&&['pageSize','page_size','pageNumSize','page_size_value'].includes(x.webPamer)&&type==='Number')s={type:'integer',minimum:1,maximum:100,default:20,description};
 return s;
}
function objectSchema(row,xs,output,parent=''){
 const properties={},required=[],groups=new Map();
 for(const x of xs){
  const p=(parent?parent+'.':'')+x.webPamer;
  if(!output&&(!visible(x)||Object.hasOwn(row.owned,p)||Object.hasOwn(row.fixed,p)||row.omitted.includes(p)))continue;
  let s=schemaFor(row,x,output,p);if(!output&&s.type==='object'&&!Object.keys(s.properties||{}).length&&!s.additionalProperties)continue;
  properties[x.webPamer]=s;
  if(!output&&x.aliasWebPamer){const list=groups.get(x.aliasWebPamer)||[];list.push(x);groups.set(x.aliasWebPamer,list);}
  else if(!output&&x.required)required.push(x.webPamer);
 }
 const allOf=[];
 for(const variants of groups.values()){
  if(variants.length>1){if(variants.some(x=>x.required))allOf.push({anyOf:variants.map(x=>({required:[x.webPamer]}))});}
  else if(variants[0].required)required.push(variants[0].webPamer);
 }
 return {type:'object',properties,additionalProperties:output,...(required.length?{required}:{}),...(allOf.length?{allOf}:{})};
}
function flatFields(row,xs,parent='',out=[]){
 for(const x of xs){if(!visible(x))continue;const p=(parent?parent+'.':'')+x.webPamer;
  if(Object.hasOwn(row.owned,p)||Object.hasOwn(row.fixed,p)||row.omitted.includes(p))continue;
  if(x.elements?.length&&!scalar(x.type)&&!x.type?.endsWith('[]'))flatFields(row,x.elements,p,out);
  else out.push({...x,_sourcePath:p});
 }return out;
}
function pathFor(row,p){return row.apiMulti===1?[p.split('.').at(-1)]:p.split('.');}
function allSchemaPaths(s,p=[],out=[]){s=resolve(s);if(!s)return out;for(const[k,v]of Object.entries(s.properties||{})){out.push({path:[...p,k],schema:resolve(v)});allSchemaPaths(v,[...p,k],out);}if(s.items)allSchemaPaths(s.items,[...p,'*'],out);return out;}
function closure(root){const found=new Set();function walk(v){if(!v||typeof v!=='object')return;if(v.$ref){const k=v.$ref.slice(8);if(!found.has(k)){found.add(k);walk(definitions[k]);}}for(const[k,c]of Object.entries(v))if(k!=='$ref')walk(c);}walk(root);return [...found].sort();}
function dedup(s){if(!s||typeof s!=='object')return s;if(Array.isArray(s))return s.map(dedup);const v=Object.fromEntries(Object.entries(s).map(([k,x])=>[k,k==='properties'?Object.fromEntries(Object.entries(x).map(([n,t])=>[n,dedup(t)])):dedup(x)]));return v.type==='object'&&Object.keys(v.properties||{}).length>2?intern(v):v;}
for(const row of evidence.source_contracts){
 if([17926,19306].includes(row.id)){issues.push({id:row.id,issue:'Official write acknowledgement lacks a complete reliable success protocol or typed receipt'});continue;}
 const start=issues.length,fields=row.apiMulti===1?flatFields(row,row.input):row.input;
 if(row.apiMulti===1&&new Set(fields.map(x=>x.webPamer)).size!==fields.length)issues.push({id:row.id,issue:'flattened parameter collision'});
 const input=objectSchema({...row,owned:row.apiMulti===1?{}:row.owned,fixed:row.apiMulti===1?{}:row.fixed,omitted:row.apiMulti===1?[]:row.omitted},fields,false);
 const response=objectSchema(row,row.output,true);
 function fieldAt(p){let xs=row.input,v;for(const k of p.split('.')){v=xs.find(x=>x.webPamer===k);xs=v?.elements||[];}return v;}
 const owned=Object.entries(row.owned).map(([p,value])=>({path:pathFor(row,p),value,type:fieldAt(p)?.type}));const fixed=Object.entries(row.fixed).map(([p,value])=>({path:pathFor(row,p),value,type:fieldAt(p)?.type}));
 for(const v of [...owned,...fixed])if(!v.type)issues.push({id:row.id,issue:'Reviewed binding path absent from official schema',path:v.path});
 // Explicit field limits from the cited operation descriptions.
 for(const k of ['pageSize','page_size'])if(input.properties[k]&&[13568,13315,13305,13151].includes(row.id))input.properties[k]={type:'integer',minimum:1,maximum:50,default:20};
 if(row.id===13151)input.properties.pageIndex={type:'integer',minimum:1,maximum:100,default:1};
 if(row.id===21234){input.required=['req'];input.properties.req.properties.skuStocks.maxItems=30;input.properties.req.properties.skuStocks.minItems=1;input.properties.req.properties.updateModel.enum=['fullStockIn','incrStockIn'];input.properties.req.properties.stockRfId.minLength=1;}
 if([13327].includes(row.id))input.required=[...new Set([...(input.required||[]),'wareId'])];
 const paths=allSchemaPaths(response),success=paths.filter(v=>['success','isSuccess','is_success'].includes(v.path.at(-1))&&(v.schema.type==='boolean'||v.schema.anyOf?.some(x=>x.type==='boolean'))).map(v=>v.path);
 if([19406,16610,16611,16612].includes(row.id))success.push(['returnType','result']);
 if(row.id===14990)success.push(['jsfResult','result']);
 if([14683,16723].includes(row.id))success.push(['returnType']);
 if(row.id===14343)success.push(['re_apply_result']);
 const diagnostics=paths.filter(v=>['errorMessage','errorMsg','errMsg','errorDesc','errorDescribe','chineseErrCode','englishErrCode','resultDescribe'].includes(v.path.at(-1))).map(v=>v.path);
 // Result-wrapper message fields are protocol diagnostics; nested business message fields remain intact.
 for(const v of paths)if(v.path.length<=2&&['msg','message'].includes(v.path.at(-1))&&paths.some(t=>JSON.stringify(t.path.slice(0,-1))===JSON.stringify(v.path.slice(0,-1))&&['success','code','errorCode'].includes(t.path.at(-1))))diagnostics.push(v.path);
 const codeChecks=[];
 for(const v of paths){if(v.path.includes('*')||v.path.length>2)continue;const d=v.schema.description||'';if(['code','errorCode','statusCode'].includes(v.path.at(-1))){const m=d.match(/(200|1000|1|0)\s*(?:为|表示|代表|：|:)\s*成功/);if(m)codeChecks.push({path:v.path,accepted:[m[1]]});}}
 if(row.id===14128)codeChecks.push({path:['returnResult','errorCode'],accepted:['1']});
 const explicitCodes={12998:['map.resultCode','200'],15088:['map.resultCode','200'],21035:['materialResult.code','200'],21532:['returnType.code','200'],21574:['returnType.code','200'],14990:['jsfResult.code','200'],16610:['returnType.code','200'],16611:['returnType.code','200'],16612:['returnType.code','200'],19408:['returnType.code','200'],12580:['msg_new.return_code','1'],12603:['msg.return_code','1','2'],12625:['msg1.return_code','1'],12630:['msg_new.return_code','1'],21141:['response.statusCode','1000'],21143:['response.statusCode','1000']};
 if(explicitCodes[row.id]){const [p,...accepted]=explicitCodes[row.id];codeChecks.push({path:p.split('.'),accepted});}
 if(row.id===21234)diagnostics.push(['returnType','obj','updateStockResult','*','message']);
 for(const id of [12580,12603,12625,12630])if(row.id===id)diagnostics.push([row.id===12603?'msg':row.id===12625?'msg1':'msg_new','desc']);
 const async=[12886,14128,19406,21579].includes(row.id);
 if(issues.length!==start)continue;
 const name='api.'+row.name;
 function nullable(v,root=false){if(!v||typeof v!=='object')return v;let out={...v};if(v.properties)out.properties=Object.fromEntries(Object.entries(v.properties).map(([k,s])=>[k,nullable(s)]));if(v.items)out.items=nullable(v.items);return root?out:{anyOf:[out,{type:'null'}]};}
 const inSchema=dedup(input),outSchema=dedup(nullable(response,true));
 methods[name]={action:name,name:row.name,id:row.id,risk:row.risk,description:row.description+' Requires the corresponding JOS application permission package and current bound POP seller grant; eligibility is decided by JD.',auth:String(row.auth)==='true',version:row.version||'2.0',wrapper:row.wrapper,input_schema:inSchema,response_schema:outSchema,input_definitions:closure(inSchema),response_definitions:closure(outSchema),owned,fixed,success,code_checks:codeChecks,diagnostics,async,receipt_mode:row.id===21234?'failed_items_only':null,root_keys:Object.keys(response.properties),failure_paths:({21035:[['materialResult','data','failIds']],14334:[['relative_results','*','fail_sku_ids']],14347:[['del_relative_results','*','failSkuIds']],19288:[['unRelativeResult','failSkuIds']]}[row.id]||[]),resource_checks:row.output.filter(x=>x.elements?.length).map(x=>({path:[x.webPamer],keys:x.elements.map(y=>y.webPamer).filter(k=>!['success','isSuccess','is_success','code','errorCode','errorMsg','errorMessage','msg','message','requestId','request_id','traceId','statusCode','statusMessage','resultDescribe','resultCode','chineseErrCode','englishErrCode','desc'].includes(k))})).filter(x=>x.keys.length),source:row.url};
}
fs.writeFileSync(outputPath,"'use strict';\n// Generated offline from pinned official JOS metadata; do not edit.\nmodule.exports="+JSON.stringify({methods,definitions})+';\n');
console.log(JSON.stringify({methods:Object.keys(methods).length,definitions:Object.keys(definitions).length,issues,sha256:crypto.createHash('sha256').update(fs.readFileSync(outputPath)).digest('hex')}));
