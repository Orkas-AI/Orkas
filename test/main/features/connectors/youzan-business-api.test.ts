import {createRequire} from 'node:module';
import {afterEach,expect,it,vi} from 'vitest';
const require=createRequire(import.meta.url),api=require('../../../../bin/youzan-business-api.cjs');
const config=(type:any=0)=>({provider:'youzan',metadata:{kdt_id:'123'},credentials:{client_id:'fixture-app',client_secret:'fixture-secret',access_token:'fixture-token',identity:{kdt_id:'123',...(type===null?{}:{type})}}});
const owner={token:async()=> 'fixture-token'};
function fixture(reply:(method:string,p:any,raw:string)=>unknown){const calls:any[]=[];vi.stubGlobal('fetch',vi.fn(async(raw:any,init:any)=>{const url=new URL(String(raw));expect(url.origin).toBe('https://open.youzanyun.com');expect(url.searchParams.get('access_token')).toBe('fixture-token');expect(init.method).toBe('POST');expect(init.redirect).toBe('error');const method=url.pathname.split('/')[2],p=JSON.parse(init.body);calls.push({method,p});const result=reply(method,p,init.body);return result instanceof Response?result:new Response(JSON.stringify(result));}));return calls;}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
it('exposes only supported shop types with capability conditions and complete on-demand parameter fields',()=>{
 expect(Object.keys(api.actionsFor(config()))).toHaveLength(536);expect(Object.keys(api.actionsFor(config(7)))).toHaveLength(443);expect(Object.keys(api.actionsFor(config(null)))).toHaveLength(355);expect(api.actionsFor(config(6))).toEqual({});
 const a=api.actionsFor(config());expect(a['youzan.item.delete.v3_0_1'].risk).toBe('D');expect(api.actionsFor(config(null))).not.toHaveProperty('youzan.item.delete.v3_0_1');const list=a['youzan.trades.sold.get.v4_0_4'];expect(list.input_schema.properties).toHaveProperty('book_key');expect(list.input_schema.properties.custom_tags.properties.tag_conditions.items.properties.tag_values.items.properties).toHaveProperty('comparison_type');expect(list.requirements.permission_packages.length).toBeGreaterThan(0);expect(a).not.toHaveProperty('youzan.shop.chain.create.sub.v1_0_0');
 const validator=new(require('@modelcontextprotocol/sdk/validation/ajv').AjvJsonSchemaValidator)();for(const row of Object.values(require('../../../../bin/youzan-api-contracts.cjs').methods)as any[])validator.getValidator(row.input_schema);
});
it('serializes documented DTO strings with exact integers and preserves full business data',async()=>{
 let quantity='7';const calls=fixture((m,p,raw)=>{expect(m).toBe('youzan.item.quantity.update');expect(typeof p.param).toBe('string');expect(p.param).toContain('"item_id":9007199254740993');expect(p.param).toContain('"sku_id":9007199254740995');expect(raw).toContain('"param":"{');quantity=String(JSON.parse(p.param).stock_num);return{code:200,success:true,data:{success:true,message:'Updated',buyer_email:'buyer@example.test',memo:'Gift note',access_token:'fixture-token'}};});
 const result=await api.execute(config(),'youzan.item.quantity.update.v4_0_0',{param:{kdt_id:'123',item_id:'9007199254740993',sku_id:'9007199254740995',stock_num:'0'}},owner);expect(quantity).toBe('0');expect(result.status).toBe('accepted');expect(result.follow_up).toContain('read back');expect(result.data.data).toMatchObject({buyer_email:'buyer@example.test',memo:'Gift note'});expect(result.data.data).not.toHaveProperty('access_token');expect(calls).toHaveLength(1);
});
it('retains order contacts and notes and exact response identifiers without exposing credentials',async()=>{
 fixture(()=>new Response('{"code":200,"success":true,"message":"fixture-secret","data":{"full_order_info":{"buyer_info":{"buyer_id":9007199254740993,"buyer_phone":"13800000000"},"order_info":{"tid":"E202610010000000000000001","buyer_message":"Wrap separately"}},"contact":{"email":"buyer@example.test","memo":"Business note fixture-token"}}}'));
 const r=await api.execute(config(),'youzan.trade.get.v4_0_2',{tid:'E202610010000000000000001'},owner);expect(r.data.data.full_order_info.buyer_info.buyer_id).toBe('9007199254740993');expect(r.data.data.full_order_info.buyer_info.buyer_phone).toBe('13800000000');expect(r.data.data.contact).toEqual({email:'buyer@example.test',memo:'Business note [redacted]'});expect(r.data).not.toHaveProperty('message');
});
it('rejects unknown, foreign-shop, unsupported-type and imprecise inputs before token or business IO',async()=>{
 const token=vi.fn(owner.token),calls=fixture(()=>({code:200,success:true,data:{success:true}}));const base={kdt_id:'123',item_id:'11',sku_id:'12',stock_num:'0'};
 for(const param of [{...base,kdt_id:'456'},{...base,item_id:'0001'},{...base,item_id:'9223372036854775808'},{...base,item_id:9007199254740992}])await expect(api.execute(config(),'youzan.item.quantity.update.v4_0_0',{param},{token})).rejects.toMatchObject({code:'E_BAD_INPUT'});
 await expect(api.execute(config(null),'youzan.item.delete.v3_0_1',{item_id:'11'},{token})).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});await expect(api.execute(config(),'raw.request',{url:'https://example.test'},{token})).rejects.toMatchObject({code:'E_BAD_INPUT'});await expect(api.execute(config(),'youzan.trades.sold.get.v4_0_4',{page_size:101},{token})).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(token).not.toHaveBeenCalled();expect(calls).toHaveLength(0);
});
it('requires actual read data, rejects failed business flags and accepts an explicitly empty list',async()=>{
 const replies=[{code:200,success:true},{code:200,success:false,data:[]},{code:200,success:true,data:[]},{code:200,success:true,data:['not-an-integer']}];fixture(()=>replies.shift());const action='youzan.item.combo.get.id.v1_0_0',p={request:{kdt_id:'123',item_id:'11',channel:0}};
 await expect(api.execute(config(7),action,p,owner)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});await expect(api.execute(config(7),action,p,owner)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect((await api.execute(config(7),action,p,owner)).data.data).toEqual([]);await expect(api.execute(config(7),action,p,owner)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
});
it('does not turn a false primitive write receipt into successful acceptance',async()=>{
 fixture(()=>({code:200,success:true,response:false}));const row=Object.values(require('../../../../bin/youzan-api-contracts.cjs').methods).find((r:any)=>r.method==='youzan.salesman.account.fire')as any;const p={fans_type:1,fans_id:'11',mobile:'13800000000'};
 const r=await api.execute(config(),row.action,p,owner);expect(r.status).toBe('partial_or_failed');
});
it('handles permission denial and uncertain transport failures without replay or raw errors',async()=>{
 const replies=[new Response('fixture-secret',{status:403}),new Response('fixture-secret',{status:503}),new Response('{"code":200,"success":true,"data":{"id":9.007199254740993e15}}')];const calls=fixture(()=>replies.shift());
 await expect(api.execute(config(),'youzan.shop.get.v3_0_0',{},owner)).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});await expect(api.execute(config(),'youzan.item.delete.v3_0_1',{item_id:'11'},owner)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});await expect(api.execute(config(),'youzan.shop.get.v3_0_0',{},owner)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(calls).toHaveLength(3);
});
it('honors cancellation before dispatch and during a request with no write replay',async()=>{
 const {withRequestSignal}=require('../../../../bin/commerce-request-context.cjs');const aborted=new AbortController();aborted.abort();const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);await expect(withRequestSignal(aborted.signal,()=>api.execute(config(),'youzan.item.delete.v3_0_1',{item_id:'11'},owner))).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});expect(fetchMock).not.toHaveBeenCalled();
 const active=new AbortController();let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});fetchMock.mockImplementation((_url:any,init:any)=>new Promise((_resolve,reject)=>{entered();init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});}));const request=withRequestSignal(active.signal,()=>api.execute(config(),'youzan.item.delete.v3_0_1',{item_id:'11'},owner));const checked=expect(request).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});await started;active.abort();await checked;expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('honors the smaller official page bound and rejects metadata-only resource responses',async()=>{
 const calls=fixture(()=>({code:200,success:true,data:{paginator:{page:1,total:0}}}));const a=api.actionsFor(config())['youzan.scrm.tag.category.list.v1_0_1'];expect(a.input_schema.properties.page_size.maximum).toBe(50);
 await expect(api.execute(config(),'youzan.scrm.tag.category.list.v1_0_1',{page_size:51},owner)).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(calls).toHaveLength(0);
 await expect(api.execute(config(),'youzan.trade.get.v4_0_2',{tid:'E202610010000000000000001'},owner)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(calls).toHaveLength(1);
});
it('associates batch settlement receipts and reports individual failures without replaying money changes',async()=>{
 const p={order_settle_open_d_t_o:{tids:['E1','E2'],operator:{operator_name:'Fixture operator'}}};const entry=(tid:string,success=true)=>({tid,kdt_id:123,cps_order_settle_res:{is_success:success,settle_state:success?18:4,settle_ext_code:success?7000:1000,message:success?'Pending':'Order not reviewed'}});let data=[entry('E1')];const calls=fixture(()=>({code:200,success:true,data}));
 await expect(api.execute(config(),'youzan.salesman.order.operate.settle.v1_0_0',p,owner)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});data=[entry('E1'),entry('E1')];await expect(api.execute(config(),'youzan.salesman.order.operate.settle.v1_0_0',p,owner)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});data=[entry('E1'),entry('OTHER')];await expect(api.execute(config(),'youzan.salesman.order.operate.settle.v1_0_0',p,owner)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});data=[entry('E1'),entry('E2',false)];const r=await api.execute(config(),'youzan.salesman.order.operate.settle.v1_0_0',p,owner);expect(r.status).toBe('partial_or_failed');expect(r.data.data[1].cps_order_settle_res.settle_state).toBe(4);expect(calls).toHaveLength(4);
});
it('requires the requested deletion identifier and SKU failure targets in business receipts',async()=>{
 let reply:any={code:200,success:true,data:{is_success:true,item_id:99}};const calls=fixture(()=>reply);await expect(api.execute(config(),'youzan.item.delete.v3_0_1',{item_id:'11'},owner)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
 const p={item_skus_list:[{item_id:'11',skus:[{sku_id:'12',stock_num:'0'},{sku_id:'13',price:'100'}]}]};reply={code:200,success:true,data:{fail_list:[{item_id:11,sku_list:[{sku_id:99,fail_info:'Rejected'}]}]}};await expect(api.execute(config(),'youzan.item.sku.batch.update.v1_0_0',p,owner)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});reply.data.fail_list[0].sku_list[0].sku_id=13;const r=await api.execute(config(),'youzan.item.sku.batch.update.v1_0_0',p,owner);expect(r.status).toBe('partial_or_failed');expect(r.data.data.fail_list[0].sku_list[0]).toEqual({sku_id:13});expect(calls).toHaveLength(3);
});
it('accepts independent frozen official response examples while retaining scoped shape validation',()=>{
 const evidence=require('../../../fixtures/connectors/official-contracts/youzan-20261001.json');expect(evidence.official_response_examples).toHaveLength(616);
 for(const r of evidence.official_response_examples)expect(()=>api.validateResponseShape(r.method+'.v'+r.version.replaceAll('.','_'),r.json),r.method).not.toThrow();
 expect(()=>api.validateResponseShape('youzan.shop.get.v3_0_0',JSON.stringify({code:200,success:true,data:{id:[],name:12}}))).toThrow();
});
it('keeps closed token failure codes and removes only documented nested diagnostic text',async()=>{
 const calls=fixture(()=>({code:200,success:true,data:{success:false,message:'Raw provider error',buyer_message:'Customer asks for a later delivery',contact:{email:'buyer@example.test'}}}));
 const result=await api.execute(config(),'youzan.item.quantity.update.v4_0_0',{param:{kdt_id:'123',item_id:'11',sku_id:'12',stock_num:'0'}},owner);expect(result.status).toBe('partial_or_failed');expect(result.data.data).toMatchObject({success:false,buyer_message:'Customer asks for a later delivery',contact:{email:'buyer@example.test'}});expect(result.data.data).not.toHaveProperty('message');
 for(const code of ['E_TOOL_CALL_RATE_LIMIT','E_TOOL_CALL_NETWORK','E_TOOL_CALL_TIMEOUT','E_TOOL_CALL_CANCELLED'])await expect(api.execute(config(),'youzan.shop.get.v3_0_0',{}, {token:async()=>{throw Object.assign(new Error('Private provider message'),{code});}})).rejects.toMatchObject({code});expect(calls).toHaveLength(1);
});
it('rejects an empty destructive receipt instead of accepting a success-only gateway envelope',async()=>{
 const calls=fixture(()=>({code:200,success:true,data:{}}));await expect(api.execute(config(),'youzan.itemcategories.tag.delete.v3_0_0',{tag_id:'11'},owner)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(calls).toHaveLength(1);
});
