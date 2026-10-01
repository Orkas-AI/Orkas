'use strict';
const fs=require('node:fs'),path=require('node:path');
const evidence=JSON.parse(fs.readFileSync(path.join(__dirname,'../test/fixtures/connectors/official-contracts/kuaishou-20261001.json'),'utf8'));
const plain=s=>String(s||'').replace(/<[^>]+>/g,' ').replace(/\[([^@\]]+)@[^\]]+\]/g,'$1').replace(/\s+/g,' ').trim();
const cap=r=>({R:100,W:25,H:10,D:10}[r.risk]);
function schema(rows,row,input){const defs={},building=new Set();
 function fields(items){const properties={},required=[];for(const f of items){const name=f.paramName;if(!name)throw Error('Unnamed field '+row.action);const s=field(f);if(properties[name]){if(JSON.stringify({...s,description:undefined})!==JSON.stringify({...properties[name],description:undefined}))throw Error('Conflicting field '+row.action+' '+name);properties[name].description=[properties[name].description,s.description].filter(Boolean).join(' ');}else properties[name]=s;if(input&&f.required===true&&!required.includes(name))required.push(name);}const lists=Object.entries(properties).filter(([,v])=>v.type==='array').map(([k])=>k),paged=Object.keys(properties).some(k=>['cursor','pcursor','total','totalCount','pageCount','pageSize','currentPageItemCount','currentPageNumber','skuCount'].includes(k));return {type:'object',properties,...(input?{additionalProperties:false,required}:{additionalProperties:true,...(paged&&lists.length?{'x-pageLists':lists}:{})})};}
 function structure(id){const key='S'+id;if(!defs[key]&&!building.has(key)){building.add(key);const d=evidence.structures[String(id)]?.official;if(!d)throw Error('Missing structure '+id+' for '+row.action);defs[key]=fields(d.params||[]);if(!input&&Number(id)===31786){defs[key].properties.code['x-successValues']=['1'];defs[key].properties.msg['x-diagnostic']=true;}building.delete(key);}return {$ref:'#/$defs/'+key};}
 function field(f){const t=String(f.paramType||'').trim(),description=plain(f.description);let s;
 const list=/^(?:List|Set)<(.+)>$/.exec(t),array=t.endsWith('[]');
 if(list||array){s={type:'array',items:field({...f,paramType:list?list[1]:t.slice(0,-2),description:'',required:false})};if(input){s.maxItems=cap(row);const m=/(?:最多(?:支持)?(?:上传|传入|传|定义)*|最大(?:支持)?|不(?:得)?超过)\s*(\d+)\s*(?:个|条|张|笔|项|组)/.exec(description);if(m)s.maxItems=Math.min(s.maxItems,Number(m[1]));const strict=/(?:请求个数|数量)小于\s*(\d+)/.exec(description);if(strict)s.maxItems=Math.min(s.maxItems,Number(strict[1])-1);if(description.includes('最多三组'))s.maxItems=Math.min(s.maxItems,3);if(/(?:最少|至少)(?:上传)?\s*1\s*张/.test(description)||/0\s*<\s*数量/.test(description))s.minItems=1;}}
 else if(f.structureId)s=structure(f.structureId);
 else if(t==='String')s={type:'string',...(input?{maxLength:262144}:{})};
 else if(t==='Long')s={anyOf:[{type:'integer',minimum:Number.MIN_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER},{type:'string',pattern:'^-?(0|[1-9][0-9]{0,18})$'}],'x-integer':'int64'};
 else if(['Integer','Int','int'].includes(t))s={type:'integer',minimum:-2147483648,maximum:2147483647};
 else if(t==='Short')s={type:'integer',minimum:-32768,maximum:32767};
 else if(['Double','Float'].includes(t))s={type:'number'};
 else if(t==='Number')s={anyOf:[{type:'number',minimum:Number.MIN_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER},{type:'string',pattern:'^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$',maxLength:128}],'x-number':true};
 else if(t==='Boolean')s={type:'boolean'};
 else if(t==='Map'||t==='Object')s={type:'object',additionalProperties:true,...(input?{maxProperties:cap(row)}:{})};
 else throw Error('Unresolved type '+t+' '+row.action+' '+f.paramName);
 if(description)s.description=description;
 if(input){
  if(['pageSize','page_size','limit'].includes(f.paramName)&&['Long','Integer','Number'].includes(t)){
   const m=/(?:最多(?:一页)?|最大(?:值)?[为是：:]?|上限[为是：:]?|不超过|范围.*?[-~～,，])\s*(\d+)/.exec(description),maximum=Math.min(100,m?Number(m[1]):100),minimum=row.action==='open.item.list.get'&&f.paramName==='pageSize'?10:1;
   if(maximum>0)s={type:'integer',minimum,maximum,default:Math.min(maximum,20),'x-pageMax':maximum,description};
  }
  const range=/(\d+)\s*<=\s*数值\s*<=\s*(\d+)/.exec(description),floor=/(\d+)\s*<=\s*数值/.exec(description),max=/最大值\s*(\d+)/.exec(description),min=/最小值\s*(\d+)/.exec(description);
  if(['Long','Integer','Number'].includes(t)){if(range){s['x-minimum']=range[1];s['x-maximum']=range[2];}else if(floor)s['x-minimum']=floor[1];if(max)s['x-maximum']=max[1];if(min)s['x-minimum']=min[1];}
  if(row.action==='open.item.sku.stock.update'&&f.paramName==='skuChangeStock'){s['x-exclusiveMinimum']='0';s['x-exclusiveMaximum']='9999999';}
  if(row.action==='open.item.sku.stock.update'&&f.paramName==='changeType')s.enum=[1,2,'1','2'];
  if(row.action==='open.item.shelf.status.update'&&f.paramName==='shelfStatus')s.enum=[0,1];
  if(row.action==='open.item.brand.list.get'&&f.paramName==='cursor')s.maximum=2000;
  if(f.paramName==='addPackageQuantity'||f.paramName==='totalPackageQuantity'){s['x-minimum']='1';s['x-maximum']='10';}
  if(f.paramName==='payWay'&&description.includes('只支持「在线支付」'))s.enum=[2];
  if(f.paramName==='note'&&description.includes('字符数<=200'))s.maxLength=200;
  if(f.id===8431672){s['x-exclusiveMinimum']='0';s['x-maximum']='100';s['x-decimalPlaces']=2;}
  if(f.paramName==='sellerId'&&/商家|卖家编号/.test(description))s['x-binding']='shop_id';
  if(f.paramName==='openId'&&/商家.*唯一标识/.test(description))s['x-binding']='open_id';
 }else{
  if(f.id===1856&&(list||array))s={anyOf:[s,{type:'string',const:'无'}],description};
  if(f.id===8431672)s={anyOf:[s,{type:'string',pattern:'^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$'}],description};
  if(f.id===1390201&&(list||array))s.items={anyOf:[s.items,{type:'integer'}]};
  if(f.id===7193519&&(list||array))s={anyOf:[s,s.items],description};
  if(row.action==='open.item.qualification.collection.config'&&f.paramName==='data'&&(list||array))s={anyOf:[s,s.items],description};
  // Only official transport/batch result fields; InputFormatConfig.message (3978) is business validation copy.
  if([121322,139549,139574,139599,139622,1328602,2541816,8176048,8276456].includes(Number(f.id)))s['x-diagnostic']=true;
  if(/(?:fail|error)/i.test(f.paramName)&&['array','object'].includes(s.type)&&/失败|错误/.test(description))s['x-failureCollection']=true;
  if(/fail/i.test(f.paramName)&&/失败.*数量|失败次数/.test(description))s['x-failureCount']=true;
  if(t==='Boolean'&&(/是否.*成功|成功标识|是否成功/.test(description)||row.risk!=='R'&&f.paramName==='result'&&/更新结果|返回结果/.test(description)))s['x-resultBoolean']=true;
  if(/^(?:code|errorCode|errCode|resultCode)$/.test(f.paramName)){if(/(?:0\s*[-:：]?\s*成功|0表示成功)/.test(description))s['x-successValues']=['0'];if(/(?:1\s*[-:：]?\s*成功|1表示成功)/.test(description))s['x-successValues']=['1'];}
 }
 return s;
 }
 const root=fields(rows);if(Object.keys(defs).length)root.$defs=defs;return root;
}
const methods={};for(const row of evidence.inventory){const d=row.official,input=schema(d.inputParams,row,true),output=schema(d.outputParams,row,false);input.description=plain(d.description)+'\nRequired existing authorization scope (one of): '+d.permissionScope+'\nSource: '+row.source.url;methods[row.action]={action:row.action,method:d.method===1?'GET':d.method===2?'POST':null,path:'/'+row.action.replaceAll('.','/'),version:String(d.version),risk:row.risk,description:d.cnName,scopes:d.permissionScope.split(','),input_schema:input,output_schema:output};if(!methods[row.action].method)throw Error('Unsupported HTTP method');}
fs.writeFileSync(process.argv[2]||path.join(__dirname,'../bin/kuaishou-api-contracts.cjs'),"'use strict';\n// Generated from pinned official Kuaishou documentation, 2026-10-01.\nmodule.exports = "+JSON.stringify({methods},null,2)+';\n');console.log('Generated '+Object.keys(methods).length+' Kuaishou merchant contracts');
