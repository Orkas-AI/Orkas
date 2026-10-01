'use strict';
// Offline conversion of reviewed official models; no runtime schema discovery.
const fs=require('node:fs'),path=require('node:path');
const evidence=JSON.parse(fs.readFileSync(path.join(__dirname,'../test/fixtures/connectors/official-contracts/ebay-20261001.json'),'utf8'));
const defs={},methods={},modes={R:100,W:25,H:10,D:10,output:100};
const clean=s=>String(s || '').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const fields=['type','enum','required','minimum','maximum','minItems','maxItems','minLength','maxLength','pattern','uniqueItems','multipleOf'];
function convert(raw,family,mode){
 if(raw.$ref){const id=family+'__'+raw.$ref.slice('#/components/schemas/'.length);define(id,family,mode);return {$ref:'#/$defs/'+id};}
 if(raw.allOf || raw.anyOf || raw.oneOf || raw.nullable)throw new Error('Unreviewed official schema composition');
 const input=mode!=='output',s=Object.fromEntries(fields.filter(k=>Object.hasOwn(raw,k)&&(input||['type','required'].includes(k))).map(k=>[k,raw[k]]));
 if(input&&raw.description)s.description=clean(raw.description);
 if(raw.type==='object'){
  if(raw.properties)s.properties=Object.fromEntries(Object.entries(raw.properties).filter(([,v])=>!input||!v.readOnly).map(([k,v])=>[k,convert(v,family,mode)]));
  s.additionalProperties=typeof raw.additionalProperties==='object'?convert(raw.additionalProperties,family,mode):input?raw.additionalProperties===true||!raw.properties:true;
 }
 if(raw.type==='array'){s.items=convert(raw.items,family,mode);if(input)s.maxItems=Math.min(s.maxItems??modes[mode],modes[mode]);}
 if(input&&raw.type==='string'&&s.maxLength===undefined)s.maxLength=262144;
 if(input&&raw.type==='integer'){s.minimum=Math.max(s.minimum??Number.MIN_SAFE_INTEGER,Number.MIN_SAFE_INTEGER);s.maximum=Math.min(s.maximum??Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER);}
 return s;
}
function define(id,family,mode){
 const cache=defs[mode] ||= {};if(Object.hasOwn(cache,id))return;
 const raw=evidence.sources[family].model.components.schemas[id.slice(family.length+2)];if(!raw)throw new Error('Missing official schema');
 cache[id]={};cache[id]=convert(raw,family,mode);
 // The official examples in these exact fields show maps of string arrays;
 // their OAS string type is inconsistent with the documented JSON wire shape.
 if(family==='inventory'&&['inventory__Product','inventory__InventoryItemGroup'].includes(id))cache[id].properties.aspects=convert({type:'object',description:raw.properties.aspects.description,additionalProperties:{type:'array',items:{type:'string',...(id==='inventory__Product'?{maxLength:50}:{})}}},family,mode);
}
function closure(s,mode,seen=new Set()){
 if(!s||typeof s!=='object')return seen;
 if(s.$ref){const id=s.$ref.slice('#/$defs/'.length);if(!seen.has(id)){seen.add(id);closure(defs[mode][id],mode,seen);}return seen;}
 for(const v of Object.values(s))if(Array.isArray(v))for(const child of v)closure(child,mode,seen);else closure(v,mode,seen);return seen;
}
const BULK={
 bulkCreateOrReplaceInventoryItem:{request:'requests',response:'responses',keys:['sku'],limit:25},
 bulkGetInventoryItem:{request:'requests',response:'responses',keys:['sku'],limit:25,success_field:'inventoryItem'},
 bulkCreateOffer:{request:'requests',response:'responses',keys:['sku','marketplaceId','format'],optional_keys:['format'],limit:25,success_field:'offerId'},
 bulkPublishOffer:{request:'requests',response:'responses',keys:['offerId'],limit:25,success_field:'listingId'},
 bulkMigrateListing:{request:'requests',response:'responses',keys:['listingId'],limit:5,success_field:'inventoryItems'},
 bulkUpdatePriceQuantity:{request:'requests',response:'responses',keys:['sku','offerId'],limit:25,expand_offers:true},
 bulkCreateOrReplaceSalesTax:{request:'salesTaxInputList',response:'updatedSalesTaxEntries',keys:['countryCode','jurisdictionId'],request_aliases:{jurisdictionId:'salesTaxJurisdictionId'},limit:10},
};
const obj=()=>({type:'object',properties:{},required:[],additionalProperties:false});
for(const row of evidence.inventory){
 if(row.excluded_reason)continue;
 const family=row.family,mode=row.risk,source=evidence.sources[family],operation=source.model.paths[row.model_path][row.method.toLowerCase()];
 const input=obj(),wire=[];
 for(const p of operation.parameters||[]){
  if(p.in==='header'){if(!['Content-Type','Content-Language','X-EBAY-C-MARKETPLACE-ID','Accept-Encoding','Accept-Language'].includes(p.name))throw new Error('Unreviewed transport header');continue;}
  if(!['path','query'].includes(p.in))throw new Error('Unreviewed parameter location');
  const group=input.properties[p.in] ||= obj();group.properties[p.name]=convert({...p.schema,description:p.description},family,mode);
  // Pinned prose constraints missing from eBay's string query schemas.
  if(p.in==='path'){group.properties[p.name].minLength=1;if(p.name==='sku')group.properties[p.name].maxLength=50;}
  if(p.in==='query'&&p.name==='limit'&&row.operation!=='getSubscription')group.properties[p.name].pattern='^(?:[1-9]|[1-9][0-9]|100)$';
  if(p.in==='query'&&p.name==='offset'&&row.operation!=='search')group.properties[p.name].pattern='^(?:0|[1-9][0-9]{0,8})$';
  if(p.required){group.required.push(p.name);if(!input.required.includes(p.in))input.required.push(p.in);}
  wire.push({location:p.in,name:p.name,explode:p.explode??true});
 }
 if(operation.requestBody){
  const content=operation.requestBody.content;if(Object.keys(content).length!==1||!content['application/json']?.schema)throw new Error('Unreviewed request media type');
  input.properties.body=convert(content['application/json'].schema,family,mode);if(operation.requestBody.required)input.required.push('body');
 }
 const bulk=BULK[row.operation];
 if(bulk){const body=defs[mode][input.properties.body.$ref.slice('#/$defs/'.length)],items=body.properties[bulk.request];body.required=[...new Set([...(body.required||[]),bulk.request])];items.minItems=1;items.maxItems=Math.min(modes[mode],bulk.limit);}
 const responses={};
 for(const [status,r]of Object.entries(operation.responses)){
  if(!/^2\d\d$/.test(status))continue;
  // HTTP 204 cannot carry a JSON body despite erroneous Error refs in OAS.
  let schema=status==='204'||!r.content?null:convert(r.content['application/json'].schema,family,'output');
  // The reference response field tree applies to per-item 207 results too.
  // Several OAS models incorrectly give 207 only an Error or no content.
  if(status==='207'&&bulk)schema=responses['200'].schema;
  responses[status]={schema,location:Object.hasOwn(r.headers||{},'Location')};
 }
 const errorPaths=[],prosePaths=[],statusPaths=[];
 function paths(s,cursor=[],seen=new Set()){
  if(!s)return;if(s.$ref){const id=s.$ref.slice('#/$defs/'.length);if(seen.has(id))return;
   if(id===family+'__Error'){if(!cursor.includes('warnings'))errorPaths.push(cursor);for(const k of ['message','longMessage','parameters'])prosePaths.push([...cursor,k]);return;}
   paths(defs.output[id],cursor,new Set([...seen,id]));return;}
  if(s.type==='array'){paths(s.items,[...cursor,'*'],seen);return;}
  for(const [k,v]of Object.entries(s.properties||{})){if(k==='statusCode'&&v.type==='integer')statusPaths.push([...cursor,k]);paths(v,[...cursor,k],seen);}
  if(typeof s.additionalProperties==='object')paths(s.additionalProperties,[...cursor,'*'],seen);
 }
 for(const r of Object.values(responses))paths(r.schema);
 methods[row.method+' '+row.path]={operation:row.operation,family,method:row.method,path:row.path,risk:mode,scopes:row.scopes.filter(s=>evidence.grant_boundary.includes(s)),
  description:clean(operation.description).slice(0,190)+' '+(mode==='R'?'One explicit page; no automatic pagination.':'Acknowledgement is not completion; inspect state before retrying an uncertain write.'),
  input_schema:input,input_definitions:[...closure(input,mode)],wire,responses,response_definitions:[...new Set(Object.values(responses).flatMap(r=>[...closure(r.schema,'output')]))],
  error_paths:errorPaths,error_prose_paths:prosePaths,status_paths:statusPaths,bulk};
}
const data={documentation_snapshot:evidence.documentation_snapshot,methods,definitions:defs,excluded_methods:Object.fromEntries(evidence.inventory.filter(r=>r.excluded_reason).map(r=>[r.method+' '+r.path,r.excluded_reason]))};
fs.writeFileSync(path.join(__dirname,'../bin/ebay-api-contracts.cjs'),"'use strict';\n// Generated offline from pinned official current-grant merchant models.\nmodule.exports = "+JSON.stringify(data,null,2)+';\n');
console.log('Generated '+Object.keys(methods).length+' eBay merchant contracts');
