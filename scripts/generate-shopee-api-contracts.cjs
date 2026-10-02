'use strict';
// Offline, reproducible conversion of Shopee's pinned structured API guide.
const fs=require('node:fs'),path=require('node:path');
const evidence=JSON.parse(fs.readFileSync(path.join(__dirname,'../test/fixtures/connectors/official-contracts/shopee-20261001.json'),'utf8'));
const methods={};
function plain(value){if(!value)return '';try{value=JSON.parse(value).content||value;}catch{}return String(value).replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();}
function fields(rows,row,input,trail=[]){const properties={},required=[];for(const f of rows){properties[f.name]=field(f,row,input,[...trail,f.name]);if(input&&/^(true|yes)$/i.test(f.required||''))required.push(f.name);}return {type:'object',properties,...(input?{required,additionalProperties:false}:{additionalProperties:true})};}
function field(f,row,input,trail){let t=f.type;const description=plain(f.description),limits=String(f.limits||'').trim();if(t==='object[]'&&row.action==='v2.product.update_item'&&trail.join('.')==='image.image_id_list')t='string[]';let s;
 if(t.endsWith('[]')){s={type:'array',items:field({...f,type:t.slice(0,-2),description:'',limits:''},row,input,trail)};if(input){s.maxItems={R:100,W:25,H:10,D:10}[row.risk];const m=/\b(?:max(?:imum)?(?:\s+(?:size|length|number))?\s*(?:is|=|:|of)?\s*|less than\s+)(\d+)\b/i.exec(description);if(m)s.maxItems=Math.min(s.maxItems,Number(m[1])-(m[0].startsWith('less than')?1:0));}}
 else if(t==='object')s=fields(f.children||[],row,input,trail);
 else if(['int64','uint64','int'].includes(t)){s={anyOf:[{type:'integer',minimum:t==='uint64'?0:Number.MIN_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER},{type:'string',pattern:t==='uint64'?'^(0|[1-9][0-9]{0,19})$':'^-?(0|[1-9][0-9]{0,18})$'}],'x-integer':t};}
 else if(['int32','timestamp'].includes(t))s={type:'integer',minimum:t==='int32'?-2147483648:0,maximum:t==='int32'?2147483647:Number.MAX_SAFE_INTEGER};
 else if(t==='float')s={type:'number'};else if(['boolean','bool'].includes(t))s={type:'boolean'};else if(t==='string')s={type:'string',...(input?{maxLength:256*1024}:{})};else throw Error('Unknown Shopee field '+t+' '+row.action+' '+trail.join('.'));
 if(description)s.description=description;if(limits)s.description=(s.description||'')+' Official limits: '+limits;
 if(input){const m=/^\[(-?\d+),\s*(-?\d+)\]$/.exec(limits);if(m&&(s.type==='integer'||s.type==='number')){s.minimum=Math.max(s.minimum??-Infinity,Number(m[1]));s.maximum=Math.min(s.maximum??Infinity,Number(m[2]));}
 if(['page_size','limit'].includes(f.name)){const candidates=[100];for(const re of [/max(?:imum)?\s*(?:=|:|is)?\s*(\d+)/ig,/\[\s*\d+\s*,\s*(\d+)\s*\]/g])for(const m of (description+' '+limits).matchAll(re))candidates.push(Number(m[1]));const cap=Math.min(...candidates);s['x-pageMax']=cap;if(s.type==='string'){s.pattern='^[1-9][0-9]{0,2}$';s.default=String(Math.min(50,cap));}else{s.type='integer';delete s.anyOf;delete s['x-integer'];s.minimum=1;s.maximum=cap;s.default=Math.min(50,cap);}}
 }
 if(input){
  if(s.type==='string'&&f.name.endsWith('_list')&&/comma/i.test(description)){const m=/limit\s*\[1,([0-9]+)\]/i.exec(description);s['x-csvMax']=Math.min(100,m?Number(m[1]):100);}
  const ignoreLimit=row.action==='v2.product.get_kit_item_info'&&f.name==='item_id';
  let range=/^(?:length\s*)?\[(-?\d+),\s*(-?\d+)(\]|\))$/.exec(limits);
  let lower=range?BigInt(range[1]):undefined,upper=range?BigInt(range[2])-(range[3]===')'?1n:0n):undefined;
  if(!range&&/^>=\d+(?:&&<=\d+)?$/.test(limits)){lower=BigInt(limits.match(/>=([0-9]+)/)[1]);const m=limits.match(/<=([0-9]+)/);if(m)upper=BigInt(m[1]);}
  if(ignoreLimit){lower=upper=undefined;}
  // The three <1 add_on_deal_id rows contradict official positive-ID payloads
  // and the same identifier's >=1 definition on delete/update endpoints.
  if(f.name==='add_on_deal_id'&&limits==='<1')lower=1n;
  if(s['x-integer']){if(lower!==undefined)s['x-minInteger']=String(lower);if(upper!==undefined)s['x-maxInteger']=String(upper);}
  else if(s.type==='array'){if(lower!==undefined)s.minItems=Number(lower);if(upper!==undefined)s.maxItems=Math.min(s.maxItems,Number(upper));}
  else if(s.type==='string'){if(lower!==undefined)s.minLength=Number(lower);if(upper!==undefined)s.maxLength=Math.min(s.maxLength,Number(upper));}
  else if(s.type==='integer'||s.type==='number'){if(lower!==undefined)s.minimum=Math.max(s.minimum??-Infinity,Number(lower));if(upper!==undefined)s.maximum=Math.min(s.maximum??Infinity,Number(upper));}
  if(s.type==='array'){
   const rangeInText=/(?:length should be between|list size must be between|limit is between)\s+(\d+)\s+(?:and|to)\s+(\d+)/i.exec(description);if(rangeInText){s.minItems=Number(rangeInText[1]);s.maxItems=Math.min(s.maxItems,Number(rangeInText[2]));}
   if(/(?:list size must be at least 1|^Non-empty mappings|Minimum 1 Item ID)/i.test(description))s.minItems=1;
   const caps={'v2.product.get_attribute_tree:category_id_list':20,'v2.bundle_deal.add_bundle_deal:additional_tiers':2,'v2.logistics.update_self_collection_order_logistics:epoc_image_list':3,'v2.returns.upload_shipping_proof:image_id_list':3};const cap=caps[row.action+':'+trail.join('.')];if(cap)s.maxItems=Math.min(s.maxItems,cap);
  }
 }
 if(!input&&/\bnull\b/i.test(description)){if(s.anyOf)s.anyOf.push({type:'null'});else s.type=[s.type,'null'];}
 return s;
}
for(const row of evidence.inventory){const input=fields(row.request,row,true),output=fields(row.response,row,false);if(row.action==='v2.business_insights.get_marketing_hot_listing'){const all={...output.properties};for(const name of Object.keys(all).filter(k=>k.startsWith('result_'))){const parents=Object.keys(all).filter(k=>name.startsWith(k+'_')&&(all[k].type==='object'||all[k].type==='array')).sort((a,b)=>b.length-a.length);if(!parents.length)throw Error('Missing official response parent '+name);const parent=all[parents[0]],dest=parent.type==='array'?parent.items:parent;dest.properties[name.slice(parents[0].length+1)]=all[name];delete output.properties[name];}}if(row.action==='v2.order.cancel_order')input.allOf=[{if:{properties:{cancel_reason:{const:'OUT_OF_STOCK'}},required:['cancel_reason']},then:{required:['item_list']}}];input.description=[row.source_name,plain(row.description),'Authorization: '+row.identity+'; existing bound shop and Seller In House System app. Platform market, enrollment and method permissions still apply.'].join('\n');const description=row.action.split('.').slice(1).join(': ').replaceAll('_',' ');methods[row.action]={path:row.path,method:row.method,risk:row.risk,identity:row.identity,description,input_schema:input,output_schema:output};}
fs.writeFileSync(process.argv[2]||path.join(__dirname,'../bin/shopee-api-contracts.cjs'),"'use strict';\n// Generated from pinned official Shopee API guide, 2026-10-01.\nmodule.exports = "+JSON.stringify({methods},null,2)+';\n');console.log('Generated '+Object.keys(methods).length+' Shopee native contracts');
