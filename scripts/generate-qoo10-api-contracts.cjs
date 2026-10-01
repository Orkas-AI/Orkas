'use strict';
// Offline conversion of the public QAPI guide's method, field and result tables.
const fs=require('node:fs'),path=require('node:path');
const evidence=JSON.parse(fs.readFileSync(path.join(__dirname,'../test/fixtures/connectors/official-contracts/qoo10-20261001.json'),'utf8'));
const methods={},byId=new Map(evidence.inventory.map(x=>[x.method.m_no,x]));
const bulk={15238:{field:'ItemInfoJson',source:10024,fields:['ItemCode','SellerCode','Price','TaxRate','Qty','ExpireDate','StartDate']},15236:{field:'ItemInfoJson',source:10020,fields:['ItemCode','SellerCode','OptionName','OptionValue','OptionCode','Price','Qty']},15237:{field:'ItemInfoJson',source:10021,fields:['ItemCode','SellerCode','OptionName','OptionValue','OptionCode','Price','Qty']},15772:{field:'SendPlanDtInfoJson',source:10050,fields:['OrderNo','EstShipDt','DelayType','DelayMemo']},15773:{field:'ShippingInfoJson',source:10042,fields:['OrderNo','ShippingCorp','TrackingNo']}};
const enums={ItemStatus:['S0','S1','S2','S3','S5','S8'],ShippingStatus:['0','1','2','3','4','5'],SearchCondition:['1','2','3','4'],search_condition:['1','2','3'],proc_status:['S1','S2','S3'],inq_type:['MSG','HELP','ITEM'],CancelReason:['','1','2','3'],ReceiverInfoEditYN:['Y','N'],lang_cd:['JA','KO','EN','ZH-CN']};
function field(f,id){
 const description=[f.en_description||f.ja_description||f.comment,f.en_example?'Official example: '+f.en_example:'',f.default_value?'Provider default: '+f.default_value:''].filter(Boolean).join('\n');
 let type=f.key_type.toLowerCase();if(f.key_name==='OptionQty'&&[15757,15758].includes(id))type='string';
 const s={type:type==='int32'?'integer':type==='decimal'?'number':'string',description},length=String(f.value_length_admin||f.value_length),cap=/^(?:max\s*)?([1-9][0-9]*)$/i.exec(length.trim()),range=/^(-?\d+)\s*~\s*(-?\d+)$/.exec(length.trim());
 if(s.type==='string'){const bytes=/^max\s*([0-9]+)\s*byte$/i.exec(length.trim());if(bytes)s['x-maxBytes']=Number(bytes[1]);s.maxLength=Math.min(cap?Number(cap[1]):256*1024,256*1024);if(f.mandatory_yn==='Y')s.minLength=1;}
 if(s.type==='integer'){s.minimum=-2147483648;s.maximum=2147483647;}if(range&&s.type!=='string'){s.minimum=Number(range[1]);s.maximum=Number(range[2]);}
 if(f.key_name==='PlusQty'&&id===10023)s.minimum=-2147483648;
 if(f.key_name==='ItemCode'){s.maxLength=10;s.pattern='^[1-9][0-9]{0,9}$';}
 if(f.key_name==='OrderNo'&&id===15477)s.maxLength=10;
 if(f.key_name==='ManufactureDate')s.maxLength=10;
 if([15757,15758].includes(id)&&f.key_name==='IndustrialCodeType'){s.enum=['JAN','KAN','ISBN','UPC','EAN','HS'];s.maxLength=4;}
 if([15757,15758].includes(id)&&f.key_name==='ItemSeriesName')s.maxLength=16;
 if([15757,15758].includes(id)&&f.key_name==='OptionMainimage')s.maxLength=256*1024;
 if(enums[f.key_name]){s.enum=enums[f.key_name];s.maxLength=Math.max(...s.enum.map(x=>x.length));}
 if(f.key_name==='Currency')s.enum=['JPY'];
 if(['Status'].includes(f.key_name)&&[10013,15764].includes(id))s.enum=['1','2','3'];
 if(f.key_name==='DiscountType')s.enum=['0','1','2'];
 if(f.key_name==='TaxRate'&&s.type==='string')s.enum=['S','10','8','0'];
 if(f.key_name==='ItemCondition')s.enum=['N','U'];
 if(['AdultYN','EditHeaderYN','EditFooterYN'].includes(f.key_name))s.enum=['Y','N'];
 if(f.key_name==='apply_type')s.enum=['item','inventory','order','ship'];
 return s;
}
for(const item of evidence.inventory){
 const id=item.method.m_no,input={type:'object',properties:{},required:[],additionalProperties:false},dateFields=[],rowFields=[];
 for(const f of item.parameters.filter(x=>x.param_type==='I')){
  input.properties[f.key_name]=field(f,id);if(f.mandatory_yn==='Y')input.required.push(f.key_name);
  if((f.en_description+f.ja_description+f.en_example).includes('$$'))rowFields.push(f.key_name);
  if(['SearchStartDate','SearchEndDate','search_Sdate','search_Edate','search_start_dt','search_end_dt','EstShipDt'].includes(f.key_name)){input.properties[f.key_name].pattern=f.key_name==='EstShipDt'?'^[0-9]{8}$':'^[0-9]{8}([0-9]{6})?$';input.properties[f.key_name].maxLength=14;dateFields.push(f.key_name);}
 }
 if([10004,10005,10007].includes(id)){input.required=input.required.filter(x=>x!=='ItemCode');input.anyOf=[{required:['ItemCode']},{required:['SellerCode']}];input.properties.SellerCode.minLength=1;}
 if(id===10008){input.properties.Page.pattern='^[1-9][0-9]{0,9}$';input.properties.Page.maxLength=10;input.properties.Page.default='1';}
 let batch=null;
 if(bulk[id]){const b=bulk[id],source=byId.get(b.source),props={};for(const name of b.fields){const f=source.parameters.find(x=>x.param_type==='I'&&x.key_name===name);props[name]=field(f,b.source);if(props[name].type!=='string'){props[name]={type:'string',maxLength:32,pattern:'^-?[0-9]+(?:\\.[0-9]+)?$',description:props[name].description};}}
  // The bulk input examples explicitly use strings, including prices/quantities.
  const required=source.parameters.filter(x=>x.param_type==='I'&&x.mandatory_yn==='Y'&&b.fields.includes(x.key_name)).map(x=>x.key_name);
  input.properties[b.field]={type:'array',minItems:1,maxItems:10,description:input.properties[b.field].description+'\nPass a typed array; the connector serializes it to the documented JSON string.',items:{type:'object',properties:props,required,additionalProperties:false}};input.required=[b.field];batch={field:b.field,kind:id===15772?'confirmation':id===15773?'shipping':'unverified_dictionary'};
 }
 let sample=null;const raw=item.notices.find(x=>x.type==='RJ'&&x.display_yn==='Y')?.comment;if(raw){try{sample=JSON.parse(raw);}catch{throw Error('Invalid official JSON sample '+id);}}
 const outputTypes=Object.fromEntries(item.parameters.filter(x=>x.param_type==='O').map(f=>[f.key_name.replace(/\$\$$/,''),f.key_type]));
 const xml=[15095,15096,15097].includes(id),outputKind=xml?'xml':Array.isArray(sample?.ResultObject)?'array':sample&&Object.hasOwn(sample,'ResultObject')?'object':item.parameters.some(f=>f.param_type==='O')?'envelope':'undocumented';
 const descriptions={10009:'Create a product',10010:'Update a product',10013:'Change product selling status',10019:'Delete an inventory option',10040:'Request a product, inventory or order export',10056:'Reply to a customer inquiry',10059:'Cancel an order',10060:'Accept an exchange claim',10061:'Register an exchange redelivery'};
 const description=descriptions[id]||item.method.method_name.replace(/([a-z])([A-Z])/g,'$1 $2');
 input.description=[description,`Official QAPI method ${id}; version ${item.method.version||'1.0'}.`,item.method.method_desc_admin||item.method.method_desc,...item.notices.filter(x=>['nt','ht','gd'].includes(x.type)&&x.display_yn==='Y').map(x=>x.description_en||x.description_ja||x.comment)].filter(Boolean).join('\n');
 methods[item.action]={id,version:item.method.version||'1.0',risk:item.risk,description,input_schema:input,batch,row_fields:rowFields,date_fields:dateFields,output_kind:outputKind,output_types:outputTypes,xml};
}
fs.writeFileSync(process.argv[2]||path.join(__dirname,'../bin/qoo10-api-contracts.cjs'),"'use strict';\n// Generated offline from the pinned public Qoo10 Japan guide.\nmodule.exports = "+JSON.stringify({methods,exclusions:evidence.exclusions},null,2)+';\n');
console.log('Generated '+Object.keys(methods).length+' Qoo10 merchant contracts');
