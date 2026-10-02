import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv';
const require=createRequire(import.meta.url),api=require('../../../../bin/shopline-graphql-api.cjs'),contracts=require('../../../../bin/shopline-graphql-contracts.cjs'),context=require('../../../../bin/commerce-request-context.cjs');
const evidence=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../../fixtures/connectors/official-contracts/shopline-graphql-20261001.json'),'utf8'));
const token='fixture-gql-token',config=()=>({provider:'shopline',metadata:{store_domain:'sample.myshopline.com'},credentials:{provider:'shopline',access_token:token,identity:{binding:'sample.myshopline.com',shop_id:'123'}}});
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
const stock={arguments:{input:{reason:'correction',setQuantities:[{inventoryItemId:'gid://shopline/InventoryItem/1',locationId:'gid://shopline/Location/2',quantity:0}]}}};
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('SHOPLINE typed GraphQL merchant journeys',()=>{
 it('exposes complete ordinary merchant contracts and navigable output types without admitting sunset or unverified qualifications',()=>{
  const actions=api.actionsFor(),validator=new AjvJsonSchemaValidator();expect(Object.keys(actions)).toHaveLength(108);expect(evidence.summary).toEqual({ordinary_merchant:108,enterprise_b2b:25,enterprise_staff:2,member_system_app:18,sunset:4});
  for(const row of evidence.inventory){if(row.group!=='ordinary_merchant'){expect(api.isNative('GRAPHQL '+row.name)).toBe(false);continue;}const spec=contracts.methods['GRAPHQL '+row.name],raw=evidence.models[row.id];expect(spec.output_type).toBe(raw.output_type);expect(spec.args).toEqual(Object.fromEntries(raw.args.map((a:any)=>[a.name,a.type])));expect(()=>validator.getValidator(actions['GRAPHQL '+row.name].input_schema)).not.toThrow();}
  for(const model of Object.values(evidence.models)as any[]){if(contracts.output[model.name]?.fields)expect(Object.keys(contracts.output[model.name].fields)).toEqual(model.fields.map((f:any)=>f.name));if(model.kind==='Input'&&contracts.definitions[model.name]){expect(Object.keys(contracts.definitions[model.name].properties)).toEqual(model.fields.map((f:any)=>f.name));expect(contracts.definitions[model.name].required).toEqual(model.fields.filter((f:any)=>f.type.endsWith('!')).map((f:any)=>f.name));}}
  const product=api.describeOutputType('GRAPHQL product','Product');expect(product.fields.collections.arguments.properties.first).toMatchObject({type:'integer',maximum:100});expect(product.fields.resourcePublicationsV2.arguments.properties.reverse.default).toBe(false);expect(product.fields.resourcePublicationsV2.arguments.properties.onlyPublished.default).toBe(true);expect(()=>api.describeOutputType('GRAPHQL inventoryItem','DiscountCode')).toThrow();expect(actions['GRAPHQL customerDelete'].risk).toBe('D');expect(actions['GRAPHQL inventorySetOnHandQuantities'].risk).toBe('H');
 });
 it('retrieves customer contact fields, exact decimal money and nested pagination through the bound store',async()=>{
  const doc={id:'gid://shopline/Customer/1',email:'fixture@example.invalid',phone:'123',amountSpent:{amount:'13.20',currencyCode:'USD'},numberOfOrders:3};const fetch=vi.fn(async()=>reply({data:{customer:doc}}));vi.stubGlobal('fetch',fetch);
  const result=await api.execute(config(),'GRAPHQL customer',{arguments:{id:'gid://shopline/Customer/1'},selection:[{field:'id'},{field:'email'},{field:'phone'},{field:'numberOfOrders'},{field:'amountSpent',children:[{field:'amount'},{field:'currencyCode'}]}]});expect(result).toEqual({data:{customer:doc}});const [url,init]=fetch.mock.calls[0]as unknown as[string,RequestInit];expect(url).toBe('https://sample.myshopline.com/admin/graph/v20260901/graphql.json');expect(init).toMatchObject({redirect:'error',headers:{Authorization:'Bearer '+token}});expect(JSON.parse(String(init.body)).variables).toEqual({v0:'gid://shopline/Customer/1'});
  const built=api.build('GRAPHQL product',{arguments:{id:1},selection:[{field:'collections',arguments:{first:2},children:[{field:'nodes',children:[{field:'id'}]}]}]});expect(built.variables).toEqual({v0:1,v1:2});expect(built.query).toContain('collections(first:$v1)');expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('keeps legal large Float values numeric and refuses unsafe integer counters',async()=>{
  const fetch=vi.fn(async()=>new Response('{"data":{"productVariant":{"weight":100000000000000000000}}}'));vi.stubGlobal('fetch',fetch);
  const variant={arguments:{id:'1'},selection:[{field:'weight'}]};expect((await api.execute(config(),'GRAPHQL productVariant',variant)).data.productVariant.weight).toBe(1e20);
  fetch.mockResolvedValueOnce(new Response('{"data":{"productVariant":{"weight":9.007199254740993e20}}}'));expect(typeof (await api.execute(config(),'GRAPHQL productVariant',variant)).data.productVariant.weight).toBe('number');
  fetch.mockResolvedValueOnce(new Response('{"data":{"customer":{"numberOfOrders":18446744073709551615}}}'));await expect(api.execute(config(),'GRAPHQL customer',{arguments:{id:'1'},selection:[{field:'numberOfOrders'}]})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
 });
 it('acknowledges explicit zero stock and surfaces indexed partial failures without replay or provider prose',async()=>{
  const fetch=vi.fn(async()=>reply({data:{inventorySetOnHandQuantities:{userErrors:[]}}}));vi.stubGlobal('fetch',fetch);expect(await api.execute(config(),'GRAPHQL inventorySetOnHandQuantities',stock)).toEqual({data:{inventorySetOnHandQuantities:{userErrors:[]}},status:'acknowledged'});expect(JSON.parse(String((fetch.mock.calls[0]as unknown as[string,RequestInit])[1].body)).variables.v0.setQuantities[0].quantity).toBe(0);
  fetch.mockResolvedValueOnce(reply({data:{inventorySetOnHandQuantities:{userErrors:[{field:['input','setQuantities','0','quantity'],message:'private '+token}]}}}));const failed=await api.execute(config(),'GRAPHQL inventorySetOnHandQuantities',stock);expect(failed).toMatchObject({status:'partial_or_failed',error_count:1,data:{inventorySetOnHandQuantities:{userErrors:[{field:['input','setQuantities','0','quantity']}]}}});expect(JSON.stringify(failed)).not.toContain(token);
  fetch.mockResolvedValueOnce(reply({data:{inventorySetOnHandQuantities:{userErrors:null}}}));await expect(api.execute(config(),'GRAPHQL inventorySetOnHandQuantities',stock)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(3);
 });
 it('reconciles variant batch acknowledgements and preserves empty no-op receipts without inventing applied changes',async()=>{
  const product={id:'1',title:'Fixture',status:'ACTIVE'},variant={id:'2',title:'Blue'};
  const fetch=vi.fn(async()=>reply({data:{productVariantsBulkUpdate:{product,productVariants:[variant],userErrors:[]}}}));vi.stubGlobal('fetch',fetch);
  const p={arguments:{productId:'1',variants:[{id:'2',price:'10.20'},{id:'3',price:'12.20'}]}};
  await expect(api.execute(config(),'GRAPHQL productVariantsBulkUpdate',p)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
  fetch.mockResolvedValueOnce(reply({data:{productVariantsBulkUpdate:{product,productVariants:[variant],userErrors:[{field:['variants','1'],message:'Unavailable variant'}]}}}));const partial=await api.execute(config(),'GRAPHQL productVariantsBulkUpdate',p);expect(partial).toMatchObject({status:'partial_or_failed',error_count:1,data:{productVariantsBulkUpdate:{productVariants:[variant],userErrors:[{field:['variants','1']}]}}});
  fetch.mockResolvedValueOnce(reply({data:{productVariantsBulkUpdate:{product,productVariants:[],userErrors:[]}}}));expect((await api.execute(config(),'GRAPHQL productVariantsBulkUpdate',{arguments:{productId:'1',variants:[]}})).status).toBe('acknowledged');expect(fetch).toHaveBeenCalledTimes(3);
 });
 it('preserves available query data with structured GraphQL errors and validates union projections',async()=>{
  const fetch=vi.fn(async()=>reply({data:{product:{id:'1',descriptionHtml:null}},errors:[{message:'private '+token,path:['product','descriptionHtml'],extensions:{code:'DATA_NOT_EXIST'}}]}));vi.stubGlobal('fetch',fetch);
  expect(await api.execute(config(),'GRAPHQL product',{arguments:{id:'1'},selection:[{field:'id'},{field:'descriptionHtml'}]})).toMatchObject({data:{product:{id:'1',descriptionHtml:null}},status:'partial_or_failed',error_count:1,graphql_errors:[{code:'DATA_NOT_EXIST',path:['product','descriptionHtml']}]});
  const selected={arguments:{id:'1'},selection:[{field:'discount',children:[{on_type:'DiscountAutomaticBasic',children:[{field:'title'}]}]}]};const q=api.build('GRAPHQL discountNode',selected);expect(q.query).toContain('... on DiscountAutomaticBasic');expect(q.query).toContain('__typename');
  fetch.mockResolvedValueOnce(reply({data:{discountNode:{discount:{__typename:'DiscountAutomaticBasic',title:'Spring'}}}}));expect((await api.execute(config(),'GRAPHQL discountNode',selected)).data.discountNode.discount.title).toBe('Spring');
 });
 it('retains asynchronous bulk IDs and completion counters even under a narrow user projection',async()=>{
  const fetch=vi.fn(async()=>reply({data:{discountRedeemCodeBulkAdd:{bulkCreation:{id:'job-1',done:false,failedCount:1,importedCount:1,codesCount:2},userErrors:[]}}}));vi.stubGlobal('fetch',fetch);
  const result=await api.execute(config(),'GRAPHQL discountRedeemCodeBulkAdd',{arguments:{discountId:'1',codes:[{code:'A'},{code:'B'}]},selection:[{field:'bulkCreation',children:[{field:'id'}]}]});expect(result).toMatchObject({status:'partial_or_failed',error_count:1,operation_state:'pending',data:{discountRedeemCodeBulkAdd:{bulkCreation:{id:'job-1',failedCount:1,importedCount:1,codesCount:2}}}});expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('rejects raw query injection, invalid scopes, unsafe IDs and excessive page cost before IO',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const altered=config();altered.metadata.store_domain='other.myshopline.com';await expect(api.execute(altered,'GRAPHQL products',{})).rejects.toMatchObject({code:'storefront_binding_mismatch'});
  for(const params of [{query:'mutation { anything }'},{arguments:{first:101}},{arguments:{first:1,last:2}},{selection:[{field:'constructor'}]},{selection:[{field:'nodes',children:[{field:'unknown'}]}]}])await expect(api.execute(config(),'GRAPHQL products',params)).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(api.execute(config(),'GRAPHQL product',{arguments:{id:Number.MAX_SAFE_INTEGER+1}})).rejects.toMatchObject({code:'E_BAD_INPUT'});await expect(api.execute(config(),'GRAPHQL companyCreate',{})).rejects.toMatchObject({code:'E_BAD_INPUT'});
  const large={arguments:{first:100},selection:[{field:'nodes',children:[{field:'collections',arguments:{first:100},children:[{field:'nodes',children:[{field:'id'}]}]}]}]};await expect(api.execute(config(),'GRAPHQL products',large)).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(fetch).not.toHaveBeenCalled();
 });
 it('fails bounded transport, cancellation and missing mutation acknowledgements without automatic retry',async()=>{
  const fetch=vi.fn(async()=>reply({errors:'Too many request'},429));vi.stubGlobal('fetch',fetch);await expect(api.execute(config(),'GRAPHQL products',{})).rejects.toMatchObject({code:'E_TOOL_CALL_RATE_LIMIT'});
  fetch.mockResolvedValueOnce(reply({data:{inventorySetOnHandQuantities:{}}}));await expect(api.execute(config(),'GRAPHQL inventorySetOnHandQuantities',stock)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
  fetch.mockResolvedValueOnce(reply({padding:'x'.repeat(1024*1024)}));await expect(api.execute(config(),'GRAPHQL products',{})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
  const controller=new AbortController();controller.abort();await expect(context.withRequestSignal(controller.signal,()=>api.execute(config(),'GRAPHQL products',{}))).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});expect(fetch).toHaveBeenCalledTimes(3);
 });
});
