#!/usr/bin/env node
'use strict';
// Reproduce from the public WOS 2.0 directory snapshot and pinned official SDK.
// node scripts/generate-weimob-api-contracts.cjs SOURCE_DIR SDK_DIR OUTPUT_FILE EVIDENCE_FILE
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const args=process.argv.slice(2), frozen=!args.length||args[0]==='--snapshot';
const [dir,sdkDir,out=path.resolve(__dirname,'../bin/weimob-api-contracts.cjs'),audit]=frozen?[undefined,undefined,args[2],undefined]:args;
const snapshot=frozen?JSON.parse(fs.readFileSync(args[1]||path.resolve(__dirname,'../test/fixtures/connectors/official-contracts/weimob-generator-input.json'),'utf8')):null;
const sha=s=>crypto.createHash('sha256').update(s).digest('hex'),raw=snapshot?null:fs.readFileSync(path.join(dir,'index.json')),index=snapshot?{apis:snapshot.apis}:JSON.parse(raw),apis=index.apis.filter(x=>x.apiType===1&&!x.isMessage),sdk=snapshot?snapshot.sdk:{};
const sourceSha=snapshot?snapshot.directory_sha256:sha(raw);
function files(d){return fs.readdirSync(d,{withFileTypes:true}).flatMap(x=>x.isDirectory()?files(path.join(d,x.name)):[path.join(d,x.name)]);}
if(!snapshot)for(const f of files(path.join(sdkDir,'pkg/wapi/wos')).filter(x=>x.endsWith('.go'))){const text=fs.readFileSync(f,'utf8'),m=text.match(/InitWithApiInfo\("([^"]+)", "([^"]+)", "([^"]+)", "([^"]+)"\)/),r=text.match(/func \(client \*Client\) \w+\(request \*(\w+)\).*?response \*(\w+)/);if(!m||!r)continue;const structs={};for(const a of text.matchAll(/type (\w+) struct \{([\s\S]*?)\n\}/g))structs[a[1]]=Object.fromEntries([...a[2].matchAll(/\w+\s+(\[\]\w+|\w+)\s+`json:"([^",]+)(?:,[^"]*)?"`/g)].map(x=>[x[2],x[1]]));function walk(name,p='',seen=[]){if(seen.includes(name))return{};const result={};for(const[k,t]of Object.entries(structs[name]||{})){const q=p+'.'+k;result[q]=t;Object.assign(result,walk(t.replace(/^\[\]/,''),q+(t.startsWith('[]')?'[]':''),[...seen,name]));}return result;}sdk[m[1]+'/'+m[3]]={input:walk(r[1]),output:walk(r[2]),file:path.relative(sdkDir,f),sha256:sha(text)};}
const plain=s=>String(s||'').replace(/<br\s*\/?\s*>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&(?:nbsp|ensp);/g,' ').replace(/&gt;/g,'>').replace(/&lt;/g,'<').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/[\t\r ]+/g,' ').trim();
const excludedNames={
 'wlc_mp/logistics/order/status/update':['additional_identity','Official description requires a logistics ISV receiving delegated merchant deliveries.'],
 'weimob_cs/msg/receive':['integration_dependency','Only apps implementing weimobCs.servicer.msg.send SPI may call this API. No receiver is configured.'],
 'weimob_bi/user/behaviors/new/get':['metered_access','Explicit per-traffic billing API; no metered data service is configured.'],
 'weimob_bi/user/behaviors/original/get':['metered_access','Requires the separately purchased self-service data extraction product and per-traffic commercial policy.'],
 'bos/account/logouturl/get':['owner_session','Merchant console passwordless session integration is outside the existing CC connector.'],
 'bos/wechat/ticket/get':['owner_credentials','Returns a JS-SDK credential; no owner JS-SDK credential workflow exists.'],
 'bos/channel/api/proxy':['downstream_contract_gap','Delegates arbitrary parameters to downstream WeChat APIs. This connector has no typed downstream contract or operation risk dispatch.'],
 'bos/cdc/auth/assign':['authorization_flow_gap','Creates external-store authorization, explicitly cannot revoke it; existing connector binds one WOS merchant.'],
 'bos/mall/channel/data/center/openapi/auth/assign':['authorization_flow_gap','Creates external-store authorization, explicitly cannot revoke it; existing connector binds one WOS merchant.'],
 'weimob_aewc/chatmessage/getList':['availability_dependency','Official current notice requires enterprise WeChat data/intelligence-zone integration; not configured by this CC connector.'],
 'weimob_aewc/chatsession/getList':['availability_dependency','Official current notice requires enterprise WeChat data/intelligence-zone integration; not configured by this CC connector.']
};
const riskOverrides={
 'weimob_shop/order/omni/update':'D','weimob_shop/rights/omni/update':'D','weimob_crm/coupon/template/status/update':'D','bos/employee/status/update':'D',
 'weimob_shop/order/flag/update':'W','weimob_shop/rights/flag/update':'W','weimob_shop/order/item/extattr/update':'W',
 'bos/url/qrcode/get':'H','weimob_guide/process/shareinfo/get':'H',
};
function risk(a){if(riskOverrides[a.apiName])return riskOverrides[a.apiName];const name=a.apiName,title=plain(a.apiRemarkName);if(/删除|取消|作废|注销|撤销|撤回|停用|关闭|解绑/.test(title)||/(?:^|\/)(?:delete\w*|cancel|cancellation|close|unbind|void)(?:\/|$)/i.test(name))return'D';if(/^(查询|获取|检查|校验|验证|搜索|统计|检索)/.test(title)&&!/(生成|创建|绑定|核销|扣减|申请)/.test(title))return'R';if(/(?:get(?:list|byid|useravailablecardlist|config|info|detail)?|search|query|list|check|batchGet|fetchSopStatisticsPage)$/i.test(name)&&!/(create|insert|update|delete|consume|lock|assign)/i.test(name))return'R';return'H';}
for(const n of ['weimob_shop/goods/getListById','weimob_shop/stock/warehouse/getListByVid','weimob_shop/rights/detail/getByOrderNos','bos/user/account/cancellation/list','bos/finance/payment/weixinpay/verify','bos/finance/payment/weixinpay/fundflow/download','weimob_crm/customer/code/decode','weimob_crm/coupon/consume/check','bos/security/isEncrypt','bos/security/encrypt','bos/security/decrypt','weimob_notes/content/getListByScroll'])riskOverrides[n]='R';
const changes=[],gaps=[],methods={},excluded=[];
function parsed(v){if(typeof v!=='string')return v;try{return JSON.parse(v.trim());}catch{return undefined;}}
const num=()=>({'x-number':true,anyOf:[{type:'number'},{type:'string',pattern:'^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$'}]});
const jsonValue=()=>({type:['object','array','string','number','boolean','null']});
function sampleSchema(v){if(v===null)return jsonValue();if(Array.isArray(v))return{type:'array',items:v.length?sampleSchema(v[0]):jsonValue()};if(typeof v==='object')return{type:'object',properties:Object.fromEntries(Object.entries(v).map(([k,x])=>[k,sampleSchema(x)])),additionalProperties:true};if(typeof v==='number')return num();return{type:typeof v};}
const arrayFix={
 'haiding_sop/order/batchGet|input|.flowIds':'string','haiding_sop/onlineorder/search|input|.deliverModes':'string',
 'weimob_shop/promotion/gift/update|input|.giftMarketRuleLevelVOS[].giftMarketGoodsVOS[].skuIds':'number','weimob_shop/promotion/gift/create|input|.giftMarketRuleLevelVOS[].giftMarketGoodsVOS[].skuIds':'number',
 'weimob_crm/coupon/template/basic/update|input|.useRule.acceptTypeDTO.excludeStoreIds':'number',
 'weimob_guide/quest/executeresult/getList|input|.queryParameter.customerWids':'number',
 'haiding_scm/storeskuprice/adjust|input|.storeIds':'string','haiding_scm/purchaseorder/search|input|.statusIn':'string','haiding_scm/purchasereturn/search|input|.statusIn':'string','haiding_scm/purchasereceipt/search|input|.statusIn':'string','haiding_scm/center/stock/getList|input|.ids':'string','haiding_scm/organization/store/search|input|.statusList':'string',
 'weimob_shop/goods/classify/relation/update|input|.classifyIdList':'number','weimob_shop/goods/classify/relation/update|input|.goodsIdList':'number','weimob_shop/rights/list/search|input|.queryParameter.channelTypes':'number'
};
for(const a of apis)if(a.apiName.startsWith('weimob_shop/promotion/'))for(const f of a.param||[])if(['excludeStoreIds','selectStoreIds','excludeSubIds','excludeGoodsIds'].includes(f.name))arrayFix[a.apiName+'|input|.'+f.name]='number';
arrayFix['weimob_guide/guider/extension/getList|input|.queryParameter.guiderWidList']='number';

function fields(rows,a,side,p='',level=0){const props={},required=[];for(const f of rows||[]){const name=f.name.trim(),q=p+'.'+name;if(name!==f.name)changes.push({api:a.apiName,side,path:q,reason:'Trim accidental whitespace in the documented key; SDK confirms normalized JSON key.'});if(props[name])throw Error('Duplicate '+a.apiName+q);props[name]=field(f,a,side,q,level);if(side==='input'&&f.required===true)required.push(name);}return{type:'object',properties:props,additionalProperties:side==='output',...(required.length?{required}:{} )};}
function field(f,a,side,q,level){const input=side==='input',description=plain(f.description),ex=parsed(f.example),children=f.childParam||[],go=sdk[a.apiName]?.[side]?.[side==='output'?q.replace(/^\.data/,''):q],key=a.apiName+'|'+side+'|'+q;let s;
 if(f.type==='number')s=num();else if(f.type==='string'||f.type==='boolean')s={type:f.type};
 else if(f.type==='enum'){const isNumeric=typeof ex==='number'||go&&/int|float/.test(go);s=isNumeric?num():{type:'string'};}
 else if(f.type==='object'){
  if(children.length)s=fields(children,a,side,q,level+1);
  else if(ex!==undefined&&ex!==null&&typeof ex!=='object'){s=sampleSchema(ex);changes.push({api:a.apiName,side,path:q,reason:'Official concrete field example corrects empty object type',example:f.example});}
  else if(Array.isArray(ex)){s={type:'array',items:jsonValue()};if(go?.startsWith('[]'))s.items=/^\[\](?:int|float)/.test(go)?num():go==='[]string'?{type:'string'}:jsonValue();changes.push({api:a.apiName,side,path:q,reason:'Official array example corrects empty object type',example:f.example});}
  else if(!input&&go&&/^(?:int\d*|float\d*|string|bool)$/.test(go)){s={anyOf:[{type:'object',additionalProperties:true},/^(?:int|float)/.test(go)?num():{type:go==='bool'?'boolean':'string'}]};changes.push({api:a.apiName,side,path:q,reason:'Empty object documentation conflicts with pinned official SDK scalar; preserve both official representations',sdk:go});}
  else {s={type:'object',additionalProperties:true};if(ex&&typeof ex==='object')s.properties=sampleSchema(ex).properties;if(input&&!/map|key:|扩展|附加|自定义|业务参数|基础信息/i.test(description))gaps.push({api:a.apiName,side,path:q,reason:'Input object has no field contract',description,example:f.example});}
 } else if(f.type==='array'||f.type==='xArray'){
  let item;if(key==='weimob_shop/order/item/extattr/update|input|.itemRemarks[].customFieldGroup')item={type:'array',maxItems:20,items:{type:'object',properties:{name:{type:'string'},value:{type:'string'}},required:['name','value'],additionalProperties:false}};else if(children.length)item=fields(children,a,side,q+'[]',level+1);
  else if(arrayFix[key]){item=arrayFix[key]==='number'?num():{type:arrayFix[key]};changes.push({api:a.apiName,side,path:q,reason:'Official item example/prose or sibling current contract resolves scalar array type',itemType:arrayFix[key]});}
  else if(Array.isArray(ex)&&ex.length)item=sampleSchema(ex[0]);
  else if(ex!==undefined&&ex!==null&&!Array.isArray(ex))item=sampleSchema(ex);
  else if(go?.startsWith('[]'))item=/^\[\](?:int|float)/.test(go)?num():go==='[]string'?{type:'string'}:go==='[]bool'?{type:'boolean'}:undefined;
  if(!item&&/^https?:/.test(String(f.example)))item={type:'string'};
  if(!item&&String(f.example).startsWith('[')&&/['"“”]|https?:/.test(String(f.example)))item={type:'string'};
  if(!item){if(input)gaps.push({api:a.apiName,side,path:q,reason:'Array item type is not defined',description,example:f.example});item=jsonValue();}
  s={type:'array',items:item};
  if(input){s.maxItems={R:100,W:25,H:10,D:10}[risk(a)];let m=description.match(/(?:最多|最大|上限为?|不能超过|不超过|不得超过|最大支持|最多支持|限制为?)\s*(\d+)\s*(?:个|条|项|张|组|件)/);if(m)s.maxItems=Math.min(s.maxItems,Number(m[1]));if(!s.maxItems)delete s.maxItems;}
 }else throw Error('Unknown type '+f.type);
 if(input&&/^(?:pageSize|page_size|size|pageLimit|limit)$/i.test(f.name)&&/分页|每页|页大小|条数|数量|记录数/.test(description)){const m=description.match(/(?:最大|最多|不能超过|不超过|上限为?)\s*(\d+)/),max=Math.min(100,m?Number(m[1]):100);s={type:'integer',minimum:1,maximum:max,default:Math.min(20,max),'x-pageMax':max};}
 if(input&&f.name==='bosId')s['x-binding']='business_operation_system_id';
 if(input&&a.apiName==='weimob_aewc/staff/getList'&&f.name==='pid')s['x-binding']='public_account_id';
 if(input&&q.endsWith('.useRule.acceptTypeDTO.excludeGoodsIds')&&a.apiName.startsWith('weimob_crm/coupon/template/basic/')){s={type:'array',items:num(),maxItems:10};changes.push({api:a.apiName,side,path:q,reason:'Official empty array example and goods ID semantics correct object table entry; corresponding coupon/template/create documents numeric goods IDs.'});}
 if(input&&['weimob_crm/coupon/receive','weimob_crm/coupon/precoupon/send'].includes(a.apiName)&&q==='.couponNums[].num')s={type:'integer',minimum:1,maximum:10};
 if(key==='weimob_cdp/tag/attribute/update|input|.attValueMap'){s={type:'object',additionalProperties:num(),maxProperties:10};}
 if(key==='weimob_crm/customer/import|input|.userList[].extendInfoList[].value'){s={anyOf:[{type:'string'},{type:'number'}]};changes.push({api:a.apiName,side,path:q,reason:'Official parent extendInfoList example contains both text and numeric birthday values.'});}
 if(key==='weimob_shop/order/detail/get|output|.data.orderInfo.orderFulfill.customFieldInfo[].sort'){s.anyOf.push({type:'null'});changes.push({api:a.apiName,side,path:q,reason:'Official parent customFieldInfo example explicitly returns null.'});}
 if(!input&&children.length&&f.type==='xArray'&&Array.isArray(ex)&&ex.some(v=>v!==null&&typeof v!=='object')){s.items={anyOf:[s.items,sampleSchema(ex.find(v=>v!==null&&typeof v!=='object'))]};changes.push({api:a.apiName,side,path:q,reason:'Current field table defines object items while official example defines scalar IDs; both source representations are preserved.'});}
 if(!input&&children.length&&f.type==='object'&&Array.isArray(ex)){s={anyOf:[s,{type:'array',items:s}]};changes.push({api:a.apiName,side,path:q,reason:'Current table/SDK define object but official field example defines an array; retain both documented representations.'});}
 if(key==='weimob_shop/order/item/extattr/update|input|.itemRemarks[].customFieldGroup')s.maxItems=10;
 if(!input){if(s.type==='boolean'&&/是否成功|操作结果|处理结果|更新接口结果/.test(description))s['x-resultBoolean']=true;if(q==='.data'&&s.type==='boolean'&&/成功|结果|业务返回数据/.test(description))s['x-resultBoolean']=true;if(/^(?:success|result|isSuccess|succeed)$/.test(f.name)&&s.type==='boolean'&&/成功|结果/.test(description))s['x-resultBoolean']=true;if(/^(?:failList|failedList|errorList|failGoodsList|errData)$/.test(f.name)&&/失败|异常|错误/.test(description))s['x-failureCollection']=true;if(/^(?:failCount|failedCount|errorCount|failCnt|errorCnt)$/.test(f.name)&&/失败|异常|错误/.test(description))s['x-failureCount']=true;if(/^(?:errmsg|errMsg|errorMessage|failMessage|errorMsg)$/.test(f.name)&&/失败|异常|错误|返回的信息/.test(description))s['x-diagnostic']=true;}
 if(!input&&/失败原因|失败描述|错误原因|异常信息/.test(description)&&/\.(?:failList|errorList|failMessage|errorMessage|errData)(?:\[\])?(?:\.|$)/.test(q)&&s.type==='string')s['x-diagnostic']=true;
 if(input&&s.type==='object'&&s.properties?.startTime&&s.properties?.endTime&&/跨度不可大于 30 天/.test(description))s['x-timeMaxDays']=30;
 if(description)s.description=description;
 return s;
}
for(const a of apis){if(excludedNames[a.apiName]){excluded.push({api:a.apiName,id:a.id,reason:excludedNames[a.apiName][0],detail:excludedNames[a.apiName][1]});continue;}if(!a.address?.startsWith('https://dopen.weimob.com/apigw/')||a.method!=='POST'||a.isDelete||!a.isShow||a.reviewStatus!==1)throw Error('Invalid public route '+a.apiName);const start=gaps.length,input_schema=fields(a.param,a,'input'),output_schema=fields(a.response,a,'output');if(gaps.length>start){excluded.push({api:a.apiName,id:a.id,reason:'contract_gap',detail:gaps.slice(start)});continue;}const name=a.apiName.replaceAll('/','.');input_schema.description=plain(a.apiDescription)+'\n'+plain(a.note)+'\nPrerequisite: this bound WOS merchant must have the product/module and this self-owned app must have the API capability approved in Weimob. The default token scope does not enumerate API permissions.';methods[name]={action:name,api:a.apiName,id:a.id,risk:risk(a),description:plain(a.apiRemarkName),path:new URL(a.address).pathname,input_schema,output_schema,source:`https://doc.weimobcloud.com/detail?menuId=19&childMenuId=1&tag=${a.categoryIds.split(',')[0]}&id=${a.id}&isold=2`,version:a.version};}
fs.writeFileSync(out,"'use strict';\n// Generated from the pinned public Weimob WOS directory; do not edit by hand.\nmodule.exports="+JSON.stringify({provider:'weimob_wos',source_sha256:sourceSha,methods})+';\n');
if(audit){const evidence={provider:'weimob_wos',as_of:'2026-10-01',source:{directory_sha256:sha(raw),categories:index.pages?.length,entries:index.apis.length,http:apis.length,errors:index.errors,source_dir:dir,sdk_commit:'fb5d1e30cd1330c2801a55c166d43752f21bc359',sdk_methods:Object.keys(sdk).length,scope:'Public WOS 2.0 category tree, every category page including parents; currently reviewed/visible HTTP APIs only.'},counts:{native:Object.keys(methods).length,risk:Object.values(methods).reduce((r,a)=>(r[a.risk]=(r[a.risk]||0)+1,r),{})},authorization:{mode:'existing client_credentials',shop_type:'business_operation_system_id',scope:'default; not a list of granted APIs',permission_guide:'https://doc.weimobcloud.com/word?tag=2521&menuId=53&childMenuId=54&isold=2',production_authorization:'https://doc.weimobcloud.com/word?tag=3693&menuId=53&childMenuId=54&isold=1',binding:'Every explicit bosId must equal the token-bound BOS. vid is an organization within the bound BOS, not the BOS ID.'},excluded:[...excluded,...index.apis.filter(x=>x.apiType===2||x.isMessage).map(a=>({api:a.apiName,id:a.id,reason:a.apiType===2?'spi_receiver_required':'message_receiver_required'}))],field_reconciliations:changes,contracts_sha256:sha(fs.readFileSync(out)),methods:Object.values(methods).map(x=>({api:x.api,id:x.id,risk:x.risk,path:x.path,source:x.source,official:(()=>{const a=apis.find(a=>a.id===x.id);return {param:a.param,response:a.response,apiDescription:a.apiDescription,note:a.note,updatedTime:a.updatedTime,reviewStatus:a.reviewStatus,isShow:a.isShow,version:a.version};})()}))};fs.writeFileSync(audit,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({methods:evidence.counts,excluded:excluded.length,gaps,changes:changes.length,bytes:fs.statSync(out).size},null,2));}
