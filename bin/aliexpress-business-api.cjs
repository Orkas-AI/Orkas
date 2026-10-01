'use strict';
const owner=require('./aliexpress-seller-api.cjs');
const {requestFailureCode}=require('./commerce-request-context.cjs');
const complianceMethods=new Set(['aliexpress.trade.compliance.order.manualcheck','aliexpress.trade.compliance.order.aicheck','aliexpress.trade.compliance.order.query']);
let catalog,actions,validator;const checks=new Map(),longTrees=new Map();
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const source=()=>catalog||=require('./aliexpress-api-contracts.cjs');
const isNative=name=>Object.hasOwn(source().methods,name);
function actionsFor(){return actions||=Object.fromEntries(Object.entries(source().methods).map(([name,r])=>[name,{risk:r.risk,description:r.description,input_schema:r.input_schema,documentation_url:r.source_url}]));}
function walk(value,path,callback){callback(value,path);if(Array.isArray(value))value.forEach(v=>walk(v,path?path+'.*':'*',callback));else if(object(value))for(const[k,v]of Object.entries(value))walk(v,path?path+'.'+k:k,callback);}
function valuesAt(value,path){const keys=Array.isArray(path)?path:path.split('.');if(!keys.length)return[value];const[k,...rest]=keys;if(k==='*')return(Array.isArray(value)?value:object(value)?Object.values(value):[]).flatMap(v=>valuesAt(v,rest));return value!==null&&typeof value==='object'&&Object.hasOwn(value,k)?valuesAt(value[k],rest):[];}
function longTree(row){if(longTrees.has(row))return longTrees.get(row);const tree=Object.create(null);for(const path of row.longs){let at=tree;for(const part of path.split('.'))at=at[part]||=(Object.create(null));at.$=true;}longTrees.set(row,tree);return tree;}
function isLong(tree,path){let at=tree;for(const part of path.split('.')){at=at?.[part]||at?.['*'];if(!at)return false;}return at.$===true;}
function exact(value,path,longs){
 if(isLong(longs,path)){const token=String(value);if(!/^(0|-?[1-9][0-9]*)$/.test(token)||BigInt(token)<-9223372036854775808n||BigInt(token)>9223372036854775807n)fail('E_BAD_INPUT','AliExpress requires an exact signed 64-bit integer');return token;}
 if(Array.isArray(value))return'['+value.map(v=>exact(v,path+'.*',longs)).join(',')+']';
 if(object(value))return'{'+Object.entries(value).map(([k,v])=>JSON.stringify(k)+':'+exact(v,path?path+'.'+k:k,longs)).join(',')+'}';
 return JSON.stringify(value);
}
function build(config,name,parameters={}){
 if(config.provider!=='aliexpress'||!isNative(name))fail('E_BAD_INPUT','Unavailable AliExpress seller action');
 let raw;try{raw=JSON.stringify(parameters);}catch{fail('E_BAD_INPUT','Invalid AliExpress parameters');}
 if(!raw||Buffer.byteLength(raw)>262144)fail('E_BAD_INPUT','AliExpress parameters exceed the host limit');
 const row=source().methods[name];validator||=new(require('@modelcontextprotocol/sdk/validation/ajv').AjvJsonSchemaValidator)();if(!checks.has(row))checks.set(row,validator.getValidator(row.input_schema));
 if(!checks.get(row)(parameters).valid)fail('E_BAD_INPUT','Invalid AliExpress parameters; inspect the described fields');
 const p=JSON.parse(raw),longs=longTree(row);let nodes=0;
 walk(p,'',(v,path)=>{if(++nodes>10000||path.split('.').length>32)fail('E_BAD_INPUT','AliExpress parameters are too deeply nested');if(typeof v==='number'&&!Number.isFinite(v))fail('E_BAD_INPUT','AliExpress requires finite numbers');if(isLong(longs,path))exact(v,path,longs);});
 if(name==='aliexpress.product.customize.template.save'&&p.components!==undefined){if(p.content!==undefined)fail('E_BAD_INPUT','Choose structured components or content, not both');p.content=JSON.stringify(p.components);delete p.components;}
 for(const key of ['product_ids','productIds'])if(typeof p[key]==='string'){
  const ids=p[key].split(';');if(ids.length>(row.risk==='R'?100:10)||ids.some(id=>!/^[1-9][0-9]{0,18}$/.test(id))||new Set(ids).size!==ids.length)fail('E_BAD_INPUT','AliExpress product batch requires unique decimal identifiers within the host limit');
 }
 if(['aliexpress.postproduct.redefining.onlineaeproduct','aliexpress.postproduct.redefining.offlineaeproduct','aliexpress.postproduct.redefining.renewexpire'].includes(name)&&!p.product_ids)fail('E_BAD_INPUT','Select the products to change');
 if(name==='aliexpress.postproduct.redefining.editsingleskustock'&&(!p.product_id||typeof p.sku_id!=='string'||p.ipm_sku_stock===undefined))fail('E_BAD_INPUT','Select an existing product and SKU with its replacement stock');
 if(name==='aliexpress.postproduct.redefining.editmutilpleskustocks'&&(!p.product_id||!object(p.sku_stocks)||!Object.keys(p.sku_stocks).length))fail('E_BAD_INPUT','Select existing product SKUs and replacement stock');
 if(p.ipm_sku_stock!==undefined&&(BigInt(p.ipm_sku_stock)<0n||BigInt(p.ipm_sku_stock)>2147483647n))fail('E_BAD_INPUT','Invalid replacement stock quantity');
 // Optional cross-channel selectors are absent from each generated schema.
 if(name==='aliexpress.logistics.getannouncement'&&p.seller_id!==undefined&&String(p.seller_id)!==config.credentials.seller_id)fail('E_BAD_INPUT','The seller must match this connection');
 const form=Object.fromEntries(Object.entries(p).map(([k,v])=>[k,object(v)||Array.isArray(v)?exact(v,k,longs):String(v)]));
 return{row,p,form};
}
const truth=v=>v===true||v==='true';
const falsity=v=>v===false||v==='false';
const present=v=>v!==undefined&&v!==null&&v!=='';
const same=(a,b)=>a!==undefined&&b!==undefined&&String(a)===String(b);
function clean(value,secrets,diagnosticPaths,path='',depth=0){
 if(depth>40)fail('E_TOOL_CALL_UPSTREAM','AliExpress response nesting exceeds its limit');
 if(typeof value==='string'){for(const s of secrets)value=value.split(s).join('[redacted]');return value;}
 if(Array.isArray(value))return value.map(v=>clean(v,secrets,diagnosticPaths,path+'.*',depth+1));
 if(!object(value))return value;
 return Object.fromEntries(Object.entries(value).filter(([k])=>!['access_token','refresh_token','app_secret','authorization','sign'].includes(k.toLowerCase())&&!diagnosticPaths.has(path?path+'.'+k:k)).map(([k,v])=>[k,clean(v,secrets,diagnosticPaths,path?path+'.'+k:k,depth+1)]));
}
function normalizeOutput(data,fields,path=''){
 if(!object(data))fail('E_TOOL_CALL_UPSTREAM','AliExpress returned malformed business data');
 const result={...data};
 for(const field of fields){if(!Object.hasOwn(data,field.name)||data[field.name]===null)continue;let v=data[field.name];const p=path?path+'.'+field.name:field.name;
  const array=field.type.endsWith('[]'),type=array?field.type.slice(0,-2):field.type;
  if((array||type==='Object')&&typeof v==='string'){try{v=owner.parseJSON(v);}catch{fail('E_TOOL_CALL_UPSTREAM','AliExpress returned malformed structured resource data');}}
  const one=x=>{if(x===null)return x;if(type==='Object'){if(!object(x))fail('E_TOOL_CALL_UPSTREAM','AliExpress returned a malformed resource object');return normalizeOutput(x,field.children,p);}
   if(type==='Number'){if(!(typeof x==='number'&&Number.isFinite(x)||typeof x==='string'&&/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(x)))fail('E_TOOL_CALL_UPSTREAM','AliExpress returned an invalid numeric field');}
   else if(type==='Boolean'){if(!truth(x)&&!falsity(x))fail('E_TOOL_CALL_UPSTREAM','AliExpress returned an invalid boolean field');}
   else if(type==='String'&&typeof x!=='string'&&!(['success','is_success'].includes(field.name)&&(truth(x)||falsity(x))))fail('E_TOOL_CALL_UPSTREAM','AliExpress returned an invalid text field');
   return x;};
  if(array){if(!Array.isArray(v))fail('E_TOOL_CALL_UPSTREAM','AliExpress returned an invalid resource list');result[field.name]=v.map(one);}else result[field.name]=one(v);
 }
 return result;
}
function outcome(data,row,p){
 if(complianceMethods.has(row.method)&&(!same(data?.code,200)||!truth(data?.success)))fail('E_TOOL_CALL_UPSTREAM','AliExpress did not accept the compliance request');
 if(!object(data)||!row.root_outputs.some(k=>Object.hasOwn(data,k)))fail('E_TOOL_CALL_UPSTREAM','AliExpress omitted documented business data');
 const bools=row.success_paths.flatMap(path=>valuesAt(data,path));
 if(bools.some(v=>!truth(v)&&!falsity(v)))fail('E_TOOL_CALL_UPSTREAM','AliExpress returned an invalid business success flag');
 const badCodes=row.error_paths.flatMap(path=>valuesAt(data,path).filter(present).map(v=>({path,value:v}))).filter(({path,value})=>!['0'].includes(String(value))&&!(['aliexpress.logistics.order.createorder','aliexpress.logistics.local.createwarehouseorder'].includes(row.method)&&path==='result.error_code'&&String(value)==='1'));
 let partial=bools.some(falsity)||badCodes.length>0;
 const conflict=valuesAt(data,'target.conflict_products');if(conflict.some(v=>present(v)&&v!=='[]'))partial=true;
 if(row.risk==='R'){if(partial)fail('E_TOOL_CALL_UPSTREAM','AliExpress rejected the read; check the query and app permissions');if(row.resource_paths.length&&!row.resource_paths.some(path=>valuesAt(data,path).some(v=>v!==undefined&&v!==null))&&!row.zero_count_paths.some(path=>valuesAt(data,path).some(v=>same(v,0))))fail('E_TOOL_CALL_UPSTREAM','AliExpress omitted the requested resource data');return{data};}
 let status=partial?'partial_or_failed':complianceMethods.has(row.method)?'accepted':'acknowledged';
 if(!partial){
  const ids={'aliexpress.offer.product.delete':['product_id','product_id'],'aliexpress.offer.product.edit':['result.product_id','product_id'],'aliexpress.offer.product.post':['result.product_id',null]};
  if(ids[row.method]){const[out,input]=ids[row.method],id=valuesAt(data,out)[0];if(!/^[1-9][0-9]*$/.test(String(id))||input&&!same(id,p[input]))fail('E_TOOL_CALL_UPSTREAM','AliExpress returned an incomplete or mismatched product receipt; inspect the shop before retrying');}
  else if(['aliexpress.evaluation.evaluation.reply','aliexpress.issue.solution.agree','aliexpress.issue.solution.save'].includes(row.method)){if(!truth(data.target??data.result_object))status='partial_or_failed';}
  else if(row.method==='aliexpress.marketing.limitdiscountpromotion.create'){if(!/^[1-9][0-9]*$/.test(String(data.target)))fail('E_TOOL_CALL_UPSTREAM','AliExpress omitted the created promotion identifier');}
  else if(row.method==='aliexpress.marketing.limitdiscountpromotion.edit'){if(!object(data.target)||!present(data.time_stamp))fail('E_TOOL_CALL_UPSTREAM','AliExpress omitted the promotion receipt');status='accepted';}
  else if(row.method==='aliexpress.merchant.redefining.saveremark'){if(!same(data.result?.error_code,0))fail('E_TOOL_CALL_UPSTREAM','AliExpress omitted the remark receipt');status='accepted';}
  else if(!bools.length||!bools.every(truth))fail('E_TOOL_CALL_UPSTREAM','AliExpress omitted a clear business acknowledgement; inspect the shop before retrying');
 }
 const product=data.result?.product_id??data.product_id;
 if(p.product_id!==undefined&&product!==undefined&&!same(product,p.product_id))fail('E_TOOL_CALL_UPSTREAM','AliExpress returned a receipt for a different product');
 if(['aliexpress.postproduct.redefining.onlineaeproduct','aliexpress.postproduct.redefining.offlineaeproduct','aliexpress.postproduct.redefining.renewexpire'].includes(row.method)){
  const requested=p.product_ids.split(';'),count=Number(data.result?.modify_count);if(!Number.isSafeInteger(count)||count<0||count>requested.length)fail('E_TOOL_CALL_UPSTREAM','AliExpress omitted valid batch acknowledgement counts');
  if(count!==requested.length)status='partial_or_failed';
  if(count===1&&product!==undefined&&!requested.includes(String(product)))fail('E_TOOL_CALL_UPSTREAM','AliExpress returned an unrequested batch product');
 }
 if(row.method==='aliexpress.product.customize.template.delete'&&!truth(data.result?.data))status='partial_or_failed';
 if(['aliexpress.trade.seller.order.acceptcancel','aliexpress.trade.seller.order.refusecancel','aliexpress.marketing.limitdiscountpromotionproduct.del'].includes(row.method)&&!truth(data.result?.target))status='partial_or_failed';
 if(['aliexpress.logistics.order.shipment','aliexpress.logistics.order.modifyshipment'].includes(row.method)){
  const request=p.param_aeop_seller_shipment_sub_trade_order_request||p,result=data.result||data;const requested=request.sub_trade_order_list,receipts=result.sub_trade_order_list;
  if(!Array.isArray(receipts)||receipts.length!==requested.length||new Set(receipts.map(r=>String(r.sub_trade_order_index))).size!==receipts.length||receipts.some(r=>!requested.some(q=>same(r.sub_trade_order_index,q.sub_trade_order_index))))fail('E_TOOL_CALL_UPSTREAM','AliExpress omitted matching shipment receipts; inspect the order before retrying');
 }
 if(row.method==='aliexpress.product.freight.price.save'){
  const keys=p.sku_list.map(s=>s.sku_unique_key);const receipts=data.result?.sku_freight_mapping_list;
  if(keys.every(present)&&(!Array.isArray(receipts)||receipts.length!==keys.length||new Set(receipts.map(x=>x.sku_unique_key)).size!==keys.length||receipts.some(x=>!keys.includes(x.sku_unique_key))))fail('E_TOOL_CALL_UPSTREAM','AliExpress omitted matching SKU freight receipts');
 }
 return{status,data,...(status==='accepted'?{verification:'Read the resulting resource before treating the change as completed.',follow_up:{action:complianceMethods.has(row.method)?'aliexpress.trade.compliance.order.query':row.method==='aliexpress.merchant.redefining.saveremark'?'aliexpress.merchant.redefining.queryremark':'aliexpress.marketing.storepromotions.list'}}:{})};
}
async function executeNative(config,name,parameters={}){
 const {row,p,form}=build(config,name,parameters);owner.validateBinding(config);await owner.ensureToken(config);
 if(['aliexpress.postproduct.redefining.editsingleskustock','aliexpress.postproduct.redefining.editmutilpleskustocks'].includes(name)){
  const readRow=source().methods['aliexpress.offer.product.query'];const read=normalizeOutput(await owner.request(config,'aliexpress.offer.product.query',{product_id:String(p.product_id)},false,false,{simplify:true}),readRow.output_tree);outcome(read,readRow,p);const product=read.result,skus=product?.aeop_ae_product_s_k_us;
  if(falsity(product?.success)||present(product?.error_code)&&!same(product.error_code,0))fail('E_TOOL_CALL_UPSTREAM','AliExpress rejected the product preflight; no stock was changed');
  const requested=p.sku_id!==undefined?[p.sku_id]:Object.keys(p.sku_stocks);
  if(!same(product?.product_id,p.product_id)||!Array.isArray(skus)||requested.some(id=>skus.filter(s=>same(s.id,id)).length!==1))fail('E_BAD_INPUT','Select existing product SKU identifiers before replacing stock');
 }
 const data=normalizeOutput(await owner.request(config,name,form,false,row.risk!=='R',{simplify:true,...(complianceMethods.has(name)?{businessSuccessCodes:['200']}:{})}),row.output_tree);
 if(name==='aliexpress.merchant.profile.get'&&data.profile?.seller_id!==undefined&&!same(data.profile.seller_id,config.credentials.seller_id))fail('E_TOOL_CALL_AUTH','AliExpress returned a different seller; reconnect');
 const result=outcome(data,row,p);const secrets=['app_key','app_secret','access_token','refresh_token'].map(k=>config.credentials[k]).filter(v=>typeof v==='string'&&v);
 return{...result,data:clean(result.data,secrets,new Set(row.diagnostic_paths))};
}
async function execute(config,name,parameters={}){
 try{return await executeNative(config,name,parameters);}catch(error){if(requestFailureCode(error)==='E_TOOL_CALL_CANCELLED')fail('E_TOOL_CALL_CANCELLED','AliExpress request was cancelled; inspect uncertain changes before retrying');throw error;}
}
module.exports={actionsFor,isNative,build,execute};
