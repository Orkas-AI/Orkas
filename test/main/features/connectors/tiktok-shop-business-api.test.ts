import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv';
const require=createRequire(import.meta.url),api=require('../../../../bin/tiktok-shop-business-api.cjs'),contracts=require('../../../../bin/tiktok-shop-api-contracts.cjs'),codec=require('../../../../bin/local-api-credential-codec.cjs'),context=require('../../../../bin/commerce-request-context.cjs');
const evidence=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../../fixtures/connectors/official-contracts/tiktok-shop-20261001.json'),'utf8'));
const dirs:string[]=[],S=(s:any)=>s?.$ref?contracts.definitions[s.$ref.slice(8)]:s;
function config(country='US',extra:any={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-tiktok-native-'));dirs.push(dir);const metadata={shop_id:'shop123',region:country==='US'?'us':'row'},credentialFile=path.join(dir,'credentials.enc'),credentialKey=crypto.randomBytes(32).toString('base64url'),credentials={provider:'tiktok_shop',service_id:'123',app_key:'123',app_secret:'app-test-secret',access_token:'fixture-access',refresh_token:'fixture-refresh',expires_at:Date.now()+3600000,refresh_expires_at:Date.now()+86400000,user_type:0,scopes:[...new Set(Object.values(contracts.methods).flatMap((r:any)=>r.scopes_any))],identity:{binding_shop_id:'shop123',region:metadata.region,shop_id:'7495355150342452340',shop_cipher:'ROW_test',shop_region:country},...extra};codec.writeCredentialFile(credentialFile,credentialKey,credentials);return {provider:'tiktok_shop',metadata,credentials,credentialFile,credentialKey};}
const reply=(data:any,status=200)=>new Response(JSON.stringify({code:0,data,request_id:'fixture-request'}),{status});
const warehouse='tiktok_shop.get_logistics_202309_warehouses',stock='tiktok_shop.post_product_202309_products_product_id_inventory_update',price='tiktok_shop.post_product_202309_products_product_id_prices_update',product='tiktok_shop.get_product_202309_products_product_id';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();while(dirs.length)fs.rmSync(dirs.pop()!,{recursive:true,force:true});});
describe('TikTok Shop typed current merchant contract',()=>{
 it('maps every selected official field tree and compiles shared on-demand contracts',()=>{
  expect(evidence.inventory).toHaveLength(341);expect(evidence.legacy_inventory).toHaveLength(78);expect(Object.keys(contracts.methods)).toHaveLength(224);
  expect(evidence.inventory.filter((r:any)=>!r.excluded_reason).map((r:any)=>r.action).sort()).toEqual(Object.keys(contracts.methods).sort());
  const validator=new AjvJsonSchemaValidator();for(const row of Object.values(contracts.methods)as any[]){for(const mode of ['input','response']){const schema={...S(row[mode+'_schema']),$defs:Object.fromEntries(row[mode+'_definitions'].map((id:string)=>[id,contracts.definitions[id]]))};expect(()=>validator.getValidator(schema)).not.toThrow();}
   function walk(s:any){s=S(s);if(s.type==='object')expect(s.additionalProperties).toBe(false);Object.values(s.properties||{}).forEach(walk);if(s.items)walk(s.items);}walk(row.input_schema);
  }
  expect(api.isNative('tiktok_shop.post_affiliate_creator_202405_videos')).toBe(false);expect(api.isNative('tiktok_shop.put_product_202309_global_products_global_product_id')).toBe(false);
  const row=contracts.methods[price],skus=S(S(S(row.input_schema).properties.body).properties.skus);expect(Object.keys(S(skus.items).properties)).toEqual(['id','price','list_price','external_list_prices']);
 });
 it('signs exact body bytes using an independent known digest and retains complete price fields',async()=>{
  vi.spyOn(Date,'now').mockReturnValue(1700000000000);const c=config(),fetch=vi.fn(async()=>reply({}));vi.stubGlobal('fetch',fetch);
  const body={skus:[{id:'1729592969712207013',price:{amount:'12.50',currency:'USD'}}]};expect(await api.execute(c,price,{path:{product_id:'1729592969712207008'},body})).toMatchObject({status:'accepted'});
  const [url,init]=fetch.mock.calls[0]as unknown as[string,RequestInit];expect(new URL(url).searchParams.get('sign')).toBe('54281d6c11601a1a0102f70c6b344ca7b27eb1e71f5d96a88eb16070fa5d9dbd');expect(init.body).toBe('{"skus":[{"id":"1729592969712207013","price":{"amount":"12.50","currency":"USD"}}]}');expect(init).toMatchObject({method:'POST',redirect:'error',headers:{'x-tts-access-token':'fixture-access'}});
  body.skus[0]={...body.skus[0],list_price:{amount:'20.00',currency:'USD'},external_list_prices:[{source:'SHOPIFY_COMPARE_AT_PRICE',amount:'20.00',currency:'USD'}]}as any;await api.execute(c,price,{path:{product_id:'1729592969712207008'},body});expect(JSON.parse(String((fetch.mock.calls[1]as any)[1].body))).toEqual(body);
 });
 it('retains item-level failures and nested warehouse identities without replay or diagnostic leaks',async()=>{
  const c=config(),fetch=vi.fn(async()=>reply({errors:[{code:12052990,message:'private diagnostic',detail:{sku_id:'sku1',extra_errors:[{warehouse_id:'wh1',code:12052097,message:'private nested'}]}}]}));vi.stubGlobal('fetch',fetch);
  const p={path:{product_id:'123'},body:{skus:[{id:'sku1',inventory:[{warehouse_id:'wh1',quantity:1,backorder_quantity:5,handling_time:2}]}]}};const result=await api.execute(c,stock,p);expect(result).toMatchObject({status:'partial_or_failed',data:{data:{errors:[{code:12052990,detail:{sku_id:'sku1',extra_errors:[{warehouse_id:'wh1',code:12052097}]}}]}}});expect(JSON.stringify(result)).not.toContain('private');expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValueOnce(reply({}));await expect(api.execute(c,stock,p)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({code:12052990,data:{errors:[{code:12052097,message:'private diagnostic',detail:{sku_id:'sku1'}}]}})));expect((await api.execute(c,stock,p)).status).toBe('partial_or_failed');expect(fetch).toHaveBeenCalledTimes(3);
 });
 it('serializes official CSV IDs and the distinct raw JSON int64 video query without rounding',async()=>{
  const c=config(),fetch=vi.fn(async()=>reply({orders:[]}));vi.stubGlobal('fetch',fetch);
  await api.execute(c,'tiktok_shop.get_order_202507_orders',{query:{ids:['7495355150342452340','7495355150342452341']}});expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get('ids')).toBe('7495355150342452340,7495355150342452341');
  fetch.mockResolvedValueOnce(reply({videos:[],latest_available_date:'2026-09-30'}));await api.execute(c,'tiktok_shop.get_analytics_202609_shop_videos_batch_performance',{query:{video_ids:['7523456789012345678'],start_date_ge:'2026-09-01',end_date_lt:'2026-09-30'}});expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get('video_ids')).toBe('[7523456789012345678]');
 });
 it('preserves declared response integers and unknown large numeric tokens exactly',async()=>{
  const c=config(),fetch=vi.fn(async()=>new Response('{"code":0,"data":{"total_count":9223372036854775807,"products":[],"unknown":{"id":9223372036854775806,"exponent":9.223372036854776e18}}}'));vi.stubGlobal('fetch',fetch);
  const result=await api.execute(c,'tiktok_shop.post_product_202502_products_search',{query:{page_size:20},body:{}});expect(result.data.data.total_count).toBe('9223372036854775807');expect(result.data.data.unknown).toEqual({id:'9223372036854775806',exponent:'9.223372036854776e18'});
  fetch.mockResolvedValueOnce(new Response('{"code":0,"data":{"total_count":9.223372036854776e18,"products":[]}}'));await expect(api.execute(c,'tiktok_shop.post_product_202502_products_search',{query:{page_size:20}})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
 });
 it('keeps async FBT tasks accepted and never follows returned download links',async()=>{
  const fetch=vi.fn(async()=>reply({task_status:'PROCESSING',download_url:'https://example.test/label.zip'}));vi.stubGlobal('fetch',fetch);
  const result=await api.execute(config(),'tiktok_shop.post_fbt_202602_inbound_orders_label_print',{body:{order_id:'123',print_items:['CARTON_PALLET_LABEL']}});expect(result).toMatchObject({status:'accepted',follow_up:expect.stringContaining('not confirmed complete')});expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('rejects cross-shop fields, unsupported countries and missing scopes before merchant IO',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const c=config();
  await expect(api.execute(c,warehouse,{query:{shop_cipher:'other'}})).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(api.execute(c,'tiktok_shop.post_product_202509_products_product_id_partial_edit',{path:{product_id:'123'},body:{replicated_products:[{region:'MX'}]}})).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(api.execute(config('US'),'tiktok_shop.post_product_202602_packages_recommend',{body:{}})).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(api.execute(config('US',{scopes:[]}),warehouse,{})).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});
  await expect(api.execute(config('US',{user_type:1}),warehouse,{})).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});expect(fetch).not.toHaveBeenCalled();
 });
 it('enforces pages, request size, int64 range, path boundaries and empty writes before IO',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const c=config();
  for(const page_size of [0,101,'20',1.5])await expect(api.execute(c,'tiktok_shop.post_product_202502_products_search',{query:{page_size}})).rejects.toMatchObject({code:'E_BAD_INPUT'});
  for(const product_id of ['..','%252e%252e','x/y',''])await expect(api.execute(c,product,{path:{product_id}})).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(api.execute(c,stock,{path:{product_id:'123'},body:{skus:[{id:'sku1',inventory:[{quantity:'9223372036854775808'}]}]}})).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(api.execute(c,'tiktok_shop.post_product_202509_products_product_id_partial_edit',{path:{product_id:'123'},body:{}})).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(api.execute(c,warehouse,{padding:'x'.repeat(262145)})).rejects.toMatchObject({code:'E_BAD_INPUT'});await expect(api.execute(c,'tiktok_shop.get_order_202507_orders',{query:{ids:['123,456']}})).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(fetch).not.toHaveBeenCalled();
 });
 it('honors declared PUT and DELETE methods and limits exact optional single-value query evidence',async()=>{
  const c=config(),fetch=vi.fn(async()=>reply({}));vi.stubGlobal('fetch',fetch);
  await api.execute(c,'tiktok_shop.put_event_202309_webhooks',{body:{address:'https://example.test/hook',event_type:'ORDER_STATUS_CHANGE'}});expect((fetch.mock.calls[0]as any)[1].method).toBe('PUT');
  fetch.mockResolvedValueOnce(reply({errors:[]}));await api.execute(c,'tiktok_shop.delete_product_202309_products',{body:{product_ids:['123']}});expect((fetch.mock.calls[1]as any)[1].method).toBe('DELETE');
  await expect(api.execute(c,'tiktok_shop.get_return_refund_202602_orders_order_id_aftersale_eligibility',{path:{order_id:'123'},query:{initiate_aftersale_user:'BUYER',request_types:['CANCEL','REFUND']}})).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(fetch).toHaveBeenCalledTimes(2);
 });
 it('uses the official bodyless export header while preserving the bounded JSON file envelope',async()=>{
  const fetch=vi.fn(async()=>reply({file:{base64:'SGVsbG8='}}));vi.stubGlobal('fetch',fetch);const result=await api.execute(config(),'tiktok_shop.get_affiliate_seller_202603_compass_offline_tasks_task_id_file',{path:{task_id:'123'}});expect(result.data.data.file.base64).toBe('SGVsbG8=');expect((fetch.mock.calls[0]as any)[1]).toMatchObject({method:'GET',headers:{'content-type':'multipart/form-data'}});expect((fetch.mock.calls[0]as any)[1].body).toBeUndefined();expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('uses rotated durable grants before issuing a single failed business request',async()=>{
  const c=config('US',{expires_at:Date.now()+1000}),fetch=vi.fn(async(raw:string)=>new URL(raw).hostname==='auth.tiktok-shops.com'?new Response(JSON.stringify({code:0,data:{access_token:'rotated-access',refresh_token:'rotated-refresh',access_token_expire_in:Math.floor(Date.now()/1000)+3600,refresh_token_expire_in:Math.floor(Date.now()/1000)+86400,user_type:0,granted_scopes:['seller.logistics']}})):new Response('{}',{status:503}));vi.stubGlobal('fetch',fetch);
  await expect(api.execute(c,warehouse,{})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(2);expect((fetch.mock.calls[1]as any)[1].headers['x-tts-access-token']).toBe('rotated-access');expect(codec.readCredentialFile(c.credentialFile,c.credentialKey).refresh_token).toBe('rotated-refresh');
 });
 it('updates discovery when granted scopes change and keeps no-public-scope seller APIs visible',()=>{
  const c=config('US',{scopes:['seller.logistics']});expect(api.actionsFor(c)).toHaveProperty(warehouse);expect(api.actionsFor(c)).not.toHaveProperty(stock);c.credentials.scopes=['seller.product.write'];expect(api.actionsFor(c)).not.toHaveProperty(warehouse);expect(api.actionsFor(c)).toHaveProperty(stock);
  c.credentials.scopes=[];expect(api.actionsFor(c)).toHaveProperty('tiktok_shop.post_product_202609_products_package_predict');
 });
 it('preserves failed conversation IDs and maps pre-token cancellation through the real MCP result owner',async()=>{
  const c=config(),fetch=vi.fn(async()=>reply({failed_conversation_ids:['7495355150342452340']}));vi.stubGlobal('fetch',fetch);
  const result=await api.execute(c,'tiktok_shop.post_affiliate_seller_202412_conversatons_read',{body:{conversation_ids:['7495355150342452340']}});expect(result).toMatchObject({status:'partial_or_failed',data:{data:{failed_conversation_ids:['7495355150342452340']}}});
  const adapter=require('../../../../bin/direct-commerce-mcp-server.cjs'),controller=new AbortController();controller.abort();const env={ORKAS_LOCAL_API_PROVIDER:c.provider,ORKAS_LOCAL_API_CREDENTIAL_FILE:c.credentialFile,ORKAS_LOCAL_API_CREDENTIAL_KEY:c.credentialKey,ORKAS_LOCAL_API_METADATA_JSON:JSON.stringify(c.metadata)};
  const cancelled=await context.withRequestSignal(controller.signal,()=>adapter.callToolResult('execute_read',{action:warehouse,parameters:{}},env));expect(cancelled).toMatchObject({isError:true,_meta:{orkas:{errorCode:'E_TOOL_CALL_CANCELLED'}}});expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('keeps HTTP, JSON, size and cancellation failures bounded without retries',async()=>{
  const c=config(),fetch=vi.fn(async()=>new Response('private',{status:429}));vi.stubGlobal('fetch',fetch);
  await expect(api.execute(c,warehouse,{})).rejects.toMatchObject({code:'E_TOOL_CALL_RATE_LIMIT'});fetch.mockResolvedValueOnce(new Response('{invalid'));await expect(api.execute(c,warehouse,{})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({code:0,data:{warehouses:[],padding:'x'.repeat(1048576)}})));await expect(api.execute(c,warehouse,{})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
  const controller=new AbortController();fetch.mockImplementationOnce(async()=>new Response(new ReadableStream({pull(){controller.abort();throw new DOMException('fixture','AbortError');}})));await expect(context.withRequestSignal(controller.signal,()=>api.execute(c,warehouse,{}))).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});expect(fetch).toHaveBeenCalledTimes(4);
 });
});
