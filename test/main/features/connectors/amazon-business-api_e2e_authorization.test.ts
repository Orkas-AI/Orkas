import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const codec = require('../../../../bin/local-api-credential-codec.cjs');

// Real stdio child and encrypted grant survive restart; only the external
// provider boundary is replaced. The persisted journal detects replay/no-IO.
it('reads authorized orders, submits inventory, restarts and cancels a listing through the real merchant MCP boundary', async () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-amazon-journey-'));
  const file=path.join(directory,'credentials.enc'),key=crypto.randomBytes(32).toString('base64url');
  const preload=path.join(directory,'provider.cjs'),journal=path.join(directory,'wire.jsonl');
  const grant={provider:'amazon_seller',client_id:'amzn1.application-oa2-client.fixture',client_secret:'fixture-client-secret',refresh_token:'Atzr|fixture-refresh-token-1234567890'};
  codec.writeCredentialFile(file,key,grant);
  fs.writeFileSync(preload, `
    const fs=require('node:fs');
    global.fetch=async(raw,init)=>{
      const url=new URL(raw);
      fs.appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify({path:url.pathname,method:init.method})+'\\n');
      if(url.href==='https://api.amazon.com/auth/o2/token')return new Response(JSON.stringify({access_token:'fixture-lwa-token',expires_in:3600}));
      if(url.origin!=='https://sellingpartnerapi-na.amazon.com' || init.headers['x-amz-access-token']!=='fixture-lwa-token')throw new Error('Unexpected wire authority');
      if(url.pathname==='/orders/2026-01-01/orders/ORDER-1' && init.method==='GET')return new Response(JSON.stringify({order:{orderId:'ORDER-1',createdTime:'2026-09-01T00:00:00Z',lastUpdatedTime:'2026-09-02T00:00:00Z',salesChannel:{channelName:'AMAZON',marketplaceId:'ATVPDKIKX0DER'},orderItems:[],buyer:{buyerEmail:'fixture@example.invalid'},recipient:{deliveryAddress:{phone:'123'}}}}));
      if(url.pathname==='/listings/2021-08-01/items/A1SELLER23456789/SKU-1'){
        if(url.searchParams.get('marketplaceIds')!=='ATVPDKIKX0DER')throw new Error('Unexpected marketplace');
        if(init.method==='PATCH' && JSON.parse(init.body).patches[0].value[0].quantity!==0)throw new Error('Lost zero stock');
        if(['PATCH','DELETE'].includes(init.method))return new Response(JSON.stringify({sku:'SKU-1',status:'ACCEPTED',submissionId:'SUB-'+init.method}));
      }
      throw new Error('Unexpected merchant operation');
    };
  `);
  const clients:Client[]=[],stderr:string[]=[];
  async function connect() {
    const client=new Client({name:'amazon-merchant-journey',version:'1'});clients.push(client);
    const transport=new StdioClientTransport({command:process.execPath,args:['--require',preload,path.resolve(__dirname,'../../../../bin/direct-commerce-mcp-server.cjs')],stderr:'pipe',
      env:{...Object.fromEntries(Object.entries(process.env).filter((row):row is [string,string]=>typeof row[1]==='string')),ELECTRON_RUN_AS_NODE:'1',
        ORKAS_LOCAL_API_PROVIDER:'amazon_seller',ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,
        ORKAS_LOCAL_API_METADATA_JSON:JSON.stringify({marketplace_id:'ATVPDKIKX0DER',seller_id:'A1SELLER23456789',environment:'live'}),FIXTURE_JOURNAL:journal}});
    transport.stderr?.on('data',data=>stderr.push(String(data)));await client.connect(transport);return client;
  }
  const parameters={path:{sellerId:'A1SELLER23456789',sku:'SKU-1'},query:{marketplaceIds:['ATVPDKIKX0DER']}};
  const read=(result:any)=>JSON.parse(result.content[0].text);
  try {
    const client=await connect();
    const described=await client.callTool({name:'describe_action',arguments:{action:'GET /orders/2026-01-01/orders/{orderId}'}});
    expect(described.isError).not.toBe(true);expect(read(described).input_schema.properties.query.properties.includedData).toBeTruthy();
    const result=await client.callTool({name:'execute_read',arguments:{action:'GET /orders/2026-01-01/orders/{orderId}',parameters:{path:{orderId:'ORDER-1'},query:{includedData:['BUYER','RECIPIENT']}}}});
    expect(result.isError).not.toBe(true);expect(read(result).result.data.order).toMatchObject({buyer:{buyerEmail:'fixture@example.invalid'},recipient:{deliveryAddress:{phone:'123'}}});
    const patch={...parameters,body:{productType:'LUGGAGE',patches:[{op:'replace',path:'/attributes/fulfillment_availability',value:[{fulfillment_channel_code:'DEFAULT',quantity:0}]}]}};
    const ack=await client.callTool({name:'execute_high_impact',arguments:{action:'PATCH /listings/2021-08-01/items/{sellerId}/{sku}',parameters:patch}});
    expect(ack.isError).not.toBe(true);expect(read(ack).result.status).toBe('acknowledged');await client.close();
    const restarted=await connect();
    const denied=await restarted.callTool({name:'execute_read',arguments:{action:'DELETE /listings/2021-08-01/items/{sellerId}/{sku}',parameters}});
    expect(denied.isError).toBe(true);
    const deleted=await restarted.callTool({name:'execute_destructive',arguments:{action:'DELETE /listings/2021-08-01/items/{sellerId}/{sku}',parameters}});
    expect(deleted.isError).not.toBe(true);expect(read(deleted).result).toMatchObject({status:'acknowledged',data:{submissionId:'SUB-DELETE'}});
    expect(codec.readCredentialFile(file,key)).toEqual(grant);
    const requests=fs.readFileSync(journal,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    expect(requests.filter(row=>row.path!=='/auth/o2/token').map(row=>row.method)).toEqual(['GET','PATCH','DELETE']);
    expect(requests.filter(row=>row.path==='/auth/o2/token')).toHaveLength(2);
    expect(JSON.stringify([described,result,ack,denied,deleted])).not.toContain('fixture-lwa-token');expect(stderr).toEqual([]);
  } finally {
    await Promise.allSettled(clients.map(client=>client.close()));fs.rmSync(directory,{recursive:true,force:true});
  }
},20000);
