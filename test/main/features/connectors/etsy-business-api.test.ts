import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require=createRequire(import.meta.url),native=require('../../../../bin/etsy-business-api.cjs'),contracts=require('../../../../bin/etsy-api-contracts.cjs');
const {withRequestSignal}=require('../../../../bin/commerce-request-context.cjs'),{AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv');
const evidence=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../../fixtures/connectors/official-contracts/etsy-20261001.json'),'utf8'));
const config=()=>({provider:'etsy',metadata:{shop_id:'67890'},credentials:{access_token:'12345.fixture-access',refresh_token:'12345.fixture-refresh',shared_secret:'fixture-private-secret',scope:'shops_r shops_w listings_r listings_w listings_d transactions_r transactions_w',identity:{user_id:'12345',shop_id:'67890'}}});
const owners={token:vi.fn(async(c:any)=>c.credentials.access_token),apiKey:()=> 'fixture-app-key:fixture-private-secret'};
const response=(data:unknown,status=200)=>new Response(data===null?null:JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();owners.token.mockClear();});
// Scenario portfolio: full usable contracts, bound fulfillment data, JSON/CSV
// writes, binary media, partial resources, false success and cancellation.
describe('Etsy merchant business contracts',()=>{
  it('covers official usable inventory and writable input fields with no response graph in discovery',()=>{
    const actions=native.actionsFor(),validator=new AjvJsonSchemaValidator();
    expect(evidence.inventory).toHaveLength(105);expect(Object.keys(actions)).toHaveLength(99);
    expect(contracts.excluded_methods).toMatchObject({getUser:expect.stringContaining('email_r'),tokenScopes:expect.stringContaining('OAuth tokens')});
    const compare=(raw:any,current:any)=>{
      if(raw.nullable)current=current.anyOf.find((s:any)=>s.type!=='null');
      if(raw.$ref){expect(current.$ref).toBe(raw.$ref.replace('#/components/schemas/','#/$defs/'));return;}
      if(raw.type)expect(current.type).toEqual(raw.type);if(raw.enum)expect(current.enum).toEqual(raw.enum);
      if(raw.properties){expect(Object.keys(current.properties).sort()).toEqual(Object.keys(raw.properties).filter(k=>!raw.properties[k].readOnly).sort());for(const [key,value]of Object.entries(raw.properties))if(!(value as any).readOnly)compare(value,current.properties[key]);}
      if(raw.required)expect(current.required).toEqual(raw.required);if(raw.items)compare(raw.items,current.items);
    };
    for(const row of evidence.inventory){
      if(row.excluded_reason){expect(actions[row.operation]).toBeUndefined();continue;}
      const action=actions[row.operation],op=evidence.model.paths[row.path][row.method.toLowerCase()];expect(action.risk).toBe(row.risk);expect(()=>validator.getValidator(action.input_schema)).not.toThrow();
      for(const p of op.parameters){if(p.in==='path'&&['shop_id','user_id'].includes(p.name)){expect(action.input_schema.properties.path?.properties[p.name]).toBeUndefined();continue;}compare(p.schema,action.input_schema.properties[p.in].properties[p.name]);}
      if(op.requestBody)compare((Object.values(op.requestBody.content)[0] as any).schema,action.input_schema.properties.body);
      for(const [id,definition]of Object.entries(action.input_schema.$defs))compare(evidence.model.components.schemas[id],definition);
      expect(action.input_schema.$defs.ShopReceipt).toBeUndefined();
      const contract=contracts.methods[row.operation];for(const schema of Object.values(contract.responses))if(schema)expect(()=>validator.getValidator({...schema as object,$defs:contracts.definitions.output})).not.toThrow();
    }
    const original=native.actionsFor;vi.spyOn(native,'actionsFor').mockReturnValue({});expect(native.actionsFor().getShopReceipts).toBeUndefined();expect(original().getShopReceipts).toBeDefined();
  });
  it('binds shop and owner paths, preserves fulfillment contacts, and blocks caller binding overrides',async()=>{
    const page={count:42,results:[{receipt_id:101,name:'Example Buyer',first_line:'10 Example Street',buyer_email:'buyer@example.invalid',message_from_buyer:'Keep my error: fragile',grandtotal:{amount:1000,divisor:100,currency_code:'USD'}}]},fetch=vi.fn().mockResolvedValue(response(page));vi.stubGlobal('fetch',fetch);
    expect(await native.execute(config(),'getShopReceipts',{query:{limit:100,offset:0}},owners)).toEqual({data:page});
    expect(fetch.mock.calls[0][0]).toBe('https://openapi.etsy.com/v3/application/shops/67890/receipts?limit=100&offset=0');expect(fetch.mock.calls[0][1].headers).toMatchObject({authorization:'Bearer 12345.fixture-access','x-api-key':'fixture-app-key:fixture-private-secret'});
    await expect(native.execute(config(),'getShopReceipts',{path:{shop_id:999}},owners)).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue(response({shop_id:67890}));await native.execute(config(),'getShopByOwnerUserId',{},owners);expect(fetch.mock.calls[1][0]).toBe('https://openapi.etsy.com/v3/application/users/12345/shops');
  });
  it('uses official CSV form arrays and preserves complete JSON inventory replacement',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(response({listing_id:101})).mockResolvedValueOnce(response({products:[{product_id:901,offerings:[]}]}));vi.stubGlobal('fetch',fetch);
    await native.execute(config(),'updateListing',{path:{listing_id:101},body:{tags:['linen','blue'],materials:null,state:'active'}},owners);
    const form=new URLSearchParams(fetch.mock.calls[0][1].body);expect(form.getAll('tags')).toEqual(['linen,blue']);expect(form.get('materials')).toBe('');
    const body={products:[{sku:'SKU-01',offerings:[{price:12.5,quantity:4,is_enabled:true,readiness_state_id:null}],property_values:[{property_id:200,value_ids:[1],values:['Blue'],scale_id:null}]}],price_on_property:[200],readiness_state_on_property:[]};
    expect((await native.execute(config(),'updateListingInventory',{path:{listing_id:101},query:{max_variations_supported:'3'},body},owners)).status).toBe('acknowledged');expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(body);expect(fetch.mock.calls[1][0]).toContain('?max_variations_supported=3');expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('surfaces incomplete listing batches with successes and rejects unrelated resources',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(response({count:1,results:[{listing_id:101,inventory:null}]})).mockResolvedValueOnce(response({count:1,results:[{listing_id:999}]}));vi.stubGlobal('fetch',fetch);
    expect(await native.execute(config(),'getListingsInventoryByListingIds',{query:{listing_ids:[101,102]}},owners)).toEqual({data:{count:1,results:[{listing_id:101,inventory:null}]},status:'partial_or_failed',missing_listing_ids:[102]});expect(new URL(fetch.mock.calls[0][0]).searchParams.getAll('listing_ids')).toEqual(['101,102']);
    await expect(native.execute(config(),'getListingsByListingIds',{query:{listing_ids:[101,102]}},owners)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('uploads bounded bytes or associates existing media without reading paths or fetching caller URLs',async()=>{
    const fetch=vi.fn().mockImplementation(()=>Promise.resolve(response({listing_file_id:88,filename:'pattern.txt'},201)));vi.stubGlobal('fetch',fetch);
    await native.execute(config(),'uploadListingFile',{path:{listing_id:101},body:{file:Buffer.from('A textile pattern').toString('base64'),name:'pattern.txt',rank:1}},owners);
    const init=fetch.mock.calls[0][1],form=init.body as FormData;expect(init.headers['content-type']).toBeUndefined();expect(await (form.get('file') as File).text()).toBe('A textile pattern');expect(form.get('name')).toBe('pattern.txt');
    await native.execute(config(),'uploadListingFile',{path:{listing_id:101},body:{listing_file_id:88}},owners);expect((fetch.mock.calls[1][1].body as FormData).get('file')).toBeNull();
    for(const body of [{file:'/tmp/private.txt',name:'x'},{}])await expect(native.execute(config(),'uploadListingFile',{path:{listing_id:101},body},owners)).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects missing/error acknowledgements, accepts empty pages and delete 204, and removes echoed credentials',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(response({})).mockResolvedValueOnce(response({error:'private customer 12345.fixture-access'})).mockResolvedValueOnce(response({count:0,results:[]})).mockResolvedValueOnce(response(null,204)).mockResolvedValueOnce(response({shop_id:67890,title:'12345.fixture-access fixture-private-secret',access_token:'hidden'}));vi.stubGlobal('fetch',fetch);
    await expect(native.execute(config(),'updateShop',{body:{title:'New title'}},owners)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});await expect(native.execute(config(),'getShop',{},owners)).rejects.toThrow('Etsy returned a business error');
    expect(await native.execute(config(),'getShopReceipts',{},owners)).toEqual({data:{count:0,results:[]}});expect(await native.execute(config(),'deleteListing',{path:{listing_id:101}},owners)).toEqual({data:null,status:'acknowledged'});expect(await native.execute(config(),'getShop',{},owners)).toEqual({data:{shop_id:67890,title:'[redacted] [redacted]'}});expect(fetch).toHaveBeenCalledTimes(5);
  });
  it('fails invalid fields, enum, numeric, batch, scope and byte bounds before business IO',async()=>{
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    for(const [name,p]of [['getShop',{headers:{authorization:'x'}}],['getShopReceipts',{query:{limit:101}}],['getListing',{path:{listing_id:1.5}}],['getListing',{path:{listing_id:Number.MAX_SAFE_INTEGER+1}}],['updateShop',{body:{title:'x'.repeat(256*1024)}}],['getListingsByListingIds',{query:{listing_ids:[1,1]}}],['updateListing',{path:{listing_id:101},body:{state:'fictional'}}]])await expect(native.execute(config(),name,p,owners)).rejects.toMatchObject({code:'E_BAD_INPUT'});
    const c=config();c.credentials.scope='shops_r';await expect(native.execute(c,'getShopReceipts',{},owners)).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});expect(fetch).not.toHaveBeenCalled();
  });
  it('owns HTTP, timeout and cancellation failures without replay',async()=>{
    for(const status of [403,429]){const fetch=vi.fn().mockResolvedValue(response({error:'private merchant message'},status));vi.stubGlobal('fetch',fetch);await expect(native.execute(config(),'getShop',{},owners)).rejects.toMatchObject({code:status===403?'E_TOOL_CALL_AUTH':'E_TOOL_CALL_RATE_LIMIT'});expect(fetch).toHaveBeenCalledTimes(1);}
    const timeout=vi.fn().mockRejectedValue(new DOMException('private text','TimeoutError'));vi.stubGlobal('fetch',timeout);await expect(native.execute(config(),'updateShop',{body:{title:'New'}},owners)).rejects.toMatchObject({code:'E_TOOL_CALL_TIMEOUT'});expect(timeout).toHaveBeenCalledTimes(1);
    const controller=new AbortController();controller.abort();const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await expect(withRequestSignal(controller.signal,()=>native.execute(config(),'getShop',{},owners))).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});expect(fetch).not.toHaveBeenCalled();
    const oversized=vi.fn().mockResolvedValue(new Response(JSON.stringify({shop_id:67890,title:'x'.repeat(1024*1024)})));vi.stubGlobal('fetch',oversized);await expect(native.execute(config(),'getShop',{},owners)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(oversized).toHaveBeenCalledTimes(1);
    const read=vi.fn().mockResolvedValue(new Response(new ReadableStream({start(c){c.error(new DOMException('private reason','AbortError'));}})));vi.stubGlobal('fetch',read);await expect(native.execute(config(),'getShop',{},owners)).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});expect(read).toHaveBeenCalledTimes(1);
  });
});
