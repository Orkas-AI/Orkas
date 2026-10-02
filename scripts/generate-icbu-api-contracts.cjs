'use strict';
// Regenerate from the pinned public TOP document inventory; never query merchant APIs.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const args=process.argv.slice(2), frozen=!args.length||args[0]==='--snapshot';
const [directory,out=path.resolve(__dirname,'../bin/icbu-api-contracts.cjs'),evidence]=frozen?[undefined,args[2],undefined]:args;
const snapshot=frozen?JSON.parse(fs.readFileSync(args[1]||path.resolve(__dirname,'../test/fixtures/connectors/official-contracts/icbu-generator-input.json'),'utf8')):null;
const exclusions={
  "alibaba.scbp.ad.campaign.find.forbidden.keyword": "jst_only",
  "alibaba.scbp.ad.campaign.update": "jst_only",
  "alibaba.scbp.ad.campaign.delete": "jst_only",
  "alibaba.scbp.ad.campaign.create": "jst_only",
  "alibaba.scbp.ad.campaign.find.campaign.page": "jst_only",
  "alibaba.scbp.ad.target.tag.estimate.uv": "jst_only",
  "alibaba.scbp.ad.campaign.find.real.cost": "jst_only",
  "alibaba.scbp.ad.campaign.find.campaign.effect": "jst_only",
  "alibaba.scbp.ad.target.tag.find.campaign.target.tag": "jst_only",
  "alibaba.scbp.ad.group.delete.forbidden.product": "jst_only",
  "alibaba.scbp.ad.keyword.get.keyword.count.by.query": "jst_only",
  "alibaba.scbp.ad.keyword.list.campaign.keywords": "jst_only",
  "alibaba.scbp.ad.keyword.update.keyword.price.batch": "jst_only",
  "alibaba.scbp.ad.keyword.create.keyword.batch": "jst_only",
  "alibaba.scbp.ad.report.get.account.report": "jst_only",
  "alibaba.scbp.ad.keyword.delete.keyword.batch": "jst_only",
  "alibaba.scbp.ad.report.get.product.report": "jst_only",
  "alibaba.scbp.ad.report.query.keyword.effect": "jst_only",
  "alibaba.scbp.ad.group.find.forbidden.product": "jst_only",
  "alibaba.scbp.ad.group.count.ad.group": "jst_only",
  "alibaba.scbp.ad.group.create.forbidden.product": "jst_only",
  "alibaba.scbp.ad.group.create.ad.group.batch": "jst_only",
  "alibaba.scbp.ad.group.update.ad.group.batch": "jst_only",
  "alibaba.scbp.ad.group.find.ad.group": "jst_only",
  "alibaba.scbp.ad.group.delete.ad.group.batch": "jst_only",
  "alibaba.scbp.ad.target.tag.merge.campaign.target.tag": "jst_only",
  "alibaba.scbp.ad.report.get.target.report": "jst_only",
  "alibaba.scbp.ad.campaign.delete.forbidden.keyword": "jst_only",
  "alibaba.scbp.ad.report.query.single.keyword.effect": "jst_only",
  "alibaba.scbp.ad.keyword.update.keyword.status.batch": "jst_only",
  "alibaba.scbp.ad.campaign.create.forbidden.keyword": "jst_only",
  "alibaba.scbp.ad.target.tag.get.all.enable.tag.list": "jst_only",
  "alibaba.scbp.ad.customer.find.customer.info": "jst_only",
  "alibaba.scbp.ad.keyword.list.relevant.products": "jst_only",
  "alibaba.scbp.ad.keyword.operation.preferential.product": "jst_only",
  "alibaba.scbp.ad.group.recommend.product": "jst_only",
  "alibaba.scbp.ad.report.get.last.effect.date": "jst_only",
  "alibaba.scbp.ad.keyword.recommend.word": "jst_only",
  "alibaba.scbp.ad.target.tag.list.recommend.tag": "jst_only",
  "alibaba.scbp.ad.keyword.recommend.price": "jst_only",
  "alibaba.icbu.photobank.upload": "binary_transport_gap",
  "alibaba.mydata.overview.date.get": "jst_only",
  "alibaba.mydata.overview.industry.get": "jst_only",
  "alibaba.mydata.overview.indicator.basic.get": "jst_only",
  "alibaba.mydata.self.product.date.get": "jst_only",
  "alibaba.mydata.self.product.get": "jst_only",
  "alibaba.seller.vendor.order.detail": "ISV_application_identity",
  "alibaba.seller.vendor.order.list": "ISV_application_identity",
  "alibaba.seller.coupon.auth.verify": "ISV_application_identity",
  "alibaba.seller.vendor.service.process": "ISV_application_identity",
  "alibaba.seller.vendor.service.vendorprocess": "ISV_application_identity",
  "alibaba.seller.vendor.trade.purchase": "ISV_application_identity",
  "alibaba.icbu.shopclone.icbuproductrights.query": "ISV_application_identity",
  "alibaba.icbu.shopclone.externalshopinfo.write": "ISV_application_identity",
  "alibaba.icbu.shopclone.externalproductinfo.write": "ISV_application_identity",
  "alibaba.icbu.shopclone.icbushopinfo.query": "ISV_application_identity",
  "alibaba.icbu.supplierfoster.isvtask.notify": "ISV_application_identity",
  "alibaba.icbu.xiaoman.fundrelation.query": "xiaoman_ACP_identity",
  "alibaba.icbu.xiaoman.acp.notice": "xiaoman_ACP_identity",
  "alibaba.icbu.xiaoman.admittence.query": "xiaoman_ACP_identity",
  "alibaba.icbu.xiaoman.va.letter.get": "xiaoman_ACP_identity",
  "alibaba.icbu.annex.upload": "binary_transport_gap",
  "alibaba.icbu.distribution.product.query": "buyer_distribution_identity",
  "alibaba.icbu.distribution.product.get": "buyer_distribution_identity",
  "alibaba.shipping.freight.calculate": "buyer_distribution_identity",
  "alibaba.dropshipping.product.get": "buyer_distribution_identity",
  "alibaba.dropshipping.token.create": "buyer_distribution_identity",
  "alibaba.buynow.order.create": "buyer_distribution_identity",
  "alibaba.order.freight.calculate": "buyer_distribution_identity",
  "alibaba.order.logistics.tracking.get": "buyer_distribution_identity",
  "alibaba.order.pay.result.query": "buyer_distribution_identity",
  "alibaba.dropshipping.order.pay": "buyer_distribution_identity",
  "alibaba.dropshipping.store.save": "buyer_distribution_identity",
  "alibaba.icbulive.productlist.pageget": "cookie_identity_gap",
  "alibaba.icbulive.product.push": "cookie_identity_gap"
};
const writeRisk={
 'alibaba.icbu.product.add.draft':'W',
 'alibaba.icbu.product.group.add':'H','alibaba.icbu.product.add':'H','alibaba.icbu.product.update':'H','alibaba.icbu.product.update.field':'H',
 'alibaba.icbu.photobank.group.operate':'D','alibaba.icbu.product.batch.update.display':'H','alibaba.icbu.product.schema.update':'H',
 'alibaba.onetouch.logistics.express.logistics.order.create':'H','alibaba.icbu.quotation.post':'H','alibaba.icbu.product.inventory.update':'H',
 'alibaba.scbp.showcase.deleteproduct':'D','alibaba.scbp.showcase.addproduct':'H','alibaba.scbp.showcase.sort':'H','alibaba.scbp.showcase.updateproduct':'H',
 'alibaba.icbu.video.relation.product.detail':'H','alibaba.icbu.video.relation.product.main':'H','alibaba.icbu.video.upload':'H'};
const inputTypes=new Set(['String','Date','Price','Boolean','Number','Json','BigDecimal']);
function input(fields,method,prefix=''){
 const properties={},required=[];
 for(const f of fields){const t=f.type.replaceAll(' ',''),array=t.endsWith('[]'),base=t.replace(/\[\]$/,''),children=f.subParams||[],key=prefix+f.name;let s;
  if(children.length)s=input(children,method,key+'.');
  else if(base==='Number')s={anyOf:[{type:'integer',minimum:Number.MIN_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER},{type:'string',pattern:'^(0|-?[1-9][0-9]*)$',maxLength:20}],'x-integer':true};
  else if(base==='Boolean')s={type:'boolean'};
  else if(base==='Json')s={type:'object',additionalProperties:true};
  else if(base==='BigDecimal')s={anyOf:[{type:'number'},{type:'string',pattern:'^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$',maxLength:100}],'x-decimal':true};
  else if(['String','Date','Price'].includes(base))s={type:'string',maxLength:f.maxLength||262144};
  else throw Error('Missing input structure: '+method+' '+key+' '+base);
  if(base==='Number'){
   let min=f.minValue,max=f.maxValue;const range=(f.description||'').match(/范围是(\d+)-(\d+)(?:$|[，。])/);if(range){min=range[1];max=range[2];}
   if(['page_size','per_page_size','count'].includes(f.name)){min=1;max=Math.min(Number(max??100),method==='alibaba.icbu.product.list'?30:100);s.default=Math.min(Number(f.defaultValue||30),max);}
   if(['current_page','page_num','to_page','page_no'].includes(f.name)){min=1;max=Math.min(Number(max??100000),100000);s.default=Number(f.defaultValue||1);}
   if(f.name==='cat_id'&&['alibaba.icbu.category.get','alibaba.icbu.category.get.new'].includes(method))min=0;
   if(min!==null&&min!==undefined)s['x-min']=String(min);if(max!==null&&max!==undefined)s['x-max']=String(max);
  }
  if(array){let cap=f.maxListSize||1000;if(f.name==='keywords')cap=Math.min(cap,3);if(['alibaba.scbp.showcase.addproduct','alibaba.scbp.showcase.deleteproduct'].includes(method)||method==='alibaba.icbu.product.inventory.update'&&f.name==='inventory_list')cap=Math.min(cap,10);s={type:'array',items:s,maxItems:cap,...(f.required?{minItems:1}:{})};}
  if(f.name==='subject'&&method.startsWith('alibaba.icbu.product.')&&writeRisk[method])s.maxLength=128;
  if(f.name==='keywords')s.items={...s.items,pattern:'^[^,;]+$'};
  if(method==='alibaba.icbu.product.batch.update.display'&&f.name==='new_display')s.enum=['on','off'];
  if(method==='alibaba.icbu.product.inventory.update'&&f.name==='operate')s.enum=['plus','sub'];
  if(method==='alibaba.icbu.photobank.group.operate'&&f.name==='operation')s.enum=['add','delete','rename'];
  s.description=f.description||f.name;properties[f.name]=s;if(f.required)required.push(f.name);
 }
 return{type:'object',properties,required,additionalProperties:false};
}
function output(fields,doc,prefix=''){
 return fields.map(f=>{const t=f.type.replaceAll(' ',''),array=t.endsWith('[]'),base=t.replace(/\[\]$/,''),key=prefix+f.name;
 const r={name:f.name,type:base,array,description:f.description||'',children:output(f.subParams||[],doc,key+'.')};
 if(array){const matches=[...doc.rspSampleJson.matchAll(new RegExp('"'+f.name+'"\\s*:\\s*\\{\\s*"([^"\\n]+)"\\s*:\\s*\\[','g'))].map(x=>x[1]);const wrappers=[...new Set(matches)];if(wrappers.length===1)r.wrapper=wrappers[0];else if(!wrappers.length&&['Number','String'].includes(base))r.wrapper=base.toLowerCase();else throw Error('Unverified TOP response array wrapper '+doc.name+' '+key);}
 if(['success','biz_success','sub_success','recognize_success'].includes(f.name)&&base==='Boolean')r.success_flag=true;
 if(['alibaba.scbp.showcase.deleteproduct','alibaba.scbp.showcase.addproduct','alibaba.scbp.showcase.sort','alibaba.scbp.showcase.updateproduct'].includes(doc.name)&&key==='result'||doc.name.startsWith('alibaba.icbu.video.relation.product.')&&key==='model')r.success_flag=true;
 const diagnostics=new Set(['message','msg','msg_info','error_message','errormsg','sub_error_msg']);if(diagnostics.has(f.name)&&/错误|返回状态|返回信息|查询返回|信息|描述|message/i.test(f.description||''))r.diagnostic=true;
 return r;
 });
}
const methods={},sources=[],omitted=[];const index=snapshot?snapshot.documents:JSON.parse(fs.readFileSync(path.join(directory,'core-index.json'),'utf8'));
for(const e of index){const bytes=snapshot?null:fs.readFileSync(path.join(directory,'documents',e.doc_id+'.json')),sha=snapshot?e.sha256:crypto.createHash('sha256').update(bytes).digest('hex');if(sha!==e.sha256)throw Error('Official source digest mismatch');const d=snapshot?e.data:JSON.parse(bytes).data;if(d.name!==e.method)throw Error('Source method mismatch');const src={method:d.name,doc_id:e.doc_id,url:e.url,sha256:sha,category:e.category,labels:d.labels,applyScopes:d.applyScopes};
 if(exclusions[d.name]){omitted.push({...src,reason:exclusions[d.name]});continue;}
 const risk=writeRisk[d.name]||'R';methods[d.name]={method:d.name,risk,description:d.apiChineseName,documentation_url:'https://open.taobao.com/docs/api.htm?apiId='+e.doc_id,requirements:{identity:'Existing Alibaba.com main merchant OAuth session; the application must have its official permission package approved.',permission_packages:d.applyScopes.map(x=>x.name),official_labels:d.labels},input_schema:input(d.requestParams,d.name),output_tree:output(d.responseParams,d),response_wrapper:d.name.replaceAll('.','_')+'_response',wire_fields:d.requestParams.map(f=>({name:f.name,type:f.type.replaceAll(' ',''),structured:(f.subParams||[]).length>0}))};
 sources.push({...src,description:d.description,requestParams:d.requestParams,responseParams:d.responseParams,rspSampleJson:d.rspSampleJson,rspSampleXml:d.rspSampleXml});
}
if(methods['alibaba.icbu.product.add'].input_schema.properties.keywords.maxItems!==3||Object.keys(methods).length!==66||omitted.length!==75)throw Error('Reviewed catalog changed; audit the new source');
const content="'use strict';\n// Generated by generate-icbu-api-contracts.cjs from pinned official TOP documents.\nmodule.exports="+JSON.stringify({version:'2026-10-01',methods})+';\n';fs.writeFileSync(out,content);
if(evidence)fs.writeFileSync(evidence,JSON.stringify({provider:'alibaba_icbu',as_of:'2026-10-01',inventory:{official:141,native:66,legacy:6,total:72,risks:Object.values(methods).reduce((a,r)=>(a[r.risk]=(a[r.risk]||0)+1,a),{})},contract_sha256:crypto.createHash('sha256').update(content).digest('hex'),sources,exclusions:omitted,notes:[
 'Jushita-only, different principal, and extra cookie identity exclusions are not claims that the provider API is unavailable.',
 'Binary byte[] upload remains a host transport gap. URL-based video upload is supported without host URL fetch.',
 'Seller order aliases are retained. Their legacy seller.order.list/get methods are absent from the current 141-method directory and complete TOP inventory, which does not prove provider removal; no native schema is invented.',
 'Use standard TOP JSON envelopes and documented array wrappers. Four omitted primitive arrays use number/string wrappers independently demonstrated by product.group.get and category.attribute.get.',
 'Root keywords use the official CURL/NodeJS comma-separated quoted entries; other primitive root arrays use documented delimiter lists. Nested typed SDK List fields use JSON arrays.',
 'Response examples sometimes contain unquoted prose placeholders or contradictory success/error samples. They are field-shape evidence, never a success oracle.',
 'Ordinary approved packages including translation and Onetouch are conditional on the merchant application permissions and service enrollment. No paid or merchant requests were made.'
]},null,2)+'\n');console.log(JSON.stringify({native:Object.keys(methods).length,excluded:omitted.length,bytes:Buffer.byteLength(content)}));
