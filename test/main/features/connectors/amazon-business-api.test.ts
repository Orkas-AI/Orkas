import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const adapter = require('../../../../bin/direct-commerce-mcp-server.cjs');
const codec = require('../../../../bin/local-api-credential-codec.cjs');
const { withRequestSignal } = require('../../../../bin/commerce-request-context.cjs');
const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/ajv');
const evidence = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../fixtures/connectors/official-contracts/amazon-20260930.json'),'utf8'));
const MARKET='ATVPDKIKX0DER', SELLER='A1SELLER23456789', TOKEN='fixture-amazon-lwa-token';
const directories:string[]=[];
function envFor() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-amazon-native-'));directories.push(dir);
  const key=crypto.randomBytes(32).toString('base64url'),file=path.join(dir,'credentials.enc');
  codec.writeCredentialFile(file,key,{provider:'amazon_seller',client_id:'amzn1.application-oa2-client.fixture',client_secret:'fixture-amazon-client-secret',refresh_token:'Atzr|fixture-amazon-refresh-token-1234567890'});
  return {ORKAS_LOCAL_API_PROVIDER:'amazon_seller',ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,
    ORKAS_LOCAL_API_METADATA_JSON:JSON.stringify({marketplace_id:MARKET,seller_id:SELLER,environment:'live'})};
}
function serve(body:any,status=200) {
  const mock=vi.fn(async (url:any) => String(url).includes('/auth/o2/token') ? new Response(JSON.stringify({access_token:TOKEN,expires_in:3600}))
    : new Response(status===204 ? null : JSON.stringify(body),{status}));
  vi.stubGlobal('fetch',mock);return mock;
}
const call=(env:any,action:string,parameters:any,lane='execute_read')=>adapter.callTool(lane,{action,parameters},env);
const order=()=>({orderId:'ORDER-1',createdTime:'2026-09-01T00:00:00Z',lastUpdatedTime:'2026-09-02T00:00:00Z',salesChannel:{channelName:'AMAZON',marketplaceId:MARKET},orderItems:[],recipient:{deliveryAddress:{name:'Buyer fixture',addressLine1:'Authorized fulfillment address',city:'Seattle',countryCode:'US',postalCode:'98103',phone:'123'}},proceeds:{grandTotal:{amount:'12',currencyCode:'USD'}},buyer:{buyerEmail:'fixture@example.invalid'}});
const inventoryAction='POST /externalFulfillment/inventory/2024-09-11/inventories';
const inventoryInput=()=>({body:{requests:[1,2].map(i=>({method:'POST',uri:`/inventory/update?locationId=LOC&skuId=SKU-${i}`,body:{quantity:0,clientSequenceNumber:100+i,marketplaceAttributes:{marketplaceId:MARKET,channelName:'FBA'}}}))}});
// The official graph owns field presence/types/required constraints. Walk its
// references independently, including recursive package shapes and inheritance.
function compareSource(raw:any,actual:any,definitions:any,root:any,where:string,seen=new Set<string>()) {
  expect(actual,where).toBeTruthy();
  if(raw.$ref){const id=raw.$ref.slice('#/definitions/'.length);if(seen.has(id))return;compareSource(definitions[id],actual,definitions,root,where,new Set([...seen,id]));return;}
  if(actual.$ref)actual=root.$defs[actual.$ref.slice('#/$defs/'.length)];
  if(raw.allOf){for(const part of raw.allOf)compareSource(part,actual,definitions,root,where,seen);return;}
  if(raw.type)expect(actual.type,where).toBe(raw.type);
  if(raw.enum && !where.endsWith('.method'))expect(actual.enum,where).toEqual(raw.enum);
  for(const key of raw.required || [])if(typeof key==='string')expect(actual.required,where).toContain(key);
  for(const [key,child]of Object.entries(raw.properties || {})){
    if(where==='body.requests.*' && ['headers','body'].includes(key))continue;
    expect(actual.properties,where).toHaveProperty(key);
    compareSource(child,actual.properties[key],definitions,root,where+'.'+key,seen);
  }
  if(raw.type==='array' && raw.items)compareSource(raw.items,actual.items,definitions,root,where+'.*',seen);
  if(raw.type==='string' && raw.items?.enum)for(const value of raw.items.enum)expect(new RegExp(actual.pattern).test(value),where).toBe(true);
  if(raw.additionalProperties && typeof raw.additionalProperties==='object')compareSource(raw.additionalProperties,actual.additionalProperties,definitions,root,where+'.<key>',seen);
}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();for(const dir of directories.splice(0))fs.rmSync(dir,{recursive:true,force:true});});

describe('Amazon usable merchant business operations',()=>{
  it('discovers all selected official operations with complete parameter groups and excludes other authorization identities',()=>{
    const actions=adapter.actionsFor({provider:'amazon_seller',metadata:{marketplace_id:MARKET,seller_id:SELLER,environment:'live'}}),validator=new AjvJsonSchemaValidator();
    const selected=evidence.inventory.filter((row:any)=>!row.excluded_reason);
    expect(evidence.inventory).toHaveLength(376);expect(selected).toHaveLength(267);
    expect(Object.keys(actions)).toHaveLength(284);
    for(const row of selected){
      const name=row.method+' '+row.path,spec=actions[name],raw=evidence.models[row.model].operations[name];
      expect(spec,name).toBeTruthy();expect(spec.risk).toBe(row.risk);
      for(const p of raw.parameters){const location=p.in==='header'?'headers':p.in,group=p.in==='body'?spec.input_schema.properties:spec.input_schema.properties[location]?.properties,key=p.in==='body'?'body':p.name;expect(group).toHaveProperty(key);
        compareSource(p.in==='body'?p.schema:{...p,required:[]},group[key],evidence.models[row.model].definitions,spec.input_schema,p.in==='body'?'body':location+'.'+p.name);
        if(p.required)expect(spec.input_schema.required).toContain(location);
      }
      expect(()=>validator.getValidator(spec.input_schema)).not.toThrow();
    }
    for(const row of evidence.inventory.filter((row:any)=>row.excluded_reason)) expect(actions).not.toHaveProperty(row.method+' '+row.path);
    expect(actions['POST /products/fees/v0/feesEstimate'].risk).toBe('R');
    expect(actions['PUT /shipping/v2/carrierAccounts'].risk).toBe('R');
  });
  it('continues order pages with provider-named filters and full role-approved fulfillment contacts and amounts',async()=>{
    const env=envFor(),mock=serve({orders:[order()],pagination:{nextToken:'PAGE-2'}});
    const parameters={query:{marketplaceIds:[MARKET],createdAfter:'2026-09-01T00:00:00Z',paginationToken:'PAGE-1',maxResultsPerPage:100,includedData:['BUYER','RECIPIENT','PROCEEDS','PACKAGES']}};
    const result=await call(env,'GET /orders/2026-01-01/orders',parameters);
    expect(result.result.data.orders[0]).toMatchObject({buyer:{buyerEmail:'fixture@example.invalid'},recipient:{deliveryAddress:{phone:'123'}},proceeds:{grandTotal:{amount:'12'}}});
    const u=new URL(mock.mock.calls[1][0]);expect(u.origin).toBe('https://sellingpartnerapi-na.amazon.com');expect(u.searchParams.get('paginationToken')).toBe('PAGE-1');expect(u.searchParams.get('includedData')).toBe('BUYER,RECIPIENT,PROCEEDS,PACKAGES');
    expect(mock.mock.calls[1][1].headers['x-amz-access-token']).toBe(TOKEN);
    await expect(call(env,'GET /orders/2026-01-01/orders',{query:{...parameters.query,maxResultsPerPage:101}})).rejects.toMatchObject({code:'E_BAD_INPUT'});
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('preserves literal SKU encoding and reports invalid listing submissions instead of claiming publication',async()=>{
    const env=envFor(),mock=serve({sku:'SKU / 1',status:'INVALID',submissionId:'SUB-1',issues:[{code:'90220',message:TOKEN,severity:'ERROR',categories:['MISSING_ATTRIBUTE']}]});
    const p={path:{sellerId:SELLER,sku:'SKU / 1'},query:{marketplaceIds:[MARKET]},body:{productType:'LUGGAGE',patches:[{op:'replace',path:'/attributes/fulfillment_availability',value:[{fulfillment_channel_code:'DEFAULT',quantity:0,merchant_note:{sellerId:'Business attribute',marketplaceId:'Business channel'}}]}]}};
    const result=await call(env,'PATCH /listings/2021-08-01/items/{sellerId}/{sku}',p,'execute_high_impact');
    expect(result.result).toMatchObject({status:'partial_or_failed',data:{sku:'SKU / 1',status:'INVALID'}});
    expect(JSON.stringify(result)).not.toContain(TOKEN);expect(mock.mock.calls[1][0]).toContain('/SKU%20%2F%201?');expect(JSON.parse(mock.mock.calls[1][1].body)).toEqual(p.body);
    await expect(call(env,'PATCH /listings/2021-08-01/items/{sellerId}/{sku}',p)).rejects.toThrow(/risk mismatch/);expect(mock).toHaveBeenCalledTimes(2);
  });
  it('requires asynchronous inbound operation ids and preserves pending acknowledgement without polling or replay',async()=>{
    const env=envFor(),mock=serve({inboundPlanId:'PLAN-1',operationId:'OP-1'},202);
    const p={body:{destinationMarketplaces:[MARKET],items:[{labelOwner:'SELLER',prepOwner:'SELLER',msku:'SKU-1',quantity:1}],sourceAddress:{name:'Seller fixture',addressLine1:'Warehouse fixture',city:'Seattle',countryCode:'US',postalCode:'98103',phoneNumber:'123'}}};
    expect(await call(env,'POST /inbound/fba/2024-03-20/inboundPlans',p,'execute_high_impact')).toMatchObject({result:{status:'acknowledged',data:{operationId:'OP-1'}}});
    mock.mockResolvedValueOnce(new Response(JSON.stringify({inboundPlanId:'PLAN-1'}),{status:202}));
    await expect(call(env,'POST /inbound/fba/2024-03-20/inboundPlans',p,'execute_high_impact')).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(mock).toHaveBeenCalledTimes(3);
  });
  it('reconciles every mixed inventory result, retains zero stock and denies omitted or unrelated acknowledgements',async()=>{
    const env=envFor(),responses=[1,2].map(i=>({status:{statusCode:i===1?200:400},body:{locationId:'LOC',skuId:`SKU-${i}`,sellableQuantity:0,actionableErrors:i===1?[]:[{errorType:'PRODUCT_VALIDATION_FAILURE',errorSubType:'INVALID_SKU'}]}})),mock=serve({responses},207),p=inventoryInput();
    expect(await call(env,inventoryAction,p,'execute_high_impact')).toMatchObject({result:{status:'partial_or_failed',data:{responses:[{body:{sellableQuantity:0}},{status:{statusCode:400}}]}}});
    mock.mockResolvedValueOnce(new Response(JSON.stringify({responses:responses.slice(0,1)}),{status:207}));
    await expect(call(env,inventoryAction,p,'execute_high_impact')).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
    await expect(call(env,inventoryAction,{body:{requests:[...p.body.requests,p.body.requests[0]]}},'execute_high_impact')).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(mock).toHaveBeenCalledTimes(3);
  });
  it('executes fee estimates as read-only POST and preserves each source identifier and business failure',async()=>{
    const env=envFor(),p={body:[{IdType:'ASIN',IdValue:'B000P6Q7MY',FeesEstimateRequest:{MarketplaceId:MARKET,PriceToEstimateFees:{ListingPrice:{CurrencyCode:'USD',Amount:12}},Identifier:'FEE-1'}}]},mock=serve([{Status:'ClientError',FeesEstimateIdentifier:{MarketplaceId:MARKET,SellerId:SELLER,IdType:'ASIN',IdValue:'B000P6Q7MY',SellerInputIdentifier:'FEE-1'},Error:{Code:'InvalidInput',Type:'Sender',Message:TOKEN,Detail:[]}}]);
    expect(await call(env,'POST /products/fees/v0/feesEstimate',p)).toMatchObject({result:{status:'partial_or_failed'}});
    expect(mock.mock.calls[1][1].method).toBe('POST');expect(JSON.parse(mock.mock.calls[1][1].body)).toEqual(p.body);expect(mock).toHaveBeenCalledTimes(2);
  });
  it('accepts only documented empty acknowledgements and rejects unexpected empty success bodies',async()=>{
    const env=envFor(),mock=serve(null,204);
    expect(await call(env,'POST /orders/v0/orders/{orderId}/shipment',{path:{orderId:'123-1234567-1234567'},body:{marketplaceId:MARKET,shipmentStatus:'ReadyForPickup'}},'execute_high_impact')).toMatchObject({result:{status:'acknowledged',data:null}});
    mock.mockResolvedValueOnce(new Response(null,{status:200}));
    await expect(call(env,'GET /orders/2026-01-01/orders/{orderId}',{path:{orderId:'ORDER-1'}})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(mock).toHaveBeenCalledTimes(3);
  });
  it('denies cross-seller, cross-marketplace, native transport overrides and malformed nested fields before acquiring a grant',async()=>{
    const env=envFor(),mock=serve({});
    for(const p of [{path:{sellerId:'OTHER',sku:'SKU-1'},query:{marketplaceIds:[MARKET]}},{path:{sellerId:SELLER,sku:'SKU-1'},query:{marketplaceIds:['OTHER']}},{path:{sellerId:SELLER,sku:'SKU-1'},query:{marketplaceIds:[MARKET]},headers:{authorization:'Bearer injected'}}])
      await expect(call(env,'GET /listings/2021-08-01/items/{sellerId}/{sku}',p)).rejects.toMatchObject({code:'E_BAD_INPUT'});
    await expect(call(env,inventoryAction,{body:{requests:[{method:'POST',uri:'https://example.invalid/delete',body:{quantity:0}}]}},'execute_high_impact')).rejects.toMatchObject({code:'E_BAD_INPUT'});
    await expect(call(env,'GET /orders/2026-01-01/orders',{query:{marketplaceIds:[MARKET],createdAfter:'not-a-date'}})).rejects.toMatchObject({code:'E_BAD_INPUT'});
    await expect(call(env,'GET /orders/2026-01-01/orders',{query:{marketplaceIds:[MARKET],paginationToken:'x'.repeat(262145)}})).rejects.toMatchObject({code:'E_BAD_INPUT'});
    const price={MarketplaceId:MARKET,ItemCondition:'New',method:'GET',uri:'/products/pricing/v0/listings/%bad/offers'};
    await expect(call(env,'POST /batches/products/pricing/v0/listingOffers',{body:{requests:[price]}})).rejects.toMatchObject({code:'E_BAD_INPUT'});
    const duplicate={marketplaceId:MARKET,sku:'SKU-1',method:'GET',uri:'/products/pricing/2022-05-01/offer/featuredOfferExpectedPrice'};
    await expect(call(env,'POST /batches/products/pricing/2022-05-01/offer/featuredOfferExpectedPrice',{body:{requests:[duplicate,duplicate]}})).rejects.toMatchObject({code:'E_BAD_INPUT'});
    expect(mock).not.toHaveBeenCalled();
  });
  it('keeps batch pricing routes read-only and denies raw headers, other methods or external subrequest destinations',async()=>{
    const env=envFor(),mock=serve({responses:[{headers:{},status:{statusCode:200},request:{marketplaceId:MARKET,sku:'SKU-1'},body:{}}]});
    const action='POST /batches/products/pricing/2022-05-01/offer/featuredOfferExpectedPrice',request={marketplaceId:MARKET,sku:'SKU-1',method:'GET',uri:'/products/pricing/2022-05-01/offer/featuredOfferExpectedPrice'};
    expect(await call(env,action,{body:{requests:[request]}})).toMatchObject({result:{data:{responses:[{status:{statusCode:200}}]}}});
    for(const extra of [{method:'DELETE'},{uri:'https://example.invalid/x'},{headers:{authorization:'injected'}}]) await expect(call(env,action,{body:{requests:[{...request,...extra}]}})).rejects.toMatchObject({code:'E_BAD_INPUT'});
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('does not interpret business attribute look-alikes as operation failures and enforces bound host batch sizes',async()=>{
    const env=envFor(),mock=serve({sku:'SKU-1',summaries:[],attributes:{status:[{value:'INVALID'}],custom:[{severity:'ERROR',errors:['Business attribute fixture'],message:'Merchant attribute',details:'Merchant details'}]}});
    const result=await call(env,'GET /listings/2021-08-01/items/{sellerId}/{sku}',{path:{sellerId:SELLER,sku:'SKU-1'},query:{marketplaceIds:[MARKET],includedData:['attributes']}});
    expect(result.result).not.toHaveProperty('status');expect(result.result.data.attributes.custom[0]).toMatchObject({severity:'ERROR',message:'Merchant attribute',details:'Merchant details'});
    const p=inventoryInput();
    await expect(call(env,inventoryAction,{body:{requests:Array.from({length:11},(_,i)=>({...p.body.requests[0],uri:`/inventory/update?locationId=LOC&skuId=SKU-${i}`}))}},'execute_high_impact')).rejects.toMatchObject({code:'E_BAD_INPUT'});
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('classifies cancellation and timeout during body consumption without a second merchant request',async()=>{
    const env=envFor(),mock=serve({});
    const signal=new AbortController();
    mock.mockImplementation(async (url:any)=>String(url).includes('/auth/o2/token')?new Response(JSON.stringify({access_token:TOKEN,expires_in:3600})):{ok:true,status:200,text:async()=>{signal.abort();throw new DOMException('Interrupted','AbortError');}});
    await expect(withRequestSignal(signal.signal,()=>call(env,'GET /orders/2026-01-01/orders/{orderId}',{path:{orderId:'ORDER-1'}}))).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});
    mock.mockImplementation(async (url:any)=>String(url).includes('/auth/o2/token')?new Response(JSON.stringify({access_token:TOKEN,expires_in:3600})):{ok:true,status:200,text:async()=>{throw new DOMException('Timed out','TimeoutError');}});
    await expect(call(env,'GET /orders/2026-01-01/orders/{orderId}',{path:{orderId:'ORDER-1'}})).rejects.toMatchObject({code:'E_TOOL_CALL_TIMEOUT'});
    expect(mock.mock.calls.filter(([url]:any[])=>!String(url).includes('/auth/o2/token'))).toHaveLength(2);
  });
});
