import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
const require=createRequire(import.meta.url),native=require('../../../../bin/lightspeed-business-api.cjs'),{AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv'),{withRequestSignal}=require('../../../../bin/commerce-request-context.cjs');
const evidence=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../../fixtures/connectors/official-contracts/lightspeed-20261001.json'),'utf8'));
const id='550e8400-e29b-41d4-a716-446655440000',other='550e8400-e29b-41d4-a716-446655440001',token='fixture-lightspeed-personal-token';
const config=()=>({provider:'lightspeed',metadata:{store_domain:'merchant.retail.lightspeed.app'},credentials:{provider:'lightspeed',access_token:token}}),reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
// Independent provider contracts supply the wire/acknowledgement oracles. These
// journeys expose lost fields, wrong authority, partial batches and rounded IDs.
describe('Lightspeed merchant operations',()=>{
  it('describes all current merchant operations with complete fields and semantic risk lanes',()=>{
    const actions=native.actionsFor(),v=new AjvJsonSchemaValidator();expect(Object.keys(actions)).toHaveLength(194);for(const a of Object.values(actions) as any[])expect(()=>v.getValidator(a.input_schema)).not.toThrow();
    expect(evidence.exclusions.filter((x:any)=>x.category==='deprecated')).toHaveLength(2);expect(actions['POST /partner/billing/token']).toBeUndefined();expect(actions['POST /products/{product_id}/actions/image_upload']).toBeUndefined();
    for(const name of ['POST /discount','POST /inventory','POST /inventory_levels','POST /users/bulk','POST /promocode/bulk/active','POST /store_credits/balances-bulk','POST /store_credits/bulk','POST /partial_packing_slip/{fulfillment_id}'])expect(actions[name].risk).toBe('R');
    expect(actions['PUT /sales/{sale_id}'].risk).toBe('D');expect(actions['POST /webhooks'].risk).toBe('H');expect(actions['PUT /products/{product_id}'].input_schema.$defs.ProductUpdate21Request.properties.details.properties.packaging).toBeTruthy();
    expect(actions['PUT /sales/{sale_id}'].input_schema.$defs.SaleUpdateRequest.required).toEqual(expect.arrayContaining(['source','state']));expect(JSON.stringify(Object.values(actions).map((a:any)=>a.description))).not.toContain('source_breakdown');
  });
  it('creates a complete catalog record and updates variant inventory and accounting fields without pruning',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(reply({data:[id]})).mockResolvedValueOnce(reply({}));vi.stubGlobal('fetch',fetch);
    const body={name:'Linen',sku:'LINEN',price_excluding_tax:19.95,is_active:true,dimensions_unit:'CM',height:2,weight:0.2,weight_unit:'KG',account_code_purchase:'500',inventory:[{outlet_id:id,current_amount:0,reorder_point:-1}],product_codes:[{id:other,type:'CUSTOM',code:'LINEN'}]};
    expect((await native.execute(config(),'POST /products',{body})).status).toBe('acknowledged');expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(body);
    const update={common:{name:'New',tag_ids:[],track_inventory:true},details:{price_excluding_tax:25,inventory:[{outlet_id:id,current_amount:0}],packaging:[{amount:2,source_product_id:id,destination_product_id:other}]}};
    await native.execute(config(),'PUT /products/{product_id}',{path:{product_id:id},body:update});expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(update);expect(fetch.mock.calls[1][0]).toBe('https://merchant.retail.lightspeed.app/api/2026-07/products/'+id);
  });
  it('retains fulfillment addresses, version pagination and complete nested business output',async()=>{
    const body={data:[{id,shipping_address:{email:'buyer@example.invalid',address_line_1:'Example Street'},line_items:[{id:other,note:'error is merchant text'}],note:'Keep me'}],version:{min:1,max:2},pagination:{next_cursor:'after'}};
    const fetch=vi.fn().mockResolvedValue(reply(body));vi.stubGlobal('fetch',fetch);expect((await native.execute(config(),'GET /sales',{query:{after:0}})).data).toEqual(body);expect(new URL(fetch.mock.calls[0][0]).searchParams.get('page_size')).toBe('100');
  });
  it('preserves exact int64 values and sends body/query versions without rounding; doubles remain numeric',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(reply([])).mockResolvedValueOnce(new Response('{"data":[{"id":"'+id+'","version":9223372036854775807,"price_excluding_tax":1e20}],"version":{"min":9223372036854775806,"max":9223372036854775807}}')).mockResolvedValueOnce(new Response('{"data":[{"id":"'+id+'","version":9.223372036854775807e18}],"version":{"min":1,"max":2}}'));vi.stubGlobal('fetch',fetch);
    await native.execute(config(),'POST /inventory',{body:{after:'9223372036854775807'}});expect(fetch.mock.calls[0][1].body).toBe('{"size":100,"after":9223372036854775807}');
    const result=await native.execute(config(),'GET /products',{query:{after:'9223372036854775806','includes[]':['composite_products','second']}});expect(result.data.version.max).toBe('9223372036854775807');expect(result.data.data[0].version).toBe('9223372036854775807');expect(result.data.data[0].price_excluding_tax).toBe(1e20);expect(new URL(fetch.mock.calls[1][0]).searchParams.getAll('includes[]')).toEqual(['composite_products','second']);
    await expect(native.execute(config(),'GET /products')).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
  });
  it('checks nested nullable sale metadata without rounding and accepts equivalent stock decimal formatting',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(new Response('{"data":{"id":"'+id+'","_metadata":{"version":9.223372036854775807e18}}}')).mockResolvedValueOnce(reply({data:[{id:'adjustment',product_id:id,outlet_id:other,quantity:'1.00000'}]},201));vi.stubGlobal('fetch',fetch);
    await expect(native.execute(config(),'GET /sales/{sale_id}',{path:{sale_id:id}})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
    expect((await native.execute(config(),'POST /stock_adjustments',{body:{stock_adjustments:[{product_id:id,outlet_id:other,quantity:'1',reason:'STOCK_FOUND'}]}})).status).toBe('acknowledged');
  });
  it('correlates partial customer-tax results by original index and rejects missing or foreign acknowledgements',async()=>{
    const body={customer_tax:[{customer_id:id,tax_id:other},{customer_id:other,tax_id:null}]},partial={data:{results:{successful:[{index:0,...body.customer_tax[0]}],failed:[{index:1,...body.customer_tax[1],errors:[{code:'VALIDATION_ERROR',messages:['private prose']}]}]},summary:{total_processed:2,success_count:1,error_count:1}}};
    const fetch=vi.fn().mockResolvedValueOnce(reply(partial,207)).mockResolvedValueOnce(reply({data:{...partial.data,summary:{total_processed:2,success_count:2,error_count:0}}})).mockResolvedValueOnce(reply({data:{...partial.data,results:{successful:[{index:0,customer_id:other,tax_id:other}],failed:partial.data.results.failed}}}));vi.stubGlobal('fetch',fetch);
    const result=await native.execute(config(),'POST /customer_taxes/bulk',{body});expect(result.status).toBe('partial_or_failed');expect(result.data.data.results.failed[0].errors).toEqual([{code:'VALIDATION_ERROR'}]);for(let i=0;i<2;i++)await expect(native.execute(config(),'POST /customer_taxes/bulk',{body})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('retains independently applied loyalty changes and does not claim undeleted promo codes succeeded',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(reply({applied:[{customer_id:id,balance:10}],errors:[{customer_id:other,error:'private prose'}]},207)).mockResolvedValueOnce(reply(['CODE2'])).mockResolvedValueOnce(reply(['foreign']));vi.stubGlobal('fetch',fetch);
    const result=await native.execute(config(),'POST /loyalty/adjustments/bulk',{body:{session_id:id,adjustments:[{customer_id:id,credit:1},{customer_id:other,debit:2}]}});expect(result).toEqual({data:{applied:[{customer_id:id,balance:10}],errors:[{customer_id:other}]},status:'partial_or_failed'});
    expect((await native.execute(config(),'DELETE /promocode/bulk',{body:['CODE1','CODE2']})).status).toBe('partial_or_failed');await expect(native.execute(config(),'DELETE /promocode/bulk',{body:['CODE1','CODE2']})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('verifies ordered stock acknowledgements and uses the documented product-ID consignment response map',async()=>{
    // StockAdjustmentBatchResponse explicitly promises the same order as request.
    const item={product_id:id,outlet_id:other,quantity:'1',reason:'STOCK_FOUND'},fetch=vi.fn().mockResolvedValueOnce(reply({data:[{id:'adjustment',...item}]},201)).mockResolvedValueOnce(reply({data:[{id:'adjustment',...item,product_id:other}]},201)).mockResolvedValueOnce(reply({data:{[id]:{count:'60.00000'}}}));vi.stubGlobal('fetch',fetch);
    expect((await native.execute(config(),'POST /stock_adjustments',{body:{stock_adjustments:[item]}})).status).toBe('acknowledged');await expect(native.execute(config(),'POST /stock_adjustments',{body:{stock_adjustments:[item]}})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect((await native.execute(config(),'POST /consignments/{consignment_id}/bulk',{path:{consignment_id:other},body:[{product_id:id,count:'60'}]})).status).toBe('acknowledged');
  });
  it('returns bounded inert packing HTML and registers merchant callback URLs only at the bound platform',async()=>{
    const html='<html><body>Pack one item <script>untrusted()</script></body></html>',fetch=vi.fn().mockResolvedValueOnce(new Response(html,{headers:{'content-type':'text/html'}})).mockResolvedValueOnce(reply({data:{id:'webhook1',active:true,type:'sale.update',url:'https://merchant.example.com/webhook'}},201));vi.stubGlobal('fetch',fetch);
    expect(await native.execute(config(),'GET /packing_slip/{fulfillment_id}',{path:{fulfillment_id:'9223372036854775807'}})).toEqual({data:html,media_type:'text/html'});
    const body={active:true,type:'sale.update',url:'https://merchant.example.com/webhook'};await native.execute(config(),'POST /webhooks',{body});expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(body);expect(fetch.mock.calls.every(([url])=>new URL(url).origin==='https://merchant.retail.lightspeed.app')).toBe(true);
  });
  it('rejects metadata-only, empty created IDs, unchanged void and unrelated resource acknowledgements',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(reply({version:{min:1,max:2}})).mockResolvedValueOnce(reply({data:[]})).mockResolvedValueOnce(reply({data:{id:other}})).mockResolvedValueOnce(reply({data:{id,state:'closed'}})).mockResolvedValueOnce(new Response(null,{status:204}));vi.stubGlobal('fetch',fetch);
    await expect(native.execute(config(),'GET /products')).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});await expect(native.execute(config(),'POST /products',{body:{name:'Linen'}})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});await expect(native.execute(config(),'GET /products/{product_id}',{path:{product_id:id}})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
    expect((await native.execute(config(),'PUT /sales/{sale_id}',{path:{sale_id:id},body:{source:{author_id:other},state:'voided'}})).status).toBe('partial_or_failed');expect((await native.execute(config(),'DELETE /customers/{customer_id}',{path:{customer_id:id}})).status).toBe('acknowledged');
  });
  it('blocks unknown fields, overflow, excessive pages/batches, empty required fields and authority changes before IO',async()=>{
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    for(const [name,p]of [['GET /products',{query:{page_size:101}}],['POST /inventory',{body:{size:101}}],['POST /products',{body:{}}],['POST /products',{body:{name:'Linen',raw_url:'https://evil.test'}}],['GET /products',{query:{after:'9223372036854775808'}}],['GET /products/{product_id}',{path:{product_id:'..'}}],['POST /stock_adjustments',{body:{stock_adjustments:Array.from({length:11},()=>({product_id:id,outlet_id:other,quantity:'1',reason:'STOCK_FOUND'}))}}],['POST /products',{body:{name:'x'.repeat(256*1024)}}],['POST /loyalty/adjustments/bulk',{body:{adjustments:[{customer_id:id,credit:1,debit:1}]}}]])await expect(native.execute(config(),name,p)).rejects.toMatchObject({code:'E_BAD_INPUT'});
    const c=config();c.metadata.store_domain='merchant.retail.lightspeed.app.evil.test';await expect(native.execute(c,'GET /products')).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});expect(fetch).not.toHaveBeenCalled();
  });
  it('classifies authorization, upstream, rate limit, timeout and cancellation without retries or secret disclosure',async()=>{
    for(const [status,code]of [[401,'E_TOOL_CALL_AUTH'],[403,'E_TOOL_CALL_AUTH'],[429,'E_TOOL_CALL_RATE_LIMIT'],[503,'E_TOOL_CALL_UPSTREAM']] as const){const fetch=vi.fn().mockResolvedValue(reply({error:token},status));vi.stubGlobal('fetch',fetch);await expect(native.execute(config(),'GET /products')).rejects.toMatchObject({code});expect(fetch).toHaveBeenCalledTimes(1);}
    const fetch=vi.fn().mockRejectedValueOnce(new DOMException(token,'TimeoutError')).mockResolvedValueOnce(reply({data:[{name:'x'.repeat(1024*1024)}]})).mockResolvedValueOnce(reply({data:{id,name:token,access_token:token,note:'Business note'}}));vi.stubGlobal('fetch',fetch);await expect(native.execute(config(),'POST /products',{body:{name:'Linen'}})).rejects.toMatchObject({code:'E_TOOL_CALL_TIMEOUT'});await expect(native.execute(config(),'GET /products')).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect((await native.execute(config(),'GET /products/{product_id}',{path:{product_id:id}})).data.data).toEqual({id,name:'[redacted]',note:'Business note'});
    const controller=new AbortController();controller.abort();await expect(withRequestSignal(controller.signal,()=>native.execute(config(),'GET /products'))).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});expect(fetch).toHaveBeenCalledTimes(3);
  });
});
