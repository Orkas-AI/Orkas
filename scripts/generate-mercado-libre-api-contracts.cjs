'use strict';
// The public Global Selling documentation is prose, tables and examples, not OpenAPI.
// Input fields below are deliberately reviewed rather than inferred from example values.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const S=(max=4096)=>({type:'string',maxLength:max}),id={type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9_:-]+$'},numid={type:'string',pattern:'^[1-9][0-9]{0,19}$'},N={type:'number'},B={type:'boolean'},I={type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER},money={type:'number',minimum:0},E=(...v)=>({type:'string',enum:v});
const O=(p={},r=[])=>({type:'object',properties:p,additionalProperties:false,...(r.length?{required:r}:{})}),A=(items,max=100,min=0)=>({type:'array',items,maxItems:max,...(min?{minItems:min}:{})}),ref=n=>({$ref:'#/$defs/'+n}),nullable=s=>({anyOf:[s,{type:'null'}]}),enumid=E('CBT','MLM','MLB','MLC','MCO','MLA','MPE'),int64={anyOf:[{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},numid],'x-mercado-integer':true};
const page={limit:{type:'integer',minimum:1,maximum:100,default:50},offset:{...I,maximum:1000000}},date=S(64),defs={};
defs.attribute_value=O({id:nullable(S(256)),name:S(),value:S(),struct:nullable(O({number:N,unit:S(64)},['number','unit']))});
defs.attribute=O({id:S(128),name:S(256),value_id:nullable(S(256)),value_name:nullable(S()),value_struct:nullable(O({number:N,unit:S(64)})),values:nullable(A(ref('attribute_value')))},[]);
defs.picture=O({id},['id']);defs.description=O({plain_text:S(50000)},['plain_text']);
defs.destination=O({site_id:enumid,logistic_type:E('remote','fulfillment','cross_docking'),listing_type_id:S(64),net_proceeds:money,price:money,official_store_id:int64},['site_id','logistic_type']);
defs.location=O({store_id:id,network_node_id:id,quantity:I},['store_id','network_node_id','quantity']);
defs.listing_site=O({listing_id:id,family_name:S(256),description:ref('description'),category_id:id,net_proceeds:money,official_store_id:{anyOf:[int64,S(32)]},listing_type_id:S(64),status:E('active','paused','closed'),deleted:B,sale_terms:A(ref('attribute')),marketplace:O({free_shipping:B},['free_shipping'])},['listing_id']);
defs.up_create=O({family_name:S(256),sites_to_sell:A(ref('destination'),10,1),attributes:A(ref('attribute'),100,1),pictures:A(ref('picture'),50,1),category_id:id,currency_id:{const:'USD',type:'string'},price:money,global_net_proceeds:money,available_quantity:I,description:ref('description'),sale_terms:A(ref('attribute'))},['family_name','sites_to_sell','attributes','pictures','category_id','currency_id']);defs.up_create.anyOf=[{required:['price']},{required:['global_net_proceeds']}];
defs.up_add_variant=O({sites_to_sell:A(ref('destination'),10,1),global_net_proceeds:money,price:money,currency_id:{const:'USD',type:'string'},available_quantity:I,description:ref('description'),pictures:A(ref('picture'),50,1),attributes:A(ref('attribute'),100,1),sale_terms:A(ref('attribute'))},['sites_to_sell','pictures','attributes']);
defs.up_update=O({family_name:S(256),attributes:A(ref('attribute')),pictures:A(ref('picture'),50,1),domain_id:id,global_net_proceeds:money,available_quantity:I,listing_sites:A(ref('listing_site'),10,1),locations:A(ref('location'),10,1),status:E('active','paused'),deleted:{const:true,type:'boolean'} });defs.up_update.minProperties=1;defs.up_update.not={required:['status','deleted']};
defs.family_common=O({family_name:S(256),description:ref('description'),attributes:A(ref('attribute')),status:E('active','paused'),deleted:{const:true,type:'boolean'}});defs.family_common.minProperties=1;defs.family_common.not={required:['status','deleted']};
defs.variant=O({up_global_id:id,global_net_proceeds:money,available_quantity:I,attributes:A(ref('attribute')),pictures:A(ref('picture'),50,1),listing_sites:A(ref('listing_site'),10,1),locations:A(ref('location'),10,1)},['up_global_id']);defs.variant.minProperties=2;
defs.family_update=O({common_data:ref('family_common'),variants:A(ref('variant'),10,1)});defs.family_update.minProperties=1;
defs.geo=O({id:S(64),name:S(128)},['id','name']);defs.pickup=O({address_line:S(1024),zip_code:{type:'string',pattern:'^[0-9]{6}$'},phone:S(64),city:ref('geo'),state:ref('geo'),country:ref('geo'),additional_info:S(256)},['address_line','zip_code','city','state','country','additional_info']);
defs.automation=O({rule_id:E('INT','INT_EXT'),min_price:money,max_price:money},['rule_id','min_price']);
defs.chart_row=O({id:S(128),sites:A(S(8),10,1),attributes:A(ref('attribute'),100,1)},['sites','attributes']);
const chartNames=O(Object.fromEntries(['CBT','MLM','MLB','MLC','MCO'].map(k=>[k,S(60)])));chartNames.minProperties=1;
const mainAttr=O({attributes:A(O({site_id:S(8),id},['site_id','id']),10,1)},['attributes']);
defs.chart=O({names:chartNames,domain_id:id,site_id:{type:'string',const:'CBT'},type:E('SPECIFIC','BRAND'),main_attribute:mainAttr,secondary_attribute:mainAttr,attributes:A(ref('attribute'),100,1),rows:A(ref('chart_row'),25,1),measure_type:E('BODY_MEASURE','CLOTHING_MEASURE','MIXED_MEASURE')},['names','domain_id','site_id','type','main_attribute','attributes','rows']);
const methods={};
function add(method,route,risk,slug,description,query={},body,extra={}){
 const props={},required=[],pathProps={};for(const m of route.matchAll(/\{([^}]+)\}/g))if(m[1]!=='bound_user_id')pathProps[m[1]]=/^(?:order|shipment|pack|question|claim|family|return|campaign|advertiser|ad_group|line_item)_id$/.test(m[1])?numid:id;
 if(Object.keys(pathProps).length){props.path=O(pathProps,Object.keys(pathProps));required.push('path');}
 if(Object.keys(query).length)props.query=O(query,extra.query_required||[]);if(extra.query_required?.length)required.push('query');
 if(body){props.body=body;required.push('body');}
 const action='api.'+method.toLowerCase()+'.'+route.split('/').filter(Boolean).map(v=>v.replace(/[{}]/g,'')).join('.').replace(/-/g,'_');
 if(methods[action])throw Error('Duplicate '+action);
 methods[action]={action,method,path:route,risk,description:description+' Global Selling main OAuth; provider checks business eligibility. Full response fields are retained within the response bound.',source:'https://global-selling.mercadolibre.com/devsite/en_us/'+slug,source_page:slug,input_schema:O(props,required),...extra};return methods[action];
}
const read=(route,slug,d,q={},x={})=>add('GET',route,'R',slug,d,q,undefined,x);
read('/users/me','manage-users-global-selling','Read the authenticated main merchant profile.');
read('/marketplace/users/{bound_user_id}','items-and-searches-global-selling','Read the bound main merchant and its authorized marketplace mapping.');
read('/marketplace/users/cap','global-listing','Read current listing capacity by marketplace and logistics.');
read('/marketplace/users/{bound_user_id}/items/search','items-and-searches-global-selling','Search global listings under the bound main merchant.',{...page,q:S(1024),category_id:id,status:A(E('pending','active','paused','deleted','inactive'),10,1),search_type:E('search','scan'),scroll_id:S(8192),sku:S(256),seller_sku:S(256),missing_product_identifiers:B,reputation_health_gauge:E('unhealthy','warning','healthy'),include_filters:B,orders:S(128),listing_type_id:S(64),labels:S(128)});
read('/marketplace/items/{item_id}','global-listing','Read global or local item, including its CBT owner mapping.');
read('/items/{item_id}/marketplace_items','items-and-searches-global-selling','Read authorized global-to-marketplace item mapping.');
read('/marketplace/items/{item_id}/description','item-description','Read full plain-text item description.');
add('POST','/global/items','H','price-per-variation-cbt','Publish a User Product and its marketplace sales conditions. Requires user_product_seller. Title and variations are not accepted.',{},ref('up_create'),{requirement:'user_product_seller'});
add('POST','/global/user-products/families','H','price-per-variation-cbt','Create up to ten User Product variations; same family_name groups a family.',{},A(ref('up_create'),10,1),{requirement:'user_product_seller'});
add('POST','/global/user-products/{user_product_id}','H','price-per-variation-cbt','Add marketplaces to an existing siteless User Product.',{},O({sites_to_sell:A(ref('destination'),10,1)},['sites_to_sell']),{requirement:'user_product_seller'});
add('POST','/global/user-products/families/{family_id}','H','price-per-variation-cbt','Add variations to an existing siteless family.',{},A(ref('up_add_variant'),10,1),{requirement:'user_product_seller'});
add('PUT','/global/user-products/{user_product_id}','D','price-per-variation-cbt','Update a User Product including delete, price, stock, pictures and all associated listings. Image lists replace existing lists; family fields may propagate asynchronously.',{},ref('up_update'),{requirement:'user_product_seller'});
add('PUT','/global/user-products/families/{family_id}','D','price-per-variation-cbt','Update or delete associated listings for a whole family. Stock available_quantity only supports cross_docking; other logistics use locations. Inspect every task and variant result.',{},ref('family_update'),{requirement:'user_product_seller'});
read('/user-products-families/tasks/{task_id}','price-per-variation-cbt','Read asynchronous task; finished does not imply every User Product succeeded.');
read('/sites/{site_id}/user-products-families/{family_id}','price-per-variation-cbt','Read family User Products.',{},{headers:{'X-API-Version':'2'}});
read('/user-products/{user_product_id}','price-per-variation-cbt','Read siteless User Product with locale and full version 2 fields.',{},{headers:{'X-API-Version':'2'}});
read('/marketplace/user-products/{user_product_id}/mapping','price-per-variation-cbt','Read a siteless User Product and its marketplace mapping.');
read('/marketplace/items/{item_id}/migration_live_listing','uptin-migration','Read the migrated live listing mapping.');
read('/marketplace/items/{item_id}/purchase_experience','shopping-experience','Read listing purchase experience.');
read('/marketplace/user_products/{user_product_id}/purchase_experience','shopping-experience','Read User Product purchase experience.');
read('/marketplace/items/catalog-forewarning','listing-required','Read listing catalog requirements.',{...page});
read('/marketplace/items/{item_id}/price_to_win','catalog-competition-gs','Read catalog competition and price to win.');
read('/marketplace/items/{item_id}/shipping_compensation','compensations','Read item shipping compensation.');
read('/marketplace/items/{item_id}/prices/automate/rules','manage-automations','Read eligible price automation rules.');
read('/marketplace/items/{item_id}/prices/automate','manage-automations','Read current price automation.');
add('POST','/marketplace/items/{item_id}/prices/automate','H','manage-automations','Enable price automation within the reviewed price bounds.',{},ref('automation'));
add('PUT','/marketplace/items/{item_id}/prices/automate','H','manage-automations','Update existing automation price bounds and rule.',{},ref('automation'));
// DELETE text and GET curl conflict is recorded; do not guess a destructive method.
read('/marketplace/items/{item_id}/prices/history','manage-automations','Read price history.',{days:{...I,minimum:1},page:I,size:{type:'integer',minimum:1,maximum:100,default:10}});
read('/marketplace/products/{product_id}/prices/automate/rules','manage-automations','Read catalog product automation rules. Requires eligible reputation.');
add('POST','/marketplace/items/{item_id}/prices/automate/by-product/{product_id}','H','manage-automations','Enable catalog product price automation; requires new eligible catalog item and reputation.',{},ref('automation'));
read('/marketplace/benchmarks/user/{bound_user_id}/items','pricing-reference','Read price reference items for the bound main merchant.');
read('/marketplace/benchmarks/items/{item_id}/details','pricing-reference','Read item benchmark details.');
read('/marketplace/orders/search','manage-orders-cbt','Search all marketplaces authorized by the main token; no incorrect main seller.id filter is added.',{...page,limit:{type:'integer',minimum:1,maximum:50,default:50},buyer:numid,'order.status':E('paid','cancelled','payment_required'),site:enumid,sort:E('date_asc','date_desc','updated_asc','updated_desc','closed_asc','closed_desc'),order:E('asc','desc'),scroll_id:S(8192),'date_created.from':date,'date_created.to':date,'last_updated.from':date,'last_updated.to':date,'date_closed.from':date,'date_closed.to':date,'mediations.stage':S(256)});
read('/marketplace/orders/{order_id}','manage-orders-cbt','Read an order including buyer, item, payment and shipment business fields.');
read('/marketplace/orders/pack/{pack_id}','packs','Read a unified pack.');
read('/marketplace/orders/{order_id}/billing_info','gs-billing-data','Read order billing information for fulfillment and invoicing.');
add('POST','/marketplace/orders/{order_id}/attributes','H','manage-orders-cbt','Set product information required for order dispatch, including Colombian phone IMEI.',{},O({name:{type:'string',const:'IMEI'},value:S(256)},['name','value']));
for(const suffix of ['', '/costs','/items','/sla','/lead_time','/history','/carrier','/compensation_costs'])read('/marketplace/shipments/{shipment_id}'+suffix,suffix==='/compensation_costs'?'compensations':'manage-shipments','Read shipment '+(suffix.slice(1)||'details')+'.',{}, {headers:{'x-format-new':'true'}});
add('POST','/marketplace/shipments/{shipment_id}/tracking','H','manage-shipments','Set tracking for remote custom shipping only.',{},O({tracking_id:S(256),tracking_url:S(2048),carrier:S(256)},['tracking_id','tracking_url','carrier']),{headers:{'x-format-new':'true'}});
add('POST','/marketplace/shipments/{shipment_id}/tracking/status','D','manage-shipments','Report final delivery status for custom shipping. not_delivered is irreversible.',{},O({tracking_id:S(256),status:E('delivered','not_delivered')},['tracking_id','status']),{headers:{'x-format-new':'true'}});
add('POST','/marketplace/shipments/{shipment_id}/split','H','manage-shipments','Split ME2 drop-off or cross-docking shipment into exactly two packages once. Include all original order quantities; fulfillment unsupported.',{},O({reason:E('FRAGILE','ANOTHER_WAREHOUSE','IRREGULAR_SHAPE','OTHER_MOTIVE','DIMENSIONS_EXCEEDED'),packs:{...A(O({orders:A(O({id:numid,quantity:{...I,minimum:1}},['id','quantity']),10,1)},['orders']),2,2)}},['reason','packs']),{headers:{'x-format-new':'true'},empty_ack:true});
read('/marketplace/shipments/dispatch_preferences/carriers','dispatch-information','Read dispatch preferences. Requires active Cainiao; empty response means none.',{},{empty_ack:true});
add('PUT','/marketplace/shipments/dispatch_preferences/carriers/{carrier_name}','H','dispatch-information','Choose pick-up or drop-off for active Cainiao; they are mutually exclusive.',{}, {oneOf:[O({pickup:{const:true,type:'boolean'}},['pickup']),O({drop_off_agency:S(128)},['drop_off_agency'])]},{empty_ack:true});
add('POST','/marketplace/shipments/dispatch_preferences/pick_up_addresses','H','dispatch-information','Set the full active-Cainiao pickup address. Chinese address must include province and city.',{},ref('pickup'),{empty_ack:true});
read('/marketplace/shipments/dispatch_preferences/pick_up_addresses','dispatch-information','Read the merchant pickup address.',{},{empty_ack:true});
read('/marketplace/questions/search','manage-questions-answers-global-selling','Search seller questions; unavailable to Model 6 sellers.',{...page,item:id,from:numid,status:E('UNANSWERED','ANSWERED','CLOSED_UNANSWERED','UNDER_REVIEW','BANNED','DELETED','DISABLED'),totalDivisions:{...I,minimum:1},division:I,sort_fields:A(E('item_id','seller_id','from_id','date_created'),4,1),sort_types:E('ASC','DESC')},{owned_query:{seller_id:'main'},model6_blocked:true});
read('/marketplace/questions/{question_id}','manage-questions-answers-global-selling','Read a question; unavailable to Model 6 sellers.',{},{model6_blocked:true});
add('POST','/marketplace/answers','H','manage-questions-answers-global-selling','Answer a buyer question; unavailable to Model 6 sellers.',{},O({question_id:int64,text:S(2000)},['question_id','text']),{model6_blocked:true});
add('DELETE','/marketplace/questions/{question_id}','D','manage-questions-answers-global-selling','Delete a question; unavailable to Model 6 sellers.',{},undefined,{model6_blocked:true,empty_ack:true});
read('/marketplace/messages/packs/{pack_id}','messaging-after-sale-global-selling','Read pack messages including authorized buyer correspondence.',page,{model6_blocked:true});
read('/marketplace/messages/{message_id}','messaging-after-sale-global-selling','Read a single message.',{},{model6_blocked:true});
read('/marketplace/messages/unread','pending-messages-gs','Read pending seller conversations; provider returns up to 1000.',{role:{type:'string',const:'seller'},tag:{type:'string',const:'post_sale'}},{model6_blocked:true});
add('POST','/marketplace/messages/packs/{pack_id}','H','messaging-after-sale-global-selling','Send post-sale message, with already uploaded attachment IDs. Respect platform first-contact reasons and Model 6 restriction.',{},O({text:S(3500),text_translated:S(3500),attachments:A(S(256),10)},['text']),{model6_blocked:true});
for(const suffix of ['', '/detail','/actions-history','/status-history','/affects-reputation','/returns','/messages','/expected-resolutions','/partial-refund/available-offers'])read('/marketplace/v2/claims/{claim_id}'+suffix,suffix==='/returns'?'manage-returns':suffix==='/messages'?'manage-claims-messages':suffix.startsWith('/expected')||suffix.startsWith('/partial')?'manage-claim-resolutions':'manage-claims','Read claim '+(suffix.slice(1)||'details')+'. Not available to Model 6 sellers.',{},{model6_blocked:true});
read('/marketplace/v2/claims/reasons/{reason_id}','manage-claims','Read claim reason details.',{},{model6_blocked:true});
add('POST','/marketplace/v2/claims/{claim_id}/expected-resolutions/partial-refund','H','manage-claim-resolutions','Offer an available percentage partial refund for a claim.',{},O({percentage:{type:'number',exclusiveMinimum:0,maximum:100}},['percentage']),{model6_blocked:true});
for(const suffix of ['expected-resolutions/refund','expected-resolutions/allow-return','actions/open-dispute'])add('POST','/marketplace/v2/claims/{claim_id}/'+suffix,'H','manage-claim-resolutions','Request claim '+suffix+'. Review available actions first.',{},undefined,{model6_blocked:true,empty_ack:true});
add('POST','/marketplace/v2/claims/{claim_id}/actions/send-message','H','manage-claims-messages','Send claim correspondence and existing evidence attachments.',{},O({receiver_role:E('complainant','mediator','respondent'),message:S(10000),attachments:A(S(256),10)},['receiver_role','message']),{model6_blocked:true});
read('/post-purchase/v1/claims/{claim_id}/attachments/{attachment_id}','manage-claims-messages','Read attachment metadata, not its binary content.',{},{model6_blocked:true});
read('/post-purchase/v1/returns/reasons','manage-returns','Read valid failed return-review reasons.',{flow:{type:'string',const:'seller_return_failed'},claim_id:numid},{query_required:['flow','claim_id'],model6_blocked:true});
read('/post-purchase/v1/claims/{claim_id}/charges/return-cost','manage-returns','Read return costs.',{},{model6_blocked:true});
const reviewFailure=O({reason:S(64),message:S(10000),attachments:A(S(256),10,1),order_id:int64},['reason','message']);reviewFailure.allOf=[{if:{properties:{reason:{enum:['SRF2','SRF4']}},required:['reason']},then:{required:['attachments']}}];
add('POST','/post-purchase/v1/returns/{return_id}/return-review','H','manage-returns','Confirm a successful return with {} or submit failed-review entries. order_id only for cart cases; SRF2/SRF4 require evidence.',{}, {oneOf:[O(),A(reviewFailure,10,1)]},{model6_blocked:true,empty_ack:true});
read('/global/users/seller_reputation','seller-reputation-global-selling','Read global and authorized marketplace seller reputation.');
read('/communications/notices','seller-news','Read seller news.',page);
read('/marketplace/moderations/infractions/{bound_user_id}','moderations-gs','Read merchant infractions.',{...page,date_created_since:date});
for(const suffix of ['/addresses','/accepted_payment_methods','/brands'])read('/users/{bound_user_id}'+suffix,suffix==='/brands'?'official-storesglobal-selling':'manage-users-global-selling','Read bound merchant '+suffix.slice(1)+'.');
read('/users/{bound_user_id}/brands/{brand_id}','official-storesglobal-selling','Read an official store brand authorized for the main merchant.');
read('/marketplace/domain_discovery/search','category-predictor','Predict CBT category and domain.',{q:S(1024)},{query_required:['q']});
read('/sites/CBT/categories','category-predictor','Read global catalog categories.');
for(const suffix of ['','/attributes','/technical_specs/input'])read('/categories/{category_id}'+suffix,suffix?'atributtes-global-selling':'category-predictor','Read category '+(suffix.slice(1)||'details')+'.');
read('/domains/{domain_id}/technical_specs','first-steps','Read domain technical specification.');
add('POST','/domains/{domain_id}/technical_specs','R','first-steps','Read dynamic size-chart specification for the supplied domain attributes.',{section:{type:'string',const:'grids'}},O({attributes:A(ref('attribute'),100,1)},['attributes']),{query_required:['section']});
read('/catalog/charts/CBT/configurations/active_domains','first-steps','Read size-chart enabled domains.');
add('POST','/catalog/charts/search','R','first-steps','Search charts for the bound main merchant; site is CBT.',{},O({domain_id:id,type:E('SPECIFIC','BRAND'),attributes:A(ref('attribute'),100,1)},['domain_id','attributes']),{owned_body:{site_id:'CBT',seller_id:'main'}});
add('POST','/catalog/charts','H','manage-size-chart','Create size guide with domain-required attributes, rows and measurements. Same token site CBT; list attributes use official value IDs.',{},ref('chart'));
read('/catalog/charts/{chart_id}','manage-size-chart','Read size guide.');
add('POST','/catalog/charts/{chart_id}/rows','H','manage-size-chart','Add size-guide row with domain measurement specification.',{},ref('chart_row'));
const chartUpdate=O({names:chartNames,rows:A(ref('chart_row'),10,1)});chartUpdate.minProperties=1;
add('PUT','/catalog/charts/{chart_id}','H','manage-size-chart','Update size guide names or existing rows.',{},chartUpdate);
add('DELETE','/catalog/charts/{chart_id}','D','manage-size-chart','Request size guide deletion. It must be unlinked from every item; verify chart_status INACTIVE.',{},undefined,{empty_ack:true});
read('/marketplace/sizechart/equivalences','manage-size-chart','Read fashion size equivalents.',{site_id:enumid,domain_id:id,gender:S(128)},{query_required:['domain_id','gender']});
read('/marketplace/products/search','products-search-gs','Search global catalog products.',{...page,q:S(1024),status:E('active','inactive'),product_identifier:S(128)});
read('/products/{product_id}','products-search-gs','Read catalog product and its relationships.');
for(const [route,slug] of [['/countries','location-global-selling'],['/countries/{country_id}','location-global-selling'],['/states/{state_id}','location-global-selling'],['/cities/{city_id}','location-global-selling'],['/currencies','design-considerations-global-selling'],['/currencies/{currency_id}','design-considerations-global-selling']])read(route,slug,'Read '+route.slice(1)+' metadata.');
for(const route of ['/sites/{site_id}/listing_types','/sites/{site_id}/listing_types/{listing_type_id}','/sites/{site_id}/listing_exposures','/sites/{site_id}/listing_exposures/{exposure_level}'])read(route,'listing-types-and-exposures','Read listing exposure metadata.');
read('/pictures/{picture_id}/errors','pictures','Read uploaded picture validation errors.');
read('/trends/{site_id}','trends-gs','Read marketplace trends.');read('/trends/{site_id}/{category_id}','trends-gs','Read category trends.');
read('/reviews/item/{item_id}','product-reviews','Read listing reviews.',{...page,limit:{...page.limit,default:5},catalog_product_id:id});
read('/multi-marketplace-tool/suggestions','multi-marketplace-tool','Read eligible suggestions for authorized destination marketplaces.',{...page,origin:A(enumid,10,1),destination:A(enumid,10,1)});
add('POST','/multi-marketplace-tool/suggestions','H','multi-marketplace-tool','Publish selected suggestions across the authorized marketplaces. Inspect per-item results and process status.',{},A(O({id,title:S(256),suggestions:A(ref('destination'),10,1)},['id','suggestions']),10,1));
read('/multi-marketplace-tool/suggestions/status/','multi-marketplace-tool','Read listing process statuses.');
read('/multi-marketplace-tool/suggestions/status/{process_id}','multi-marketplace-tool','Read a listing process and per-site results.');
read('/multi-marketplace-tool/config/automatic','multi-marketplace-tool','Read automatic cross-marketplace publication settings.');
add('PUT','/multi-marketplace-tool/config/automatic/','H','multi-marketplace-tool','Configure automatic publication in authorized marketplaces. Unspecified sites keep their configuration.',{},A(O({site_id:enumid,logistic_type:E('remote'),enabled:B},['site_id','logistic_type','enabled']),10,1));
read('/multi-marketplace-tool/suggestions/validate','multi-marketplace-tool','Read explanations for unrealized suggestions.');
// Child selectors are authorized using the same main grant's authoritative mapping, never new tokens.
read('/marketplace/inventories/{inventory_id}/stock/fulfillment','fulfillment-stock-gs','Read fulfillment inventory for a verified mapped seller; Mexico/Chile fulfillment eligibility.',{seller_id:numid,include_attributes:{type:'string',const:'conditions'}},{query_required:['seller_id'],child_query:['seller_id']});
read('/marketplace/stock/fulfillment/operations/search','fulfillment-stock-gs','Read fulfillment stock movements for a verified mapped seller.',{seller_id:numid,inventory_id:id,date_from:date,date_to:date,type:S(128),'external_references.shipment_id':numid,scroll:S(8192),limit:page.limit},{query_required:['seller_id','inventory_id','date_from','date_to'],child_query:['seller_id']});
read('/marketplace/stock/fulfillment/operations/{operation_id}','fulfillment-stock-gs','Read fulfillment operation for a verified mapped seller.',{seller_id:numid},{query_required:['seller_id'],child_query:['seller_id']});
read('/marketplace/v2/claims/search','manage-claims','Search claims for a verified mapped seller; Model 6 unsupported.',{...page,user_id:numid,date_created:date,last_updated:date,id:numid,order_id:numid,pack_id:numid,player_role:E('complainant','respondent','mediator'),player_user_id:numid,reason_id:id,resource:E('shipment','payment','order','purchase'),resource_id:numid,site_id:enumid,stage:E('claim','dispute','recontact','stale','none'),status:S(64),type:S(64),sort:S(128)},{query_required:['user_id'],child_query:['user_id'],model6_blocked:true});
read('/marketplace/users/{seller_id}/items/search','items-and-searches-global-selling','Search one marketplace seller verified by the bound main mapping.',{...page,q:S(1024),category_id:id,status:A(E('pending','active','paused','deleted','inactive'),10,1),search_type:E('search','scan'),scroll_id:S(8192),sku:S(256),seller_sku:S(256),missing_product_identifiers:B,reputation_health_gauge:E('unhealthy','warning','healthy'),include_filters:B,orders:S(128),listing_type_id:S(64),labels:S(128)},{child_path:['seller_id']});
read('/marketplace/sellers/{seller_id}/working_days','manage-shipments','Read holidays for a marketplace seller verified under the bound main merchant.',{},{child_path:['seller_id']});
add('PUT','/marketplace/sellers/{seller_id}/working_days','H','manage-shipments','Set holiday work choices for a verified marketplace seller, at least four days ahead. Closed/finalized/mandatory dates cannot be changed.',{},O({dates:A(O({date:{type:'string',pattern:'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'},checked:B},['date','checked']),10,1),site_id:enumid},['dates']),{child_path:['seller_id'],empty_ack:true});
read('/messages/packs/{pack_id}/sellers/{seller_id}','pending-messages-gs','Read messages for a verified marketplace seller without marking them read.',{...page,tag:{type:'string',const:'post_sale'}},{child_path:['seller_id'],fixed_query:{mark_as_read:'false'},model6_blocked:true});
read('/advertising/advertisers','new-product-ads','List advertisers accessible to the same merchant grant. PADS must be activated; DISPLAY requires Commercial Advisor enablement.',{product_id:E('PADS','DISPLAY'),sort_by:E('advertiser_id','site_id'),sort_order:E('asc','desc')},{query_required:['product_id'],headers:{'Api-Version':'1'}});
const adsbase='/marketplace/advertising/{site_id}',advbase=adsbase+'/advertisers/{advertiser_id}/product_ads',adsExtra={advertising:'PADS',headers:{'api-version':'2'}};
const metricNames='clicks prints ctr cost cpc acos organic_units_quantity organic_units_amount organic_items_quantity direct_items_quantity indirect_items_quantity advertising_items_quantity cvr roas sov direct_units_quantity indirect_units_quantity units_quantity direct_amount indirect_amount total_amount impression_share top_impression_share lost_impression_share_by_budget lost_impression_share_by_ad_rank acos_benchmark tacos'.split(' ');
const metrics=A(E(...metricNames,...metricNames.map(s=>s.toUpperCase())),40,1),metricQuery={date_from:date,date_to:date,metrics,metrics_summary:B};
const campaignFields={name:S(256),status:E('active','paused'),budget:money,strategy:E('profitability','increase','visibility'),channel:{type:'string',const:'marketplace'},roas_target:{type:'number',minimum:1,maximum:35}};
add('POST',advbase+'/campaigns','H','new-product-ads','Create a Product Ads campaign. Daily budget may spend up to twice its daily average using unused balance. Advertiser is verified under the same grant.',{},O(campaignFields,['name','status','budget','strategy','roas_target']),adsExtra);
const campaignUpdate=O(Object.fromEntries(Object.entries(campaignFields).filter(([k])=>k!=='channel')));campaignUpdate.minProperties=1;
add('PUT',adsbase+'/product_ads/campaigns/{campaign_id}','H','new-product-ads','Update advertising campaign budget, target and status for an authorized advertiser.',{},campaignUpdate,adsExtra);
read(advbase+'/campaigns/search','new-product-ads','Search authorized advertiser campaigns and optional metrics.',{...page,...metricQuery,aggregation:S(32),aggregation_type:S(32),'filters[campaign_ids]':A(numid,100,1),'filters[campaign_id]':numid,'filters[status]':A(E('active','paused','deleted'),3,1),'filters[channel]':{type:'string',const:'marketplace'}},adsExtra);
read(adsbase+'/product_ads/campaigns/{campaign_id}','new-product-ads','Read authorized advertiser campaign and metrics.',metricQuery,adsExtra);
read(advbase+'/ad_groups/search','new-product-ads','Search current Ad Groups and metrics; use plural filters[item_ids].',{...page,...metricQuery,'filters[item_ids]':A(id,100,1),sort:E('asc','desc'),sort_by:S(64)},adsExtra);
read(adsbase+'/product_ads/ad_groups/{ad_group_id}','new-product-ads','Read current Ad Group and metrics.',{...metricQuery,channel:{type:'string',const:'marketplace'},'filters[campaign_id]':A(numid,100,1),aggregation_type:E('adgroup','daily')},adsExtra);
const adChange=O({status:E('active','paused'),campaign_id:int64});adChange.minProperties=1;
add('PUT',adsbase+'/product_ads/ad_groups/{ad_group_id}','H','new-product-ads','Move or update an Ad Group, applying to all linked variants. Both current and destination campaign advertisers are verified.',{},adChange,adsExtra);
add('PUT',advbase+'/ad_groups','H','new-product-ads','Move or update up to ten Ad Groups under the same authorized advertiser.',{},O({ad_groups:A(int64,10,1),status:E('active','paused'),campaign_id:int64},['ad_groups','status','campaign_id']),adsExtra);
add('DELETE',adsbase+'/product_ads/campaigns/{campaign_id}/ad_groups/{ad_group_id}','D','new-product-ads','Remove one Ad Group from an authorized campaign.',{},undefined,{...adsExtra,empty_ack:true});
add('DELETE',adsbase+'/product_ads/campaigns/{campaign_id}/ad_groups','D','new-product-ads','Remove up to ten Ad Groups from an authorized campaign.',{},O({ad_groups:A(int64,10,1)},['ad_groups']),{...adsExtra,empty_ack:true});
read(adsbase+'/product_ads/campaigns/{campaign_id}/ad_groups/metrics','new-product-ads','Read campaign Ad Group metrics; multi-day ranges require explicit group filters.',{...metricQuery,'filters[ad_group_ids]':A(numid,100,1)},{...adsExtra,query_required:['date_from','date_to']});
read(adsbase+'/product_ads/ad_groups/{ad_group_id}/ads','new-product-ads','Read the ads of a current Ad Group with metrics.',{...page,...metricQuery},adsExtra);
const displaybase='/advertising/advertisers/{advertiser_id}/display',displayExtra={advertising:'DISPLAY',headers:{'Api-Version':'1'}},sorts={sort_by:E('id','name','start_date','end_date'),sort_order:E('asc','desc')};
read(displaybase+'/campaigns','display-gs','Read advisor-enabled Display campaigns for a same-grant advertiser.',sorts,displayExtra);
read(displaybase+'/campaigns/{campaign_id}/metrics','display-gs','Read Display campaign daily metrics; maximum date range is 90 days.',{...sorts,date_from:date,date_to:date},{...displayExtra,query_required:['date_from','date_to']});
read(displaybase+'/campaigns/{campaign_id}/line_items','display-gs','Read Display campaign line items.',sorts,displayExtra);
read(displaybase+'/campaigns/{campaign_id}/line_items/{line_item_id}/creatives','display-gs','Read Display line-item creative metadata.',{sort_by:E('id','name','start_date'),sort_order:E('asc','desc')},displayExtra);
read(displaybase+'/metrics','display-gs','Read Display line-item or creative metrics for up to 90 days.',{dimension:E('line_items','creatives'),date_from:date,date_to:date,campaign_id:numid,line_item_id:numid,ids:A(numid,100,1)},{...displayExtra,query_required:['dimension','date_from','date_to']});

read('/users/{bound_user_id}','manage-users-global-selling','Read the bound Global main account profile.');
read('/items/{item_id}','items-and-searches-global-selling','Read global listing fields.');
read('/items','items-and-searches-global-selling','Read up to 100 global listings; optional projection fields.',{ids:A({...id,pattern:'^CBT[0-9]+$'},100,1),attributes:A(S(128),100,1)},{query_required:['ids'],receipt:'multiget'});
read('/items/{item_id}/catalog_listing_eligibility','catalog-eligibility-gs','Check existing listing catalog eligibility.');
read('/multiget/catalog_listing_eligibility','catalog-eligibility-gs','Check catalog eligibility for a bounded set of global items.',{ids:A({...id,pattern:'^CBT[0-9]+$'},100,1)},{query_required:['ids'],receipt:'multiget'});
add('POST','/items/catalog_listings','H','catalog-listing-gs','Opt an eligible existing global item into an exact catalog product; synchronized conditions cannot be opted out.',{},O({item_id:{...id,pattern:'^CBT[0-9]+$'},variation_id:int64,catalog_product_id:{...id,pattern:'^CBT[0-9]+$'}},['item_id','catalog_product_id']));
read('/item/{item_id}/performance','listings-quality-gs','Read current listing performance, including quality objectives and actions.');
for(const suffix of ['available_listing_types','available_upgrades','available_downgrades'])read('/items/{item_id}/'+suffix,'listing-types-and-exposures','Read item '+suffix+'.');
read('/users/{bound_user_id}/available_listing_types','listing-types-and-exposures','Read available listing types for the bound main account.',{category_id:id},{query_required:['category_id']});
read('/users/{bound_user_id}/available_listing_type/free','listing-types-and-exposures','Read free listing eligibility for the bound main account.',{category_id:id},{query_required:['category_id']});
read('/orders/{order_id}/shipments','manage-orders-cbt','Read current hosted order shipment relationships; always process the returned array.',{hosted:B,list:B,list_all:B},{headers:{'X-New-Domain':'true'}});
read('/shipments/{shipment_id}/orders','manage-shipments','Read shipment orders using the current domain.',{}, {headers:{'X-New-Domain':'true','x-format-new':'true'}});
read('/visits/items','visits','Read total visits for one local marketplace item; CBT items are unsupported.',{ids:A({type:'string',pattern:'^ML[A-Z][0-9]+$|^MCO[0-9]+$|^MPE[0-9]+$'},1,1)},{query_required:['ids'],ack_dynamic_key:'ids'});
read('/items/visits','visits','Read visits in an ordered date range of at most 150 days for one local item.',{ids:A({type:'string',pattern:'^ML[A-Z][0-9]+$|^MCO[0-9]+$|^MPE[0-9]+$'},1,1),date_from:date,date_to:date},{query_required:['ids','date_from','date_to']});
read('/items/{item_id}/visits/time_window','visits','Read dated local item visits; at most 150 days.',{last:{type:'integer',minimum:1,maximum:150},unit:{type:'string',const:'day'},ending:{type:'string',pattern:'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'}},{query_required:['unit']});
for(const row of Object.values(methods))if(row.path.endsWith('/shipping_compensation')||row.path.endsWith('/compensation_costs'))row.input_schema.properties.query=O({weight_unit:E('g','kg','lb','oz'),dimensions_unit:E('mm','cm','m','in','ft')});

read('/users/{bound_user_id}/items/search','catalog-eligibility-gs','Search catalog or eligible global items owned by the bound main merchant.',{...page,catalog_listing:B,tags:{type:'string',const:'catalog_listing_eligible'}});
read('/orders/{order_id}','manage-orders-cbt','Read the current order representation including gross-price fields.');
read('/marketplace/items/{item_id}/shipping_options/cost','manage-shipments','Read an active marketplace listing shipping cost.');
const sourceDir=process.argv[2]&&process.argv[2]!=='--pinned'?process.argv[2]:null,output=process.argv[3]||path.resolve(__dirname,'../bin/mercado-libre-api-contracts.cjs');
const pinned=sourceDir?null:JSON.parse(fs.readFileSync(path.resolve(__dirname,'../test/fixtures/connectors/official-contracts/mercado-libre-20261001.json'),'utf8')).response_acknowledgements;
const decode=s=>s.replace(/<[^>]*>/g,'').replace(/&(quot|apos|lt|gt|amp|nbsp);|&#(x[0-9a-f]+|[0-9]+);/gi,(m,k,n)=>n?String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n)):({quot:'"',apos:"'",lt:'<',gt:'>',amp:'&',nbsp:' '})[k.toLowerCase()]);
// Associate response examples with their documented method and URL, not arbitrary nested metadata.
for(const row of Object.values(methods)){
 const p=sourceDir?JSON.parse(fs.readFileSync(path.join(sourceDir,row.source_page+'.json'),'utf8')):{content:''};
 const pattern=new RegExp('^'+row.path.split('/').map(v=>v.startsWith('{')?'[^/?]+':v.replace(/[.]/g,'\\.')).join('/')+'/?$');
 let matching=false;const keys=new Set();row.ack_array=false;
 for(const m of p.content.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi)){
  const text=decode(m[1]).trim();
  if(/curl\b/.test(text)){
   const method=(text.match(/(?:-X|--request)\s+([A-Z]+)/)||[])[1]||(/(?:--data|-d)\s/.test(text)?'POST':'GET');
   const urls=[...text.matchAll(/https?:\/\/api\.mercadolibre\.com([^\s'"<>]*)/g)].map(x=>x[1].split('?')[0]);
   matching=method===row.method&&urls.some(u=>pattern.test(u));continue;
  }
  if(!matching)continue;let value;try{value=JSON.parse(text);}catch{continue;}
  if(Array.isArray(value)){row.ack_array=true;continue;}
  if(!value||typeof value!=='object'||value.error||Number(value.status)>=400||Number(value.code)>=400)continue;
  for(const k of Object.keys(value))if(!['request_id','message','error','cause','code','status'].includes(k))keys.add(k);
  if(value.status==='success')keys.add('status');
 }
 row.ack_keys=[...keys].sort();if(pinned&&pinned[row.action])Object.assign(row,pinned[row.action]);
 if(row.path.startsWith('/global/user-products')||row.path==='/global/items'){row.receipt='up';row.ack_keys=row.path==='/global/items'||row.method==='POST'?['item_id','siteless_user_product_id']:['id','family_id','variants','listing_sites','task_id'];row.ack_array=row.path.includes('/families')&&row.method==='POST';}
 if(row.path==='/user-products-families/tasks/{task_id}'){row.receipt='task';row.ack_keys=['task_id','user_products'];}
 if(row.path.startsWith('/multi-marketplace-tool'))row.receipt='suggestions';
 if(row.advertising&&row.method!=='GET')row.receipt='ad_bulk';
}
const ackOverrides={
 'GET /orders/{order_id}':{ack_keys:['id','order_items']},
 'GET /marketplace/items/{item_id}/shipping_options/cost':{ack_keys:['shipping_fee','billable_weight']},
 'GET /items/{item_id}':{ack_keys:['id']},
 'GET /users/{bound_user_id}':{ack_keys:['id']},
 'GET /visits/items':{ack_keys:[],ack_dynamic_key:'ids'},
 'GET /user-products/{user_product_id}':{ack_keys:['id','family_id']},
 'GET /marketplace/items/catalog-forewarning':{ack_keys:['results','paging']},
 'GET /marketplace/items/{item_id}/price_to_win':{ack_keys:['item_id','price_to_win']},
 'GET /marketplace/items/{item_id}/shipping_compensation':{ack_keys:['dimension_by','package']},
 'POST /marketplace/items/{item_id}/prices/automate/by-product/{product_id}':{ack_keys:['item_id','item_rule']},
 'GET /marketplace/shipments/{shipment_id}':{ack_keys:['id'],ack_array:false},
 'GET /marketplace/shipments/{shipment_id}/lead_time':{ack_keys:['option_id','shipping_method','estimated_delivery_time']},
 'GET /marketplace/shipments/{shipment_id}/compensation_costs':{ack_keys:['dimension_by','package']},
 'POST /marketplace/v2/claims/{claim_id}/actions/send-message':{ack_http:[201],empty_ack:true},
 'GET /catalog/charts/CBT/configurations/active_domains':{ack_array:true},
 'GET /currencies/{currency_id}':{ack_keys:['id','symbol']},
 'GET /pictures/{picture_id}/errors':{ack_keys:['id'],business_error_resource:true},
 'GET /multi-marketplace-tool/suggestions':{ack_array:true},
 'PUT /multi-marketplace-tool/config/automatic/':{ack_array:true},
 'GET /advertising/advertisers':{ack_keys:['advertisers']},
 'GET /advertising/advertisers/{advertiser_id}/display/campaigns/{campaign_id}/line_items/{line_item_id}/creatives':{ack_keys:['results']},
 'DELETE /catalog/charts/{chart_id}':{ack_message:"Before removing the size chart, we'll check that it isn't linked to any listing."},
 'PUT /marketplace/sellers/{seller_id}/working_days':{ack_message:'all working days were saved'},
 'POST /marketplace/shipments/{shipment_id}/tracking':{ack_values:{status:['success']}},
 'POST /marketplace/shipments/{shipment_id}/tracking/status':{ack_values:{status:['success']}}
};
const deferredResponseRoutes=new Set(['POST /marketplace/messages/packs/{pack_id}','POST /catalog/charts/{chart_id}/rows','PUT /catalog/charts/{chart_id}']);
for(const row of Object.values(methods)){
 const key=row.method+' '+row.path;if(deferredResponseRoutes.has(key)){delete methods[row.action];continue;}
 Object.assign(row,ackOverrides[key]||{});
 const listKeys=['results','questions','messages','advertisers','processes','global_items','dates'];row.resource_key=listKeys.find(k=>row.ack_keys.includes(k))||null;
 if(!row.ack_keys.length&&!row.ack_array&&!row.empty_ack&&!row.ack_message&&!row.ack_http&&!row.ack_dynamic_key)throw Error('Unreviewed acknowledgement '+key);
}

function refs(v,s=new Set()){if(!v||typeof v!=='object')return s;if(v.$ref){const key=v.$ref.slice(8);if(!s.has(key)){s.add(key);refs(defs[key],s);}}for(const x of Object.values(v))if(x!==v.$ref)if(Array.isArray(x))x.forEach(y=>refs(y,s));else refs(x,s);return s;}
for(const row of Object.values(methods))row.input_definitions=[...refs(row.input_schema)].sort();
const result={version:1,provider:'mercado_libre',source_format:'official HTML tables and reviewed request examples; no public complete OpenAPI',methods,definitions:defs};const content="'use strict';\n// Generated by generate-mercado-libre-api-contracts.cjs from reviewed official Global Selling documentation.\nmodule.exports="+JSON.stringify(result)+';\n';fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,content);console.log(JSON.stringify({operations:Object.keys(methods).length,definitions:Object.keys(defs).length,sha256:crypto.createHash('sha256').update(content).digest('hex'),bytes:Buffer.byteLength(content)}));
