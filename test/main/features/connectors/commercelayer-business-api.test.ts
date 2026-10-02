import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv';
const require=createRequire(import.meta.url),api=require('../../../../bin/commercelayer-business-api.cjs'),context=require('../../../../bin/commerce-request-context.cjs');
const evidence=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../../fixtures/connectors/official-contracts/commercelayer-20261001.json'),'utf8'));
const token='fixture-cl-token',config=()=>({provider:'commerce_layer',metadata:{organization_slug:'sample-shop'},credentials:{client_secret:'fixture-client-secret'}});
const owners=()=>({base:()=> 'https://sample-shop.commercelayer.io',token:vi.fn(async()=>token)});
const reply=(body:unknown,status=200)=>new Response(status===204?null:JSON.stringify(body),{status});
const resource=(type:string,id:string,attributes:unknown={})=>({type,id,attributes});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('Commerce Layer pinned merchant contracts',()=>{
 it('compiles the complete selected inventory and preserves official writable fields and required values',()=>{
  const actions=api.actionsFor(),selected=evidence.inventory.filter((row:any)=>!row.excluded_reason),validator=new AjvJsonSchemaValidator();
  expect(evidence.inventory).toHaveLength(1271);expect(Object.keys(actions)).toHaveLength(1166);expect(new Set(Object.keys(actions))).toEqual(new Set(selected.map((r:any)=>r.action)));
  for(const row of selected){const spec=actions[row.action],op=evidence.model.paths[row.path][row.method.toLowerCase()],seen=new Set<string>();expect(()=>validator.getValidator(spec.input_schema),row.action).not.toThrow();
   function compare(raw:any,converted:any){if(raw.$ref){const id=raw.$ref.slice('#/components/schemas/'.length).replaceAll('/','__');expect(converted.$ref).toBe('#/$defs/'+id);if(seen.has(id))return;seen.add(id);compare(raw.$ref.slice(2).split('/').reduce((v:any,k:string)=>v[k],evidence.model),spec.input_schema.$defs[id]);return;}expect(converted.type).toEqual(raw.type);if(raw.enum)expect(converted.enum).toEqual(raw.enum);if(raw.required)expect(converted.required).toEqual(raw.required);if(raw.properties){expect(Object.keys(converted.properties)).toEqual(Object.keys(raw.properties));for(const k of Object.keys(raw.properties))compare(raw.properties[k],converted.properties[k]);}if(raw.items)compare(raw.items,converted.items);if(raw.oneOf)raw.oneOf.forEach((s:any,i:number)=>compare(s,converted.oneOf[i]));}
   if(op.requestBody)compare(op.requestBody.content['application/vnd.api+json'].schema,spec.input_schema.properties.body);
  }
  for(const name of ['POST /stripe_gateways','POST /customer_password_resets','GET /discount_engines'])expect(api.isNative(name)).toBe(false);
  expect(actions['PATCH /orders/{orderId}'].risk).toBe('D');expect(actions['POST /imports'].risk).toBe('D');
  const original=actions['PATCH /stock_items/{stockItemId}'].input_schema.$defs.stockItemUpdate.properties.data.properties.attributes.properties,changed={...original};delete changed._validate;expect(Object.keys(changed)).not.toEqual(Object.keys(original));
 },20000);
 it('retains fulfillment contacts and sparse associations with correctly encoded explicit queries',async()=>{
  const doc={data:[resource('orders','order-1',{customer_email:'fixture@example.invalid',metadata:{errors:'business value'}})],included:[resource('addresses','address-1',{phone:'123',email:'fixture@example.invalid'})]};
  const fetch=vi.fn(async()=>reply(doc));vi.stubGlobal('fetch',fetch);
  const result=await api.execute(config(),'GET /orders',{query:{include:['shipping_address'],fields:{orders:['customer_email','shipping_address']},page:{number:2,size:25},sort:['-created_at'],filter:{q:{customer_email_eq:'fixture@example.invalid',shipping_address_city_eq:'Rome'}}}},owners());
  expect(result.data).toEqual(doc);const [raw,init]=fetch.mock.calls[0] as unknown as [string,RequestInit],url=new URL(raw);
  expect(url.origin+url.pathname).toBe('https://sample-shop.commercelayer.io/api/orders');expect(url.searchParams.get('filter[q][customer_email_eq]')).toBe('fixture@example.invalid');expect(url.searchParams.get('page[size]')).toBe('25');expect(url.searchParams.get('include')).toBe('shipping_address');expect(init).toMatchObject({redirect:'error',headers:{authorization:'Bearer '+token}});expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('blocks unknown filters which the provider silently ignores, unsupported fields and over-limit pages before token IO',async()=>{
  const fetch=vi.fn(),owner=owners();vi.stubGlobal('fetch',fetch);
  for(const query of [{filter:{q:{bogus_eq:'x'}}},{filter:{q:{customer_email_strange:'x'}}},{sort:['bogus']},{include:['bogus']},{fields:{orders:['bogus']}},{page:{size:26}}])await expect(api.execute(config(),'GET /orders',{query},owner)).rejects.toMatchObject({code:'E_BAD_INPUT'});
  expect(owner.token).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
 });
 it('writes zero inventory and open metadata with exact JSON:API relationships and rejects identity mismatches',async()=>{
  const body={data:{type:'stock_items',id:'stock-1',attributes:{quantity:0,metadata:{warehouse:'fixture',nested:{value:0}}},relationships:{stock_location:{data:{type:'stock_locations',id:'loc-1'}}}}};
  const fetch=vi.fn(async()=>reply({data:resource('stock_items','stock-1',{quantity:0})}));vi.stubGlobal('fetch',fetch);const owner=owners();
  expect(await api.execute(config(),'PATCH /stock_items/{stockItemId}',{path:{stockItemId:'stock-1'},body},owner)).toMatchObject({status:'acknowledged',data:{data:{attributes:{quantity:0}}}});
  expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string,RequestInit])[1].body))).toEqual(body);
  await expect(api.execute(config(),'PATCH /stock_items/{stockItemId}',{path:{stockItemId:'other'},body},owner)).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(fetch).toHaveBeenCalledTimes(1);expect(owner.token).toHaveBeenCalledTimes(1);
 });
 it('keeps asynchronous failure counters and records without raw diagnostics or automatic replay',async()=>{
  const fetch=vi.fn(async()=>reply({data:resource('imports','import-1',{status:'interrupted',errors_count:1,processed_count:2,errors_log:{private:token}})},201));vi.stubGlobal('fetch',fetch);
  const result=await api.execute(config(),'POST /imports',{body:{data:{type:'imports',attributes:{resource_type:'stock_items',inputs:[{sku_code:'SKU',quantity:0}],cleanup_records:false}}}},owners());
  expect(result).toMatchObject({status:'partial_or_failed',data:{data:{attributes:{status:'interrupted',errors_count:1,processed_count:2}}}});expect(JSON.stringify(result)).not.toContain(token);expect(result.data.data.attributes.errors_log).toBeUndefined();expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('checks single identities and relationship cardinality while allowing empty collection and absent associations',async()=>{
  const fetch=vi.fn(async()=>reply({data:[]}));vi.stubGlobal('fetch',fetch);
  expect(await api.execute(config(),'GET /orders',{},owners())).toEqual({data:{data:[]}});
  fetch.mockResolvedValueOnce(reply({data:null}));expect(await api.execute(config(),'GET /orders/{orderId}/shipping_address',{path:{orderId:'order-1'}},owners())).toEqual({data:{data:null}});
  for(const doc of [{data:{...resource('orders','order-1'),relationships:{shipping_address:{data:[]}}}},{data:resource('orders','different')},{data:resource('orders','order-1',{total_amount_cents:'invalid'})},{}]){fetch.mockResolvedValueOnce(reply(doc));await expect(api.execute(config(),'GET /orders/{orderId}',{path:{orderId:'order-1'}},owners())).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});}
  fetch.mockResolvedValueOnce(reply({data:resource('orders','order-1'),included:[resource('imports','past-import',{status:'failed'})]}));expect((await api.execute(config(),'GET /orders/{orderId}',{path:{orderId:'order-1'}},owners())).status).toBeUndefined();expect(fetch).toHaveBeenCalledTimes(7);
 });
 it('rejects authority injection, unknown body fields, traversal and oversized input before IO',async()=>{
  const fetch=vi.fn(),owner=owners();vi.stubGlobal('fetch',fetch);
  for(const params of [{path:{orderId:'../other'}},{path:{orderId:'order-1'},url:'https://other.invalid'},{path:{orderId:'order-1'},query:{fields:{orders:['x'.repeat(262144)]}}}])await expect(api.execute(config(),'GET /orders/{orderId}',params,owner)).rejects.toMatchObject({code:'E_BAD_INPUT'});
  const c=config();c.metadata.organization_slug='different';await expect(api.execute(c,'GET /orders',{},owner)).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(owner.token).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
 });
 it('accepts only documented deletion acknowledgement and classifies auth, cancellation and oversized response without replay',async()=>{
  const fetch=vi.fn(async()=>reply(null,204));vi.stubGlobal('fetch',fetch);
  expect(await api.execute(config(),'DELETE /skus/{skuId}',{path:{skuId:'sku-1'}},owners())).toEqual({data:null,status:'acknowledged'});
  fetch.mockResolvedValueOnce(reply({},200));await expect(api.execute(config(),'DELETE /skus/{skuId}',{path:{skuId:'sku-1'}},owners())).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
  fetch.mockResolvedValueOnce(reply({secret:token},403));await expect(api.execute(config(),'GET /orders',{},owners())).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});
  const controller=new AbortController();fetch.mockImplementationOnce(async()=>new Response(new ReadableStream({pull(){controller.abort();throw new DOMException('fixture','AbortError');}})));await expect(context.withRequestSignal(controller.signal,()=>api.execute(config(),'GET /orders',{},owners()))).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});
  fetch.mockResolvedValueOnce(reply({data:[],large:'x'.repeat(1024*1024)}));await expect(api.execute(config(),'GET /orders',{},owners())).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(5);
 });
});
