import {createRequire} from 'node:module';
import {createHmac} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
const require=createRequire(import.meta.url),api=require('../../../../bin/alibaba-1688-business-api.cjs'),contracts=require('../../../../bin/alibaba-1688-api-contracts.cjs');
const {withRequestSignal}=require('../../../../bin/commerce-request-context.cjs');
const config=()=>({provider:'alibaba_1688',metadata:{},credentials:{provider:'alibaba_1688',app_key:'123456',app_secret:'fixture-secret',access_token:'fixture-access',refresh_token:'fixture-refresh',identity:{member_id:'seller1'}}});
const owner={token:vi.fn(async()=> 'fixture-access')};
const action=(method:string)=>Object.keys(contracts.methods).find(k=>contracts.methods[k].name===method)!;
const call=(method:string,p={},c=config())=>api.execute(c,action(method),p,owner);
const mock=(data:unknown)=>{const f=vi.fn(async()=>new Response(typeof data==='string'?data:JSON.stringify(data)));vi.stubGlobal('fetch',f);return f;};
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();owner.token.mockClear();});

it('describes complete seller inputs without buyer, affiliate or credential escape routes',()=>{
 const rows=api.actionsFor(config());expect(Object.keys(rows)).toHaveLength(42);const stock=rows[action('alibaba.product.modifyStock')];expect(stock.risk).toBe('H');
 expect(stock.input_schema.$defs[stock.input_schema.properties.productStockChange.items.$ref.slice(8)].properties).toHaveProperty('skuStocks');
 expect(rows[action('alibaba.trade.getSellerOrderList')].input_schema.properties).toHaveProperty('needBuyerAddressAndPhone');
 expect(Object.keys(rows).join(' ')).not.toMatch(/buyerView|BuyerOrder|fastCreateOrder|p4p|streamer|incrementModify/);
 expect(Object.values(rows).every((r:any)=>r.input_schema.additionalProperties===false)).toBe(true);
});
it('signs fixed seller authority and preserves exact IDs, typed large floats and complete business fields',async()=>{
 const fetch=mock('{"productInfo":{"productID":9223372036854775807,"subject":"Fixture","saleInfo":{"priceRanges":[{"price":100000000000000000000}]},"futureLong":9223372036854775806}}');
 const out=await call('alibaba.product.get',{productID:'9223372036854775807'});const [raw,init]=fetch.mock.calls[0] as any;
 expect(raw).toBe('https://gw.open.1688.com/openapi/param2/1/com.alibaba.product/alibaba.product.get/123456');const form=new URLSearchParams(init.body);
 expect(form.get('productID')).toBe('9223372036854775807');expect(form.get('webSite')).toBe('1688');expect(form.get('scene')).toBe('1688');
 const actual=form.get('_aop_signature');form.delete('_aop_signature');const pairs=[...form].sort(([a],[b])=>a<b?-1:a>b?1:0);
 expect(actual).toBe(createHmac('sha1','fixture-secret').update('param2/1/com.alibaba.product/alibaba.product.get/123456'+pairs.map(([k,v])=>k+v).join('')).digest('hex').toUpperCase());expect(init.redirect).toBe('error');expect(init.signal).toBeInstanceOf(AbortSignal);
 expect(out.data.productInfo.productID).toBe('9223372036854775807');expect(out.data.productInfo.futureLong).toBe('9223372036854775806');expect(out.data.productInfo.saleInfo.priceRanges[0].price).toBe(1e20);
});
it('rejects substitutions, unsafe numbers, malformed dates and excessive pagination before token acquisition or IO',async()=>{
 const fetch=mock({});for(const [method,p]of [
 ['alibaba.product.get',{productID:'1',webSite:'alibaba'}],['alibaba.product.get',{productID:9223372036854775807}],['alibaba.product.get',{productID:'9223372036854775808'}],
 ['alibaba.product.list.get',{pageNo:1,pageSize:21}],['alibaba.product.list.get',{pageNo:1,pageSize:1,startModifyTime:'yesterday'}],['alibaba.product.get',{productID:'1',access_token:'other'}],
 ] as const)await expect(call(method,p)).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(owner.token).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
it('retains failed resource IDs and rejects missing, unrelated or duplicate batch acknowledgements without replay',async()=>{
 const p={productStockChange:[{productId:'11',productAmountChange:2,skuStocks:[]},{productId:'12',productAmountChange:1,skuStocks:[]}],increaceModify:true};
 const fetch=mock({success:true,result:[{productId:11,result:true},{productId:12,result:false,code:'DENIED',desc:'provider private prose'}]});const out=await call('alibaba.product.modifyStock',p);
 expect(out.status).toBe('partial_or_failed');expect(out.data.result).toEqual([{productId:11,result:true},{productId:12,result:false,code:'DENIED'}]);
 expect(JSON.parse(new URLSearchParams((fetch.mock.calls[0] as any)[1].body).get('productStockChange')!)[0]).toMatchObject({productId:11,productAmountChange:2});
 for(const result of [[{productId:11,result:true}],[{productId:11,result:true},{productId:99,result:true}],[{productId:11,result:true},{productId:11,result:true}]]){fetch.mockResolvedValueOnce(new Response(JSON.stringify({result,success:true})));await expect(call('alibaba.product.modifyStock',p)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});}expect(fetch).toHaveBeenCalledTimes(4);
});
it('checks the seller view before cancellation and sends exactly one authorized cancellation',async()=>{
 const fetch=mock({});fetch.mockResolvedValueOnce(new Response(JSON.stringify({result:{baseInfo:{id:10,sellerID:'buyer1'}},success:'true'})));
 await expect(call('alibaba.trade.cancel',{tradeID:'10',cancelReason:'other',remark:'Please cancel'})).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});expect(fetch).toHaveBeenCalledTimes(1);
 fetch.mockResolvedValueOnce(new Response(JSON.stringify({result:{baseInfo:{id:10,sellerID:'seller1'}},success:'true'}))).mockResolvedValueOnce(new Response(JSON.stringify({success:true})));
 expect((await call('alibaba.trade.cancel',{tradeID:'10',cancelReason:'other'})).status).toBe('acknowledged');expect(fetch.mock.calls.filter(([u]:any)=>u.includes('/alibaba.trade.cancel/'))).toHaveLength(1);
});
it('preserves business status and memo while rejecting incomplete lists and mismatched seller identity',async()=>{
 const fetch=mock({success:true,result:[{baseInfo:{id:1,sellerID:'seller1',status:'cancel',remark:'Memo',buyerContact:{email:'buyer@example.test'}}}]});const out=await call('alibaba.trade.getSellerOrderList',{});
 expect(out.status).toBeUndefined();expect(out.data.result[0].baseInfo).toMatchObject({status:'cancel',remark:'Memo',buyerContact:{email:'buyer@example.test'}});
 for(const data of [{success:true,totalRecord:1},{success:true,result:{}},{success:true,result:[{baseInfo:{sellerID:'other'}}]}]){fetch.mockResolvedValueOnce(new Response(JSON.stringify(data)));await expect(call('alibaba.trade.getSellerOrderList',{})).rejects.toThrow();}
 fetch.mockResolvedValueOnce(new Response(JSON.stringify({result:{memberId:'other'},success:true})));await expect(call('alibaba.account.basic')).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});
 fetch.mockResolvedValueOnce(new Response(JSON.stringify({productList:[],success:true,message:'Business result information'})));expect((await call('alibaba.product.getByIdList',{productIdList:['1']})).data.message).toBe('Business result information');
});
it('bounds nested data, propagates cancellation and does not replay a network-uncertain write',async()=>{
 const fetch=mock({});let nested:any={};for(let n=0;n<45;n++)nested={a:nested};await expect(call('alibaba.product.get',{productID:'1',extra:nested})).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(fetch).not.toHaveBeenCalled();
 fetch.mockResolvedValueOnce(new Response(JSON.stringify({productInfo:{productID:1,future:nested}})));await expect(call('alibaba.product.get',{productID:'1'})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
 const c=new AbortController();c.abort();await expect(withRequestSignal(c.signal,()=>call('alibaba.product.get',{productID:'1'}))).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});expect(fetch).toHaveBeenCalledTimes(1);
 fetch.mockRejectedValueOnce(new TypeError('fixture-access'));await expect(call('alibaba.product.delete',{productID:'1'})).rejects.toMatchObject({code:'E_TOOL_CALL_NETWORK'});expect(fetch).toHaveBeenCalledTimes(2);
});

it('requires shipment resource receipts and complete multi-package outcomes without changing the dispatched write',async()=>{
 const first={cpCode:'SF',mailNo:'M1',quantity:1},second={cpCode:'SF',mailNo:'M2',quantity:1};
 const p={multiPackage:true,sendGoods:[{sourceId:'10',sendGoodEntries:[{sourceEntryId:'11',amount:2,weight:1,extBody:JSON.stringify([first,second])}]}]};
 const success={sourceId:'10',sourceEntryId:'11',success:true,extBody:JSON.stringify(first)},failure={sourceId:'10',sourceEntryId:'11',success:false,extBody:JSON.stringify(second),errorMessage:'Private diagnostic'};
 const fetch=mock({success:false,result:{sendSuccessList:[success],sendFailList:[failure]}});
 const out=await call('alibaba.logistics.OpDeliverySendOrder.offline',p);expect(out.status).toBe('partial_or_failed');expect(out.data.result.sendFailList[0]).not.toHaveProperty('errorMessage');
 for(const data of [{success:true,result:{}},{success:true,result:{logisticsId:'L1'}},{success:true,result:{sendSuccessList:[success]}}]){
  fetch.mockResolvedValueOnce(new Response(JSON.stringify(data)));await expect(call('alibaba.logistics.OpDeliverySendOrder.offline',p)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
 }
 await expect(call('alibaba.logistics.OpDeliverySendOrder.offline',{sendGoods:[]})).rejects.toMatchObject({code:'E_BAD_INPUT'});
 expect(fetch).toHaveBeenCalledTimes(4);
});
it('correlates marketing enrollment results and checks the published ten-product limit before IO',async()=>{
 const p={param:{topicId:1,enrollOffers:[{offerId:'11',formItems:[]},{offerId:'12',formItems:[]}]}};
 const fetch=mock({success:true,result:[{offerId:11,enrollResult:true,enrollId:9},{offerId:12,enrollResult:false}]});expect((await call('alibaba.light.enroll.record.batch.insert',p)).status).toBe('partial_or_failed');
 fetch.mockResolvedValueOnce(new Response(JSON.stringify({success:true,result:[{offerId:11,enrollResult:true,enrollId:9}]})));await expect(call('alibaba.light.enroll.record.batch.insert',p)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
 await expect(call('alibaba.light.enroll.record.batch.insert',{param:{topicId:1,enrollOffers:Array.from({length:11},(_,i)=>({offerId:String(i+1),formItems:[]}))}})).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(fetch).toHaveBeenCalledTimes(2);
});

it('preserves full legacy business data with bounded exact-number parsing and cancels after seller verification',async()=>{
 const c=config(),data={message:'Business information',buyerContact:{phone:'123'},access_token:'secret',memo:c.credentials.app_secret};
 expect(api.sanitize(data,c.credentials)).toEqual({message:'Business information',buyerContact:{phone:'123'},memo:'[redacted]'});expect(data).toHaveProperty('access_token');
 expect(api.parse('{"productInfo":{"productID":9223372036854775807,"saleInfo":{"priceRanges":[{"price":100000000000000000000}]}}}','alibaba.product.get')).toEqual({productInfo:{productID:'9223372036854775807',saleInfo:{priceRanges:[{price:1e20}]}}});
 const abort=new AbortController(),fetch=mock({});fetch.mockImplementationOnce(async()=>{abort.abort();return new Response(JSON.stringify({result:{baseInfo:{id:10,sellerID:'seller1'}},success:'true'}));});
 await expect(withRequestSignal(abort.signal,()=>call('alibaba.trade.cancel',{tradeID:'10',cancelReason:'other'}))).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});expect(fetch).toHaveBeenCalledTimes(1);
});
