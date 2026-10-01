import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {expect,it} from 'vitest';
const require=createRequire(import.meta.url),codec=require('../../../../bin/local-api-credential-codec.cjs');
it('keeps bound seller authorization, typed fields and all risk lanes across real TikTok MCP restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-tiktok-journey-')),file=path.join(dir,'credentials.enc'),key=crypto.randomBytes(32).toString('base64url'),preload=path.join(dir,'provider.cjs'),journal=path.join(dir,'wire.jsonl');
 const grant={provider:'tiktok_shop',service_id:'123',app_key:'fixture-app',app_secret:'fixture-secret',access_token:'fixture-access',refresh_token:'fixture-refresh',expires_at:Date.now()+3600000,refresh_expires_at:Date.now()+86400000,user_type:0,scopes:['seller.authorization.info','seller.logistics','seller.product.write','seller.product.delete','seller.customer_service'],identity:{binding_shop_id:'shop123',shop_id:'7495355150342452340',shop_cipher:'fixture-cipher',shop_region:'US',region:'us'}};codec.writeCredentialFile(file,key,grant);
 fs.writeFileSync(preload,`
 const fs=require('node:fs');global.fetch=async(raw,init)=>{const u=new URL(raw);fs.appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify({path:u.pathname,method:init.method})+'\\n');if(u.origin!=='https://open-api.tiktokglobalshop.com'||init.headers['x-tts-access-token']!=='fixture-access')throw new Error('Wrong shop authority');
 if(!u.searchParams.has('sign'))throw new Error('Missing signature');const p=u.pathname;let data;
 if(p==='/authorization/202309/shops')data={shops:[{id:'7495355150342452340',code:'shop123',cipher:'fixture-cipher',region:'US',name:'Fixture'}]};
 else {if(u.searchParams.get('shop_cipher')!=='fixture-cipher')throw new Error('Wrong shop binding');
 if(p==='/logistics/202309/warehouses')data={warehouses:[{id:'100',name:'Fixture',type:'SALES_WAREHOUSE'}]};
 else if(p==='/product/202309/products/123/prices/update'){if(JSON.parse(init.body).skus[0].external_list_prices[0].amount!=='20.00')throw new Error('Lost optional fields');data={};}
 else if(p==='/product/202309/products/123/inventory/update')data={errors:[{code:12052990,message:'private diagnostic',detail:{sku_id:'sku1'}}]};
 else if(p==='/customer_service/202309/conversations/c1/messages/read')data={};
 else if(p==='/product/202309/products'&&init.method==='DELETE')data={errors:[]};else throw new Error('Unexpected merchant call');}
 return new Response(JSON.stringify({code:0,data,request_id:'fixture-request'}));};
 `);
 const clients:Client[]=[],stderr:string[]=[];
 async function connect(){const client=new Client({name:'tiktok-business-journey',version:'1'});clients.push(client);const transport=new StdioClientTransport({command:process.execPath,args:['--require',preload,path.resolve(__dirname,'../../../../bin/direct-commerce-mcp-server.cjs')],stderr:'pipe',env:{...Object.fromEntries(Object.entries(process.env).filter((r):r is[string,string]=>typeof r[1]==='string')),ELECTRON_RUN_AS_NODE:'1',ORKAS_LOCAL_API_PROVIDER:'tiktok_shop',ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,ORKAS_LOCAL_API_METADATA_JSON:JSON.stringify({shop_id:'shop123',region:'us'}),FIXTURE_JOURNAL:journal}});transport.stderr?.on('data',d=>stderr.push(String(d)));await client.connect(transport);return client;}
 const parsed=(r:any)=>JSON.parse(r.content[0].text),call=(client:Client,name:string,action:string,parameters={})=>client.callTool({name,arguments:{action,parameters}});
 try{
  const c=await connect();expect((await c.listTools()).tools).toHaveLength(6);const desc=await c.callTool({name:'describe_action',arguments:{action:'tiktok_shop.post_product_202309_products_product_id_prices_update'}});expect(desc.isError).not.toBe(true);expect(parsed(desc).risk).toBe('H');
  const r=await call(c,'execute_read','tiktok_shop.get_logistics_202309_warehouses');expect(r.isError).not.toBe(true);expect(parsed(r).result.data.data.warehouses[0].id).toBe('100');
  const p={path:{product_id:'123'},body:{skus:[{id:'sku1',price:{amount:'12.50',currency:'USD'},external_list_prices:[{source:'SHOPIFY_COMPARE_AT_PRICE',amount:'20.00',currency:'USD'}]}]}};
  expect((await call(c,'execute_read','tiktok_shop.post_product_202309_products_product_id_prices_update',p)).isError).toBe(true);const updated=await call(c,'execute_high_impact','tiktok_shop.post_product_202309_products_product_id_prices_update',p);expect(updated.isError).not.toBe(true);expect(parsed(updated).result.status).toBe('accepted');
  const partial=await call(c,'execute_high_impact','tiktok_shop.post_product_202309_products_product_id_inventory_update',{path:{product_id:'123'},body:{skus:[{id:'sku1',inventory:[{warehouse_id:'100',quantity:0}]}]}});expect(partial.isError).toBe(true);expect(parsed(partial).result).toMatchObject({status:'partial_or_failed',data:{data:{errors:[{code:12052990,detail:{sku_id:'sku1'}}]}}});expect(JSON.stringify(partial)).not.toContain('private diagnostic');await c.close();
  const restarted=await connect();expect((await call(restarted,'execute_write','tiktok_shop.post_customer_service_202309_conversations_conversation_id_messages_read',{path:{conversation_id:'c1'}})).isError).not.toBe(true);expect((await call(restarted,'execute_destructive','tiktok_shop.delete_product_202309_products',{body:{product_ids:['123']}})).isError).not.toBe(true);
  expect((await call(restarted,'execute_read','tiktok_shop.get_product_202309_global_products_global_product_id',{path:{global_product_id:'123'}})).isError).toBe(true);expect(codec.readCredentialFile(file,key)).toEqual(grant);expect(fs.readFileSync(journal,'utf8').trim().split('\n').map(l=>JSON.parse(l).method)).toEqual(['GET','GET','POST','POST','POST','DELETE']);expect(stderr).toEqual([]);
 }finally{await Promise.allSettled(clients.map(c=>c.close()));fs.rmSync(dir,{recursive:true,force:true});}
},20000);
