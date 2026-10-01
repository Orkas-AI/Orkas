import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
const require=createRequire(import.meta.url),codec=require('../../../../bin/local-api-credential-codec.cjs');

// A real child, encrypted rotating grant and restart; only Etsy IO is replaced.
// Journal assertions independently detect wrong authority, repeated writes and
// IO from a denied risk lane. This does not claim live merchant authorization.
it('refreshes Etsy authorization, reads receipts, edits inventory and deletes after restart through the real MCP boundary',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-etsy-journey-')),file=path.join(directory,'credentials.enc'),key=crypto.randomBytes(32).toString('base64url'),preload=path.join(directory,'provider.cjs'),journal=path.join(directory,'wire.jsonl');
  const grant={provider:'etsy',keystring:'etsykeystring123456',shared_secret:'fixture-shared-secret',access_token:'12345.expired',refresh_token:'12345.old-refresh',expires_at:0,scope:'shops_r shops_w listings_r listings_w listings_d transactions_r transactions_w',identity:{shop_id:'67890',user_id:'12345'}};
  codec.writeCredentialFile(file,key,grant);
  fs.writeFileSync(preload,`
    const fs=require('node:fs');
    global.fetch=async(raw,init)=>{
      const url=new URL(raw);fs.appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify({path:url.pathname,method:init.method})+'\\n');
      if(url.href==='https://api.etsy.com/v3/public/oauth/token')return new Response(JSON.stringify({access_token:'12345.rotated-access',refresh_token:'12345.rotated-refresh',expires_in:3600,scope:'shops_r shops_w listings_r listings_w listings_d transactions_r transactions_w'}));
      if(url.origin!=='https://openapi.etsy.com'||init.headers.authorization!=='Bearer 12345.rotated-access'||init.headers['x-api-key']!=='etsykeystring123456:fixture-shared-secret')throw new Error('Unexpected Etsy authority');
      if(url.pathname==='/v3/application/shops/67890/receipts'&&init.method==='GET')return new Response(JSON.stringify({count:1,results:[{receipt_id:101,buyer_email:'fixture@example.invalid',first_line:'Example address'}]}));
      if(url.pathname==='/v3/application/listings/101/inventory'&&init.method==='PUT'){
        if(JSON.parse(init.body).products[0].offerings[0].quantity!==0)throw new Error('Lost zero inventory');
        return new Response(JSON.stringify({products:[{product_id:900,offerings:[{quantity:0}]}]}));
      }
      if(url.pathname==='/v3/application/listings/101'&&init.method==='DELETE')return new Response(null,{status:204});
      throw new Error('Unexpected Etsy operation');
    };
  `);
  const clients:Client[]=[],stderr:string[]=[];
  async function connect(){
    const client=new Client({name:'etsy-merchant-journey',version:'1'});clients.push(client);
    const transport=new StdioClientTransport({command:process.execPath,args:['--require',preload,path.resolve(__dirname,'../../../../bin/direct-commerce-mcp-server.cjs')],stderr:'pipe',env:{...Object.fromEntries(Object.entries(process.env).filter((row):row is [string,string]=>typeof row[1]==='string')),ELECTRON_RUN_AS_NODE:'1',ORKAS_LOCAL_API_PROVIDER:'etsy',ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,ORKAS_LOCAL_API_METADATA_JSON:JSON.stringify({shop_id:'67890'}),FIXTURE_JOURNAL:journal}});
    transport.stderr?.on('data',data=>stderr.push(String(data)));await client.connect(transport);return client;
  }
  const read=(result:any)=>JSON.parse(result.content[0].text);
  try{
    const client=await connect(),described=await client.callTool({name:'describe_action',arguments:{action:'updateListingInventory'}});
    expect(described.isError).not.toBe(true);expect(read(described).input_schema.properties.body.properties.products).toBeTruthy();
    const result=await client.callTool({name:'execute_read',arguments:{action:'getShopReceipts',parameters:{query:{limit:100}}}});
    expect(result.isError).not.toBe(true);expect(read(result).result.data.results[0]).toMatchObject({buyer_email:'fixture@example.invalid',first_line:'Example address'});
    const ack=await client.callTool({name:'execute_high_impact',arguments:{action:'updateListingInventory',parameters:{path:{listing_id:101},body:{products:[{offerings:[{price:12.5,quantity:0,is_enabled:true,readiness_state_id:null}]}]}}}});
    expect(ack.isError).not.toBe(true);expect(read(ack).result.status).toBe('acknowledged');await client.close();
    const restarted=await connect(),denied=await restarted.callTool({name:'execute_read',arguments:{action:'deleteListing',parameters:{path:{listing_id:101}}}});expect(denied.isError).toBe(true);
    const deleted=await restarted.callTool({name:'execute_destructive',arguments:{action:'deleteListing',parameters:{path:{listing_id:101}}}});expect(deleted.isError).not.toBe(true);expect(read(deleted).result).toEqual({data:null,status:'acknowledged'});
    expect(codec.readCredentialFile(file,key)).toMatchObject({access_token:'12345.rotated-access',refresh_token:'12345.rotated-refresh',identity:grant.identity});
    const requests=fs.readFileSync(journal,'utf8').trim().split('\n').map(line=>JSON.parse(line));expect(requests.map(row=>row.method)).toEqual(['POST','GET','PUT','DELETE']);expect(stderr).toEqual([]);expect(JSON.stringify([described,result,ack,denied,deleted])).not.toContain('rotated-access');
  }finally{await Promise.allSettled(clients.map(client=>client.close()));fs.rmSync(directory,{recursive:true,force:true});}
},20000);
