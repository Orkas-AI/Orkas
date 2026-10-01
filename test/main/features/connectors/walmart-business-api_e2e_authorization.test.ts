import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {expect,it} from 'vitest';
const require=createRequire(import.meta.url),codec=require('../../../../bin/local-api-credential-codec.cjs');
it('keeps the current Walmart seller token owner, global market fields and risk lanes across real stdio restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-walmart-journey-')),file=path.join(dir,'credentials.enc'),key=crypto.randomBytes(32).toString('base64url'),preload=path.join(dir,'provider.cjs'),journal=path.join(dir,'wire.jsonl');
 const grant={provider:'walmart',client_id:'fixture-seller-client',client_secret:'fixture-seller-secret'};codec.writeCredentialFile(file,key,grant);
 fs.writeFileSync(preload,`
 const fs=require('node:fs');global.fetch=async(raw,init)=>{const url=new URL(raw);fs.appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify({path:url.pathname,method:init.method,query:url.search})+'\\n');
 if(url.origin!=='https://marketplace.walmartapis.com'||init.headers.WM_MARKET!=='ca')throw new Error('Wrong merchant authority');
 const p=url.pathname;
 if(p==='/v3/token/detail')return new Response(JSON.stringify({is_valid:true,scopes:{item:'view_only',price:'full_access',orders:'full_access',inventory:'full_access'}}));
 if(p==='/v3/token'){if(init.body!=='grant_type=client_credentials'||!init.headers.authorization.startsWith('Basic '))throw new Error('Wrong credential flow');return new Response(JSON.stringify({access_token:'fixture-walmart-token',expires_in:900}));}
 if(init.headers['WM_SEC.ACCESS_TOKEN']!=='fixture-walmart-token'||init.headers.WM_GLOBAL_VERSION!=='3.1')throw new Error('Wrong bound market token');
 if(p==='/v3/inventory'&&init.method==='GET')return new Response(JSON.stringify({sku:'sku-1',quantity:{unit:'EACH',amount:5}}));
 if(p==='/v3/inventory'&&init.method==='PUT'){const b=JSON.parse(init.body);if(b.quantity.amount!==0)throw new Error('Lost inventory fields');return new Response(JSON.stringify(b));}
 if(p==='/v3/inventories/sku-1'&&init.method==='PUT')return new Response(JSON.stringify({sku:'sku-1',nodes:[{shipNode:'node-1',status:'Failure',errors:[{code:'INVALID_NODE',field:'shipNode',description:'private detail'}]}]}));
 if(p==='/v3/items/sku-1'&&init.method==='DELETE')return new Response(JSON.stringify({sku:'sku-1',message:'Retired'}));throw new Error('Unexpected merchant operation');};
 `);
 const clients:Client[]=[],stderr:string[]=[];
 async function connect(){const client=new Client({name:'walmart-business-journey',version:'1'});clients.push(client);const transport=new StdioClientTransport({command:process.execPath,args:['--require',preload,path.resolve(__dirname,'../../../../bin/direct-commerce-mcp-server.cjs')],stderr:'pipe',env:{...Object.fromEntries(Object.entries(process.env).filter((r):r is[string,string]=>typeof r[1]==='string')),ELECTRON_RUN_AS_NODE:'1',ORKAS_LOCAL_API_PROVIDER:'walmart',ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,ORKAS_LOCAL_API_METADATA_JSON:JSON.stringify({market:'ca',environment:'live'}),FIXTURE_JOURNAL:journal}});transport.stderr?.on('data',data=>stderr.push(String(data)));await client.connect(transport);return client;}
 const parsed=(r:any)=>JSON.parse(r.content[0].text);
 try{
  const client=await connect();expect((await client.listTools()).tools).toHaveLength(6);
  const desc=await client.callTool({name:'describe_action',arguments:{action:'PUT /v3/inventory'}});expect(desc.isError).not.toBe(true);expect(parsed(desc).risk).toBe('H');
  const read=await client.callTool({name:'execute_read',arguments:{action:'GET /v3/inventory',parameters:{query:{sku:'sku-1'}}}});expect(read.isError).not.toBe(true);expect(parsed(read).result.data.quantity.amount).toBe(5);
  expect((await client.callTool({name:'execute_high_impact',arguments:{action:'PUT /v3/inventory',parameters:{query:{sku:'sku-1'},body:{sku:'sku-1',quantity:{unit:'EACH',amount:0},inventoryAvailableDate:'2026-10-03'}}}})).isError).toBe(true);
  const stock=await client.callTool({name:'execute_high_impact',arguments:{action:'PUT /v3/inventory',parameters:{query:{sku:'sku-1'},body:{sku:'sku-1',quantity:{unit:'EACH',amount:0}}}}});expect(stock.isError).not.toBe(true);expect(parsed(stock).result.status).toBe('acknowledged');
  const partial=await client.callTool({name:'execute_high_impact',arguments:{action:'PUT /v3/inventories/{sku}',parameters:{path:{sku:'sku-1'},body:{inventories:{nodes:[{shipNode:'node-1',inputQty:{unit:'EACH',amount:0}}]}}}}});expect(partial.isError).toBe(true);expect(parsed(partial).result).toMatchObject({status:'partial_or_failed',data:{nodes:[{errors:[{code:'INVALID_NODE',field:'shipNode'}]}]}});await client.close();
  const restarted=await connect(),args={action:'DELETE /v3/items/{sku}',parameters:{path:{sku:'sku-1'}}};expect((await restarted.callTool({name:'execute_read',arguments:args})).isError).toBe(true);expect((await restarted.callTool({name:'execute_destructive',arguments:args})).isError).not.toBe(true);
  expect((await restarted.callTool({name:'execute_read',arguments:{action:'GET /v3/insights/prosellerbadge',parameters:{}}})).isError).toBe(true);
  expect(codec.readCredentialFile(file,key)).toEqual(grant);expect(fs.readFileSync(journal,'utf8').trim().split('\n').map(line=>JSON.parse(line).method)).toEqual(['GET','POST','GET','PUT','PUT','POST','DELETE']);expect(stderr).toEqual([]);
 }finally{await Promise.allSettled(clients.map(client=>client.close()));fs.rmSync(dir,{recursive:true,force:true});}
},20000);
