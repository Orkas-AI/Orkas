import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {expect,it} from 'vitest';
const require=createRequire(import.meta.url),codec=require('../../../../bin/local-api-credential-codec.cjs');
it('keeps merchant identity and full fulfillment data through inventory adjustment, restart, partial tax update and destructive sale void',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-lightspeed-journey-')),file=path.join(dir,'grant.enc'),key=crypto.randomBytes(32).toString('base64url'),preload=path.join(dir,'provider.cjs'),journal=path.join(dir,'wire.jsonl');
  const id='550e8400-e29b-41d4-a716-446655440000',other='550e8400-e29b-41d4-a716-446655440001',grant={provider:'lightspeed',access_token:'fixture-lightspeed-token'};codec.writeCredentialFile(file,key,grant);
  fs.writeFileSync(preload,`
    const fs=require('node:fs'),id='${id}',other='${other}';global.fetch=async(raw,init)=>{
      const url=new URL(raw);if(url.origin!=='https://merchant.retail.lightspeed.app'||init.headers.authorization!=='Bearer fixture-lightspeed-token')throw new Error('Unexpected store or authority');
      fs.appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify({path:url.pathname,method:init.method,body:init.body&&JSON.parse(init.body)})+'\\n');
      const reply=(data,status=200)=>new Response(JSON.stringify(data),{status});
      if(url.pathname==='/api/2.0/retailer')return reply({data:{id:'retailer1',domain_prefix:'merchant'}});
      if(url.pathname==='/api/2026-07/sales'&&init.method==='GET')return reply({data:[{id,shipping_address:{email:'buyer@example.invalid',address_line_1:'Example Street'},line_items:[{id:other,quantity:2}]}],version:{min:1,max:2}});
      if(url.pathname==='/api/2026-07/stock_adjustments'&&init.method==='POST'){const items=JSON.parse(init.body).stock_adjustments;if(items.length!==1||items[0].quantity!=='-1')throw new Error('Unexpected adjustment');return reply({data:items.map(x=>({id:'adjustment',...x}))},201);}
      if(url.pathname==='/api/2026-07/customer_taxes/bulk'&&init.method==='POST')return reply({data:{results:{successful:[{index:0,customer_id:id,tax_id:null}],failed:[{index:1,customer_id:other,tax_id:id,errors:[{code:'INVALID_TAX_ID',messages:['private prose']}]}]},summary:{total_processed:2,success_count:1,error_count:1}}},207);
      if(url.pathname==='/api/2026-07/sales/'+id&&init.method==='PUT'){if(JSON.parse(init.body).state!=='voided')throw new Error('Expected explicit void');return reply({data:{id,state:'voided'}});}
      throw new Error('Unexpected operation');
    };
  `);
  const clients:Client[]=[],stderr:string[]=[];async function connect(){const client=new Client({name:'lightspeed-merchant-journey',version:'1'});clients.push(client);const transport=new StdioClientTransport({command:process.execPath,args:['--require',preload,path.resolve(__dirname,'../../../../bin/direct-commerce-mcp-server.cjs')],stderr:'pipe',env:{...Object.fromEntries(Object.entries(process.env).filter((row):row is [string,string]=>typeof row[1]==='string')),ELECTRON_RUN_AS_NODE:'1',ORKAS_LOCAL_API_PROVIDER:'lightspeed',ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,ORKAS_LOCAL_API_METADATA_JSON:JSON.stringify({store_domain:'merchant.retail.lightspeed.app'}),FIXTURE_JOURNAL:journal}});transport.stderr?.on('data',data=>stderr.push(String(data)));await client.connect(transport);return client;}
  const read=(result:any)=>JSON.parse(result.content[0].text);
  try{
    const client=await connect(),tools=await client.listTools();expect(tools.tools).toHaveLength(6);expect(JSON.stringify(tools)).not.toContain('source_breakdown');
    const described=await client.callTool({name:'describe_action',arguments:{action:'PUT /products/{product_id}'}});expect(described.isError).not.toBe(true);expect(read(described).input_schema.$defs.ProductUpdate21Request.properties.details.properties.packaging).toBeTruthy();
    const sales=await client.callTool({name:'execute_read',arguments:{action:'GET /sales',parameters:{query:{page_size:10}}}});expect(sales.isError).not.toBe(true);expect(read(sales).result.data.data[0].shipping_address.email).toBe('buyer@example.invalid');
    const stock=await client.callTool({name:'execute_high_impact',arguments:{action:'POST /stock_adjustments',parameters:{body:{stock_adjustments:[{product_id:id,outlet_id:other,quantity:'-1',reason:'DAMAGE'}]}}}});expect(stock.isError).not.toBe(true);expect(read(stock).result.status).toBe('acknowledged');await client.close();
    const restarted=await connect(),tax={body:{customer_tax:[{customer_id:id,tax_id:null},{customer_id:other,tax_id:id}]}};expect((await restarted.callTool({name:'execute_read',arguments:{action:'POST /customer_taxes/bulk',parameters:tax}})).isError).toBe(true);
    const partial=await restarted.callTool({name:'execute_high_impact',arguments:{action:'POST /customer_taxes/bulk',parameters:tax}});expect(partial.isError).toBe(true);expect(read(partial).result.status).toBe('partial_or_failed');expect(read(partial).result.data.data.results.successful).toHaveLength(1);
    const sale={path:{sale_id:id},body:{source:{author_id:other},state:'voided'}};expect((await restarted.callTool({name:'execute_high_impact',arguments:{action:'PUT /sales/{sale_id}',parameters:sale}})).isError).toBe(true);const voided=await restarted.callTool({name:'execute_destructive',arguments:{action:'PUT /sales/{sale_id}',parameters:sale}});expect(voided.isError).not.toBe(true);expect(read(voided).result.data.data.state).toBe('voided');
    expect(fs.readFileSync(journal,'utf8').trim().split('\n').map(line=>JSON.parse(line).method)).toEqual(['GET','GET','POST','POST','PUT']);expect(stderr).toEqual([]);expect(codec.readCredentialFile(file,key)).toEqual(grant);expect(JSON.stringify([sales,stock,partial,voided])).not.toContain(grant.access_token);
  }finally{await Promise.allSettled(clients.map(client=>client.close()));fs.rmSync(dir,{recursive:true,force:true});}
},20000);
