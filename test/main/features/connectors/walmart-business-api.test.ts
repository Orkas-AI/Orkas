import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv';
const require=createRequire(import.meta.url),api=require('../../../../bin/walmart-business-api.cjs'),contracts=require('../../../../bin/walmart-api-contracts.cjs'),context=require('../../../../bin/commerce-request-context.cjs');
const evidence=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../../fixtures/connectors/official-contracts/walmart-20261001.json'),'utf8'));
const token='fixture-walmart-token',config=(market='us',environment='live')=>({provider:'walmart',metadata:{market,environment},credentials:{client_id:'fixture-client',client_secret:'fixture-secret-123'}});
const owners=()=>({base:vi.fn((c:any)=>c.metadata.environment==='sandbox'?'https://sandbox.walmartapis.com':'https://marketplace.walmartapis.com'),token:vi.fn(async()=>token)});
const reply=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status});
const inventory={sku:'sku/1',quantity:{unit:'EACH',amount:0}};
const shape=(s:any)=>s?.$ref?contracts.definitions[s.$ref.slice('#/$defs/'.length)]:s;
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('Walmart current seller market contracts',()=>{
 it('covers every selected source row by market with shared full-field contracts and compilable outputs',()=>{
  const v=new AjvJsonSchemaValidator();expect(evidence.inventory).toHaveLength(442);expect(Object.keys(contracts.methods)).toHaveLength(404);
  for(const market of ['us','ca','mx','cl']){const selected=evidence.inventory.filter((r:any)=>!r.excluded_reason&&r.markets.includes(market)&&!r.environments),actions=api.actionsFor(config(market));expect(Object.keys(actions).sort()).toEqual(selected.map((r:any)=>r.action).sort());
   for(const a of Object.values(actions) as any[])expect(()=>v.getValidator(a.input_schema)).not.toThrow();
  }
  for(const r of Object.values(contracts.methods)as any[])for(const s of Object.values(r.responses)as any[])if(s)expect(()=>v.getValidator({...s,$defs:Object.fromEntries(r.response_definitions.map((id:string)=>[id,contracts.definitions[id]]))})).not.toThrow();
  expect(Object.keys(api.actionsFor(config('us','sandbox')))).toHaveLength(182);expect(api.actionsFor(config()).hasOwnProperty('POST /simulations/items')).toBe(false);
  expect(api.isNative('POST /v3/token')).toBe(false);expect(api.isNative('POST /v3/settings/psprisksignalsprofile')).toBe(false);expect(api.isNative('POST /v3/feeds [Item Management]')).toBe(false);
  expect(api.actionsFor(config())['POST /v3/price/getPricingInsights'].risk).toBe('R');expect(api.actionsFor(config())['POST /v3/price [Promotion Management]'].risk).toBe('D');
  const r=contracts.methods['ca POST /v3/price'],b=shape(r.input_schema.properties.body),header=shape(b.properties.MPItemFeedHeader);expect(Object.keys(header.properties).sort()).toEqual(['businessUnit','locale','mart','tenant','version']);expect(header.required).toEqual(['mart','locale','version','businessUnit','tenant']);expect(shape(header.properties.tenant).const).toBe('WALMART_CA');expect(shape(header.properties.locale).oneOf.map((s:any)=>shape(s).type)).toEqual(['array']);
 });
 it('uses fixed owned global authority and exact country headers for CA/MX/CL',async()=>{
  const fetch=vi.fn(async()=>reply(inventory));vi.stubGlobal('fetch',fetch);
  for(const market of ['ca','mx','cl']){const o=owners();expect(await api.execute(config(market),'GET /v3/inventory',{query:{sku:'sku/1'}},o)).toEqual({data:inventory});expect(o.token).toHaveBeenCalledTimes(1);}
  for(let i=0;i<3;i++){const [url,init]=fetch.mock.calls[i]as unknown as[string,RequestInit];expect(url).toBe('https://marketplace.walmartapis.com/v3/inventory?sku=sku%2F1');expect(init).toMatchObject({redirect:'error',headers:{'WM_MARKET':['ca','mx','cl'][i],WM_GLOBAL_VERSION:'3.1','WM_SEC.ACCESS_TOKEN':token}});}
 });
 it('retains full inventory fields including zero and scheduled availability, rejects unrelated acknowledgements',async()=>{
  const body={...inventory,inventoryAvailableDate:'2026-10-03'},fetch=vi.fn(async()=>reply(body));vi.stubGlobal('fetch',fetch);
  expect(await api.execute(config(),'PUT /v3/inventory',{query:{sku:'sku/1',shipNode:'node-1'},body},owners())).toMatchObject({status:'acknowledged',data:body});expect(JSON.parse(String((fetch.mock.calls[0]as unknown as[string,RequestInit])[1].body))).toEqual(body);
  fetch.mockResolvedValueOnce(reply({...body,sku:'other'}));await expect(api.execute(config(),'PUT /v3/inventory',{query:{sku:'sku/1'},body},owners())).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
 });
 it('preserves per-node partial evidence and never repeats a write',async()=>{
  const body={inventories:{nodes:[{shipNode:'good',inputQty:{unit:'EACH',amount:0}},{shipNode:'bad',inputQty:{unit:'EACH',amount:5}}]}},fetch=vi.fn(async()=>reply({sku:'sku/1',nodes:[{shipNode:'good',status:'Success'},{shipNode:'bad',status:'Failure',errors:[{code:'INVALID_NODE',field:'shipNode',description:'secret '+token}]}]}));vi.stubGlobal('fetch',fetch);
  const result=await api.execute(config(),'PUT /v3/inventories/{sku}',{path:{sku:'sku/1'},body},owners());expect(result.status).toBe('partial_or_failed');expect(result.data.nodes[1].errors).toEqual([{code:'INVALID_NODE',field:'shipNode'}]);expect(JSON.stringify(result)).not.toContain(token);expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValueOnce(reply({sku:'sku/1',nodes:[{shipNode:'good',status:'Success'}]}));await expect(api.execute(config(),'PUT /v3/inventories/{sku}',{path:{sku:'sku/1'},body},owners())).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockResolvedValueOnce(reply({sku:'sku/1',nodes:[{shipNode:'good',status:'Success',errors:[{code:'NOTICE',severity:'WARN',description:'advisory'}]},{shipNode:'bad',status:'Success'}]}));expect((await api.execute(config(),'PUT /v3/inventories/{sku}',{path:{sku:'sku/1'},body},owners())).status).toBe('acknowledged');
 });
 it('locks feedType while preserving typed lag-time items and only acknowledges async submission',async()=>{
  const fetch=vi.fn(async()=>reply({feedId:'feed-1'}));vi.stubGlobal('fetch',fetch);const body={lagTimeHeader:{version:'1.1',feedDate:'2026-10-01T00:00:00Z'},lagTime:[{sku:'sku/1',fulfillmentLagTime:2,additionalAttributes:[{name:'warehouse',value:'A'}]}]};
  const result=await api.execute(config(),'POST /v3/feeds [Lag Time]',{body},owners());expect(result).toMatchObject({status:'accepted',data:{feedId:'feed-1'},follow_up:expect.stringContaining('asynchronous')});expect(fetch.mock.calls[0][0]).toBe('https://marketplace.walmartapis.com/v3/feeds?feedType=lagtime');expect(JSON.parse(String((fetch.mock.calls[0]as unknown as[string,RequestInit])[1].body))).toEqual(body);
  await expect(api.execute(config(),'POST /v3/feeds [Lag Time]',{body,query:{feedType:'DELETE_ITEM'}},owners())).rejects.toMatchObject({code:'E_BAD_INPUT'});fetch.mockResolvedValueOnce(reply({}));await expect(api.execute(config(),'POST /v3/feeds [Lag Time]',{body},owners())).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(2);
 });
 it('keeps async feed errors/counts without turning normal resource states into failures',async()=>{
  const fetch=vi.fn(async()=>reply({feedId:'feed-1',feedStatus:'PROCESSED',itemsReceived:2,itemsSucceeded:1,itemsFailed:1,itemsProcessing:0,ingestionErrors:{ingestionError:[{code:'INVALID_SKU',type:'DATA_ERROR',description:'private diagnostic'}]}}));vi.stubGlobal('fetch',fetch);
  const result=await api.execute(config(),'GET /v3/feeds/{feedId}',{path:{feedId:'feed-1'}},owners());expect(result.status).toBe('partial_or_failed');expect(result.data.itemsSucceeded).toBe(1);expect(JSON.stringify(result)).not.toContain('private diagnostic');
  fetch.mockResolvedValueOnce(reply({feedId:'feed-1',feedStatus:'INPROGRESS',itemsReceived:2,itemsProcessing:2}));expect(await api.execute(config(),'GET /v3/feeds/{feedId}',{path:{feedId:'feed-1'}},owners())).toMatchObject({follow_up:expect.any(String)});expect(fetch).toHaveBeenCalledTimes(2);
 });
 it('retains successful item rows while marking the official partial HTTP acknowledgement',async()=>{
  const fetch=vi.fn(async()=>reply({itemResponse:[{productId:'product-1',productIdType:'WPID',status:'IN_REVIEW'}]},206));vi.stubGlobal('fetch',fetch);
  expect(await api.execute(config(),'POST /v3/items/dispute/duplicates/status',{body:{issues:[{productId:'product-1',productIdType:'WPID'},{productId:'product-2',productIdType:'WPID'}]}},owners())).toMatchObject({status:'partial_or_failed',data:{itemResponse:[{productId:'product-1',status:'IN_REVIEW'}]}});expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('bounds numeric-string pages and default pagination before credential or network IO',async()=>{
  const fetch=vi.fn(async()=>reply({totalResults:0,results:{feed:[]}}));vi.stubGlobal('fetch',fetch);const o=owners();
  for(const limit of ['101','0','-1','1.1','x','1000000000000000000',1])await expect(api.execute(config(),'GET /v3/feeds',{query:{limit}},o)).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(o.token).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  await api.execute(config(),'GET /v3/feeds',{},o);expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get('limit')).toBe('50');
 });
 it('preserves declared int64 exactly and declared large floating values as numbers',async()=>{
  const fetch=vi.fn(async()=>new Response('{"totalResults":9223372036854775807,"results":{"feed":[]}}'));vi.stubGlobal('fetch',fetch);
  expect((await api.execute(config(),'GET /v3/feeds',{},owners())).data.totalResults).toBe('9223372036854775807');fetch.mockResolvedValueOnce(new Response('{"totalResults":9.223372036854776e18,"results":{"feed":[]}}'));await expect(api.execute(config(),'GET /v3/feeds',{},owners())).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
  fetch.mockResolvedValueOnce(new Response('{"sku":"sku/1","quantity":{"unit":"EACH","amount":100000000000000000000}}'));expect((await api.execute(config(),'GET /v3/inventory',{query:{sku:'sku/1'}},owners())).data.quantity.amount).toBe(1e20);
 });
 it('serializes actual official form arrays and object query members without coercion',async()=>{
  const fetch=vi.fn(async()=>reply({returnOrders:[]}));vi.stubGlobal('fetch',fetch);
  await api.execute(config('ca'),'GET /v3/returns',{query:{'Query Params':{returnOrderId:'return-1',limit:2,isWFSEnabled:'true'}}},owners());let url=new URL(String(fetch.mock.calls[0][0]));expect(url.searchParams.get('returnOrderId')).toBe('return-1');expect(url.searchParams.get('limit')).toBe('2');expect(url.searchParams.get('isWFSEnabled')).toBe('true');expect(url.searchParams.has('Query Params')).toBe(false);
  fetch.mockResolvedValueOnce(reply({list:{meta:{totalCount:0,limit:20},elements:{order:[]}}}));await api.execute(config('ca'),'GET /v3/orders',{query:{status:['CREATED','SHIPPED'],shipNodeType:'SellerFulfilled'}},owners());url=new URL(String(fetch.mock.calls[1][0]));expect(url.searchParams.getAll('status')).toEqual(['CREATED','SHIPPED']);expect(url.searchParams.get('limit')).toBe('20');
  await expect(api.execute(config('ca'),'GET /v3/orders',{query:{shipNodeType:'WFSGlobalFulfilled'}},owners())).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(fetch).toHaveBeenCalledTimes(2);
 });
 it('restores nullable numeric unions inside arrays and preserves unknown numeric token text',async()=>{
  const fetch=vi.fn(async()=>new Response('{"pricingInsightsResponseList":[{"currentPrice":100000000000000000000,"buyBoxBasePrice":1e20,"competitorPrice":null}],"unknown":{"id":9223372036854775807,"scientific":9.223372036854776e18,"array":[100000000000000000000]}}'));vi.stubGlobal('fetch',fetch);
  const result=await api.execute(config(),'POST /v3/price/getPricingInsights',{body:{pageNumber:0}},owners());expect(result.data.pricingInsightsResponseList[0]).toEqual({currentPrice:1e20,buyBoxBasePrice:1e20,competitorPrice:null});expect(result.data.unknown).toEqual({id:'9223372036854775807',scientific:'9.223372036854776e18',array:['100000000000000000000']});
  fetch.mockResolvedValueOnce(new Response('{"pricingInsightsResponseList":[{"inventoryCount":9223372036854775807}]}'));await expect(api.execute(config(),'POST /v3/price/getPricingInsights',{body:{pageNumber:0}},owners())).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
 });
 it('rejects crossed markets, authority changes, identity headers, path escapes and invalid quantities before IO',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const o=owners();
  await expect(api.execute(config('cl'),'POST /v3/orders/{purchaseOrderId}/refund',{path:{purchaseOrderId:'p-1'}},o)).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(api.execute(config('ca','sandbox'),'GET /v3/inventory',{query:{sku:'sku/1'}},o)).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(api.execute(config(),'GET /v3/inventory',{query:{sku:'sku/1'},header:{WM_MARKET:'ca'}},o)).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(api.execute(config(),'GET /v3/items/{id}',{path:{id:'..'}},o)).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(api.execute(config(),'GET /v3/inventory',{query:{sku:'sku/1'}},{...o,base:()=> 'https://other.invalid'})).rejects.toMatchObject({code:'E_BAD_INPUT'});
  for(const amount of [-1,0.5,Number.MAX_SAFE_INTEGER+1])await expect(api.execute(config(),'PUT /v3/inventory',{query:{sku:'sku/1'},body:{...inventory,quantity:{unit:'EACH',amount}}},o)).rejects.toMatchObject({code:'E_BAD_INPUT'});
  const r=contracts.methods['ca POST /v3/price'];expect(shape(shape(r.input_schema.properties.body).properties.MPItemFeedHeader).properties).not.toHaveProperty('unknown');expect(o.token).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
 });
 it('enforces empty 204 acknowledgements, error/cancellation/size boundaries without replay',async()=>{
  const fetch=vi.fn(async()=>new Response(null,{status:204}));vi.stubGlobal('fetch',fetch);
  expect(await api.execute(config(),'DELETE /v3/advertising/sem/campaigns/{campaignId}',{path:{campaignId:'campaign-1'}},owners())).toEqual({data:null,status:'acknowledged'});
  fetch.mockResolvedValueOnce(reply({message:token},403));await expect(api.execute(config(),'GET /v3/inventory',{query:{sku:'sku/1'}},owners())).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});
  const controller=new AbortController();fetch.mockImplementationOnce(async()=>new Response(new ReadableStream({pull(){controller.abort();throw new DOMException('fixture','AbortError');}})));await expect(context.withRequestSignal(controller.signal,()=>api.execute(config(),'GET /v3/inventory',{query:{sku:'sku/1'}},owners()))).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});
  fetch.mockResolvedValueOnce(reply({...inventory,padding:'x'.repeat(1024*1024)}));await expect(api.execute(config(),'GET /v3/inventory',{query:{sku:'sku/1'}},owners())).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(4);
 });
});
