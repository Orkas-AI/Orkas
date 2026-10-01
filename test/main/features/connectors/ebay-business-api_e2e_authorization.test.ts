import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
const require=createRequire(import.meta.url),codec=require('../../../../bin/local-api-credential-codec.cjs');

it('refreshes an encrypted seller grant, reads orders and creates then deletes an offer across a real MCP restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-ebay-journey-')),file=path.join(dir,'credentials.enc'),key=crypto.randomBytes(32).toString('base64url');
 const preload=path.join(dir,'provider.cjs'),journal=path.join(dir,'wire.jsonl');
 const metadata={environment:'live',marketplace_id:'EBAY_US',content_language:'en-US'},scope=['account','inventory','fulfillment'].map(x=>'https://api.ebay.com/oauth/api_scope/sell.'+x).join(' ');
 const grant={provider:'ebay',client_id:'fixture-client',client_secret:'fixture-client-secret',access_token:'expired-token',refresh_token:'fixture-refresh',expires_at:0,scope,identity:metadata};
 codec.writeCredentialFile(file,key,grant);
 fs.writeFileSync(preload,`
 const fs=require('node:fs');global.fetch=async(raw,init)=>{
  const url=new URL(raw);if(url.origin!=='https://api.ebay.com')throw new Error('Unexpected merchant authority');
  fs.appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify({path:url.pathname,method:init.method})+'\\n');
  if(url.pathname==='/identity/v1/oauth2/token'){
   const p=new URLSearchParams(init.body);if(p.get('scope')!==process.env.FIXTURE_SCOPE||p.get('grant_type')!=='refresh_token')throw new Error('Unexpected grant scope');
   return new Response(JSON.stringify({access_token:'refreshed-ebay-token',scope:process.env.FIXTURE_SCOPE,expires_in:7200}));
  }
  if(init.headers.authorization!=='Bearer refreshed-ebay-token'||init.headers['X-EBAY-C-MARKETPLACE-ID']!=='EBAY_US')throw new Error('Lost bound grant');
  if(url.pathname==='/sell/fulfillment/v1/order'&&init.method==='GET')return new Response(JSON.stringify({orders:[{orderId:'ORDER-1',buyer:{username:'fixture-buyer'}}],total:1}));
  if(url.pathname==='/sell/inventory/v1/offer'&&init.method==='POST'){
   const p=JSON.parse(init.body);if(p.sku!=='SKU-1'||p.marketplaceId!=='EBAY_US')throw new Error('Lost offer identity');
   return new Response(JSON.stringify({offerId:'OFFER-1'}),{status:201});
  }
  if(url.pathname==='/sell/inventory/v1/offer/OFFER-1'&&init.method==='DELETE')return new Response(null,{status:204});
  throw new Error('Unexpected merchant operation');
 };
 `);
 const clients:Client[]=[],stderr:string[]=[];
 async function connect(){
  const client=new Client({name:'ebay-merchant-journey',version:'1'});clients.push(client);
  const transport=new StdioClientTransport({command:process.execPath,args:['--require',preload,path.resolve(__dirname,'../../../../bin/direct-commerce-mcp-server.cjs')],stderr:'pipe',env:{
   ...Object.fromEntries(Object.entries(process.env).filter((row):row is [string,string]=>typeof row[1]==='string')),ELECTRON_RUN_AS_NODE:'1',
   ORKAS_LOCAL_API_PROVIDER:'ebay',ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,ORKAS_LOCAL_API_METADATA_JSON:JSON.stringify(metadata),FIXTURE_SCOPE:scope,FIXTURE_JOURNAL:journal}});
  transport.stderr?.on('data',v=>stderr.push(String(v)));await client.connect(transport);return client;
 }
 const read=(v:any)=>JSON.parse(v.content[0].text);
 try{
  const client=await connect(),described=await client.callTool({name:'describe_action',arguments:{action:'POST /sell/inventory/v1/offer'}});
  expect(described.isError).not.toBe(true);expect(read(described).input_schema.$defs.inventory__EbayOfferDetailsWithKeys.properties.listingDescription).toBeTruthy();
  const orders=await client.callTool({name:'execute_read',arguments:{action:'GET /sell/fulfillment/v1/order',parameters:{query:{limit:'100'}}}});
  expect(orders.isError).not.toBe(true);expect(read(orders).result.data.orders).toEqual([{orderId:'ORDER-1',buyer:{username:'fixture-buyer'}}]);
  const created=await client.callTool({name:'execute_write',arguments:{action:'POST /sell/inventory/v1/offer',parameters:{body:{sku:'SKU-1',marketplaceId:'EBAY_US',format:'FIXED_PRICE',availableQuantity:0}}}});
  expect(created.isError).not.toBe(true);expect(read(created).result).toMatchObject({status:'acknowledged',data:{offerId:'OFFER-1'}});await client.close();
  const restarted=await connect(),args={action:'DELETE /sell/inventory/v1/offer/{offerId}',parameters:{path:{offerId:'OFFER-1'}}};
  expect((await restarted.callTool({name:'execute_read',arguments:args})).isError).toBe(true);
  const deleted=await restarted.callTool({name:'execute_destructive',arguments:args});expect(deleted.isError).not.toBe(true);expect(read(deleted).result).toEqual({data:null,status:'acknowledged'});
  expect(codec.readCredentialFile(file,key)).toMatchObject({access_token:'refreshed-ebay-token',scope,identity:metadata});
  expect(fs.readFileSync(file,'utf8')).not.toContain('refreshed-ebay-token');
  expect(fs.readFileSync(journal,'utf8').trim().split('\n').map(v=>JSON.parse(v))).toEqual([{path:'/identity/v1/oauth2/token',method:'POST'},{path:'/sell/fulfillment/v1/order',method:'GET'},{path:'/sell/inventory/v1/offer',method:'POST'},{path:'/sell/inventory/v1/offer/OFFER-1',method:'DELETE'}]);
  expect(JSON.stringify([described,orders,created,deleted])).not.toContain('refreshed-ebay-token');
 }finally{await Promise.allSettled(clients.map(c=>c.close()));fs.rmSync(dir,{recursive:true,force:true});}
 expect(stderr).toEqual([]);
},20000);
