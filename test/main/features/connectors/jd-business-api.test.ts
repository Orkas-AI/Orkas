import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
const require=createRequire(import.meta.url),api=require('../../../../bin/jd-business-api.cjs'),contracts=require('../../../../bin/jd-api-contracts.cjs');
const {withRequestSignal}=require('../../../../bin/commerce-request-context.cjs');
const config=()=>({provider:'jd_jos',metadata:{},credentials:{provider:'jd_jos',app_key:'fixture-app',app_secret:'fixture-secret',access_token:'fixture-access',refresh_token:'fixture-refresh',identity:{vender_id:'100',shop_id:'200'}}});
const owner={token:vi.fn(async()=> 'fixture-access')};
const call=(method:string,p={},c=config())=>api.execute(c,'api.jingdong.'+method,p,owner);
const mock=(data:unknown)=>{const f=vi.fn(async()=>new Response(typeof data==='string'?data:JSON.stringify(data)));vi.stubGlobal('fetch',f);return f;};
const wrapped=(name:string,value:unknown)=>({['jingdong_'+name.replaceAll('.','_')+'_responce']:value});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();owner.token.mockClear();});
it('publishes typed ordinary merchant contracts, omitting cloud-sensitive and additional-token identities',()=>{
 const rows=api.actionsFor(config());expect(Object.keys(rows)).toHaveLength(396);expect(rows['api.jingdong.ware.stock.sku.set'].risk).toBe('H');expect(rows['api.jingdong.pop.afs.soa.refundapply.replyRefund'].risk).toBe('H');
 expect(rows).not.toHaveProperty('api.jingdong.pop.order.search');expect(rows).not.toHaveProperty('api.jingdong.pop.order.get');expect(rows).not.toHaveProperty('api.jingdong.pushChatMessage');
 const s=rows['api.jingdong.sku.read.findSkuById'].input_schema;expect(s.properties).toHaveProperty('field');expect(s.properties).not.toHaveProperty('venderId');
 for(const r of Object.values(contracts.methods)as any[]){for(const k of [...r.input_definitions,...r.response_definitions])expect(contracts.definitions).toHaveProperty(k);}
});
it('signs an exact official numeric ID, retains all business fields and bounds transport',async()=>{
 const fetch=mock('{"jingdong_sku_read_findSkuById_responce":{"sku":{"skuId":9007199254740993,"wareId":123,"skuName":"Fixture","futureId":9223372036854775807,"memo":"Business memo","customerPhone":"123"}}}');
 const out=await call('sku.read.findSkuById',{skuId:'9007199254740993'});const [url,init]=fetch.mock.calls[0]as any;expect(url).toBe('https://api.jd.com/routerjson');expect(init.redirect).toBe('error');expect(init.signal).toBeInstanceOf(AbortSignal);
 const form=new URLSearchParams(init.body);expect(form.get('360buy_param_json')).toBe('{"skuId":9007199254740993}');const sign=form.get('sign');form.delete('sign');expect(sign).toBe(createHash('md5').update('fixture-secret'+[...form].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>k+v).join('')+'fixture-secret').digest('hex').toUpperCase());
 expect(out.data.jingdong_sku_read_findSkuById_responce.sku).toMatchObject({skuId:'9007199254740993',futureId:'9223372036854775807',memo:'Business memo',customerPhone:'123'});
});
it('uses official flat CSV query fields and rejects wrong parameter trees before authorization',async()=>{
 const fetch=mock(wrapped('ware.read.searchWare4Valid',{page:{data:[],pageNo:1,pageSize:1,totalItem:0}}));await call('ware.read.searchWare4Valid',{wareId:['10','11'],searchField:['title'],pageSize:1});const p=JSON.parse(new URLSearchParams((fetch.mock.calls[0]as any)[1].body).get('360buy_param_json')!);expect(p).toEqual({wareId:'10,11',searchField:'title',pageSize:1});
 for(const parameters of [{wareQuery:{pageSize:1}},{pageSize:51},{pageSize:'1000'},{searchField:['title,other']},{venderId:'other'}])await expect(call('ware.read.searchWare4Valid',parameters)).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(fetch).toHaveBeenCalledTimes(1);expect(owner.token).toHaveBeenCalledTimes(1);
});
it('preserves nested stock input, reports failed items and never replays an uncertain write',async()=>{
 const p={req:{updateModel:'fullStockIn',stockRfId:'once',skuStocks:[{skuId:'11',stockNum:2},{skuId:'12',stockNum:3}]}};
 const fetch=mock(wrapped('ware.stock.sku.set',{returnType:{success:true,obj:{updateStockResult:[{data:'11',success:true,storeId:0},{data:'12',success:false,storeId:0,message:'private failure'}]}}}));const out=await call('ware.stock.sku.set',p);expect(out.status).toBe('partial_or_failed');expect(out.data.jingdong_ware_stock_sku_set_responce.returnType.obj.updateStockResult[1].data).toBe('12');
 const wire=JSON.parse(new URLSearchParams((fetch.mock.calls[0]as any)[1].body).get('360buy_param_json')!);expect(wire.req.skuStocks[0]).toEqual({skuId:11,stockNum:2});
 await expect(call('ware.stock.sku.set',{req:{...p.req,skuStocks:Array.from({length:31},()=>p.req.skuStocks[0])}})).rejects.toMatchObject({code:'E_BAD_INPUT'});
 for(const results of [[{data:'99',success:true,storeId:0}],[{data:'11',success:true,storeId:0},{data:'11',success:true,storeId:0}]]){fetch.mockResolvedValueOnce(new Response(JSON.stringify(wrapped('ware.stock.sku.set',{returnType:{success:true,obj:{updateStockResult:results}}}))));await expect(call('ware.stock.sku.set',p)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});}
 await expect(call('ware.stock.sku.set',{req:{...p.req,skuStocks:[{skuId:'11',stockNum:-1}]}})).rejects.toMatchObject({code:'E_BAD_INPUT'});
 fetch.mockRejectedValueOnce(new TypeError('fixture-access'));await expect(call('ware.stock.sku.set',p)).rejects.toMatchObject({code:'E_TOOL_CALL_NETWORK'});expect(fetch).toHaveBeenCalledTimes(4);
 fetch.mockResolvedValueOnce(new Response(JSON.stringify(wrapped('ware.stock.sku.set',{returnType:{success:true}}))));const receipt=await call('ware.stock.sku.set',p);expect(receipt.status).toBe('accepted');expect(receipt.follow_up).toContain('failure details only');
});
it('binds seller fields from the grant and rejects caller overrides or identity changes',async()=>{
 const fetch=mock(wrapped('asc.audit.count',{result:{success:true,code:'0',data:2}}));await call('asc.audit.count',{operatePin:'operator',operateNick:'Operator'});const p=JSON.parse(new URLSearchParams((fetch.mock.calls[0]as any)[1].body).get('360buy_param_json')!);expect(p.buId).toBe('100');await expect(call('asc.audit.count',{buId:'101'})).rejects.toMatchObject({code:'E_BAD_INPUT'});
 fetch.mockResolvedValueOnce(new Response(JSON.stringify(wrapped('seller.vender.info.get',{vender_info_result:{vender_id:999,shop_id:200}}))));await expect(call('seller.vender.info.get')).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});
 const c=config();owner.token.mockImplementationOnce(async()=>{c.credentials.identity.shop_id='201';return'fixture-access';});await expect(call('sku.read.findSkuById',{skuId:1},c)).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});expect(fetch).toHaveBeenCalledTimes(2);
});
it('rejects missing list resources and invalid declared types while preserving business status fields',async()=>{
 const fetch=mock(wrapped('ware.read.searchWare4Valid',{page:{pageNo:1,totalItem:1}}));await expect(call('ware.read.searchWare4Valid',{})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
 fetch.mockResolvedValueOnce(new Response(JSON.stringify(wrapped('ware.read.searchWare4Valid',{page:{data:{},totalItem:1}}))));await expect(call('ware.read.searchWare4Valid',{})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
 fetch.mockResolvedValueOnce(new Response(JSON.stringify(wrapped('sku.read.findSkuById',{sku:{skuId:1,status:4,message:'Business text',future:{status:'failed'}}}))));const out=await call('sku.read.findSkuById',{skuId:1});expect(out.status).toBeUndefined();expect(out.data.jingdong_sku_read_findSkuById_responce.sku.message).toBe('Business text');
});
it('distinguishes asynchronous acceptance from completion and sanitizes only protocol diagnostics',async()=>{
 const fetch=mock(wrapped('pop.afs.soa.afsRefundApply',{returnType:{result:true,errorCode:'1',errorMsg:'private diagnostic'}}));const row=contracts.methods['api.jingdong.pop.afs.soa.afsRefundApply'];expect(row.async).toBe(true);
 const out=await call('pop.afs.soa.afsRefundApply',{afsServiceId:11,processType:1,source:10,isFreight:2,returnPackFeeFlag:2,country:'CN'});expect(out.status).toBe('accepted');expect(out.data.jingdong_pop_afs_soa_afsRefundApply_responce.returnType).toEqual({result:true,errorCode:'1'});
 // The pure legacy boundary must retain legitimate business messages and contact fields.
 expect(api.sanitize({message:'Business text',buyerPhone:'123',access_token:'secret'},config().credentials)).toEqual({message:'Business text',buyerPhone:'123'});expect(fetch).toHaveBeenCalledTimes(1);
});
it('uses exact numeric strings without precision loss and rejects unsafe JavaScript integers',async()=>{
 expect(api.serializeParameters('jingdong.price.write.updateSkuJdPrice',{skuId:'9007199254740993',jdPrice:'19.95'})).toBe('{"skuId":9007199254740993,"jdPrice":19.95}');
 expect(api.serializeParameters('jingdong.sku.read.searchSkuList',{skuId:'11,12',page_size:20})).toBe('{"skuId":"11,12","page_size":20}');
 const fetch=mock({});await expect(call('sku.read.findSkuById',{skuId:9007199254740992})).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(fetch).not.toHaveBeenCalled();expect(owner.token).not.toHaveBeenCalled();
 expect(api.parse('{"overflow":1e400}')).toEqual({overflow:'1e400'});expect(()=>api.serializeParameters('jingdong.price.write.updateSkuJdPrice',{skuId:1,jdPrice:'1e400'})).toThrow();
 expect(api.parse('{"large":100000000000000000000,"scientific":1e30,"fraction":1.25,"nested":[9223372036854775807]}')).toEqual({large:'100000000000000000000',scientific:'1e30',fraction:1.25,nested:['9223372036854775807']});
});
it('bounds payload complexity and propagates cancellation without a business dispatch',async()=>{
 const fetch=mock({});const abort=new AbortController();abort.abort();await expect(withRequestSignal(abort.signal,()=>call('sku.read.findSkuById',{skuId:1}))).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});expect(fetch).not.toHaveBeenCalled();
 expect(()=>api.parse('['.repeat(45)+'0'+']'.repeat(45))).toThrow();let value:any={};for(let i=0;i<45;i++)value={a:value};await expect(call('sku.read.findSkuById',{skuId:1,extra:value})).rejects.toMatchObject({code:'E_BAD_INPUT'});
 owner.token.mockRejectedValueOnce(new DOMException('Stopped','AbortError'));await expect(call('sku.read.findSkuById',{skuId:1})).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});expect(fetch).not.toHaveBeenCalled();
});
it('compiles every reachable input and output contract without orphaned definitions',()=>{
 const {AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv'),validator=new AjvJsonSchemaValidator();
 for(const row of Object.values(contracts.methods)as any[]){for(const output of [false,true]){const definitions=output?row.response_definitions:row.input_definitions;const schema={...(output?row.response_schema:row.input_schema),$defs:Object.fromEntries(definitions.map((k:string)=>[k,contracts.definitions[k]]))};expect(()=>validator.getValidator(schema)).not.toThrow();}}
});
