import {createRequire} from 'node:module';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv';
const require=createRequire(import.meta.url),api=require('../../../../bin/mercado-libre-business-api.cjs'),contracts=require('../../../../bin/mercado-libre-api-contracts.cjs'),context=require('../../../../bin/commerce-request-context.cjs');
const cfg=()=>({provider:'mercado_libre',metadata:{user_id:'123456'},credentials:{scope:'offline_access read write',access_token:'fixture-access',refresh_token:'fixture-refresh',client_secret:'fixture-secret',identity:{user_id:'123456',site_id:'CBT'}}});
const owner={token:async()=> 'fixture-access'},reply=(v:any,status=200)=>new Response(JSON.stringify(v),{status});
const orders='api.get.marketplace.orders.search',update='api.put.global.user_products.user_product_id',stock='api.get.marketplace.inventories.inventory_id.stock.fulfillment';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('Mercado Libre same-grant Global Selling merchant operations',()=>{
 it('describes reviewed closed input fields and compiles each reachable schema on demand',()=>{
  const v=new AjvJsonSchemaValidator(),actions=api.actionsFor(cfg());expect(Object.keys(actions)).toHaveLength(167);
  for(const r of Object.values(actions) as any[])expect(()=>v.getValidator(r.input_schema)).not.toThrow();
  expect(api.isNative('api.post.marketplace.seller_promotions.items.item_id')).toBe(false);
  expect(api.isNative('api.post.marketplace.messages.packs.pack_id')).toBe(false);
  expect(api.isNative('api.get.marketplace.shipments.shipment_id.labels')).toBe(false);
  expect(contracts.methods[update].risk).toBe('D');
 });
 it('lets the bound main grant aggregate orders and preserves exact large IDs, PII and all extra fields',async()=>{
  const fetch=vi.fn(async()=>new Response('{"results":[{"id":9223372036854775807,"buyer":{"email":"buyer@example.test"},"price":100000000000000000000,"cost":1.23456789e25,"extra":{"id":9223372036854775806,"exponent":9.223372036854776e18}}],"paging":{"total":1}}'));vi.stubGlobal('fetch',fetch);
  const r=await api.execute(cfg(),orders,{query:{limit:10,'order.status':'paid'}},owner);expect(r.data.results[0]).toMatchObject({id:'9223372036854775807',buyer:{email:'buyer@example.test'},price:1e20,cost:1.23456789e25,extra:{id:'9223372036854775806',exponent:'9.223372036854776e18'}});
  const u=new URL(String(fetch.mock.calls[0][0]));expect(u.searchParams.get('seller.id')).toBeNull();expect(u.searchParams.get('limit')).toBe('10');expect((fetch.mock.calls[0]as any)[1]).toMatchObject({redirect:'error',headers:{authorization:'Bearer fixture-access'}});
 });
 it('validates authoritative main-to-child mappings on every request without changing credentials',async()=>{
  const c=cfg(),saved=structuredClone(c),fetch=vi.fn(async(raw:string)=>new URL(raw).pathname==='/marketplace/users/123456'?reply({user_id:123456,site_id:'CBT',marketplaces:[{user_id:654321,site_id:'MLM',logistic_type:'fulfillment'}]}):reply({inventory_id:'INV1',available_quantity:6}));vi.stubGlobal('fetch',fetch);
  await api.execute(c,stock,{path:{inventory_id:'INV1'},query:{seller_id:'654321'}},owner);await api.execute(c,stock,{path:{inventory_id:'INV1'},query:{seller_id:'654321'}},owner);expect(fetch).toHaveBeenCalledTimes(4);expect(c).toEqual(saved);
  await expect(api.execute(c,stock,{path:{inventory_id:'INV1'},query:{seller_id:'777'}},owner)).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(fetch).toHaveBeenCalledTimes(5);
  fetch.mockResolvedValueOnce(reply({user_id:777,site_id:'CBT',marketplaces:[{user_id:654321}]}));await expect(api.execute(c,stock,{path:{inventory_id:'INV1'},query:{seller_id:'654321'}},owner)).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});expect(fetch).toHaveBeenCalledTimes(6);
 });
 it('preserves mixed UP failures and pending task IDs, scrubs provider diagnostic prose and never replays',async()=>{
  const fetch=vi.fn(async()=>reply({id:'U1',success:true,listing_sites:[{id:'MLM1',success:true,task_id:'task1'},{id:'MLC2',success:false,errors:[{code:5014,message:'private diagnostic fixture-secret',references:['MLC2']}]}]},206));vi.stubGlobal('fetch',fetch);
  const r=await api.execute(cfg(),update,{path:{user_product_id:'U1'},body:{listing_sites:[{listing_id:'MLM1',net_proceeds:12},{listing_id:'MLC2',status:'paused'}]}},owner);expect(r).toMatchObject({status:'partial_or_failed',data:{listing_sites:[{id:'MLM1',task_id:'task1'},{id:'MLC2',errors:[{code:5014,references:['MLC2']}]}]}});expect(JSON.stringify(r)).not.toContain('private diagnostic');expect(JSON.stringify(r)).not.toContain('fixture-secret');expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('distinguishes actual task receipts from business statuses, errors and pending orders',async()=>{
  const fetch=vi.fn(async()=>reply({results:[{id:1,status:'pending',errors:['business metadata'],task_id:'unrelated'}],paging:{total:1}}));vi.stubGlobal('fetch',fetch);expect(await api.execute(cfg(),orders,{},owner)).not.toHaveProperty('status');
  fetch.mockResolvedValueOnce(reply({task_id:'t1',status:'finished',user_products:[{id:'U1',status:'succeeded'},{id:'U2',status:'failed',reasons:[{code:'not_allowed',message:'private'}]}]}));expect(await api.execute(cfg(),'api.get.user_products_families.tasks.task_id',{path:{task_id:'t1'}},owner)).toMatchObject({status:'partial_or_failed'});
  fetch.mockResolvedValueOnce(reply({task_id:'t2',status:'processing',user_products:[]}));expect(await api.execute(cfg(),'api.get.user_products_families.tasks.task_id',{path:{task_id:'t2'}},owner)).toMatchObject({status:'accepted'});
 });
 it('rejects correlation-only acknowledgements and uses documented HTTP or explicit success receipts',async()=>{
  const fetch=vi.fn(async()=>reply({request_id:'request1'}));vi.stubGlobal('fetch',fetch);await expect(api.execute(cfg(),orders,{},owner)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
  for(const response of [{paging:{total:1}},{results:{},paging:{total:1}}]){fetch.mockResolvedValueOnce(reply(response));await expect(api.execute(cfg(),orders,{},owner)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});}
  fetch.mockResolvedValueOnce(reply({status:'failed'}));await expect(api.execute(cfg(),'api.post.marketplace.shipments.shipment_id.tracking',{path:{shipment_id:'1'},body:{tracking_id:'T1',tracking_url:'https://carrier.example.test/T1',carrier:'Carrier'}},owner)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
  fetch.mockResolvedValueOnce(new Response('',{status:201}));expect(await api.execute(cfg(),'api.post.marketplace.v2.claims.claim_id.actions.send_message',{path:{claim_id:'1'},body:{receiver_role:'complainant',message:'Please review your delivery.'}},owner)).toMatchObject({status:'accepted'});expect(fetch).toHaveBeenCalledTimes(5);
 });
 it('serializes exact positive int64 question IDs and rejects zero, overflow, unsafe numbers and unknown fields before IO',async()=>{
  const fetch=vi.fn(async()=>reply({id:12,question_id:12,text:'Done'}));vi.stubGlobal('fetch',fetch);const action='api.post.marketplace.answers';await api.execute(cfg(),action,{body:{question_id:'9223372036854775807',text:'Answer'}},owner);expect((fetch.mock.calls[0]as any)[1].body).toBe('{"question_id":9223372036854775807,"text":"Answer"}');
  for(const question_id of [0,'0',9223372036854775807,'9223372036854775808'])await expect(api.execute(cfg(),action,{body:{question_id,text:'Answer'}},owner)).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(api.execute(cfg(),orders,{query:{'seller.id':'777'}},owner)).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('enforces identity and post-refresh permissions, keeping discovery in sync with grants',async()=>{
  const c=cfg(),fetch=vi.fn();vi.stubGlobal('fetch',fetch);c.credentials.scope='offline_access read';expect(api.actionsFor(c)).toHaveProperty(orders);expect(api.actionsFor(c)).not.toHaveProperty(update);await expect(api.execute(c,update,{path:{user_product_id:'U1'},body:{deleted:true}},owner)).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});
  c.credentials.scope='offline_access read write';await expect(api.execute(c,update,{path:{user_product_id:'U1'},body:{deleted:true}},{token:async()=>{c.credentials.scope='offline_access read';return 'rotated';}})).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});
  c.credentials.identity.site_id='MLM';expect(api.actionsFor(c)).toEqual({});await expect(api.execute(c,orders,{},owner)).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});expect(fetch).not.toHaveBeenCalled();
 });
 it('bounds depth, size, pages, effect counts and path inputs before IO',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);for(const query of [{limit:0},{limit:51},{limit:'10'}])await expect(api.execute(cfg(),orders,{query},owner)).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(api.execute(cfg(),update,{path:{user_product_id:'..'},body:{deleted:true}},owner)).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(api.execute(cfg(),update,{path:{user_product_id:'U1'},body:{status:'active',deleted:true}},owner)).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(api.execute(cfg(),orders,{padding:'x'.repeat(262145)},owner)).rejects.toMatchObject({code:'E_BAD_INPUT'});let nested:any={};for(let i=0;i<50;i++)nested={nested};await expect(api.execute(cfg(),orders,nested,owner)).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(fetch).not.toHaveBeenCalled();
 });
 it('bounds provider structural depth and body bytes without leaking raw upstream text',async()=>{
  const fetch=vi.fn(async()=>new Response('{"results":'+ '['.repeat(45)+'1'+']'.repeat(45)+'}'));vi.stubGlobal('fetch',fetch);await expect(api.execute(cfg(),orders,{},owner)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({results:[],large:'x'.repeat(1048577)})));await expect(api.execute(cfg(),orders,{},owner)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(2);
 });
 it('validates current advertiser access and destination ownership before a single budget write',async()=>{
  const fetch=vi.fn(async(raw:string,init:any)=>{const u=new URL(raw);if(u.pathname==='/advertising/advertisers')return reply({advertisers:[{advertiser_id:111,site_id:'MLM'}]});if(init.method==='GET')return reply({id:222,advertiser_id:111,status:'active'});return reply({id:222,advertiser_id:111,budget:50,status:'active'});});vi.stubGlobal('fetch',fetch);
  const action='api.put.marketplace.advertising.site_id.product_ads.campaigns.campaign_id';expect(await api.execute(cfg(),action,{path:{site_id:'MLM',campaign_id:'222'},body:{budget:50}},owner)).toMatchObject({status:'accepted'});expect(fetch.mock.calls.map((r:any)=>r[1].method)).toEqual(['GET','GET','PUT']);
  fetch.mockResolvedValueOnce(reply({advertisers:[{advertiser_id:999,site_id:'MLM'}]}));await expect(api.execute(cfg(),action,{path:{site_id:'MLM',campaign_id:'222'},body:{budget:50}},owner)).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});expect(fetch.mock.calls.filter((r:any)=>r[1].method==='PUT')).toHaveLength(1);
 });
 it('checks returned main identities even after a previously verified grant and allows only one mapped holiday write',async()=>{
  const fetch=vi.fn(async()=>reply({id:777,site_id:'CBT'}));vi.stubGlobal('fetch',fetch);await expect(api.execute(cfg(),'api.get.users.me',{},owner)).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});
  fetch.mockResolvedValueOnce(reply({user_id:123456,site_id:'MLM'}));await expect(api.execute(cfg(),'api.get.marketplace.users.bound_user_id',{},owner)).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});
  fetch.mockResolvedValueOnce(reply({user_id:123456,site_id:'CBT',marketplaces:[{user_id:654321,site_id:'MLM'}]}));fetch.mockResolvedValueOnce(reply({message:'all working days were saved'}));
  expect(await api.execute(cfg(),'api.put.marketplace.sellers.seller_id.working_days',{path:{seller_id:'654321'},body:{dates:[{date:'2026-12-25',checked:true}]}},owner)).toMatchObject({status:'accepted'});expect(fetch.mock.calls.filter((r:any)=>r[1].method==='PUT')).toHaveLength(1);
 });
 it('maps cancellation through token and relationship preflights and does not issue a merchant write',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await expect(api.execute(cfg(),orders,{}, {token:async()=>{throw Object.assign(new Error('cancelled'),{name:'AbortError'});}})).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});
  const controller=new AbortController();fetch.mockImplementation(async(_u:any,init:any)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{name:'AbortError'})),{once:true})));
  const task=context.withRequestSignal(controller.signal,()=>api.execute(cfg(),stock,{path:{inventory_id:'I1'},query:{seller_id:'654321'}},owner));await new Promise(r=>setTimeout(r,10));controller.abort();await expect(task).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});expect(fetch).toHaveBeenCalledTimes(1);
 });
});
