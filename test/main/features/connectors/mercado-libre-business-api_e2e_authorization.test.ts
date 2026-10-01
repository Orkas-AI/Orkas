import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {expect,it} from 'vitest';
const require=createRequire(import.meta.url),codec=require('../../../../bin/local-api-credential-codec.cjs');
it('keeps Global main OAuth, child verification, complete receipts and risk gates across real MCP restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-mercado-journey-')),file=path.join(dir,'credentials.enc'),key=crypto.randomBytes(32).toString('base64url'),preload=path.join(dir,'provider.cjs'),journal=path.join(dir,'wire.jsonl');
 const grant={provider:'mercado_libre',client_id:'fixture-client',client_secret:'fixture-secret',access_token:'fixture-access',refresh_token:'fixture-refresh',expires_at:Date.now()+3600000,scope:'offline_access read write',identity:{user_id:'123456',site_id:'CBT',nickname:'Fixture'}};codec.writeCredentialFile(file,key,grant);
 fs.writeFileSync(preload,`
 const fs=require('node:fs');global.fetch=async(raw,init)=>{const u=new URL(raw);fs.appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify({path:u.pathname,method:init.method,query:u.search})+'\\n');if(u.origin!=='https://api.mercadolibre.com'||init.headers.authorization!=='Bearer fixture-access')throw new Error('Wrong merchant authority');
 let data,status=200;if(u.pathname==='/users/me')data={id:123456,site_id:'CBT',nickname:'Fixture'};
 else if(u.pathname==='/marketplace/orders/search'){if(u.searchParams.has('seller.id'))throw new Error('Wrong main seller filter');data={results:[{id:'9223372036854775807',buyer:{email:'buyer@example.test'}}],paging:{total:1}};}
 else if(u.pathname==='/marketplace/users/123456')data={user_id:123456,site_id:'CBT',marketplaces:[{user_id:654321,site_id:'MLM',logistic_type:'fulfillment'}]};
 else if(u.pathname==='/marketplace/inventories/INV1/stock/fulfillment'){if(u.searchParams.get('seller_id')!=='654321')throw new Error('Wrong child');data={inventory_id:'INV1',available_quantity:3};}
 else if(u.pathname==='/global/user-products/U1'){if(JSON.parse(init.body).listing_sites[0].net_proceeds!==12.5)throw new Error('Lost business field');status=206;data={id:'U1',success:true,listing_sites:[{id:'MLM1',success:false,errors:[{code:5014,message:'private failure',references:['MLM1']}]}]};}
 else if(u.pathname==='/marketplace/answers'){if(!init.body.includes('9223372036854775807'))throw new Error('Lost integer precision');data={id:1,question_id:'9223372036854775807',text:'Answer'};}
 else throw new Error('Unexpected merchant request '+u.pathname);
 return new Response(JSON.stringify(data),{status});};`);
 const clients:Client[]=[],stderr:string[]=[];
 async function connect(){const client=new Client({name:'mercado-business-journey',version:'1'});clients.push(client);const transport=new StdioClientTransport({command:process.execPath,args:['--require',preload,path.resolve(__dirname,'../../../../bin/direct-commerce-mcp-server.cjs')],stderr:'pipe',env:{...Object.fromEntries(Object.entries(process.env).filter((r):r is[string,string]=>typeof r[1]==='string')),ELECTRON_RUN_AS_NODE:'1',ORKAS_LOCAL_API_PROVIDER:'mercado_libre',ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,ORKAS_LOCAL_API_METADATA_JSON:JSON.stringify({user_id:'123456'}),FIXTURE_JOURNAL:journal}});transport.stderr?.on('data',d=>stderr.push(String(d)));await client.connect(transport);return client;}
 const parsed=(r:any)=>JSON.parse(r.content[0].text),call=(client:Client,name:string,action:string,parameters={})=>client.callTool({name,arguments:{action,parameters}});
 try{
  const c=await connect();expect((await c.listTools()).tools).toHaveLength(6);const desc=await c.callTool({name:'describe_action',arguments:{action:'api.put.global.user_products.user_product_id'}});expect(desc.isError).not.toBe(true);expect(parsed(desc).risk).toBe('D');
  const r=await call(c,'execute_read','api.get.marketplace.orders.search',{query:{limit:10}});expect(r.isError).not.toBe(true);expect(parsed(r).result.data.results[0]).toEqual({id:'9223372036854775807',buyer:{email:'buyer@example.test'}});
  const stock='api.get.marketplace.inventories.inventory_id.stock.fulfillment';expect((await call(c,'execute_read',stock,{path:{inventory_id:'INV1'},query:{seller_id:'777'}})).isError).toBe(true);expect((await call(c,'execute_read',stock,{path:{inventory_id:'INV1'},query:{seller_id:'654321'}})).isError).not.toBe(true);
  const action='api.put.global.user_products.user_product_id',p={path:{user_product_id:'U1'},body:{listing_sites:[{listing_id:'MLM1',net_proceeds:12.5}]}};expect((await call(c,'execute_high_impact',action,p)).isError).toBe(true);const partial=await call(c,'execute_destructive',action,p);expect(partial.isError).toBe(true);expect(parsed(partial).result).toMatchObject({status:'partial_or_failed',data:{id:'U1',listing_sites:[{id:'MLM1',errors:[{code:5014,references:['MLM1']}]}]}});expect(JSON.stringify(partial)).not.toContain('private failure');await c.close();
  const restarted=await connect();const answer=await call(restarted,'execute_high_impact','api.post.marketplace.answers',{body:{question_id:'9223372036854775807',text:'Answer'}});expect(answer.isError).not.toBe(true);expect(parsed(answer).result.status).toBe('accepted');expect(codec.readCredentialFile(file,key)).toEqual(grant);
  const wire=fs.readFileSync(journal,'utf8').trim().split('\n').map(l=>JSON.parse(l));expect(wire.filter(r=>r.method==='PUT')).toHaveLength(1);expect(wire.filter(r=>r.path==='/marketplace/inventories/INV1/stock/fulfillment')).toHaveLength(1);expect(wire.filter(r=>r.path==='/marketplace/users/123456')).toHaveLength(2);expect(stderr).toEqual([]);
 }finally{await Promise.allSettled(clients.map(c=>c.close()));fs.rmSync(dir,{recursive:true,force:true});}
},20000);
