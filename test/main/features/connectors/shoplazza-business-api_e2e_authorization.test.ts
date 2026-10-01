import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {expect,it} from 'vitest';
const require=createRequire(import.meta.url),codec=require('../../../../bin/local-api-credential-codec.cjs');
it('retains the encrypted bound grant across fulfillment, zero-stock and independently persisted theme edits after restart',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-shoplazza-journey-')),file=path.join(dir,'grant.enc'),key=crypto.randomBytes(32).toString('base64url'),preload=path.join(dir,'provider.cjs'),journal=path.join(dir,'wire.jsonl');
  const grant={provider:'shoplazza',access_token:'fixture-shoplazza-token',identity:{binding:'fixture.myshoplaza.com',shop_id:'123'}};codec.writeCredentialFile(file,key,grant);
  fs.writeFileSync(preload,`
    const fs=require('node:fs');global.fetch=async(raw,init)=>{
      const url=new URL(raw);if(url.origin!=='https://fixture.myshoplaza.com'||!url.pathname.startsWith('/openapi/2026-01/')||init.headers['Access-Token']!=='fixture-shoplazza-token')throw new Error('Unexpected store or authority');
      fs.appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify({path:url.pathname,method:init.method,body:init.body&&JSON.parse(init.body)})+'\\n');
      const reply=data=>new Response(JSON.stringify({code:'Success',data}));
      if(url.pathname.endsWith('/shop'))return reply({id:'123',name:'Fixture',system_domain:'fixture.myshoplaza.com'});
      if(url.pathname.endsWith('/orders')&&init.method==='GET')return reply({orders:[{id:'o1',shipping_address:{email:'buyer@example.invalid',address1:'Example Street'},line_items:[{id:'l1',quantity:2}]}],cursor:'after'});
      if(url.pathname.endsWith('/inventory_levels/set')&&init.method==='POST'){if(init.body!=='{"inventory_item_id":"i1","location_id":"l1","stock":0}')throw new Error('Expected zero stock');return reply({inventory_level:{inventory_item_id:'i1',location_id:'l1',stock:0}});}
      if(url.pathname.endsWith('/themes/edit-sessions/e1/files/index/operations')&&init.method==='POST')return reply({data:[{op:'replace_props',result:'success'},{op:'remove_section',result:'Target missing'}]});
      if(url.pathname.endsWith('/webhooks')&&init.method==='GET')return reply({webhooks:[]});
      if(url.pathname.endsWith('/webhooks')&&init.method==='POST')return reply({webhook:{id:'w1',...JSON.parse(init.body).webhook}});
      if(url.pathname.endsWith('/webhooks/w1')&&init.method==='DELETE')return reply({});
      throw new Error('Unexpected operation');
    };
  `);
  const clients:Client[]=[],stderr:string[]=[];async function connect(){const client=new Client({name:'shoplazza-merchant-journey',version:'1'});clients.push(client);const transport=new StdioClientTransport({command:process.execPath,args:['--require',preload,path.resolve(__dirname,'../../../../bin/direct-commerce-mcp-server.cjs')],stderr:'pipe',env:{...Object.fromEntries(Object.entries(process.env).filter((row):row is [string,string]=>typeof row[1]==='string')),ELECTRON_RUN_AS_NODE:'1',ORKAS_LOCAL_API_PROVIDER:'shoplazza',ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,ORKAS_LOCAL_API_METADATA_JSON:JSON.stringify({store_domain:'fixture.myshoplaza.com'}),FIXTURE_JOURNAL:journal}});transport.stderr?.on('data',data=>stderr.push(String(data)));await client.connect(transport);return client;}
  const read=(result:any)=>JSON.parse(result.content[0].text);
  try{
    const client=await connect(),tools=await client.listTools();expect(tools.tools).toHaveLength(6);expect(JSON.stringify(tools)).not.toContain('auto_publish_at');
    const described=await client.callTool({name:'describe_action',arguments:{action:'product-create'}});expect(described.isError).not.toBe(true);expect(read(described).input_schema.$defs['v202506.Product'].properties.auto_publish_at).toBeTruthy();
    const order=await client.callTool({name:'execute_read',arguments:{action:'orders',parameters:{query:{page_size:10}}}});expect(order.isError).not.toBe(true);expect(read(order).result.data.orders[0].shipping_address).toEqual({email:'buyer@example.invalid',address1:'Example Street'});
    const inventory=await client.callTool({name:'execute_high_impact',arguments:{action:'inventory-level-set',parameters:{body:{inventory_item_id:'i1',location_id:'l1',stock:0}}}});expect(inventory.isError).not.toBe(true);expect(read(inventory).result.status).toBe('acknowledged');await client.close();
    const restarted=await connect(),parameters={path:{oseid:'e1',doc_id:'index'},body:{operations:[{op:'replace_props',target:'hero',props:{title:'Hello'}},{op:'remove_section',target:'old'}]}},denied=await restarted.callTool({name:'execute_read',arguments:{action:'theme-edit-session-batch-operations',parameters}});expect(denied.isError).toBe(true);
    const batch=await restarted.callTool({name:'execute_destructive',arguments:{action:'theme-edit-session-batch-operations',parameters}});expect(batch.isError).toBe(true);expect(read(batch).result).toEqual({data:{data:[{op:'replace_props',result:'success'},{op:'remove_section',result:'failed'}]},status:'partial_or_failed'});
    const callback={body:{webhook:{address:'https://merchant.example.com/events',topic:'orders/create'}}};
    expect((await restarted.callTool({name:'execute_read',arguments:{action:'webhooks',parameters:{}}})).isError).not.toBe(true);
    expect((await restarted.callTool({name:'execute_read',arguments:{action:'webhook-create',parameters:callback}})).isError).toBe(true);
    const registered=await restarted.callTool({name:'execute_high_impact',arguments:{action:'webhook-create',parameters:callback}});expect(registered.isError).not.toBe(true);expect(read(registered).result.data.webhook.address).toBe(callback.body.webhook.address);
    expect((await restarted.callTool({name:'execute_high_impact',arguments:{action:'webhook-delete',parameters:{path:{id:'w1'}}}})).isError).toBe(true);
    expect((await restarted.callTool({name:'execute_destructive',arguments:{action:'webhook-delete',parameters:{path:{id:'w1'}}}})).isError).not.toBe(true);
    expect(fs.readFileSync(journal,'utf8').trim().split('\n').map(line=>JSON.parse(line).method)).toEqual(['GET','GET','POST','POST','GET','POST','DELETE']);expect(stderr).toEqual([]);expect(codec.readCredentialFile(file,key)).toEqual(grant);expect(JSON.stringify([order,inventory,batch])).not.toContain(grant.access_token);
  }finally{await Promise.allSettled(clients.map(client=>client.close()));fs.rmSync(dir,{recursive:true,force:true});}
},20000);
