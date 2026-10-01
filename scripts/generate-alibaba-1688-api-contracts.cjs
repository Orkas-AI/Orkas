'use strict';
// Reproduce from pinned, anonymously accessible official API/model metadata.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const evidence=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../test/fixtures/connectors/official-contracts/alibaba-1688-20261001.json'),'utf8'));
const included=new Set(evidence.supported_methods),definitions={},methods={},models=new Map(evidence.model_index.map(r=>[JSON.stringify(r.key),r.data]));
const risks={
 'alibaba.userDefine.category.add':'H','alibaba.product.delete':'D','alibaba.product.expire':'H','alibaba.product.modifyStock':'H',
 'alibaba.photobank.album.modify':'H','alibaba.photobank.photo.modify':'H','alibaba.photobank.album.add':'H','alibaba.photobank.album.delete':'D',
 'alibaba.photobank.photo.delete':'D','alibaba.photobank.photo.deleteBatch':'D','alibaba.logistics.OpDeliverySendOrder.offline':'H',
 'alibaba.logistics.OpDeliverySendOrder.dummy':'H','alibaba.logistics.officialPickup':'H','alibaba.trade.cancel':'D','alibaba.light.enroll.record.batch.insert':'H',
};
const receipts={
 'alibaba.product.list.get':['result','pageResult','resultList'],
 'alibaba.product.getByStatus':['result','pageResult','resultList'],
 'alibaba.trade.refund.queryOrderRefundList':['result','opOrderRefundModels'],
};
const pages={pageSize:100,size:100};
const pageCaps={'alibaba.product.list.get':20,'alibaba.photobank.photo.getList':30,'alibaba.trade.ec.getOrderList.sellerView':20,'alibaba.trade.getSellerOrderList':20,'alibaba.enroll.records.list':20};
function field(a,kind,f){
 const t=f.type,arr=t.endsWith('[]');let s;
 if(arr){s={type:'array',maxItems:kind===1?(f.name==='enrollOffers'?10:100):10000,items:field(a,kind,{...f,type:t.slice(0,-2),typeName:f.typeName?.replace(/\[\]$/,'')})};}
 else if(t.startsWith('message:')){
  const key=JSON.stringify([a.namespace,a.name,a.version,kind,f.typeName||t.slice(8)]),id='d'+crypto.createHash('sha256').update(key).digest('hex').slice(0,20);
  if(!definitions[id]){const fields=models.get(key);if(!fields)throw new Error('Missing official model '+key);definitions[id]={};definitions[id]=object(a,kind,fields);}
  s={$ref:'#/$defs/'+id};
 }else if(['Long','long','java.lang.Long'].includes(t)){s={anyOf:[{type:'integer',minimum:-Number.MAX_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER},{type:'string',pattern:'^-?(?:0|[1-9][0-9]{0,18})$'}],'x-1688-long':true};}
 else if(['Integer','int','java.lang.Integer'].includes(t)){s={type:'integer',minimum:-2147483648,maximum:2147483647};}
 else if(['Boolean','boolean','java.lang.Boolean'].includes(t))s={type:'boolean'};
 else if(['Double','double','java.lang.Double','BigDecimal','java.math.BigDecimal'].includes(t))s={type:'number'};
 else if(['Date','java.util.Date'].includes(t))s=kind===1?{type:'string',pattern:'^[0-9]{17}[+-][0-9]{4}$'}:{type:['string','number']};
 else if(['String','java.lang.String'].includes(t))s={type:'string',maxLength:kind===1?100000:1048576};
 else if(t==='java.util.Map'&&kind===2)s={type:'object',additionalProperties:true};
 else if(t==='java.util.List'&&kind===2)s={type:'array',items:{},maxItems:10000};
 else throw new Error('Unreviewed official type '+t+' '+a.name+' '+f.name);
 if(kind===1&&s.type==='integer'&&Object.hasOwn(pages,f.name)){s.minimum=1;s.maximum=f.name==='pageSize'?(pageCaps[a.name]||100):pages[f.name];}
 if(kind===1&&['pageNo','page','index','currentPageNum'].includes(f.name)&&s.type==='integer'){s.minimum=['index','currentPageNum'].includes(f.name)?0:1;s.maximum=100000;}
 if(kind===1&&['webSite','scene'].includes(f.name))s={type:'string',const:'1688'};
 return {...s,...(f.description?{description:f.description}:{}),'x-official-required':Boolean(f.required),...(f.defaultValue!==null&&f.defaultValue!==undefined?{'x-official-default':f.defaultValue}:{})};
}
function object(a,kind,fields){return {type:'object',properties:Object.fromEntries(fields.map(f=>[f.name,field(a,kind,f)])),...(kind===1?{required:fields.filter(f=>f.required&&f.defaultValue===null).map(f=>f.name)}:{}),additionalProperties:kind!==1};}
function reachable(s){const found=new Set();function walk(v){if(!v||typeof v!=='object')return;if(v.$ref){const id=v.$ref.slice(8);if(found.has(id))return;found.add(id);walk(definitions[id]);}Object.values(v).forEach(walk);}walk(s);return [...found].sort();}
for(const record of evidence.source_index){const a=record.data;if(!a||!included.has(a.name))continue;
 const input=object(a,1,a.apiAppParamVOList),output=object(a,2,a.apiReturnParamVOList),owned={};
 for(const key of ['webSite','scene'])if(input.properties[key]){owned[key]='1688';delete input.properties[key];input.required=input.required.filter(v=>v!==key);}
 const action='api.'+a.namespace+'.'+a.name+'.v'+a.version;
 const ack=a.apiReturnParamVOList.filter(f=>!['errorCode','errorMessage','errorMsg','errCode','errMsg','extErrorMessage','message','code','reason','success','succes','isSuccess','retCodes','totalRecords','totalRecord','count','currentPage','pageSize','pageIndex','sizePerPage'].includes(f.name)).map(f=>f.name);
 const requirements=(a.bizSolutionDTOList||[]).map(v=>({key:v.bizKey,name:v.name}));
 methods[action]={action,namespace:a.namespace,name:a.name,version:a.version,risk:risks[a.name]||'R',description:a.displayName+'. '+a.description+' Uses the bound 1688 seller grant; the application must hold a listed official solution permission. '+requirements.map(v=>v.name).join('; '),requirements,owned,input_schema:input,input_definitions:reachable(input),response_schema:output,response_definitions:reachable(output),ack_keys:ack,diagnostic_keys:a.apiReturnParamVOList.filter(f=>['errorMessage','errorMsg','errMsg','extErrorMessage','reason'].includes(f.name)||f.name==='message'&&a.name!=='alibaba.product.getByIdList').map(f=>f.name),receipt_path:receipts[a.name]||null,need_auth:a.needAuth,source:record.url};
}
const result={provider:'alibaba_1688',source_date:'2026-10-01',definitions,methods};
const out=process.argv[2]||path.resolve(__dirname,'../bin/alibaba-1688-api-contracts.cjs');fs.writeFileSync(out,"'use strict';\n// Generated from pinned official 1688 metadata. Do not edit.\nmodule.exports="+JSON.stringify(result)+';\n');
console.log(JSON.stringify({methods:Object.keys(methods).length,definitions:Object.keys(definitions).length,sha256:crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex')}));
