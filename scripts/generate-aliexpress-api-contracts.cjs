'use strict';
const fs=require('node:fs'),path=require('node:path');
const evidence=require('../test/fixtures/connectors/official-contracts/aliexpress-20261001.json');
const methods={};
const object=()=>({type:'object',properties:{},additionalProperties:false});
const diagnosticMemoMethods=new Set(['aliexpress.trade.redefining.verifycode','aliexpress.trade.redefining.sendcode','aliexpress.trade.redefining.extendsbuyeracceptgoodstime']);
const selectors=new Set(['channel_seller_id','seller_channel_id','channelSellerId','channel']);
const wireLong={anyOf:[{type:'integer',minimum:-Number.MAX_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER},{type:'string',pattern:'^(0|-?[1-9][0-9]*)$',maxLength:20}],description:'Exact signed 64-bit integer. Use a decimal string beyond the JavaScript safe integer range.'};
function field(f,op,p,meta){
 let s;const bound=op.risk==='R'?100:10;let t=f.type;
 if(t==='Object[]'&&f.serviceParamPath==='java.util.List<java.lang.String>')t='String[]';
 if(t.endsWith('[]')){const item={...f,type:t.slice(0,-2),serviceParamPath:(f.serviceParamPath||'').replace(/^java\.util\.List<(.*)>$/,'$1')};s={type:'array',maxItems:Math.min(bound,Number(f.maxListSize)||bound),items:field(item,op,p+'.*',meta)};}
 else if(t==='Object'){
  s=object();
  for(const child of f.children){if(selectors.has(child.name)||op.name==='aliexpress.appraise.redefining.savesellerfeedback'&&child.name==='image_urls')continue;s.properties[child.name]=field(child,op,p+'.'+child.name,meta);if(child.required)(s.required||=[]).push(child.name);}
  if(!f.children.length){
   const maps={sku_stocks:{type:'integer',minimum:0,maximum:2147483647},sku_id_price_map:{type:'string',maxLength:32,pattern:'^(0|[1-9][0-9]*)(\\.[0-9]+)?$'},properties:{type:'array',maxItems:100,items:structuredClone(wireLong)},region_saleable_condition:{type:'boolean'},attributes:{$ref:'#/$defs/jsonValue'}};
   if(f.name==='attributes')meta.jsonValues=true;
   if(maps[f.name]){delete s.properties;s.additionalProperties=maps[f.name];s.maxProperties=bound;s.propertyNames={type:'string',minLength:1,maxLength:256};if(f.name==='properties'){s.propertyNames={type:'string',pattern:'^(0|[1-9][0-9]*)$',maxLength:19};meta.longs.push(p+'.*.*');}}
   else if(f.serviceParamPath?.startsWith('java.util.Map'))throw Error('Unreviewed map: '+op.name+':'+p);
  }
 }
 else if(t==='Number'){
  if(/(?:^|\.)(?:Integer|int|Short|short)$/.test(f.serviceParamPath||''))s={type:'integer',minimum:-2147483648,maximum:2147483647};
  else if(/(?:Double|double|Float|float|BigDecimal)/.test(f.serviceParamPath||''))s={type:'number',minimum:-Number.MAX_VALUE,maximum:Number.MAX_VALUE};
  else{s=structuredClone(wireLong);meta.longs.push(p);}
 }
 else if(t==='Boolean')s={type:'boolean'};
 else if(t==='String')s={type:'string',maxLength:Math.min(262144,Number(f.maxSize)||65536)};
 else throw Error('Unsupported input '+op.name+':'+p+':'+t);
 if(op.name==='aliexpress.trade.compliance.order.query'&&f.name==='child_trade_order_ids'&&s.type==='array')s.maxItems=50;
 if(f.desc)s.description=f.desc+(s.description?' '+s.description:'');
 if(f.required&&s.type==='string')s.minLength=1;
 if(['page_size','pageSize','page_count','pageCount','limit','page_size_value'].includes(f.name)&&t==='Number'){s={type:'integer',minimum:1,maximum:bound,description:s.description};meta.longs=meta.longs.filter(x=>x!==p);meta.pages.push(p);}
 if(['current_page','currentPage','page','page_no','pageNo','page_index','pageIndex'].includes(f.name)&&t==='Number'){s={type:'integer',minimum:1,maximum:100000,description:s.description};meta.longs=meta.longs.filter(x=>x!==p);}
 if(f.name==='page_size'&&['aliexpress.postproduct.redefining.findproductinfolistquery','aliexpress.offer.draftproducts.get'].includes(op.name))s.maximum=99;
 if(f.name==='page_size'&&op.name==='aliexpress.trade.redefining.findorderlistsimplequery')s.maximum=50;
 return s;
}
function flatten(ns,p=''){return ns.flatMap(f=>[{path:p+f.name,type:f.type,description:f.desc},...flatten(f.children,p+f.name+(f.type.endsWith('[]')?'.*.':'.'))]);}
for(const op of evidence.operations.filter(o=>o.status==='candidate')){
 const meta={method:op.name,risk:op.risk,source_url:op.source_url,input_schema:object(),longs:[],pages:[],output_tree:op.outputs.map(function compact(f){return{name:f.name,type:f.type,children:f.children.map(compact)};}),outputs:flatten(op.outputs),root_outputs:op.outputs.map(x=>x.name)};
 for(const f of op.inputs){if(selectors.has(f.name))continue;meta.input_schema.properties[f.name]=field(f,op,f.name,meta);if(f.required)(meta.input_schema.required||=[]).push(f.name);}
 if(op.risk!=='R'&&Object.keys(meta.input_schema.properties).length)meta.input_schema.minProperties=1;
 if(meta.jsonValues)meta.input_schema.$defs={jsonValue:{anyOf:[{type:'string',maxLength:65536},{type:'number',minimum:-Number.MAX_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER},{type:'boolean'},{type:'null'},{type:'array',maxItems:100,items:{$ref:'#/$defs/jsonValue'}},{type:'object',maxProperties:100,propertyNames:{maxLength:256},additionalProperties:{$ref:'#/$defs/jsonValue'}}]}};
 meta.description=op.title+'. '+(op.risk==='R'?'One bounded response; no automatic pagination.':'No automatic retry; inspect uncertain or partial changes before another call.');
 const stock=['aliexpress.postproduct.redefining.editsingleskustock','aliexpress.postproduct.redefining.editmutilpleskustocks'];
 if(stock.includes(op.name))meta.description+=' Existing product/SKU identifiers are verified before replacing stock.';
 meta.success_paths=meta.outputs.filter(x=>['success','is_success','isSuccess','result_success','ret','succeeded','ret_success'].includes(x.path.split('.').at(-1))&&['Boolean','String'].includes(x.type)).map(x=>x.path);
 meta.error_paths=meta.outputs.filter(x=>['error_code','errorCode','error_code_str','sub_error_code','msg_code','code_of_error','result_error_code','result_code'].includes(x.path.split('.').at(-1))).map(x=>x.path);
 meta.diagnostic_paths=meta.outputs.filter(x=>['error_message','errorMessage','error_msg','error_mmessage','error_desc','msg_info','error_cause','error','msg','errorMsg','error_info','result_error_desc','result_info'].includes(x.path.split('.').at(-1))).map(x=>x.path);
 if(diagnosticMemoMethods.has(op.name))meta.diagnostic_paths.push('memo');
 const root=op.outputs.length===1&&op.outputs[0].type==='Object'?op.outputs[0]:{name:'',children:op.outputs};
 const ignored=new Set(['success','is_success','isSuccess','result_success','ret','succeeded','ret_success','fail','error_code','errorCode','error_code_str','sub_error_code','msg_code','code_of_error','result_error_code','result_code','error_message','errorMessage','error_msg','error_mmessage','error_desc','msg_info','error_cause','error','msg','errorMsg','error_info','error_details','result_error_desc','result_info','time_stamp','timeStamp','type','current_page','total_page','page_no','page_size','total_count','total_item','total_record','total','product_count']);
 meta.resource_paths=root.children.filter(f=>!ignored.has(f.name)&&!meta.diagnostic_paths.includes((root.name?root.name+'.':'')+f.name)).map(f=>(root.name?root.name+'.':'')+f.name);
 meta.zero_count_paths=root.children.filter(f=>['total_count','total_item','total_record','total','product_count'].includes(f.name)).map(f=>(root.name?root.name+'.':'')+f.name);
 methods[op.name]=meta;
}
const destination=process.env.ORKAS_ALIEXPRESS_CONTRACT_OUTPUT||path.resolve(__dirname,'../bin/aliexpress-api-contracts.cjs');
fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,"'use strict';\n// Generated from frozen official API documentation by generate-aliexpress-api-contracts.cjs.\nmodule.exports="+JSON.stringify({methods})+';\n');console.log(JSON.stringify({operations:Object.keys(methods).length}));
