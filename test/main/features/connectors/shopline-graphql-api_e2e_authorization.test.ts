import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {expect,it} from 'vitest';
const require=createRequire(import.meta.url),codec=require('../../../../bin/local-api-credential-codec.cjs');
it('discovers typed GraphQL outputs, preserves partial stock receipts and enforces risk lanes after restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-shopline-gql-journey-')),file=path.join(dir,'credentials.enc'),key=crypto.randomBytes(32).toString('base64url'),preload=path.join(dir,'provider.cjs'),journal=path.join(dir,'wire.jsonl');
 const grant={provider:'shopline',access_token:'fixture-shopline-token',identity:{binding:'sample.myshopline.com',shop_id:'123'}};codec.writeCredentialFile(file,key,grant);
 fs.writeFileSync(preload,`
 const fs=require('node:fs');let stockCalls=0;global.fetch=async(raw,init)=>{const url=new URL(raw);if(url.origin!=='https://sample.myshopline.com'||init.headers.Authorization!=='Bearer fixture-shopline-token')throw new Error('Wrong merchant authority');
 if(url.pathname==='/admin/openapi/v20260901/merchants/shop.json'){fs.appendFileSync(process.env.FIXTURE_JOURNAL,'identity\\n');return new Response(JSON.stringify({data:{id:'123',name:'Fixture',currency:'USD'}}));}
 if(url.pathname!=='/admin/graph/v20260901/graphql.json'||init.method!=='POST')throw new Error('Wrong GraphQL endpoint');const b=JSON.parse(init.body);let root,data;
 if(b.query.includes('{customer(')){root='customer';data={id:'gid://shopline/Customer/1',email:'fixture@example.invalid'};}
 else if(b.query.includes('{inventorySetOnHandQuantities(')){root='inventorySetOnHandQuantities';if(b.variables.v0.setQuantities[0].quantity!==0)throw new Error('Lost zero quantity');data={userErrors:stockCalls++?[{field:['input','setQuantities','0'],message:'private diagnostic'}]:[]};}
 else if(b.query.includes('{productDelete(')){root='productDelete';data={deletedProductId:'gid://shopline/Product/1',userErrors:[]};}
 else throw new Error('Unexpected GraphQL root');fs.appendFileSync(process.env.FIXTURE_JOURNAL,root+'\\n');return new Response(JSON.stringify({data:{[root]:data}}));};
 `);
 const clients:Client[]=[],stderr:string[]=[];
 async function connect(){const client=new Client({name:'shopline-business-journey',version:'1'});clients.push(client);const transport=new StdioClientTransport({command:process.execPath,args:['--require',preload,path.resolve(__dirname,'../../../../bin/direct-commerce-mcp-server.cjs')],stderr:'pipe',env:{...Object.fromEntries(Object.entries(process.env).filter((r):r is [string,string]=>typeof r[1]==='string')),ELECTRON_RUN_AS_NODE:'1',ORKAS_LOCAL_API_PROVIDER:'shopline',ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,ORKAS_LOCAL_API_METADATA_JSON:JSON.stringify({store_domain:'sample.myshopline.com'}),FIXTURE_JOURNAL:journal}});transport.stderr?.on('data',data=>stderr.push(String(data)));await client.connect(transport);return client;}
 const parsed=(r:any)=>JSON.parse(r.content[0].text);
 try{
  const client=await connect();expect((await client.listTools()).tools).toHaveLength(6);
  const desc=await client.callTool({name:'describe_action',arguments:{action:'GRAPHQL inventorySetOnHandQuantities'}});expect(desc.isError).not.toBe(true);expect(parsed(desc).risk).toBe('H');
  const output=await client.callTool({name:'describe_action',arguments:{action:'GRAPHQL customer',output_type:'Customer'}});expect(output.isError).not.toBe(true);expect(parsed(output).fields.email.type).toBe('String');
  expect((await client.callTool({name:'describe_action',arguments:{action:'GET /orders.json',output_type:'Customer'}})).isError).toBe(true);
  const read=await client.callTool({name:'execute_read',arguments:{action:'GRAPHQL customer',parameters:{arguments:{id:'gid://shopline/Customer/1'},selection:[{field:'id'},{field:'email'}]}}});expect(read.isError).not.toBe(true);expect(parsed(read).result.data.customer.email).toBe('fixture@example.invalid');
  const stockArgs={action:'GRAPHQL inventorySetOnHandQuantities',parameters:{arguments:{input:{reason:'correction',setQuantities:[{inventoryItemId:'gid://shopline/InventoryItem/1',locationId:'gid://shopline/Location/1',quantity:0}]}}}};
  expect((await client.callTool({name:'execute_read',arguments:stockArgs})).isError).toBe(true);const stock=await client.callTool({name:'execute_high_impact',arguments:stockArgs});expect(stock.isError).not.toBe(true);expect(parsed(stock).result.status).toBe('acknowledged');
  const partial=await client.callTool({name:'execute_high_impact',arguments:stockArgs});expect(partial.isError).toBe(true);expect(parsed(partial).result).toMatchObject({status:'partial_or_failed',error_count:1,data:{inventorySetOnHandQuantities:{userErrors:[{field:['input','setQuantities','0']}]}}});await client.close();
  const restarted=await connect(),args={action:'GRAPHQL productDelete',parameters:{arguments:{input:{id:'gid://shopline/Product/1'}}}};expect((await restarted.callTool({name:'execute_read',arguments:args})).isError).toBe(true);const deleted=await restarted.callTool({name:'execute_destructive',arguments:args});expect(deleted.isError).not.toBe(true);expect(parsed(deleted).result).toMatchObject({data:{productDelete:{deletedProductId:'gid://shopline/Product/1'}},status:'acknowledged'});
  expect(codec.readCredentialFile(file,key)).toEqual(grant);expect(fs.readFileSync(journal,'utf8').trim().split('\n')).toEqual(['identity','customer','inventorySetOnHandQuantities','inventorySetOnHandQuantities','productDelete']);expect(stderr).toEqual([]);
 }finally{await Promise.allSettled(clients.map(client=>client.close()));fs.rmSync(dir,{recursive:true,force:true});}
},20000);
