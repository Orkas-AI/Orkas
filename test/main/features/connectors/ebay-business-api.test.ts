import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const require=createRequire(import.meta.url);
const adapter=require('../../../../bin/direct-commerce-mcp-server.cjs');
const native=require('../../../../bin/ebay-business-api.cjs');
const codec=require('../../../../bin/local-api-credential-codec.cjs');
const {withRequestSignal}=require('../../../../bin/commerce-request-context.cjs');
const {AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv');
const evidence=JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../fixtures/connectors/official-contracts/ebay-20261001.json'),'utf8'));
const directories:string[]=[],TOKEN='fixture-ebay-access-token';
const SCOPES=['account','inventory','fulfillment'].map(x=>'https://api.ebay.com/oauth/api_scope/sell.'+x).join(' ');
const config={provider:'ebay',metadata:{environment:'live',marketplace_id:'EBAY_US',content_language:'en-US'},credentials:{scope:SCOPES}};
function envFor(credentials:any={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-ebay-native-'));directories.push(dir);
 const file=path.join(dir,'credentials.enc'),key=crypto.randomBytes(32).toString('base64url');
 const metadata={environment:'live',marketplace_id:'EBAY_US',content_language:'en-US'};
 codec.writeCredentialFile(file,key,{provider:'ebay',access_token:TOKEN,expires_at:Date.now()+3600000,scope:SCOPES,identity:metadata,...credentials});
 return {ORKAS_LOCAL_API_PROVIDER:'ebay',ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,ORKAS_LOCAL_API_METADATA_JSON:JSON.stringify(metadata)};
}
function serve(body:any,status=200){const mock=vi.fn(async()=>new Response(status===204?null:JSON.stringify(body),{status}));vi.stubGlobal('fetch',mock);return mock;}
const call=(env:any,action:string,parameters:any,lane='execute_read')=>adapter.callTool(lane,{action,parameters},env);
function compare(raw:any,actual:any,root:any,where:string,model:any,seen=new Set<string>()){
 expect(actual,where).toBeTruthy();
 if(raw.nullable){expect(actual.anyOf?.some((s:any)=>s.type==='null'),where).toBe(true);actual=actual.anyOf.find((s:any)=>s.type!=='null');}
 if(raw.$ref){const id=raw.$ref.slice('#/components/schemas/'.length);if(seen.has(id))return;compare(model.components.schemas[id],actual,root,where,model,new Set([...seen,id]));return;}
 if(actual.$ref)actual=root.$defs[actual.$ref.slice('#/$defs/'.length)];
 if(raw.type)expect(actual.type,where).toBe(raw.type);
 if(raw.enum)expect(actual.enum,where).toEqual(raw.enum);
 for(const key of raw.required || [])if(!raw.properties?.[key]?.readOnly)expect(actual.required,where).toContain(key);
 for(const [key,child]of Object.entries(raw.properties || {})){
  if(model===evidence.sources.inventory.model&&key==='aspects'&&raw.properties.aspects.type==='string'){
   expect(raw.properties.aspects.description).toContain('"aspects": {');
   expect(actual.properties.aspects).toMatchObject({type:'object',additionalProperties:{type:'array',items:{type:'string'}}});continue;
  }
  if((child as any).readOnly){expect(actual.properties,where).not.toHaveProperty(key);continue;}
  compare(child,actual.properties[key],root,where+'.'+key,model,seen);
 }
 if(raw.items)compare(raw.items,actual.items,root,where+'.*',model,seen);
 if(typeof raw.additionalProperties==='object')compare(raw.additionalProperties,actual.additionalProperties,root,where+'.<key>',model,seen);
}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();for(const dir of directories.splice(0))fs.rmSync(dir,{recursive:true,force:true});});
describe('eBay current-grant merchant APIs',()=>{
 it('exposes exact current-grant operations with complete official field trees and keeps unavailable scopes hidden',()=>{
  const actions=adapter.actionsFor(config),rows=evidence.inventory.filter((r:any)=>!r.excluded_reason),validator=new AjvJsonSchemaValidator();
  expect(evidence.inventory).toHaveLength(133);expect(rows).toHaveLength(89);expect(Object.keys(actions)).toHaveLength(131);
  for(const row of rows){const name=row.method+' '+row.path,spec=actions[name],model=evidence.sources[row.family].model,raw=model.paths[row.model_path][row.method.toLowerCase()];
   expect(spec.risk,name).toBe(row.risk);for(const p of raw.parameters||[])if(p.in!=='header')compare(p.schema,spec.input_schema.properties[p.in].properties[p.name],spec.input_schema,p.name,model);
   if(raw.requestBody)compare(raw.requestBody.content['application/json'].schema,spec.input_schema.properties.body,spec.input_schema,'body',model);
   expect(()=>validator.getValidator(spec.input_schema),name).not.toThrow();
  }
  for(const row of evidence.inventory.filter((r:any)=>r.excluded_reason))expect(actions).not.toHaveProperty(row.method+' '+row.path);
  expect(actions).not.toHaveProperty('orders.issue_refund');
  expect(native.actionsFor({...config,credentials:{scope:'https://api.ebay.com/oauth/api_scope/sell.account'}})).not.toHaveProperty('GET /sell/inventory/v1/inventory_item');
  const disabled=vi.spyOn(native,'actionsFor').mockReturnValue({});expect(adapter.actionsFor(config)).not.toHaveProperty('GET /sell/account/v2/rate_table/{rate_table_id}');disabled.mockRestore();
 });
 it('preserves authorized order contacts and merchant attributes and paginates with the source string contract',async()=>{
  const env=envFor(),mock=serve({orders:[{orderId:'O-1',fulfillmentStartInstructions:[{shippingStep:{shipTo:{fullName:'Fixture person',email:'fixture@example.invalid',primaryPhone:{phoneNumber:'123'}}}}],custom:{errors:['Business value'],message:'Merchant message'}}],next:'https://api.ebay.com/sell/fulfillment/v1/order?offset=100',total:201});
  const result=await call(env,'GET /sell/fulfillment/v1/order',{query:{limit:'100',offset:'0'}});
  expect(result.result.data.orders[0]).toMatchObject({custom:{message:'Merchant message'},fulfillmentStartInstructions:[{shippingStep:{shipTo:{email:'fixture@example.invalid'}}}]});
  expect(mock.mock.calls[0][0]).toBe('https://api.ebay.com/sell/fulfillment/v1/order?limit=100&offset=0');expect(mock).toHaveBeenCalledTimes(1);
  expect(mock.mock.calls[0][1].headers['X-EBAY-C-MARKETPLACE-ID']).toBe('EBAY_US');
 });
 it('reconciles 207 bulk stock results by SKU, preserves successful items and strips only provider error prose without replay',async()=>{
  const env=envFor(),p={body:{requests:[{sku:'A',locale:'en_US',availability:{shipToLocationAvailability:{quantity:0}}},{sku:'B',locale:'en_US',availability:{shipToLocationAvailability:{quantity:1}}}]}},mock=serve({responses:[{sku:'B',statusCode:400,errors:[{errorId:25001,domain:'API_INVENTORY',category:'REQUEST',message:TOKEN}]},{sku:'A',statusCode:204}]},207);
  const result=await adapter.callToolResult('execute_high_impact',{action:'POST /sell/inventory/v1/bulk_create_or_replace_inventory_item',parameters:p},env);
  expect(result.isError).toBe(true);expect(JSON.parse(result.content[0].text).result).toEqual({status:'partial_or_failed',data:{responses:[{sku:'B',statusCode:400,errors:[{errorId:25001,domain:'API_INVENTORY',category:'REQUEST'}]},{sku:'A',statusCode:204}]}});
  expect(JSON.parse(mock.mock.calls[0][1].body)).toEqual(p.body);
  mock.mockResolvedValueOnce(new Response(JSON.stringify({responses:[{sku:'A',statusCode:204}]})));
  await expect(call(env,'POST /sell/inventory/v1/bulk_create_or_replace_inventory_item',p,'execute_high_impact')).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(mock).toHaveBeenCalledTimes(2);
 });
 it('accepts offer-only price updates and maps tax request jurisdiction names to their distinct response names',async()=>{
  const env=envFor(),mock=serve({responses:[{sku:'A',offerId:'OFF-1',statusCode:200}]});
  expect(await call(env,'POST /sell/inventory/v1/bulk_update_price_quantity',{body:{requests:[{offers:[{offerId:'OFF-1',price:{value:'1.00',currency:'USD'}}]}]}},'execute_high_impact')).toMatchObject({result:{status:'acknowledged'}});
  mock.mockResolvedValueOnce(new Response(JSON.stringify({updatedSalesTaxEntries:[{countryCode:'US',jurisdictionId:'GU',statusCode:200}]})));
  expect(await call(env,'POST /sell/account/v1/bulk_create_or_replace_sales_tax',{body:{salesTaxInputList:[{countryCode:'US',salesTaxJurisdictionId:'GU',salesTaxPercentage:'1.00',shippingAndHandlingTaxed:false}]}},'execute_high_impact')).toMatchObject({result:{status:'acknowledged'}});expect(mock).toHaveBeenCalledTimes(2);
 });
 it('uses read-only POST for bulk retrieval and does not classify documented warnings as failed writes',async()=>{
  const env=envFor(),mock=serve({responses:[{sku:'A',statusCode:200,inventoryItem:{sku:'A',product:{aspects:{message:['Business text']}}}}]});
  expect(await call(env,'POST /sell/inventory/v1/bulk_get_inventory_item',{body:{requests:[{sku:'A'}]}})).toMatchObject({risk:'R',result:{data:{responses:[{inventoryItem:{sku:'A'}}]}}});
  mock.mockResolvedValueOnce(new Response(JSON.stringify({warnings:[{errorId:123,domain:'API_INVENTORY',message:'Fixture warning'}]}),{status:200}));
  const result=await adapter.callToolResult('execute_high_impact',{action:'PUT /sell/inventory/v1/inventory_item/{sku}',parameters:{path:{sku:'A'},body:{product:{aspects:{marketplaceId:['merchant-owned value'],locale:['merchant-owned value']}}}}},env);
  expect(result.isError).not.toBe(true);expect(JSON.parse(mock.mock.calls[1][1].body).product.aspects).toEqual({marketplaceId:['merchant-owned value'],locale:['merchant-owned value']});expect(mock).toHaveBeenCalledTimes(2);
 });
 it('uses a valid Location header as the creation acknowledgement and accepts documented 204 deletes',async()=>{
  const env=envFor(),p={path:{orderId:'O-1'},body:{lineItems:[{lineItemId:'L-1',quantity:1}],shippedDate:'2026-10-01T00:00:00Z',shippingCarrierCode:'USPS',trackingNumber:'TRACK-1'}},location='https://api.ebay.com/sell/fulfillment/v1/order/O-1/shipping_fulfillment/F-1';
  const mock=vi.fn(async()=>new Response(null,{status:201,headers:{location}}));vi.stubGlobal('fetch',mock);
  expect(await call(env,'POST /sell/fulfillment/v1/order/{orderId}/shipping_fulfillment',p,'execute_high_impact')).toMatchObject({result:{data:{},location,status:'acknowledged'}});
  mock.mockResolvedValueOnce(new Response(null,{status:201,headers:{location:'https://foreign.invalid/resource'}}));
  await expect(call(env,'POST /sell/fulfillment/v1/order/{orderId}/shipping_fulfillment',p,'execute_high_impact')).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
  mock.mockResolvedValueOnce(new Response(null,{status:204}));
  expect(await call(env,'DELETE /sell/inventory/v1/offer/{offerId}',{path:{offerId:'OFF-1'}},'execute_destructive')).toMatchObject({result:{data:null,status:'acknowledged'}});expect(mock).toHaveBeenCalledTimes(3);
 });
 it('rejects wrong lanes, transport injection, cross-marketplace fields, oversized batches and missing item identities before IO',async()=>{
  const env=envFor(),mock=serve({});
  for(const parameters of [{query:{limit:100}},{query:{limit:'101'}},{headers:{authorization:'injected'}},{query:{offset:'-1'}},{query:{filter:'x'.repeat(262145)}}])await expect(call(env,'GET /sell/fulfillment/v1/order',parameters)).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(call(env,'POST /sell/inventory/v1/offer',{body:{marketplaceId:'EBAY_GB',sku:'A'}},'execute_write')).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(call(env,'POST /sell/inventory/v1/bulk_publish_offer',{body:{requests:Array.from({length:11},(_,i)=>({offerId:'O-'+i}))}},'execute_high_impact')).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(call(env,'POST /sell/inventory/v1/bulk_get_inventory_item',{body:{requests:[{}]}})).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(call(env,'DELETE /sell/inventory/v1/offer/{offerId}',{path:{offerId:'O-1'}})).rejects.toThrow(/risk mismatch/);expect(mock).not.toHaveBeenCalled();
 });
 it('classifies forbidden, body cancellation and timeout without replaying a merchant request',async()=>{
  const env=envFor(),mock=serve({errors:[{message:TOKEN}]},403);
  await expect(call(env,'GET /sell/account/v2/rate_table/{rate_table_id}',{path:{rate_table_id:'R-1'}})).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});
  const controller=new AbortController();mock.mockImplementation(async()=>({ok:true,status:200,text:async()=>{controller.abort();throw new DOMException('Fixture cancellation','AbortError');}}));
  await expect(withRequestSignal(controller.signal,()=>call(env,'GET /sell/inventory/v1/inventory_item',{}))).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});
  mock.mockImplementation(async()=>({ok:true,status:200,text:async()=>{throw new DOMException('Fixture timeout','TimeoutError');}}));
  await expect(call(env,'GET /sell/inventory/v1/inventory_item',{})).rejects.toMatchObject({code:'E_TOOL_CALL_TIMEOUT'});expect(mock).toHaveBeenCalledTimes(3);
  mock.mockImplementation(async()=>new Response('{}',{status:403}));
  await expect(call(envFor({expires_at:0,client_id:'fixture-client',client_secret:'fixture-secret',refresh_token:'fixture-refresh'}),'GET /sell/inventory/v1/inventory_item',{})).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});
  expect(mock).toHaveBeenCalledTimes(4);
 });
 it('preserves an already granted legacy finance scope across refresh and stops a refund if the refreshed grant loses it',async()=>{
  const finance='https://api.ebay.com/oauth/api_scope/sell.finances',credentials={client_id:'fixture-client',client_secret:'fixture-client-secret',refresh_token:'fixture-refresh',expires_at:0,scope:SCOPES+' '+finance};
  const mock=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({access_token:'refreshed-token',expires_in:7200,scope:SCOPES+' '+finance}))).mockResolvedValueOnce(new Response(JSON.stringify({refundId:'REFUND-1'})));
  vi.stubGlobal('fetch',mock);expect(await call(envFor(credentials),'orders.issue_refund',{order_id:'O-1',body:{refundAmount:{currency:'USD',value:'1.00'}}},'execute_high_impact')).toMatchObject({result:{refundId:'REFUND-1'}});
  expect(new URLSearchParams(mock.mock.calls[0][1].body).get('scope')?.split(' ')).toContain(finance);
  mock.mockResolvedValueOnce(new Response(JSON.stringify({access_token:'narrowed-token',expires_in:7200,scope:SCOPES})));
  await expect(call(envFor(credentials),'orders.issue_refund',{order_id:'O-2',body:{}},'execute_high_impact')).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});
  expect(mock).toHaveBeenCalledTimes(3);
  mock.mockResolvedValueOnce(new Response(JSON.stringify({access_token:'narrowed-discovery-token',expires_in:7200,scope:SCOPES}))).mockResolvedValueOnce(new Response(JSON.stringify({sellingLimit:{quantity:100}})));
  const capabilities=await adapter.callTool('list_capabilities',{},envFor(credentials));
  expect(capabilities.actions.map((action:any)=>action.action)).not.toContain('orders.issue_refund');
  expect(mock).toHaveBeenCalledTimes(5);
 });
});
