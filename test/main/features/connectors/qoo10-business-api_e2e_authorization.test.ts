import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {expect,it} from 'vitest';
const require=createRequire(import.meta.url),codec=require('../../../../bin/local-api-credential-codec.cjs');
it('fulfills an order after encrypted-grant restart and exposes partial shipments without bypassing cancellation permission',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-qoo10-journey-')),file=path.join(dir,'grant.enc'),key=crypto.randomBytes(32).toString('base64url'),preload=path.join(dir,'provider.cjs'),journal=path.join(dir,'wire.jsonl');
 const certification='fixture-qoo10-private-key',grant={provider:'qoo10_japan',certification_key:certification,identity:{key_fingerprint:crypto.createHash('sha256').update(certification).digest('hex')}};codec.writeCredentialFile(file,key,grant);
 fs.writeFileSync(preload,`
 const fs=require('node:fs');global.fetch=async(raw,init)=>{const url=new URL(raw),method=url.pathname.split('/').pop(),params=Object.fromEntries(new URLSearchParams(init.body));if(url.origin!=='https://api.qoo10.jp'||init.headers.GiosisCertificationKey!=='${certification}'||url.search)throw new Error('Unexpected authority');fs.appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify({method,params})+'\\n');const reply=(ResultObject)=>new Response(JSON.stringify({ResultCode:0,ResultObject}));
 if(method==='ItemsLookup.GetAllGoodsInfo')return reply({TotalItems:0,TotalPages:0,PresentPage:0,Items:[]});
 if(method==='ShippingBasic.GetShippingInfo_v3')return reply([{OrderNo:1062428737,Receiver:'Buyer',ReceiverTel:'0123',ShippingAddress:'Example Street',ShippingMessage:'Leave at desk'}]);
 if(method==='ItemsContents.EditGoodsContents'){if(params.Contents!=='<p>Linen</p>')throw new Error('Lost product content');return reply();}
 if(method==='ShippingBasic.SetSendingInfoBulk'){const rows=JSON.parse(params.ShippingInfoJson);if(rows[0].OrderNo!=='1062428737'||rows[1].TrackingNo!=='B124')throw new Error('Lost batch fields');return reply([{contr_no:1062428737,result_cd:0},{contr_no:1062428738,result_cd:-10103}]);}
 if(method==='Claim.SetCancelProcess'){if(params.ContrNo!=='1062428738')throw new Error('Wrong order');return reply();}throw new Error('Unexpected request');};
 `);
 const clients:Client[]=[],stderr:string[]=[];async function connect(){const client=new Client({name:'qoo10-merchant-journey',version:'1'});clients.push(client);const transport=new StdioClientTransport({command:process.execPath,args:['--require',preload,path.resolve(__dirname,'../../../../bin/direct-commerce-mcp-server.cjs')],stderr:'pipe',env:{...Object.fromEntries(Object.entries(process.env).filter((row):row is [string,string]=>typeof row[1]==='string')),ELECTRON_RUN_AS_NODE:'1',ORKAS_LOCAL_API_PROVIDER:'qoo10_japan',ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,ORKAS_LOCAL_API_METADATA_JSON:'{}',FIXTURE_JOURNAL:journal}});transport.stderr?.on('data',data=>stderr.push(String(data)));await client.connect(transport);return client;}
 const read=(r:any)=>JSON.parse(r.content[0].text);
 try{
  const client=await connect();expect((await client.listTools()).tools).toHaveLength(6);const directory=await client.callTool({name:'list_capabilities',arguments:{}});expect(directory.isError).not.toBe(true);expect(JSON.stringify(directory)).toContain('ShippingBasic.SetSendingInfoBulk');
  const described=await client.callTool({name:'describe_action',arguments:{action:'ShippingBasic.SetSendingInfoBulk'}});expect(read(described).input_schema.properties.ShippingInfoJson.items.properties.TrackingNo.maxLength).toBe(50);
  const orders=await client.callTool({name:'execute_read',arguments:{action:'ShippingBasic.GetShippingInfo_v3',parameters:{ShippingStatus:'2',SearchStartDate:'20261001',SearchEndDate:'20261001'}}});expect(orders.isError).not.toBe(true);expect(read(orders).result.data.ResultObject[0].ShippingAddress).toBe('Example Street');
  const edit=await client.callTool({name:'execute_high_impact',arguments:{action:'ItemsContents.EditGoodsContents',parameters:{ItemCode:'1234567890',Contents:'<p>Linen</p>'}}});expect(edit.isError).not.toBe(true);await client.close();
  const restarted=await connect(),parameters={ShippingInfoJson:[{OrderNo:'1062428737',ShippingCorp:'Carrier',TrackingNo:'B123'},{OrderNo:'1062428738',ShippingCorp:'Carrier',TrackingNo:'B124'}]};expect((await restarted.callTool({name:'execute_read',arguments:{action:'ShippingBasic.SetSendingInfoBulk',parameters}})).isError).toBe(true);
  const partial=await restarted.callTool({name:'execute_high_impact',arguments:{action:'ShippingBasic.SetSendingInfoBulk',parameters}});expect(partial.isError).toBe(true);expect(read(partial).result.status).toBe('partial_or_failed');expect(read(partial).result.data.ResultObject[0].result_cd).toBe(0);
  const cancel={action:'Claim.SetCancelProcess',parameters:{ContrNo:'1062428738',CancelReason:'3'}};expect((await restarted.callTool({name:'execute_high_impact',arguments:cancel})).isError).toBe(true);expect((await restarted.callTool({name:'execute_destructive',arguments:cancel})).isError).not.toBe(true);
  expect(fs.readFileSync(journal,'utf8').trim().split('\n').map(line=>JSON.parse(line).method)).toEqual(['ItemsLookup.GetAllGoodsInfo','ItemsLookup.GetAllGoodsInfo','ShippingBasic.GetShippingInfo_v3','ItemsContents.EditGoodsContents','ShippingBasic.SetSendingInfoBulk','Claim.SetCancelProcess']);expect(codec.readCredentialFile(file,key)).toEqual(grant);expect(stderr).toEqual([]);expect(JSON.stringify([orders,partial])).not.toContain(certification);
 }finally{await Promise.allSettled(clients.map(c=>c.close()));fs.rmSync(dir,{recursive:true,force:true});}
},20000);
