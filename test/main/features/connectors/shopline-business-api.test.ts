import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv';
const require=createRequire(import.meta.url),api=require('../../../../bin/shopline-business-api.cjs'),context=require('../../../../bin/commerce-request-context.cjs');
const evidence=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../../fixtures/connectors/official-contracts/shopline-20261001.json'),'utf8'));
const token='fixture-shopline-token',config=()=>({provider:'shopline',metadata:{store_domain:'sample.myshopline.com'},credentials:{provider:'shopline',access_token:token,identity:{binding:'sample.myshopline.com',shop_id:'123'}}});
const reply=(body:unknown,status=200,headers:HeadersInit={})=>new Response(JSON.stringify(body),{status,headers});
const metafield=(key:string)=>({owner_resource:'products',owner_id:'product-1',namespace:'custom',key,type:'single_line_text_field',value:'Care guide'});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('SHOPLINE pinned merchant contracts',()=>{
 it('preserves all selected official input fields, required fields and explicit source corrections',()=>{
  const selected=evidence.inventory.filter((r:any)=>!r.excluded_reason),actions=api.actionsFor(),validator=new AjvJsonSchemaValidator();expect(evidence.inventory).toHaveLength(440);expect(Object.keys(actions)).toHaveLength(407);expect(new Set(Object.keys(actions))).toEqual(new Set(selected.map((r:any)=>r.action)));
  for(const row of selected){const spec=actions[row.action],model=structuredClone(evidence.models[row.id]);for(const patch of evidence.schema_overrides.filter((p:any)=>p.source_id===row.id))patch.pointer.slice(1).split('/').map((p:string)=>p.replace(/~1/g,'/').replace(/~0/g,'~')).reduce((v:any,k:string)=>v[k],model).type=patch.type;
   expect(()=>validator.getValidator(spec.input_schema),row.action).not.toThrow();
   function compare(raw:any,converted:any){if(converted.$ref)converted=spec.input_schema.$defs[converted.$ref.slice('#/$defs/'.length)];expect(converted.type).toEqual(({long:'integer',double:'number',float:'number',map:'object'} as any)[raw.type]||raw.type||(raw.properties?'object':undefined));if(raw.required)expect(converted.required).toEqual(raw.required);if(raw.enum)expect(converted.enum).toEqual(raw.enum);if(raw.properties){expect(Object.keys(converted.properties)).toEqual(Object.keys(raw.properties));for(const k of Object.keys(raw.properties))compare(raw.properties[k],converted.properties[k]);}if(raw.items)compare(raw.items,converted.items);}
   if(model.requestBody)compare(model.requestBody.content['application/json'].schema,spec.input_schema.properties.body);
  }
  for(const action of ['POST /storefront_access_tokens.json','POST /subscription/{id}/cancel.json','POST /bulk_operation_run_mutation_general.json'])expect(api.isNative(action)).toBe(false);
  expect(actions['POST /orders/{id}/cancel.json'].risk).toBe('D');expect(actions['POST /customers/query_user_by_email.json'].risk).toBe('R');expect(evidence.graphql_operations).toHaveLength(157);
  const schema=structuredClone(actions['POST /inventory_levels/set.json'].input_schema);delete schema.properties.body.properties.available;expect(schema.properties.body.properties.available).toBeUndefined();expect(actions['POST /inventory_levels/set.json'].input_schema.properties.body.properties.available).toBeDefined();
 });
 it('returns full fulfillment contacts and bounded same-route pagination within the authorized store',async()=>{
  const doc={orders:[{id:'order-1',email:'fixture@example.invalid',shipping_address:{phone:'123',first_name:'Fixture'},note_attributes:[{name:'errors',value:'business data'}]}]},fetch=vi.fn(async()=>reply(doc,200,{link:'<https://sample.myshopline.com/admin/openapi/v20260901/orders.json?page_info=next-1>; rel="next"'}));vi.stubGlobal('fetch',fetch);
  const result=await api.execute(config(),'GET /orders.json',{query:{limit:'1',email:'fixture@example.invalid'}});expect(result).toEqual({data:doc,next_cursor:'next-1'});const [url,init]=fetch.mock.calls[0] as unknown as [string,RequestInit];expect(new URL(url).origin).toBe('https://sample.myshopline.com');expect(new URL(url).pathname).toBe('/admin/openapi/v20260901/orders.json');expect(init).toMatchObject({redirect:'error',headers:{Authorization:'Bearer '+token}});expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('bounds declared numeric-string pages before IO and defaults orders to twenty records',async()=>{
  const fetch=vi.fn(async()=>reply({orders:[]}));vi.stubGlobal('fetch',fetch);
  for(const limit of ['101','100000000000000000000','oops','0','-1','1.5',' 1',1])await expect(api.execute(config(),'GET /orders.json',{query:{limit}})).rejects.toMatchObject({code:'E_BAD_INPUT'});
  expect(fetch).not.toHaveBeenCalled();await api.execute(config(),'GET /orders.json',{});expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get('limit')).toBe('20');
 });
 it('preserves numeric 64-bit resource IDs exactly and refuses unsafe numeric writes',async()=>{
  const fetch=vi.fn(async()=>new Response('{"metafield":{"id":9223372036854775807,"value":"9223372036854775807"}}'));vi.stubGlobal('fetch',fetch);
  const result=await api.execute(config(),'GET /{resource}/{owner_id}/metafields/{id}.json',{path:{resource:'products',owner_id:'product-1',id:'9223372036854775807'}});expect(result.data.metafield.id).toBe('9223372036854775807');expect(result.data.metafield.value).toBe('9223372036854775807');
  await expect(api.execute(config(),'POST /inventory_levels/set.json',{body:{available:Number.MAX_SAFE_INTEGER+1,inventory_item_id:'item-1',location_id:'loc-1'}})).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('retains documented large double and scientific numeric values while rejecting imprecise long notation',async()=>{
  const fetch=vi.fn(async()=>new Response('{"orders":[{"id":"order-1","total_weight":1e20,"line_items":[{"grams":9007199254740992.5},{"grams":100000000000000000000}]}]}'));vi.stubGlobal('fetch',fetch);
  const result=await api.execute(config(),'GET /orders.json',{});expect(result.data.orders[0].total_weight).toBe(1e20);expect(typeof result.data.orders[0].line_items[0].grams).toBe('number');expect(result.data.orders[0].line_items[1].grams).toBe(1e20);
  fetch.mockResolvedValueOnce(new Response('{"metafield":{"id":9.223372036854776e18}}'));await expect(api.execute(config(),'GET /{resource}/{owner_id}/metafields/{id}.json',{path:{resource:'products',owner_id:'product-1',id:'9223372036854775807'}})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(2);
 });
 it('writes exact zero inventory and preserves additional official product fields',async()=>{
  const fetch=vi.fn(async()=>reply({inventory_level:{available:0,inventory_item_id:'item-1',location_id:'loc-1'}}));vi.stubGlobal('fetch',fetch);const body={available:0,inventory_item_id:'item-1',location_id:'loc-1'};
  expect(await api.execute(config(),'POST /inventory_levels/set.json',{body})).toMatchObject({status:'acknowledged',data:{inventory_level:body}});expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string,RequestInit])[1].body))).toEqual(body);
  fetch.mockResolvedValueOnce(reply({product:{id:'product-1',title:'Updated',body_html:'<p>Full details</p>'}}));const product={title:'Updated',body_html:'<p>Full details</p>',handle:'updated-product'};expect(await api.execute(config(),'PUT /products/{product_id}.json',{path:{product_id:'product-1'},body:{product}})).toMatchObject({status:'acknowledged'});expect(JSON.parse(String((fetch.mock.calls[1] as unknown as [string,RequestInit])[1].body))).toEqual({product});
 });
 it('accepts documented string metafield values and retains partial counts and identifiers without provider prose',async()=>{
  const good=metafield('good'),bad=metafield('bad'),fetch=vi.fn(async()=>reply({metafields:[good],fail_metafields:[{key:'bad',namespace:'custom',owner_id:'product-1',owner_resource:'products',errors:'private '+token}]}));vi.stubGlobal('fetch',fetch);
  const result=await api.execute(config(),'POST /metafields_set.json',{body:{metafields:[good,bad]}});expect(result.status).toBe('partial_or_failed');expect(result.data.metafields).toEqual([good]);expect(result.data.fail_metafields_count).toBe(1);expect(result.data.fail_metafields[0]).toEqual({key:'bad',namespace:'custom',owner_id:'product-1',owner_resource:'products'});expect(JSON.stringify(result)).not.toContain(token);
  fetch.mockResolvedValueOnce(reply({metafields:[good],fail_metafields:[]}));await expect(api.execute(config(),'POST /metafields_set.json',{body:{metafields:[good,bad]}})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(2);
 });
 it('rejects binding tampering, path injection, unknown body fields and excessive batches before IO',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const altered=config();altered.metadata.store_domain='other.myshopline.com';await expect(api.execute(altered,'GET /orders.json',{})).rejects.toMatchObject({code:'storefront_binding_mismatch'});
  for(const p of [{path:{product_id:'../other'}},{path:{product_id:'product-1'},url:'https://other.invalid'}])await expect(api.execute(config(),'GET /products/{product_id}.json',p)).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(api.execute(config(),'POST /inventory_levels/set.json',{body:{available:0,inventory_item_id:'item-1',location_id:'loc-1',arbitrary:true}})).rejects.toMatchObject({code:'E_BAD_INPUT'});await expect(api.execute(config(),'POST /metafields_set.json',{body:{metafields:Array.from({length:11},(_,i)=>metafield('key'+i))}})).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(fetch).not.toHaveBeenCalled();
 });
 it('validates empty deletion acknowledgement, rejects missing resource evidence and preserves nullable fields',async()=>{
  const fetch=vi.fn(async()=>reply({}));vi.stubGlobal('fetch',fetch);expect(await api.execute(config(),'DELETE /products/{product_id}.json',{path:{product_id:'product-1'}})).toEqual({data:{},status:'acknowledged'});
  await expect(api.execute(config(),'GET /orders.json',{})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
  fetch.mockResolvedValueOnce(reply({orders:[{id:'order-1',email:null}]}));expect((await api.execute(config(),'GET /orders.json',{})).data.orders[0].email).toBeNull();
  fetch.mockResolvedValueOnce(reply({orders:'wrong-shape'}));await expect(api.execute(config(),'GET /orders.json',{})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(4);
 });
 it('preserves official asynchronous partial states even without a failure record list',async()=>{
  const fetch=vi.fn(async()=>reply({task_status:'CREATE_PART_FAIL',task_id:'task-1'}));vi.stubGlobal('fetch',fetch);
  const result=await api.execute(config(),'GET /sales/plugin/flash_sale/tasks/{task_id}.json',{path:{task_id:'task-1'}});expect(result).toMatchObject({status:'partial_or_failed',data:{task_status:'CREATE_PART_FAIL'}});expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('classifies HTTP auth errors, cancellation and oversized responses without replay',async()=>{
  const fetch=vi.fn(async()=>reply({message:token},403));vi.stubGlobal('fetch',fetch);await expect(api.execute(config(),'GET /orders.json',{})).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});
  const controller=new AbortController();fetch.mockImplementationOnce(async()=>new Response(new ReadableStream({pull(){controller.abort();throw new DOMException('fixture','AbortError');}})));await expect(context.withRequestSignal(controller.signal,()=>api.execute(config(),'GET /orders.json',{}))).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});
  fetch.mockResolvedValueOnce(reply({orders:[],padding:'x'.repeat(1024*1024)}));await expect(api.execute(config(),'GET /orders.json',{})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(3);
 });
});
