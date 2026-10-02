import { afterEach, describe, expect, it, vi } from 'vitest';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require=createRequire(import.meta.url),native=require('../../../../bin/woocommerce-business-api.cjs'),contracts=require('../../../../bin/woocommerce-api-contracts.cjs'),adapter=require('../../../../bin/direct-commerce-mcp-server.cjs');
const {AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv'),{withRequestSignal}=require('../../../../bin/commerce-request-context.cjs');
const evidence=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../../fixtures/connectors/official-contracts/woocommerce-20261001.json'),'utf8'));
const config=()=>({provider:'woocommerce',metadata:{store_url:'https://shop.example.com/store'},credentials:{consumer_key:'ck_'+'a'.repeat(40),consumer_secret:'cs_'+'b'.repeat(40)}});
const owners={base:adapter.woocommerceBase},response=(data:unknown,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
// Independent cases protect merchant catalog/fulfillment, source-version gaps,
// root-array replacement, batch partial results, pagination and failure/no replay.
describe('WooCommerce published merchant API contracts',()=>{
  it('describes reviewed fixed routes and every published writable resource field with valid schemas',()=>{
    const actions=native.actionsFor(),v=new AjvJsonSchemaValidator();expect(Object.keys(actions)).toHaveLength(132);expect(evidence.release).toBe('11.1.2');
    for(const row of evidence.inventory){const name=row.method+' '+row.path,s=actions[name];expect(s.risk).toBe(row.risk);expect(()=>v.getValidator(s.input_schema)).not.toThrow();
      if(row.resource&&['POST','PUT'].includes(row.method)&&row.response_kind!=='batch'&&!row.path.endsWith('/locations')){
        const expected=Object.entries(evidence.schemas[row.resource].properties).filter(([,s]:any)=>!s.readonly).map(([k])=>k);for(const key of expected)expect(s.input_schema.properties.body.properties).toHaveProperty(key);
      }
    }
    expect(actions['POST /orders/{id}/actions/send_email'].risk).toBe('H');expect(actions['POST /products/batch'].risk).toBe('D');expect(actions['PUT /system_status/tools/{id}']).toBeUndefined();expect(actions['POST /paypal-buttons/create-order']).toBeUndefined();
    expect(actions['PUT /products/{id}'].input_schema.properties.body.properties.id).toBeUndefined();expect(actions['PUT /orders/{id}'].input_schema.properties.body.properties.line_items.items.properties.id).toBeTruthy();
    expect(actions['GET /orders'].input_schema.properties.query.properties.context).toMatchObject({type:'string',enum:['view','edit']});expect(actions['PUT /products/{id}'].input_schema.properties.body.properties.stock_quantity.type).toBe('number');
    const original=native.actionsFor;vi.spyOn(native,'actionsFor').mockReturnValue({});expect(native.actionsFor()['PUT /products/{id}']).toBeUndefined();expect(original()['PUT /products/{id}']).toBeTruthy();
  });
  it('preserves current product fields and full nested order edits on the bound store',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(response({id:42,name:'Linen',global_unique_id:'0012345678905'})).mockResolvedValueOnce(response({id:723,billing:{email:'buyer@example.invalid'},shipping:{address_1:'Example Street'},customer_note:'error is a merchant word',line_items:[{id:449,quantity:2}]}));vi.stubGlobal('fetch',fetch);
    const product={name:'Linen',global_unique_id:'0012345678905',brands:[{id:7}],regular_price:'19.95',stock_quantity:0,manage_stock:true,low_stock_amount:2,date_created:'2026-09-22T10:00:00',images:[{id:6,alt:'Blue linen'}],meta_data:[{key:'sizing',value:{sizes:['S','M']}}]};
    expect((await native.execute(config(),'PUT /products/{id}',{path:{id:42},body:product},owners)).status).toBe('acknowledged');expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(product);expect(fetch.mock.calls[0][0]).toBe('https://shop.example.com/store/wp-json/wc/v3/products/42');
    const order={manual_update:true,created_via:'admin',billing:{email:'buyer@example.invalid'},shipping:{address_1:'Example Street'},line_items:[{id:449,quantity:2,meta_data:[{id:12,key:'size',value:'M'}]}]};
    const result=await native.execute(config(),'PUT /orders/{id}',{path:{id:723},body:order},owners);expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(order);expect(result.data).toMatchObject({billing:{email:'buyer@example.invalid'},shipping:{address_1:'Example Street'},customer_note:'error is a merchant word'});
    expect(fetch.mock.calls[0][1].headers.authorization).toBe('Basic '+Buffer.from(config().credentials.consumer_key+':'+config().credentials.consumer_secret).toString('base64'));
  });
  it('uses current status arrays and bracketed WordPress filters without losing pagination metadata',async()=>{
    const fetch=vi.fn().mockResolvedValue(response([{id:723}],200,{'x-wp-total':'235','x-wp-totalpages':'3'}));vi.stubGlobal('fetch',fetch);
    const result=await native.execute(config(),'GET /orders',{query:{status:['processing','on-hold'],created_via:['checkout','admin'],include:[723,724],per_page:100,page:2}},owners),url=new URL(fetch.mock.calls[0][0]);
    expect(url.searchParams.get('status[0]')).toBe('processing');expect(url.searchParams.get('status[1]')).toBe('on-hold');expect(url.searchParams.get('include[1]')).toBe('724');expect(result).toEqual({data:[{id:723}],pagination:{total:235,total_pages:3}});expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('supports published related/suggested products and read-only refund previews without creating refunds',async()=>{
    const preview={breakdown:{products:{items:[{id:449,quantity:1,total:'11.00'}]}},subtotal:'10.00',tax:'1.00',total:'11.00',max_refundable:'22.00'};
    const fetch=vi.fn().mockResolvedValueOnce(response({related_ids:[42,43]})).mockResolvedValueOnce(response([])).mockResolvedValueOnce(response(preview));vi.stubGlobal('fetch',fetch);
    expect((await native.execute(config(),'GET /products/{id}/related',{path:{id:41}},owners)).data).toEqual({related_ids:[42,43]});
    await native.execute(config(),'GET /products/suggested-products',{query:{categories:[7],tags:[9],limit:5}},owners);expect(new URL(fetch.mock.calls[1][0]).searchParams.get('categories[0]')).toBe('7');
    const body={line_items:[{line_item_id:449,quantity:1,refund_total:11}]};expect(await native.execute(config(),'POST /orders/{order_id}/refunds/preview',{path:{order_id:723},body},owners)).toEqual({data:preview});expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual(body);
    await expect(native.execute(config(),'POST /orders/{order_id}/refunds/preview',{path:{order_id:723},body:{line_items:[{quantity:1}]}},owners)).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(fetch).toHaveBeenCalledTimes(3);
    expect(native.actionsFor()['POST /products/{product_id}/variations/generate']).toBeUndefined();
  });
  it('accepts string shipping method identifiers from the official resource schema',async()=>{const fetch=vi.fn().mockResolvedValue(response({id:'flat_rate',title:'Flat rate'}));vi.stubGlobal('fetch',fetch);expect((await native.execute(config(),'GET /shipping_methods/{id}',{path:{id:'flat_rate'}},owners)).data.id).toBe('flat_rate');});
  it('retains tax postcode/city arrays and custom store tax classes omitted by the old example',async()=>{
    const fetch=vi.fn().mockResolvedValue(response({id:11,postcodes:['10001','10002'],cities:['New York']}));vi.stubGlobal('fetch',fetch);
    const body={country:'US',state:'NY',postcodes:['10001','10002'],cities:['New York'],rate:'8.8750',class:'merchant-special',priority:1};await native.execute(config(),'POST /taxes',{body},owners);expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(body);
  });
  it('replaces shipping locations with a root array, permits explicit clearing and accepts instance setting maps',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(response([{code:'US:NY',type:'state'}])).mockResolvedValueOnce(response([])).mockResolvedValueOnce(response({instance_id:9,settings:{cost:{value:'5.00'}}}));vi.stubGlobal('fetch',fetch);
    await native.execute(config(),'PUT /shipping/zones/{id}/locations',{path:{id:5},body:[{code:'US:NY',type:'state'}]},owners);expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual([{code:'US:NY',type:'state'}]);
    expect(await native.execute(config(),'PUT /shipping/zones/{id}/locations',{path:{id:5},body:[]},owners)).toMatchObject({status:'acknowledged',data:[]});
    const body={enabled:true,settings:{cost:'5.00',tax_status:'taxable',dimensions:{width:320,height:240,crop:true}}};await native.execute(config(),'PUT /shipping/zones/{zone_id}/methods/{instance_id}',{path:{zone_id:5,instance_id:9},body},owners);expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual(body);
  });
  it('preserves successful batch items, classifies official per-item errors and rejects missing or unrelated acknowledgements',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(response({create:[{id:90,name:'New'}],update:[{id:12,error:{code:'invalid_tax',message:'private buyer@example.invalid',data:{status:400,private:'hidden'}}}],delete:[{id:13}]})).mockResolvedValueOnce(response({update:[]})).mockResolvedValueOnce(response({update:[{id:99}]}));vi.stubGlobal('fetch',fetch);
    const body={create:[{name:'New'}],update:[{id:12,name:'Old'}],delete:[13]};expect(await native.execute(config(),'POST /taxes/batch',{body},owners)).toEqual({status:'partial_or_failed',data:{create:[{id:90,name:'New'}],update:[{id:12,error:{code:'invalid_tax',data:{status:400}}}],delete:[{id:13}]}});
    for(let i=0;i<2;i++)await expect(native.execute(config(),'POST /taxes/batch',{body:{update:[{id:12,name:'Old'}]}},owners)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('rejects false acknowledgements, preserves legitimate empty collections and strips credential echoes only',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(response({})).mockResolvedValueOnce(response({id:999})).mockResolvedValueOnce(response([])).mockResolvedValueOnce(response({code:'bad_input',message:'private response',data:{status:400}})).mockResolvedValueOnce(response({id:42,name:config().credentials.consumer_secret,meta_data:[{key:'error',value:'keep'}],consumer_key:'hidden'}));vi.stubGlobal('fetch',fetch);
    await expect(native.execute(config(),'PUT /products/{id}',{path:{id:42},body:{name:'New'}},owners)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});await expect(native.execute(config(),'GET /products/{id}',{path:{id:42}},owners)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
    expect(await native.execute(config(),'GET /products',{},owners)).toEqual({data:[]});await expect(native.execute(config(),'GET /products',{},owners)).rejects.toThrow('WooCommerce returned a business error');expect((await native.execute(config(),'GET /products/{id}',{path:{id:42}},owners)).data).toEqual({id:42,name:'[redacted]',meta_data:[{key:'error',value:'keep'}]});
  });
  it('blocks malformed fields, size, duplicate/combined batch overflow and unsafe store before IO',async()=>{
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    for(const [name,p]of [['GET /products',{headers:{authorization:'other'}}],['GET /products',{query:{per_page:101}}],['PUT /products/{id}',{path:{id:42},body:{unpublished_field:true}}],['PUT /products/{id}',{path:{id:42},body:{name:'x'.repeat(256*1024)}}],['POST /taxes/batch',{body:{update:[{id:1},{id:1}]}}],['POST /taxes/batch',{body:{update:Array.from({length:6},(_,i)=>({id:i+1})),delete:[7,8,9,10,11]}}],['GET /taxes',{query:{page:0}}]])await expect(native.execute(config(),name,p,owners)).rejects.toMatchObject({code:'E_BAD_INPUT'});
    const c=config();c.metadata.store_url='https://127.0.0.1/private';await expect(native.execute(c,'GET /products',{},owners)).rejects.toThrow('invalid WooCommerce store binding');expect(fetch).not.toHaveBeenCalled();
  });
  it('classifies HTTP/body size/cancellation/timeout failures without retries or provider error text',async()=>{
    for(const [status,code]of [[403,'E_TOOL_CALL_AUTH'],[429,'E_TOOL_CALL_RATE_LIMIT'],[503,'E_TOOL_CALL_UPSTREAM']] as const){const fetch=vi.fn().mockResolvedValue(response({message:'private data'},status));vi.stubGlobal('fetch',fetch);await expect(native.execute(config(),'GET /products',{},owners)).rejects.toMatchObject({code});expect(fetch).toHaveBeenCalledTimes(1);}
    const timeout=vi.fn().mockRejectedValue(new DOMException('private','TimeoutError'));vi.stubGlobal('fetch',timeout);await expect(native.execute(config(),'PUT /products/{id}',{path:{id:42},body:{name:'New'}},owners)).rejects.toMatchObject({code:'E_TOOL_CALL_TIMEOUT'});expect(timeout).toHaveBeenCalledTimes(1);
    const oversized=vi.fn().mockResolvedValue(response([{id:1,name:'x'.repeat(1024*1024)}]));vi.stubGlobal('fetch',oversized);await expect(native.execute(config(),'GET /products',{},owners)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(oversized).toHaveBeenCalledTimes(1);
    const controller=new AbortController();controller.abort();const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await expect(withRequestSignal(controller.signal,()=>native.execute(config(),'GET /products',{},owners))).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});expect(fetch).not.toHaveBeenCalled();
  });
});
