import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
const require=createRequire(import.meta.url),native=require('../../../../bin/shoplazza-business-api.cjs'),{AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv'),{withRequestSignal}=require('../../../../bin/commerce-request-context.cjs');
const evidence=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../../fixtures/connectors/official-contracts/shoplazza-20261001.json'),'utf8'));
const token='fixture-shoplazza-private-token',config=()=>({provider:'shoplazza',metadata:{store_domain:'fixture.myshoplaza.com'},credentials:{provider:'shoplazza',access_token:token,identity:{binding:'fixture.myshoplaza.com',shop_id:'123'}}}),reply=(data:unknown,status=200)=>new Response(JSON.stringify({code:'Success',data}),{status,headers:{'content-type':'application/json'}});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
// Merchant catalog/fulfillment and theme journeys are checked against separately
// published protocol examples, exact wire payloads, and injected incomplete replies.
describe('Shoplazza current merchant contracts',()=>{
  it('preserves the complete pinned merchant inventory and compiles every described contract',()=>{
    const actions=native.actionsFor(),validator=new AjvJsonSchemaValidator();expect(Object.keys(actions)).toHaveLength(300);expect(evidence.source.version).toBe('v202601');
    const allowed=evidence.source.modules.flatMap((m:any)=>m.commands.filter((c:any)=>m.name!=='billing').map((c:any)=>c.id));expect(Object.keys(actions).sort()).toEqual(allowed.sort());
    for(const action of Object.values(actions) as any[])expect(()=>validator.getValidator(action.input_schema)).not.toThrow();
    expect(actions['theme-publish'].risk).toBe('H');expect(actions['theme-edit-session-batch-operations'].risk).toBe('D');expect(actions['theme-pb-update'].risk).toBe('R');expect(actions['one-time-application-charge-create']).toBeUndefined();
    const product=actions['product-create'].input_schema.$defs['v202506.Product'];expect(product.properties.auto_publish_at.type).toBe('string');expect(product.properties.images.minItems).toBe(1);expect(product.required).toContain('has_only_default_variant');
    expect(actions['order-update'].input_schema.$defs['v202601.UpdateOrderParam'].properties.custom_fields.additionalProperties.type).toBe('string');
  });
  it('creates a full product and preserves complete fulfillment/contact fields without altering token scope',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(reply({product:{id:'p1',title:'Linen'}})).mockResolvedValueOnce(reply({order:{id:'o1',shipping_address:{email:'buyer@example.invalid',address1:'Example Street'},customer:{first_name:'Example'},custom_fields:{shipment:'A'},note:'error is ordinary merchant text'}}));vi.stubGlobal('fetch',fetch);
    const product={title:'Linen',has_only_default_variant:true,images:[{src:'https://cdn.example.com/linen.png'}],variants:[{price:19.95,sku:'S',inventory_quantity:0,compare_at_price:25}],tags:['linen'],auto_publish_at:'2026-10-02T10:00:00Z',seo_keywords:['linen'],requires_shipping:true};
    expect((await native.execute(config(),'product-create',{body:{product}})).status).toBe('acknowledged');expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({product});expect(fetch.mock.calls[0][0]).toBe('https://fixture.myshoplaza.com/openapi/2026-01/products');expect(fetch.mock.calls[0][1].headers['Access-Token']).toBe(token);
    const body={order:{note:'Ready',tags:['ready'],custom_fields:{shipment:'A'},order_confirm_notify:0}};const result=await native.execute(config(),'order-update',{path:{order_id:'o1'},body});expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(body);expect(result.data.order).toMatchObject({shipping_address:{email:'buyer@example.invalid',address1:'Example Street'},customer:{first_name:'Example'},note:'error is ordinary merchant text'});
  });
  it('uses operation-specific pagination and repeated query arrays with exact uint64 IDs',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(reply({cursor:'next',products:[],has_more:true})).mockResolvedValueOnce(reply({orders:[],cursor:'after'})).mockResolvedValueOnce(new Response('{"code":"Success","data":{"location":{"id":18446744073709551615,"name":"Warehouse"}}}'));vi.stubGlobal('fetch',fetch);
    const result=await native.execute(config(),'products',{query:{ids:['p1','p2'],per_page:100,location_id:'18446744073709551615'}}),url=new URL(fetch.mock.calls[0][0]);expect(url.searchParams.getAll('ids')).toEqual(['p1','p2']);expect(url.searchParams.get('per_page')).toBe('100');expect(url.searchParams.get('location_id')).toBe('18446744073709551615');expect(result.data).toEqual({cursor:'next',products:[],has_more:true});
    await native.execute(config(),'orders',{query:{page_size:100,cursor:'before'}});expect(new URL(fetch.mock.calls[1][0]).searchParams.get('page_size')).toBe('100');
    expect((await native.execute(config(),'location-detail',{path:{location_id:'18446744073709551615'}})).data.location.id).toBe('18446744073709551615');
  });
  it('manages merchant callback registrations with exact fields and never contacts the callback service',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(reply({webhook:{id:'w1',address:'https://merchant.example.com/events',topic:'orders/create'}})).mockResolvedValueOnce(reply({carrier_service:{id:'c1',name:'Carrier',callback_url:'https://merchant.example.com/rates'}})).mockResolvedValueOnce(reply({webhooks:[]})).mockResolvedValueOnce(reply({}));vi.stubGlobal('fetch',fetch);
    const webhook={address:'https://merchant.example.com/events',topic:'orders/create'},carrier_service={name:'Carrier',callback_url:'https://merchant.example.com/rates',carrier_code:'merchant',active:true,logo:'https://merchant.example.com/logo.png',short_desc:'Merchant carrier'};
    expect((await native.execute(config(),'webhook-create',{body:{webhook}})).status).toBe('acknowledged');expect((await native.execute(config(),'carrier-service-create',{body:{carrier_service}})).status).toBe('acknowledged');await native.execute(config(),'webhooks',{query:{topic:'orders/create',page_size:10}});await native.execute(config(),'carrier-service-delete',{path:{carrier_service_id:'c1'}});
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({webhook});expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({carrier_service});expect(fetch.mock.calls.every(([url])=>new URL(url).origin==='https://fixture.myshoplaza.com')).toBe(true);expect(fetch).toHaveBeenCalledTimes(4);
    const actions=native.actionsFor();expect(actions.webhooks.risk).toBe('R');expect(actions['webhook-create'].risk).toBe('H');expect(actions['carrier-service-delete'].risk).toBe('D');
  });
  it('encodes documented metafield map filters as JSON and enforces int64 business minima',async()=>{
    const fetch=vi.fn().mockResolvedValue(reply({metafields:[]}));vi.stubGlobal('fetch',fetch);
    await native.execute(config(),'shop-metafields',{query:{metafields:{key:'value'}}});expect(new URL(fetch.mock.calls[0][0]).searchParams.get('metafields')).toBe('{"key":"value"}');
    await expect(native.execute(config(),'variant-update',{path:{variant_id:'v1'},body:{variant:{price:10,whole_prices:[{price:8,min_quantity:'-1'}]}}})).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('serializes int64 as exact numeric JSON while preserving declared doubles and scientific numbers',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(reply({variant:{id:'v1',price:19}})).mockResolvedValueOnce(new Response('{"code":"Success","data":{"product":{"id":"p1","price_min":9007199254740993,"price_max":1e20,"compare_at_price_min":9007199254740993.5,"retail_price_min":1.25e30}}}'));vi.stubGlobal('fetch',fetch);
    await native.execute(config(),'variant-update',{path:{variant_id:'v1'},body:{variant:{price:19,inventory_quantity:'9223372036854775807',position:'-9223372036854775808'}}});
    expect(fetch.mock.calls[0][1].body).toBe('{"variant":{"price":19,"inventory_quantity":9223372036854775807,"position":-9223372036854775808}}');
    const product=(await native.execute(config(),'product-detail',{path:{product_id:'p1'}})).data.product;
    expect(product.price_min).toBe(Number('9007199254740993'));expect(product.price_max).toBe(1e20);expect(product.compare_at_price_min).toBe(Number('9007199254740993.5'));expect(product.retail_price_min).toBe(1.25e30);
  });
  it('rejects an unsafe scientific nested integer instead of returning a rounded identifier',async()=>{
    const fetch=vi.fn().mockResolvedValue(new Response('{"code":"Success","data":{"location":{"id":1.8446744073709551615e19,"name":"Warehouse"}}}'));vi.stubGlobal('fetch',fetch);
    await expect(native.execute(config(),'location-detail',{path:{location_id:'18446744073709551615'}})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps protobuf Struct/Value in native JSON form and preserves theme preview without a write acknowledgement',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(reply({schema:{children:[]},html:'<p>Ready</p>',failures:[]})).mockResolvedValueOnce(reply({data:[{op:'replace_props',result:'success'},{op:'remove_section',result:'private error '+token}]}));vi.stubGlobal('fetch',fetch);
    const preview={schema:{title:'Canvas',children:[{kind:'text',text:'Hello'}]},ops:[{op:'set',path:'0.text',value:'World'}]};expect(await native.execute(config(),'theme-pb-update',{body:preview})).toEqual({data:{schema:{children:[]},html:'<p>Ready</p>',failures:[]}});expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(preview);
    const body={operations:[{op:'replace_props',target:'hero',props:{title:'Hello',active:true}},{op:'remove_section',target:'old',value:'plain JSON value'}]};const result=await native.execute(config(),'theme-edit-session-batch-operations',{path:{oseid:'edit1',doc_id:'index'},body});expect(result).toEqual({data:{data:[{op:'replace_props',result:'success'},{op:'remove_section',result:'failed'}]},status:'partial_or_failed'});expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(body);expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects missing/reordered theme batch acknowledgements and marks draft conflicts as incomplete',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(reply({data:[]})).mockResolvedValueOnce(reply({data:[{op:'remove_section',result:'success'}]})).mockResolvedValueOnce(reply({promoted:false,conflict:true}));vi.stubGlobal('fetch',fetch);const parameters={path:{oseid:'e1',doc_id:'index'},body:{operations:[{op:'replace_props',target:'hero',props:{title:'New'}}]}};
    for(let i=0;i<2;i++)await expect(native.execute(config(),'theme-edit-session-batch-operations',parameters)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect((await native.execute(config(),'theme-edit-session-promote',{path:{oseid:'e1'}})).status).toBe('partial_or_failed');expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('does not claim incomplete comment and gift-card batches succeeded or disclose provider error prose',async()=>{
    const comment={product_id:'p1',user_name:'Example',star:5,like:0,created_at:'2026-10-01T00:00:00Z',content:'Great'};const fetch=vi.fn().mockResolvedValueOnce(reply({success_count:1,error_count:1,error_infos:[{...comment,error_message:'private response'}]})).mockResolvedValueOnce(reply({success_count:1,error_count:0,error_infos:[]})).mockResolvedValueOnce(reply({success_gift_cards:[{id:'g1',code:'ABCDEFGH'}],failed_gift_cards:[{code:'IJKLMNOP'}]}));vi.stubGlobal('fetch',fetch);
    expect(await native.execute(config(),'comment-batch-create',{body:{comments:[comment,comment]}})).toEqual({data:{success_count:1,error_count:1,error_infos:[comment]},status:'partial_or_failed'});await expect(native.execute(config(),'comment-batch-create',{body:{comments:[comment,comment]}})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
    expect((await native.execute(config(),'gift-card-batch-create',{body:{gift_cards:[{code:'ABCDEFGH',initial_value:'10',currency:'USD'},{code:'IJKLMNOP',initial_value:'10',currency:'USD'}]}})).status).toBe('partial_or_failed');expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('accepts documented empty acknowledgements and returns asynchronous acceptance without hidden polling',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(reply({})).mockResolvedValueOnce(reply({task_id:'task1'})).mockResolvedValueOnce(reply({task_id:'task1',status:1,total:1,finished:1,success_list:[],failure_list:['https://cdn.example.com/bad.png']}));vi.stubGlobal('fetch',fetch);
    expect(await native.execute(config(),'product-delete',{path:{product_id:'p1'}})).toEqual({data:{},status:'acknowledged'});const uploaded=await native.execute(config(),'file-create',{body:{original_source_list:['https://cdn.example.com/bad.png']}});expect(uploaded.status).toBe('accepted');expect(fetch).toHaveBeenCalledTimes(2);expect((await native.execute(config(),'file-upload-task',{path:{task_id:'task1'}})).status).toBe('partial_or_failed');
  });
  it('rejects missing/foreign resource acknowledgements, unchanged cancellation and credential echoes',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(reply({})).mockResolvedValueOnce(reply({product:{id:'foreign'}})).mockResolvedValueOnce(reply({order:{id:'o1',status:'placed',financial_status:'paid'}})).mockResolvedValueOnce(reply({product:{id:'p1',title:token,access_token:token,description:'Merchant description'}}));vi.stubGlobal('fetch',fetch);
    for(let i=0;i<2;i++)await expect(native.execute(config(),'product-detail',{path:{product_id:'p1'}})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect((await native.execute(config(),'order-cancel',{path:{order_id:'o1'}})).status).toBe('partial_or_failed');expect((await native.execute(config(),'product-detail',{path:{product_id:'p1'}})).data.product).toEqual({id:'p1',title:'[redacted]',description:'Merchant description'});
  });
  it('blocks schema/size/batch/integer overflow and binding tampering before IO',async()=>{
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    for(const [name,p]of [['products',{query:{per_page:101}}],['products',{query:{location_id:'18446744073709551616'}}],['product-detail',{path:{product_id:'..'}}],['product-detail',{path:{product_id:'p1'},headers:{'Access-Token':'evil'}}],['product-create',{body:{product:{title:'Missing required fields'}}}],['theme-pb-update',{body:{schema:{v:'x'.repeat(256*1024)}}}],['theme-edit-session-batch-operations',{path:{oseid:'e1',doc_id:'index'},body:{operations:Array.from({length:11},()=>({op:'remove_section',target:'hero'}))}}]])await expect(native.execute(config(),name,p)).rejects.toMatchObject({code:'E_BAD_INPUT'});
    const c=config();c.metadata.store_domain='other.myshoplaza.com';await expect(native.execute(c,'products')).rejects.toMatchObject({code:'storefront_binding_mismatch'});expect(fetch).not.toHaveBeenCalled();
  });
  it('classifies permission, business, rate-limit, network, timeout, cancellation and oversized responses without retries',async()=>{
    for(const [status,code]of [[403,'E_TOOL_CALL_AUTH'],[429,'E_TOOL_CALL_RATE_LIMIT'],[503,'E_TOOL_CALL_UPSTREAM']] as const){const fetch=vi.fn().mockResolvedValue(reply({private:token},status));vi.stubGlobal('fetch',fetch);await expect(native.execute(config(),'products')).rejects.toMatchObject({code});expect(fetch).toHaveBeenCalledTimes(1);}
    const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({code:'PermissionDenied',message:token,data:{products:[]}}))).mockRejectedValueOnce(new DOMException('private','TimeoutError')).mockResolvedValueOnce(reply({products:[{description:'x'.repeat(1024*1024)}]}));vi.stubGlobal('fetch',fetch);await expect(native.execute(config(),'products')).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});await expect(native.execute(config(),'product-delete',{path:{product_id:'p1'}})).rejects.toMatchObject({code:'E_TOOL_CALL_TIMEOUT'});await expect(native.execute(config(),'products')).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(3);
    const controller=new AbortController();controller.abort();await expect(withRequestSignal(controller.signal,()=>native.execute(config(),'products'))).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});expect(fetch).toHaveBeenCalledTimes(3);
  });
});
