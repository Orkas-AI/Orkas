'use strict';

// Pinned WooCommerce release schemas, reconciled with its PHP controller
// inheritance. No live discovery, PHP execution, or model-generated fields.
const fs=require('node:fs'),path=require('node:path');
const evidence=JSON.parse(fs.readFileSync(path.join(__dirname,'../test/fixtures/connectors/official-contracts/woocommerce-20261001.json'),'utf8'));
const limits={R:100,W:25,H:10,D:10},methods={};
const object=()=>({type:'object',properties:{},required:[],additionalProperties:false});
const dynamic=value=>value&&typeof value==='object'&&(Object.hasOwn(value,'$php')||Object.values(value).some(dynamic));
function convert(raw,limit,top=false){
  if(!raw||typeof raw!=='object')return {};
  if(raw.$php)throw new Error('Unresolved WooCommerce contract expression: '+raw.$php);
  const result={};
  for(const k of ['type','enum','minimum','maximum','minLength','maxLength','minItems','maxItems','pattern','description'])if(raw[k]!==undefined&&!dynamic(raw[k]))result[k]=raw[k];
  if(result.type==='date-time')result.type='string';
  if(result.type==='mixed')delete result.type;
  if(typeof result.description!=='string')delete result.description;
  if(['uri','email','date-time'].includes(raw.format))result.format=raw.format;
  if(raw.properties){result.properties={};for(const [k,v]of Object.entries(raw.properties))if(!top||!v.readonly)result.properties[k]=convert(v,limit);result.additionalProperties=false;}
  else if(result.type==='object')result.additionalProperties=true;
  if(raw.items)result.items=convert(raw.items,limit);
  if(Array.isArray(raw.required))result.required=raw.required;
  if(result.type==='array'||Array.isArray(result.type)&&result.type.includes('array')){result.items ||= {};result.maxItems=Math.min(raw.maxItems??limit,limit);}
  if(result.type==='string')result.maxLength=Math.min(result.maxLength??256*1024,256*1024);
  if(result.type==='integer'){result.minimum=Math.max(result.minimum??Number.MIN_SAFE_INTEGER,Number.MIN_SAFE_INTEGER);result.maximum=Math.min(result.maximum??Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER);}
  return result;
}
function bodyFor(row,limit,create){
  const body=convert(evidence.schemas[row.resource],limit,true);body.required=[];
  for(const [key,arg]of Object.entries(row.args))if(body.properties[key]&&arg.required===true)body.required.push(key);
  if(create){
    if(['products/categories','products/brands','products/tags','products/attributes','products/attributes/{attribute_id}/terms','products/shipping_classes','taxes/classes','shipping/zones'].includes(row.resource))body.required.push('name');
    if(row.resource==='products/reviews')body.required.push('product_id','review','reviewer','reviewer_email');
    if(row.resource==='orders/{order_id}/notes')body.required.push('note');
    if(row.resource==='customers')body.required.push('email');
    if(row.resource==='coupons')body.required.push('code');
  }
  // WooCommerce instance settings are a key/value dictionary, not the output
  // setting-descriptor object. Core supports scalar, multiselect and dimensions.
  if(row.resource==='shipping/zones/{zone_id}/methods'){
    body.properties.settings={type:'object',additionalProperties:{anyOf:[{type:['string','number','boolean','null']},{type:'array',items:{type:['string','number']},maxItems:limit},{type:'object',properties:{width:{type:'integer'},height:{type:'integer'},crop:{type:'boolean'}},additionalProperties:false}]}};
    if(create){body.properties.method_id={type:'string',minLength:1,maxLength:200};body.required.push('method_id');}
  }
  body.required=[...new Set(body.required)];return body;
}
for(const row of evidence.inventory){
  const limit=limits[row.risk],input=object(),pathNames=[...row.path.matchAll(/\{([^}]+)\}/g)].map(m=>m[1]);
  if(pathNames.length){input.properties.path=object();input.required.push('path');for(const key of pathNames){
    const stringId=key==='slug'||key==='location'||key==='currency'||row.path.startsWith('/shipping_methods/');
    input.properties.path.properties[key]=stringId?{type:'string',minLength:1,maxLength:200}:{type:'integer',minimum:row.path.startsWith('/shipping/zones/')?0:1,maximum:Number.MAX_SAFE_INTEGER};input.properties.path.required.push(key);
  }}
  if(['GET','DELETE'].includes(row.method)){
    const query=object();for(const [key,arg]of Object.entries(row.args))if(!pathNames.includes(key)){query.properties[key]=convert(arg,limit);if(arg.required===true)query.required.push(key);}
    if(query.properties.page)query.properties.page.minimum=1;
    if(query.properties.per_page){query.properties.per_page.minimum=1;query.properties.per_page.maximum=100;}
    if(query.properties.offset)query.properties.offset.minimum=0;
    if(query.properties.limit?.type==='integer'){query.properties.limit.minimum=1;query.properties.limit.maximum=100;}
    if(Object.keys(query.properties).length){input.properties.query=query;if(query.required.length)input.required.push('query');}
  }else if(row.response_kind==='batch'){
    const create=bodyFor({...row,args:{}},limit,true),update=bodyFor({...row,args:{}},limit,false);
    update.properties.id={type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER};update.required=['id'];
    input.properties.body={type:'object',properties:{create:{type:'array',items:create,maxItems:limit},update:{type:'array',items:update,maxItems:limit},delete:{type:'array',items:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},maxItems:limit,uniqueItems:true}},additionalProperties:false,minProperties:1};input.required.push('body');
  }else if(row.resource){
    input.properties.body=bodyFor(row,limit,row.method==='POST'&&!row.path.endsWith('/duplicate'));input.required.push('body');
    if(row.path.endsWith('/locations')){input.properties.body={type:'array',items:{...input.properties.body,required:['code'],properties:{...input.properties.body.properties,code:{type:'string',minLength:1,maxLength:256}}},maxItems:limit};}
  }else{
    const body=object();for(const [key,arg]of Object.entries(row.args))if(!pathNames.includes(key)){body.properties[key]=convert(arg,limit);if(arg.required===true)body.required.push(key);}
    input.properties.body=body;input.required.push('body');
  }
  // The standard example has a dynamic enum captured from one demo store.
  for(const group of [input.properties.query,input.properties.body])if(group?.properties?.class)delete group.properties.class.enum;
  const ackKey=row.response_kind==='message'?'message':row.resource==='taxes/classes'?'slug':row.resource==='shipping/zones/{zone_id}/methods'?'instance_id':row.response_kind==='object'&&row.resource?'id':null;
  methods[row.method+' '+row.path]={...row,input_schema:input,ack_key:ackKey,description:row.method+' '+row.path+' — WooCommerce 11.1.2 merchant API. '+(row.risk==='R'?'Returns one page with pagination metadata.':'Acknowledgement only; inspect state before retrying an uncertain write.' )};
  delete methods[row.method+' '+row.path].args;delete methods[row.method+' '+row.path].minimum_version;
}
fs.writeFileSync(path.join(__dirname,'../bin/woocommerce-api-contracts.cjs'),"'use strict';\n// Generated offline from pinned WooCommerce 11.1.2 controller contracts.\nmodule.exports = "+JSON.stringify({release:evidence.release,release_commit:evidence.release_commit,methods,excluded_groups:evidence.excluded_groups},null,2)+';\n');
console.log('Generated '+Object.keys(methods).length+' WooCommerce merchant contracts');
