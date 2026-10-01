import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {expect,it} from 'vitest';
const require=createRequire(import.meta.url),codec=require('../../../../bin/local-api-credential-codec.cjs');
// Real MCP transport, grant persistence and restart; only the provider wire is replaced.
it('reads fulfillment data, acknowledges inventory, restarts and enforces deletion lane without replay',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-bc-journey-'));
  const file=path.join(directory,'credentials.enc'),key=crypto.randomBytes(32).toString('base64url'),preload=path.join(directory,'provider.cjs'),journal=path.join(directory,'wire.jsonl');
  const grant={provider:'bigcommerce',access_token:'fixture-bc-token',identity:{binding:'abc123',shop_id:'123'}};codec.writeCredentialFile(file,key,grant);
  fs.writeFileSync(preload,`
    const fs=require('node:fs');
    global.fetch=async(raw,init)=>{
      const url=new URL(raw);fs.appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify({path:url.pathname,method:init.method})+'\\n');
      if(url.origin!=='https://api.bigcommerce.com' || !url.pathname.startsWith('/stores/abc123/') || init.headers['X-Auth-Token']!=='fixture-bc-token')throw new Error('Unexpected wire authority');
      if(url.pathname==='/stores/abc123/v2/orders/123' && init.method==='GET')return new Response(JSON.stringify({id:123,billing_address:{zip:'10001',email:'fixture@example.invalid'}}));
      if(url.pathname==='/stores/abc123/v3/inventory/adjustments/absolute' && init.method==='PUT'){
        if(JSON.parse(init.body).items[0].quantity!==0)throw new Error('Lost zero stock');
        return new Response(JSON.stringify({transaction_id:'tx-1'}));
      }
      if(url.pathname==='/stores/abc123/v3/catalog/products/metafields' && init.method==='POST')return new Response(JSON.stringify({data:[],errors:[{status:422,title:'Fixture refusal'}],meta:{total:1,success:0,failed:1}}),{status:422});
      if(url.pathname==='/stores/abc123/v3/catalog/products/123' && init.method==='DELETE')return new Response(null,{status:204});
      throw new Error('Unexpected merchant operation');
    };
  `);
  const clients:Client[]=[],stderr:string[]=[];
  async function connect(){
    const client=new Client({name:'bc-business-journey',version:'1'});clients.push(client);
    const transport=new StdioClientTransport({command:process.execPath,args:['--require',preload,path.resolve(__dirname,'../../../../bin/direct-commerce-mcp-server.cjs')],stderr:'pipe',env:{
      ...Object.fromEntries(Object.entries(process.env).filter((row):row is [string,string]=>typeof row[1]==='string')),ELECTRON_RUN_AS_NODE:'1',ORKAS_LOCAL_API_PROVIDER:'bigcommerce',ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,ORKAS_LOCAL_API_METADATA_JSON:JSON.stringify({store_hash:'abc123'}),FIXTURE_JOURNAL:journal}});
    transport.stderr?.on('data',data=>stderr.push(String(data)));await client.connect(transport);return client;
  }
  const parsed=(result:any)=>JSON.parse(result.content[0].text);
  try{
    const client=await connect();
    const description=await client.callTool({name:'describe_action',arguments:{action:'GET /v2/orders/{order_id}'}});expect(description.isError).not.toBe(true);expect(parsed(description).input_schema.properties.query.properties.consignment_structure).toBeTruthy();
    const read=await client.callTool({name:'execute_read',arguments:{action:'GET /v2/orders/{order_id}',parameters:{path:{order_id:123}}}});expect(read.isError).not.toBe(true);expect(parsed(read).result.data.billing_address.email).toBe('fixture@example.invalid');
    const ack=await client.callTool({name:'execute_high_impact',arguments:{action:'PUT /v3/inventory/adjustments/absolute',parameters:{body:{items:[{location_id:1,variant_id:2,quantity:0}]}}}});expect(ack.isError).not.toBe(true);expect(parsed(ack).result).toMatchObject({status:'acknowledged',data:{transaction_id:'tx-1'}});
    const partial=await client.callTool({name:'execute_high_impact',arguments:{action:'POST /v3/catalog/products/metafields',parameters:{body:[{permission_set:'app_only',namespace:'fixture',key:'color',value:'blue',resource_id:123}]}}});expect(partial.isError).toBe(true);expect(parsed(partial).result).toMatchObject({status:'partial_or_failed',data:{error_count:1,meta:{total:1,success:0,failed:1}}});await client.close();
    const restarted=await connect(),args={action:'DELETE /v3/catalog/products/{product_id}',parameters:{path:{product_id:123}}};
    expect((await restarted.callTool({name:'execute_read',arguments:args})).isError).toBe(true);
    const removed=await restarted.callTool({name:'execute_destructive',arguments:args});expect(removed.isError).not.toBe(true);expect(parsed(removed).result).toEqual({data:null,status:'acknowledged'});
    expect(codec.readCredentialFile(file,key)).toEqual(grant);expect(fs.readFileSync(journal,'utf8').trim().split('\n').map(line=>JSON.parse(line).method)).toEqual(['GET','PUT','POST','DELETE']);expect(stderr).toEqual([]);
  }finally{await Promise.allSettled(clients.map(client=>client.close()));fs.rmSync(directory,{recursive:true,force:true});}
},20000);
