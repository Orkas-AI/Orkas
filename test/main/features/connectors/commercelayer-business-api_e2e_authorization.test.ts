import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {expect,it} from 'vitest';
const require=createRequire(import.meta.url),codec=require('../../../../bin/local-api-credential-codec.cjs');
it('uses encrypted integration credentials through real stdio, preserves fulfillment data and enforces lanes across restart',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-cl-journey-')),file=path.join(directory,'credentials.enc'),key=crypto.randomBytes(32).toString('base64url'),preload=path.join(directory,'provider.cjs'),journal=path.join(directory,'wire.jsonl');
 const grant={provider:'commerce_layer',client_id:'fixture-client',client_secret:'fixture-client-secret'};codec.writeCredentialFile(file,key,grant);
 fs.writeFileSync(preload,`
 const fs=require('node:fs');global.fetch=async(raw,init)=>{
  const url=new URL(raw);fs.appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify({path:url.pathname,method:init.method})+'\\n');
  if(url.href==='https://auth.commercelayer.io/oauth/token'){
   const body=JSON.parse(init.body);if(body.client_id!=='fixture-client'||body.client_secret!=='fixture-client-secret'||body.grant_type!=='client_credentials')throw new Error('Wrong integration grant');
   return new Response(JSON.stringify({access_token:'fixture-cl-token',expires_in:7200}));
  }
  if(url.origin!=='https://sample-shop.commercelayer.io'||init.headers.authorization!=='Bearer fixture-cl-token')throw new Error('Wrong merchant authority');
  if(url.pathname==='/api/application'&&init.method==='GET')return new Response(JSON.stringify({data:{type:'application',id:'app-1'}}));
  if(url.pathname==='/api/orders/order-1'&&init.method==='GET')return new Response(JSON.stringify({data:{type:'orders',id:'order-1',attributes:{customer_email:'fixture@example.invalid'}},included:[{type:'addresses',id:'addr-1',attributes:{phone:'123',email:'fixture@example.invalid'}}]}));
  if(url.pathname==='/api/stock_items/stock-1'&&init.method==='PATCH'){
   if(JSON.parse(init.body).data.attributes.quantity!==0)throw new Error('Lost zero stock');return new Response(JSON.stringify({data:{type:'stock_items',id:'stock-1',attributes:{quantity:0}}}));
  }
  if(url.pathname==='/api/imports'&&init.method==='POST')return new Response(JSON.stringify({data:{type:'imports',id:'import-1',attributes:{status:'interrupted',errors_count:1,processed_count:2,errors_log:{message:'fixture private'}}}}),{status:201});
  if(url.pathname==='/api/orders/order-1'&&init.method==='PATCH'){
   if(JSON.parse(init.body).data.attributes._cancel!==true)throw new Error('Missing transition');return new Response(JSON.stringify({data:{type:'orders',id:'order-1',attributes:{status:'cancelled'}}}));
  }throw new Error('Unexpected merchant operation');
 };
 `);
 const clients:Client[]=[],stderr:string[]=[];
 async function connect(){const client=new Client({name:'cl-business-journey',version:'1'});clients.push(client);const transport=new StdioClientTransport({command:process.execPath,args:['--require',preload,path.resolve(__dirname,'../../../../bin/direct-commerce-mcp-server.cjs')],stderr:'pipe',env:{...Object.fromEntries(Object.entries(process.env).filter((row):row is [string,string]=>typeof row[1]==='string')),ELECTRON_RUN_AS_NODE:'1',ORKAS_LOCAL_API_PROVIDER:'commerce_layer',ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,ORKAS_LOCAL_API_METADATA_JSON:JSON.stringify({organization_slug:'sample-shop'}),FIXTURE_JOURNAL:journal}});transport.stderr?.on('data',data=>stderr.push(String(data)));await client.connect(transport);return client;}
 const parsed=(r:any)=>JSON.parse(r.content[0].text);
 try{
  const client=await connect();expect((await client.listTools()).tools).toHaveLength(6);
  const describe=await client.callTool({name:'describe_action',arguments:{action:'PATCH /orders/{orderId}'}});expect(describe.isError).not.toBe(true);expect(parsed(describe).risk).toBe('D');
  const read=await client.callTool({name:'execute_read',arguments:{action:'GET /orders/{orderId}',parameters:{path:{orderId:'order-1'},query:{include:['shipping_address']}}}});expect(read.isError).not.toBe(true);expect(parsed(read).result.data.included[0].attributes.phone).toBe('123');
  const stock=await client.callTool({name:'execute_high_impact',arguments:{action:'PATCH /stock_items/{stockItemId}',parameters:{path:{stockItemId:'stock-1'},body:{data:{type:'stock_items',id:'stock-1',attributes:{quantity:0}}}}}});expect(stock.isError).not.toBe(true);expect(parsed(stock).result.status).toBe('acknowledged');
  const partial=await client.callTool({name:'execute_destructive',arguments:{action:'POST /imports',parameters:{body:{data:{type:'imports',attributes:{resource_type:'stock_items',inputs:[{sku_code:'SKU',quantity:0}],cleanup_records:false}}}}}});expect(partial.isError).toBe(true);expect(parsed(partial).result.status).toBe('partial_or_failed');expect(parsed(partial).result.data.data.attributes.errors_count).toBe(1);await client.close();
  const restarted=await connect(),args={action:'PATCH /orders/{orderId}',parameters:{path:{orderId:'order-1'},body:{data:{type:'orders',id:'order-1',attributes:{_cancel:true}}}}};expect((await restarted.callTool({name:'execute_read',arguments:args})).isError).toBe(true);
  const cancelled=await restarted.callTool({name:'execute_destructive',arguments:args});expect(cancelled.isError).not.toBe(true);expect(parsed(cancelled).result.data.data.attributes.status).toBe('cancelled');
  expect(codec.readCredentialFile(file,key)).toEqual(grant);expect(fs.readFileSync(journal,'utf8').trim().split('\n').map(line=>{const row=JSON.parse(line);return row.method+' '+row.path;})).toEqual(['POST /oauth/token','GET /api/application','GET /api/orders/order-1','PATCH /api/stock_items/stock-1','POST /api/imports','POST /oauth/token','PATCH /api/orders/order-1']);expect(stderr).toEqual([]);
 }finally{await Promise.allSettled(clients.map(client=>client.close()));fs.rmSync(directory,{recursive:true,force:true});}
},20000);
