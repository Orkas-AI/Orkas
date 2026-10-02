'use strict';
// Offline generation from pinned official Douyin structured documentation.
const fs=require('node:fs'),path=require('node:path');
const evidence=JSON.parse(fs.readFileSync(path.join(__dirname,'../test/fixtures/connectors/official-contracts/douyin-20261001.json'),'utf8'));
const plain=s=>String(s||'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
function merge(a,b,label){if(a.type!==b.type)throw Error('Conflicting duplicate '+label);if(a.properties){for(const [k,v]of Object.entries(b.properties))a.properties[k]=a.properties[k]?merge(a.properties[k],v,label+'.'+k):v;}else if(a.items)a.items=merge(a.items,b.items,label+'[]');else if(JSON.stringify({...a,description:''})!==JSON.stringify({...b,description:''}))throw Error('Conflicting scalar '+label);if(b.description&&a.description!==b.description)a.description=(a.description||'')+' '+b.description;return a;}
function fields(rows,row,input,trail=[]){const properties={},required=[];for(const f of rows){if(input&&(f.isHidden||f.mustNeed!==true&&/(?:已废弃|已下线)/.test(f.description||'')))continue;const name=input?f.requestName:f.responseName;if(!name)throw Error('Missing name '+row.action);const s=field(f,row,input,[...trail,name]);properties[name]=properties[name]?merge(properties[name],s,row.action+' '+trail.join('.')+'.'+name):s;if(input&&f.mustNeed===true&&!required.includes(name))required.push(name);}return {type:'object',properties,...(input?{required,additionalProperties:false}:{additionalProperties:true})};}
function field(f,row,input,trail){let t=f.type;const desc=plain(f.description),name=trail.at(-1);if(t===0){const map={3:2,4:2,6:row.action==='product.detail'?2:1,7:row.action==='afterSale.Detail'?2:1,12:1,31:2,40:1};if(!map[f.timeConvert])throw Error('Unverified special type '+row.action+' '+trail.join('.'));t=map[f.timeConvert];}
 let s;if(t===2)s={type:'string',...(input?{maxLength:262144}:{})};
 else if(t===1)s={anyOf:[{type:'integer',minimum:Number.MIN_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER},{type:'string',pattern:'^-?(0|[1-9][0-9]{0,18})$'}],'x-integer':'int64'};
 else if(t===6||t===7)s={type:'integer',minimum:t===6?-32768:-2147483648,maximum:t===6?32767:2147483647};
 else if(t===9)s={type:'number'};
 else if(t===99)s={anyOf:[{type:'number',minimum:Number.MIN_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER},{type:'string',pattern:'^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$',maxLength:128}],'x-number':true};
 else if(t===4)s={type:'boolean'};
 else if(t===5||t===11)s=fields(f.children||[],row,input,trail);
 else if(t===3){if(!f.subType)throw Error('Missing array subtype '+row.action+' '+trail.join('.'));s={type:'array',items:field({...f,type:f.subType,description:'',example:undefined},row,input,trail)};if(input){s.maxItems={R:100,W:25,H:10,D:10}[row.risk];const m=/(?:最多(?:支持)?(?:传入|传)?|最大(?:支持)?|上限[为是]?|不(?:得)?超过)\s*(\d+)\s*(?:个|条|张|笔|项)/.exec(desc);if(m)s.maxItems=Math.min(s.maxItems,Number(m[1]));}}
 else if(t===8){if(!f.mapKeyType||!f.mapValueType)throw Error('Missing map type '+row.action+' '+trail.join('.'));s={type:'object',additionalProperties:field({...f,type:f.mapValueType,subType:f.mapValueSubType,description:''},row,input,trail)};if(input){s.maxProperties={R:100,W:25,H:10,D:10}[row.risk];if([1,6,7,99].includes(f.mapKeyType))s.propertyNames={pattern:'^-?(0|[1-9][0-9]*)$'};}}
 else throw Error('Unknown type '+t+' '+row.action+' '+trail.join('.'));
 if(desc)s.description=desc;
 if(!input){
  if(/(?:fail|err_infos)/i.test(name)&&['array','object'].includes(s.type)&&/失败|错误/.test(desc))s['x-failureCollection']=true;
  if(/fail/i.test(name)&&/失败.*数量|失败次数/.test(desc))s['x-failureCount']=true;
  if(s.type==='boolean'&&/是否.*成功|标识请求是否成功/.test(desc))s['x-resultBoolean']=true;
  if(/^(?:status_code|err_code|error_code|ErrCode|err_no)$/.test(name))s['x-successValues']=['0'];
  if(name==='code'&&/(?:0(?:表示|为|:|：|： )成功|0\s*[:：-]\s*成功)/.test(desc))s['x-successValues']=['0'];
  if(name==='code'&&/100000.*成功/.test(desc))s['x-successValues']=['100000'];
  const special={'alliance.getOrderList':'100000','crossBorder.UpdateProductRecord':'0','crossBorder.GetProductRecordBasicOptions':'0'};
  if(trail.length===1&&name==='code'&&special[row.action])s['x-successValues']=[special[row.action]];
  if(row.action==='order.PackageProcessFail'&&name==='ret_code')s['x-successValues']=['0'];
 }
 if(input){
  if(s.type==='object'&&s.additionalProperties===false&&Object.keys(s.properties).length===0)throw Error('Unspecified public object '+row.action+' '+trail.join('.'));
  if(['page_size','pageSize','size','limit'].includes(name)&&[1,6,7,99].includes(t)){
   const m=/(?:最大(?:值)?[为是：:]?|上限[为是：:]?|不超过|范围.*?[-~～,，])\s*(\d+)/.exec(desc),cap=Math.min(100,m?Number(m[1]):100);
   if(cap>0)s={type:'integer',minimum:1,maximum:cap,default:Math.min(50,cap),'x-pageMax':cap,...(desc?{description:desc}:{})};
  }
  if(s.type==='string'&&/(?:逗号|分号|分隔)/.test(desc)&&/(?:_ids|_list)$/.test(name)){s['x-separatedMax']={R:100,W:25,H:10,D:10}[row.risk];s['x-separator']=/分号|;/.test(desc)?';':',';}
  if(row.action==='promise.SaveTemplate'&&trail.join('.')==='template_info.c_shop_id')s={...s,const:0};
  if(row.action==='open.getAuthInfo'&&name==='auth_subject_type')s={type:'string',enum:['shop'],description:'Existing bound Shop authorization only.'};
 }
 return s;
}
const methods={};for(const row of evidence.inventory){const input=fields(row.request,row,true),data=fields(row.response,row,false);input.description=[plain(row.description),row.eligibility,'Source: '+row.source_url].join('\n');const output={type:'object',properties:{code:{type:'integer'},err_no:{type:'integer'},msg:{type:'string'},message:{type:'string'},sub_code:{type:'string'},sub_msg:{type:'string'},log_id:{type:'string'},data},additionalProperties:true};methods[row.action]={path:row.path,method:row.action,risk:row.risk,description:row.path.slice(1).replaceAll('/',' · '),input_schema:input,output_schema:output};}
fs.writeFileSync(process.argv[2]||path.join(__dirname,'../bin/douyin-api-contracts.cjs'),"'use strict';\n// Generated from pinned official Douyin API guide, 2026-10-01.\nmodule.exports = "+JSON.stringify({methods},null,2)+';\n');console.log('Generated '+Object.keys(methods).length+' Douyin native contracts');
