import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
const require=createRequire(import.meta.url),codec=require('../../../../bin/local-api-credential-codec.cjs');
// Real encrypted grant, MCP subprocess and restart. Only provider IO is replaced;
// exact journal assertions expose unauthorized lanes, wrong hosts and retries.
it('uses the bound WooCommerce grant across fulfillment, shipping replacement and partial destructive batch after restart',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-woo-journey-')),file=path.join(dir,'grant.enc'),key=crypto.randomBytes(32).toString('base64url'),preload=path.join(dir,'provider.cjs'),journal=path.join(dir,'wire.jsonl');
  const grant={provider:'woocommerce',consumer_key:'ck_'+'a'.repeat(40),consumer_secret:'cs_'+'b'.repeat(40)};codec.writeCredentialFile(file,key,grant);
  fs.writeFileSync(preload,`
    const fs=require('node:fs');global.fetch=async(raw,init)=>{
      const url=new URL(raw);if(url.origin!=='https://shop.example.com'||!url.pathname.startsWith('/store/wp-json/wc/v3/')||init.headers.authorization!=='Basic '+Buffer.from('ck_'+'a'.repeat(40)+':cs_'+'b'.repeat(40)).toString('base64'))throw new Error('Unexpected store or authority');
      fs.appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify({path:url.pathname,method:init.method,body:init.body&&JSON.parse(init.body)})+'\\n');
      if(url.pathname.endsWith('/system_status'))return new Response(JSON.stringify({environment:{site_url:'https://shop.example.com/store',version:'11.1.2'}}));
      if(url.pathname.endsWith('/orders')&&init.method==='GET')return new Response(JSON.stringify([{id:723,billing:{email:'buyer@example.invalid'},shipping:{address_1:'Example Street'},line_items:[{id:449,quantity:2}]}]),{headers:{'x-wp-total':'1','x-wp-totalpages':'1'}});
      if(url.pathname.endsWith('/shipping/zones/5/locations')&&init.method==='PUT'){if(init.body!=='[]')throw new Error('Expected explicit clear');return new Response('[]');}
      if(url.pathname.endsWith('/taxes/batch')&&init.method==='POST')return new Response(JSON.stringify({update:[{id:12,error:{code:'invalid_tax',message:'private message',data:{status:400}}}],delete:[{id:13}]}));
      throw new Error('Unexpected operation');
    };
  `);
  const clients:Client[]=[],stderr:string[]=[];async function connect(){const client=new Client({name:'woocommerce-merchant-journey',version:'1'});clients.push(client);const transport=new StdioClientTransport({command:process.execPath,args:['--require',preload,path.resolve(__dirname,'../../../../bin/direct-commerce-mcp-server.cjs')],stderr:'pipe',env:{...Object.fromEntries(Object.entries(process.env).filter((row):row is [string,string]=>typeof row[1]==='string')),ELECTRON_RUN_AS_NODE:'1',ORKAS_LOCAL_API_PROVIDER:'woocommerce',ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,ORKAS_LOCAL_API_METADATA_JSON:JSON.stringify({store_url:'https://shop.example.com/store'}),FIXTURE_JOURNAL:journal}});transport.stderr?.on('data',data=>stderr.push(String(data)));await client.connect(transport);return client;}
  const read=(result:any)=>JSON.parse(result.content[0].text);
  try{
    const client=await connect(),tools=await client.listTools();expect(tools.tools).toHaveLength(6);expect(JSON.stringify(tools)).not.toContain('global_unique_id');
    const describe=await client.callTool({name:'describe_action',arguments:{action:'PUT /products/{id}'}});expect(describe.isError).not.toBe(true);expect(read(describe).input_schema.properties.body.properties.global_unique_id).toBeTruthy();
    const order=await client.callTool({name:'execute_read',arguments:{action:'GET /orders',parameters:{query:{status:['processing']}}}});expect(order.isError).not.toBe(true);expect(read(order).result.data[0]).toMatchObject({billing:{email:'buyer@example.invalid'},shipping:{address_1:'Example Street'}});
    const ack=await client.callTool({name:'execute_high_impact',arguments:{action:'PUT /shipping/zones/{id}/locations',parameters:{path:{id:5},body:[]}}});expect(ack.isError).not.toBe(true);expect(read(ack).result.status).toBe('acknowledged');await client.close();
    const restarted=await connect(),parameters={body:{update:[{id:12,rate:'8.5'}],delete:[13]}},denied=await restarted.callTool({name:'execute_read',arguments:{action:'POST /taxes/batch',parameters}});expect(denied.isError).toBe(true);
    const batch=await restarted.callTool({name:'execute_destructive',arguments:{action:'POST /taxes/batch',parameters}});expect(batch.isError).toBe(true);expect(read(batch).result.status).toBe('partial_or_failed');expect(read(batch).result.data.delete).toEqual([{id:13}]);
    expect(fs.readFileSync(journal,'utf8').trim().split('\n').map(line=>JSON.parse(line).method)).toEqual(['GET','GET','PUT','POST']);expect(stderr).toEqual([]);expect(codec.readCredentialFile(file,key)).toEqual(grant);expect(JSON.stringify([order,ack,batch])).not.toContain(grant.consumer_secret);
  }finally{await Promise.allSettled(clients.map(client=>client.close()));fs.rmSync(dir,{recursive:true,force:true});}
},20000);
