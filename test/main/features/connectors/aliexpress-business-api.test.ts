import {createRequire} from 'node:module';
import {createHash,createHmac} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
const require=createRequire(import.meta.url),api=require('../../../../bin/aliexpress-business-api.cjs');
const config=()=>({provider:'aliexpress',metadata:{},credentials:{provider:'aliexpress',app_key:'fixture-app',app_secret:'fixture-secret',access_token:'fixture-token',refresh_token:'fixture-refresh',seller_id:'123',expires_at:Date.now()+3600000,refresh_expires_at:Date.now()+7200000,identity:{seller_id:'123',shop_id:'456',app_fingerprint:createHash('sha256').update('fixture-app').digest('hex')}}});
function fixture(reply:(method:string,p:URLSearchParams)=>unknown){const calls:any[]=[];vi.stubGlobal('fetch',vi.fn(async(url:any,init:any)=>{expect(String(url)).toBe('https://api-sg.aliexpress.com/sync');expect(init.redirect).toBe('error');const p=new URLSearchParams(init.body);expect(p.get('session')).toBe('fixture-token');expect(p.get('simplify')).toBe('true');const signed=Object.fromEntries(p);expect(p.get('sign')).toBe(createHmac('sha256','fixture-secret').update(Object.keys(signed).filter(k=>k!=='sign').sort().map(k=>k+signed[k]).join('')).digest('hex').toUpperCase());calls.push({method:p.get('method'),p});const r=reply(p.get('method')!,p);return r instanceof Response?r:new Response(JSON.stringify({code:'0',...r as object}));}));return calls;}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
it('describes current merchant fields without enabling other channel identities or retired maintenance APIs',()=>{
 const a=api.actionsFor();expect(Object.keys(a)).toHaveLength(215);const list=a['aliexpress.postproduct.redefining.findproductinfolistquery'].input_schema.properties.aeop_a_e_product_list_query.properties;expect(list).toHaveProperty('audit_failure_reason');expect(list).toHaveProperty('turkey_rep_id');expect(a['aliexpress.merchant.profile.get'].input_schema.properties).not.toHaveProperty('channel_seller_id');expect(a).not.toHaveProperty('aliexpress.carmodel.sixlevel.query');expect(a).not.toHaveProperty('aliexpress.postproduct.redefining.findaeproductprohibitedwords');expect(a['aliexpress.offer.product.delete'].risk).toBe('D');expect(a['aliexpress.trade.seller.order.acceptcancel'].risk).toBe('H');
 const v=new(require('@modelcontextprotocol/sdk/validation/ajv').AjvJsonSchemaValidator)();for(const s of Object.values(a)as any[])v.getValidator(s.input_schema);
});
it('preserves exact nested numeric IDs and escaped text on the signed wire and full business response',async()=>{
 const id='9007199254740993',subject='quoted" \\ text';const calls=fixture((_m,p)=>{expect(p.get('aeop_a_e_product_list_query')).toContain('"product_id":9007199254740993');expect(p.get('aeop_a_e_product_list_query')).toContain('"excepted_product_ids":[9007199254740995]');expect(JSON.parse(p.get('aeop_a_e_product_list_query')!).subject).toBe(subject);return new Response('{"code":"0","result":{"success":true,"current_page":1,"product_count":1,"aeop_a_e_product_display_d_t_o_list":[{"product_id":9007199254740993,"buyer_email":"buyer@example.test","description":"fixture-token"}]}}');});
 const r=await api.execute(config(),'aliexpress.postproduct.redefining.findproductinfolistquery',{aeop_a_e_product_list_query:{product_status_type:'onSelling',product_id:id,excepted_product_ids:['9007199254740995'],subject,page_size:1}});expect(r.data.result.aeop_a_e_product_display_d_t_o_list[0]).toEqual({product_id:id,buyer_email:'buyer@example.test',description:'[redacted]'});expect(calls).toHaveLength(1);
 for(const product_id of ['0001','9223372036854775808',9007199254740992])await expect(api.execute(config(),'aliexpress.offer.product.query',{product_id})).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(calls).toHaveLength(1);
});
it('keeps arbitrary documented customization JSON and numeric property-map identifiers intact',()=>{
 const c=api.build(config(),'aliexpress.product.customize.template.save',{name:'Template',components:[{attributes:{ownerId:'business value',nested:{color:'red'},count:2},name:'Card'}]});expect(JSON.parse(c.form.content)[0].attributes).toEqual({ownerId:'business value',nested:{color:'red'},count:2});expect(c.form).not.toHaveProperty('components');
 const q=api.build(config(),'aliexpress.category.itemQualification.list',{category_id:'123',custom_property:{properties:{'366':['9007199254740993']}}});expect(q.form.custom_property).toContain('"366":[9007199254740993]');expect(()=>api.build(config(),'aliexpress.category.itemQualification.list',{category_id:'123',custom_property:{properties:{'366.foo':['9007199254740993']}}})).toThrow();
});
it('prechecks exact SKU ownership and writes replacement stock once with a matching receipt',async()=>{
 let quantity=7;const calls=fixture((m,p)=>{if(m==='aliexpress.offer.product.query')return{result:{product_id:'9007199254740993',aeop_ae_product_s_k_us:[{id:'14:1;5:2',ipm_sku_stock:quantity}]}};quantity=Number(p.get('ipm_sku_stock'));return{result:{success:true,modify_count:1,product_id:'9007199254740993'}};});
 const r=await api.execute(config(),'aliexpress.postproduct.redefining.editsingleskustock',{product_id:'9007199254740993',sku_id:'14:1;5:2',ipm_sku_stock:0});expect(r.status).toBe('acknowledged');expect(quantity).toBe(0);expect(calls.map(c=>c.method)).toEqual(['aliexpress.offer.product.query','aliexpress.postproduct.redefining.editsingleskustock']);
 await expect(api.execute(config(),'aliexpress.postproduct.redefining.editsingleskustock',{product_id:'9007199254740993',sku_id:'wrong',ipm_sku_stock:1})).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(calls.filter(c=>c.method.endsWith('editsingleskustock'))).toHaveLength(1);
});
it('rejects misleading stock receipt and does not retry an uncertain write',async()=>{
 let bad=true;const calls=fixture(m=>m==='aliexpress.offer.product.query'?{result:{product_id:11,aeop_ae_product_s_k_us:[{id:'<none>'}]}}:bad?{result:{success:true,product_id:12,modify_count:1}}:new Response('provider private text',{status:503}));
 const p={product_id:11,sku_id:'<none>',ipm_sku_stock:1};await expect(api.execute(config(),'aliexpress.postproduct.redefining.editsingleskustock',p)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});bad=false;await expect(api.execute(config(),'aliexpress.postproduct.redefining.editsingleskustock',p)).rejects.toMatchObject({code:'storefront_upstream_error'});expect(calls).toHaveLength(4);
});
it('reports partial product batches with exact failure targets and safe diagnostics',async()=>{
 const calls=fixture(()=>({result:{success:true,modify_count:1,product_id:11,error_details:[{product_ids:[12],error_code:'FAIL',error_message:'private upstream details'}]}}));const r=await api.execute(config(),'aliexpress.postproduct.redefining.onlineaeproduct',{product_ids:'11;12'});expect(r.status).toBe('partial_or_failed');expect(r.data.result.error_details).toEqual([{product_ids:[12],error_code:'FAIL'}]);expect(calls).toHaveLength(1);
});
it('does not treat a missing or duplicate child shipment receipt as a complete shipment',async()=>{
 const calls=fixture(()=>({result:{success:true,sub_trade_order_list:[{sub_trade_order_index:1,shipment_list:[{logistics_no:'TRACK1',service_name:'EMS'}]}]}}));const shipment_list=[{logistics_no:'TRACK1',service_name:'EMS'}];await expect(api.execute(config(),'aliexpress.logistics.order.shipment',{param_aeop_seller_shipment_sub_trade_order_request:{trade_order_id:'9007199254740993',sub_trade_order_list:[{sub_trade_order_index:1,send_type:'all',shipment_list},{sub_trade_order_index:2,send_type:'all',shipment_list}]}})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(calls).toHaveLength(1);
});
it('keeps limited receipts explicitly accepted and exposes a readback action',async()=>{
 fixture(()=>({result:{error_code:0}}));const r=await api.execute(config(),'aliexpress.merchant.redefining.saveremark',{remark_id:11,content:'Business note'});expect(r.status).toBe('accepted');expect(r.follow_up.action).toBe('aliexpress.merchant.redefining.queryremark');
});
it('rejects channel substitution, oversized batches and tampered grants before sending credentials',async()=>{
 const calls=fixture(()=>({profile:{seller_id:123}}));await expect(api.execute(config(),'aliexpress.merchant.profile.get',{channel_seller_id:'999'})).rejects.toMatchObject({code:'E_BAD_INPUT'});await expect(api.execute(config(),'aliexpress.postproduct.redefining.onlineaeproduct',{product_ids:Array.from({length:11},(_,i)=>String(i+1)).join(';')})).rejects.toMatchObject({code:'E_BAD_INPUT'});const c=config();c.credentials.identity.seller_id='456';await expect(api.execute(c,'aliexpress.merchant.profile.get')).rejects.toThrow();expect(calls).toHaveLength(0);
});
it('rejects provider account mismatches and unsafe numeric responses',async()=>{
 let unsafe=false;const calls=fixture(()=>unsafe?new Response('{"code":"0","profile":{"seller_id":9.007199254740993e15}}'):{profile:{seller_id:456}});await expect(api.execute(config(),'aliexpress.merchant.profile.get')).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});unsafe=true;await expect(api.execute(config(),'aliexpress.merchant.profile.get')).rejects.toThrow();expect(calls).toHaveLength(2);
});
it('requires business resources and typed declared fields rather than accepting a success-only read',async()=>{
 const replies=[{success:true},{success:true,aeop_post_category_list:{}},{success:true,aeop_post_category_list:[]},{success:'unknown',aeop_post_category_list:[]}];fixture(()=>replies.shift());
 await expect(api.execute(config(),'aliexpress.category.tree.list',{category_id:0})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
 await expect(api.execute(config(),'aliexpress.category.tree.list',{category_id:0})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
 expect((await api.execute(config(),'aliexpress.category.tree.list',{category_id:0})).data.aeop_post_category_list).toEqual([]);await expect(api.execute(config(),'aliexpress.category.tree.list',{category_id:0})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
});
it('does not allow failed or missing product data to authorize a stock write',async()=>{
 const calls=fixture(()=>({result:{success:false,error_code:'FAIL',product_id:11,aeop_ae_product_s_k_us:[{id:'<none>'}]}}));await expect(api.execute(config(),'aliexpress.postproduct.redefining.editsingleskustock',{product_id:11,sku_id:'<none>',ipm_sku_stock:0})).rejects.toThrow();expect(calls).toHaveLength(1);
});

it('preserves request cancellation without dispatching or replaying a merchant write',async()=>{
 const {withRequestSignal}=require('../../../../bin/commerce-request-context.cjs');const before=new AbortController();before.abort();const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
 await expect(withRequestSignal(before.signal,()=>api.execute(config(),'aliexpress.offer.product.delete',{product_id:11}))).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});expect(fetchMock).not.toHaveBeenCalled();
 const active=new AbortController();let started!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve;});fetchMock.mockImplementation((_url:any,init:any)=>new Promise((_resolve,reject)=>{started();init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});}));
 const pending=withRequestSignal(active.signal,()=>api.execute(config(),'aliexpress.offer.product.delete',{product_id:11}));const checked=expect(pending).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});await entered;active.abort();await checked;expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('preserves order and operation notes while removing only documented diagnostic memo paths',async()=>{
 const replies:any={
  'aliexpress.trade.new.redefining.findorderbyid':{target:{memo:'Gift for customer',opr_log_dto_list:[{memo:'Customer requested delivery change'}]}},
  'aliexpress.trade.seller.orderlist.get':{result:{success:true,target_list:[{product_list:[{memo:'Wrap separately'}]}]}},
  'aliexpress.trade.redefining.findorderlistsimplequery':{result:{order_list:[{memo:'Leave at front desk'}]}},
  'aliexpress.trade.redefining.sendcode':{is_success:true,memo:'private provider diagnostic'},
 };
 fixture(m=>replies[m]);
 expect((await api.execute(config(),'aliexpress.trade.new.redefining.findorderbyid',{param1:{order_id:11}})).data.target).toEqual(replies['aliexpress.trade.new.redefining.findorderbyid'].target);
 expect((await api.execute(config(),'aliexpress.trade.seller.orderlist.get',{param_aeop_order_query:{current_page:1,page_size:1}})).data.result.target_list[0].product_list[0].memo).toBe('Wrap separately');
 expect((await api.execute(config(),'aliexpress.trade.redefining.findorderlistsimplequery',{param1:{page:1,page_size:1}})).data.result.order_list[0].memo).toBe('Leave at front desk');
 const sent=await api.execute(config(),'aliexpress.trade.redefining.sendcode',{param_1:{biz_type:'ETICKET',order_id:11,send_code_list:[{order_line_id:12,code_list:[{code:'business-voucher',expire_time:'2027-01-01'}]}]}});expect(sent.status).toBe('acknowledged');expect(sent.data).not.toHaveProperty('memo');
});
it('requires both documented compliance business status and success, preserving pending audit results',async()=>{
 let reply:any={code:'200',success:true,data:[]};const calls=fixture(()=>reply);
 const query={trade_order_id:'11',child_trade_order_ids:['12']};expect((await api.execute(config(),'aliexpress.trade.compliance.order.query',query)).data.data).toEqual([]);
 reply={code:'200',success:true,data:[{child_trade_order_id:'12',can_appeal:true,audit_history:[{audit_status:'REJECTED',reject_reason:'Product label missing',audit_type:'MANUAL_AUDIT'}]}]};expect((await api.execute(config(),'aliexpress.trade.compliance.order.query',query)).data.data[0].audit_history[0].reject_reason).toBe('Product label missing');
 for(const method of ['manualcheck','aicheck']){reply={code:'200',success:true,data:null};const result=await api.execute(config(),'aliexpress.trade.compliance.order.'+method,{item_id:'13',trade_order_id:'11',child_trade_order_id:'12',...(method==='manualcheck'?{appeal_text:'Please check updated label'}:{})});expect(result.status).toBe('accepted');expect(result.follow_up.action).toBe('aliexpress.trade.compliance.order.query');}
 for(const invalid of [{code:'400',success:true,data:[]},{code:'500',success:true,data:[]},{code:'200',data:[]},{code:'0',success:true,data:[]},{code:'200',success:false,data:[]}]){reply=invalid;await expect(api.execute(config(),'aliexpress.trade.compliance.order.query',query)).rejects.toThrow();}
 reply={error_response:{code:'200'},code:'200',success:true,data:[]};await expect(api.execute(config(),'aliexpress.trade.compliance.order.query',query)).rejects.toThrow();expect(calls).toHaveLength(10);
});
