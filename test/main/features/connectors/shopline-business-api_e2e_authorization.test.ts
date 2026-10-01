import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {expect,it} from 'vitest';
const require=createRequire(import.meta.url),codec=require('../../../../bin/local-api-credential-codec.cjs');
it('preserves full merchant fields and partial batch evidence through real stdio and enforces destructive lane after restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-shopline-journey-')),file=path.join(dir,'credentials.enc'),key=crypto.randomBytes(32).toString('base64url'),preload=path.join(dir,'provider.cjs'),journal=path.join(dir,'wire.jsonl');
 const grant={provider:'shopline',access_token:'fixture-shopline-token',identity:{binding:'sample.myshopline.com',shop_id:'123'}};codec.writeCredentialFile(file,key,grant);
 fs.writeFileSync(preload,`
 const fs=require('node:fs');global.fetch=async(raw,init)=>{const url=new URL(raw);fs.appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify({path:url.pathname,method:init.method})+'\\n');
 if(url.origin!=='https://sample.myshopline.com'||!url.pathname.startsWith('/admin/openapi/v20260901/')||init.headers.Authorization!=='Bearer fixture-shopline-token')throw new Error('Wrong merchant authority');
 const p=url.pathname.slice('/admin/openapi/v20260901'.length);
 if(p==='/merchants/shop.json')return new Response(JSON.stringify({data:{id:'123',name:'Fixture',currency:'USD'}}));
 if(p==='/orders.json'&&init.method==='GET')return new Response(JSON.stringify({orders:[{id:'order-1',email:'fixture@example.invalid',shipping_address:{phone:'123'}}]}));
 if(p==='/inventory_levels/set.json'&&init.method==='POST'){const b=JSON.parse(init.body);if(b.available!==0)throw new Error('Lost zero inventory');return new Response(JSON.stringify({inventory_level:b}));}
 if(p==='/metafields_set.json'&&init.method==='POST')return new Response(JSON.stringify({metafields:[],fail_metafields:[{key:'care',namespace:'custom',owner_id:'product-1',owner_resource:'products',errors:'private diagnostic'}]}));
 if(p==='/products/product-1.json'&&init.method==='DELETE')return new Response('{}');throw new Error('Unexpected merchant operation');};
 `);
 const clients:Client[]=[],stderr:string[]=[];
 async function connect(){const client=new Client({name:'shopline-business-journey',version:'1'});clients.push(client);const transport=new StdioClientTransport({command:process.execPath,args:['--require',preload,path.resolve(__dirname,'../../../../bin/direct-commerce-mcp-server.cjs')],stderr:'pipe',env:{...Object.fromEntries(Object.entries(process.env).filter((r):r is [string,string]=>typeof r[1]==='string')),ELECTRON_RUN_AS_NODE:'1',ORKAS_LOCAL_API_PROVIDER:'shopline',ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,ORKAS_LOCAL_API_METADATA_JSON:JSON.stringify({store_domain:'sample.myshopline.com'}),FIXTURE_JOURNAL:journal}});transport.stderr?.on('data',data=>stderr.push(String(data)));await client.connect(transport);return client;}
 const parsed=(r:any)=>JSON.parse(r.content[0].text);
 try{
  const client=await connect();expect((await client.listTools()).tools).toHaveLength(6);
  const desc=await client.callTool({name:'describe_action',arguments:{action:'POST /inventory_levels/set.json'}});expect(desc.isError).not.toBe(true);expect(parsed(desc).risk).toBe('H');
  const read=await client.callTool({name:'execute_read',arguments:{action:'GET /orders.json',parameters:{query:{limit:'1'}}}});expect(read.isError).not.toBe(true);expect(parsed(read).result.data.orders[0].shipping_address.phone).toBe('123');
  const stock=await client.callTool({name:'execute_high_impact',arguments:{action:'POST /inventory_levels/set.json',parameters:{body:{available:0,inventory_item_id:'item-1',location_id:'loc-1'}}}});expect(stock.isError).not.toBe(true);expect(parsed(stock).result.status).toBe('acknowledged');
  const partial=await client.callTool({name:'execute_high_impact',arguments:{action:'POST /metafields_set.json',parameters:{body:{metafields:[{key:'care',namespace:'custom',owner_id:'product-1',owner_resource:'products',type:'single_line_text_field',value:'Wash cold'}]}}}});expect(partial.isError).toBe(true);expect(parsed(partial).result).toMatchObject({status:'partial_or_failed',data:{fail_metafields_count:1}});await client.close();
  const restarted=await connect(),args={action:'DELETE /products/{product_id}.json',parameters:{path:{product_id:'product-1'}}};expect((await restarted.callTool({name:'execute_read',arguments:args})).isError).toBe(true);const deleted=await restarted.callTool({name:'execute_destructive',arguments:args});expect(deleted.isError).not.toBe(true);expect(parsed(deleted).result).toEqual({data:{},status:'acknowledged'});
  expect(codec.readCredentialFile(file,key)).toEqual(grant);expect(fs.readFileSync(journal,'utf8').trim().split('\n').map(line=>JSON.parse(line).method)).toEqual(['GET','GET','POST','POST','DELETE']);expect(stderr).toEqual([]);
 }finally{await Promise.allSettled(clients.map(client=>client.close()));fs.rmSync(dir,{recursive:true,force:true});}
},20000);
