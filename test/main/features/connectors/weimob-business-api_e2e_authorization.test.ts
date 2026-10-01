import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {expect,it} from 'vitest';
const require=createRequire(import.meta.url),codec=require('../../../../bin/local-api-credential-codec.cjs');
it('runs WOS through real MCP discovery, complete fields, four risk lanes and restart persistence',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-weimob-journey-')),file=path.join(dir,'grant.enc'),key=crypto.randomBytes(32).toString('base64url'),preload=path.join(dir,'provider.cjs'),journal=path.join(dir,'wire.jsonl');
 const grant={provider:'weimob_wos',client_id:'fixture-client',client_secret:'fixture-private-secret',access_token:'fixture-private-access',expires_at:Date.now()+3600000,identity:{business_operation_system_id:'9007199254740993',public_account_id:'789',business_id:'456'}};codec.writeCredentialFile(file,key,grant);
 fs.writeFileSync(preload,`
 const fs=require('node:fs');global.fetch=async(raw,init)=>{const u=new URL(raw),p=JSON.parse(init.body);if(u.origin!=='https://dopen.weimob.com'||u.searchParams.get('accesstoken')!=='fixture-private-access'||init.method!=='POST')throw Error('Unbound request');fs.appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify({path:u.pathname,body:init.body})+'\\n');const reply=data=>new Response(JSON.stringify({code:{errcode:'0',errmsg:'private diagnostic'},data}));
 if(u.pathname==='/apigw/bos/v2.0/organization/getList')return reply({list:[{vid:123,name:'Shop'}]});
 if(u.pathname==='/apigw/bos/v2.0/info/get')return new Response('{"code":{"errcode":"0"},"data":{"bosId":9007199254740993,"bosName":"Shop"}}');
 if(u.pathname==='/apigw/weimob_shop/v2.0/order/detail/get'){if(!init.body.includes('"orderNo":9007199254740993'))throw Error('Rounded ID');return reply({orderInfo:{orderFulfill:{receiverInfo:{phone:'0101',address:'Dock'}}},buyerMessage:'Leave at reception'});}
 if(u.pathname==='/apigw/weimob_shop/v2.0/order/flag/update'){if(p.flagContent!=='Packed')throw Error('Lost note');return reply({success:true});}
 if(u.pathname==='/apigw/weimob_shop/v2.0/goods/price/update')return reply({success:true});
 if(u.pathname==='/apigw/weimob_shop/v2.0/stock/update')return reply({failList:[{goodsId:1,skuIdSet:[2],message:'private provider failure'}]});
 if(u.pathname==='/apigw/weimob_shop/v2.0/goods/delete')return reply({returnResult:true});throw Error('Unexpected request');};`);
 const clients:Client[]=[],stderr:string[]=[];async function connect(){const client=new Client({name:'weimob-merchant-journey',version:'1'});clients.push(client);const transport=new StdioClientTransport({command:process.execPath,args:['--require',preload,path.resolve(__dirname,'../../../../bin/direct-commerce-mcp-server.cjs')],stderr:'pipe',env:{...Object.fromEntries(Object.entries(process.env).filter((x):x is[string,string]=>typeof x[1]==='string')),ELECTRON_RUN_AS_NODE:'1',ORKAS_LOCAL_API_PROVIDER:'weimob_wos',ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,ORKAS_LOCAL_API_METADATA_JSON:JSON.stringify({shop_id:'9007199254740993',shop_type:'business_operation_system_id'}),FIXTURE_JOURNAL:journal}});transport.stderr?.on('data',data=>stderr.push(String(data)));await client.connect(transport);return client;}
 const read=(r:any)=>JSON.parse(r.content[0].text);
 try{const client=await connect();expect((await client.listTools()).tools).toHaveLength(6);const directory=read(await client.callTool({name:'list_capabilities',arguments:{}}));expect(directory.actions).toHaveLength(573);expect(JSON.stringify(directory)).not.toContain('input_schema');expect(directory.actions.some((x:any)=>x.action==='bos.wechat.ticket.get')).toBe(false);expect(read(await client.callTool({name:'describe_action',arguments:{action:'weimob_shop.goods.create'}})).input_schema.properties.goodsCertificateInfoDTO).toBeDefined();
 const order=await client.callTool({name:'execute_read',arguments:{action:'weimob_shop.order.detail.get',parameters:{orderNo:'9007199254740993'}}});expect(order.isError).not.toBe(true);expect(read(order).result.data.data.orderInfo.orderFulfill.receiverInfo.address).toBe('Dock');
 const note={action:'weimob_shop.order.flag.update',parameters:{orderNos:[1],flagContent:'Packed'}};expect((await client.callTool({name:'execute_read',arguments:note})).isError).toBe(true);expect((await client.callTool({name:'execute_write',arguments:note})).isError).not.toBe(true);
 const price={action:'weimob_shop.goods.price.update',parameters:{goodsId:1,basicInfo:{vid:123},skuList:[{skuId:2,salePrice:12.35}]}};expect((await client.callTool({name:'execute_write',arguments:price})).isError).toBe(true);expect((await client.callTool({name:'execute_high_impact',arguments:price})).isError).not.toBe(true);await client.close();const restarted=await connect();
 const partial=await restarted.callTool({name:'execute_high_impact',arguments:{action:'weimob_shop.stock.update',parameters:{basicInfo:{vid:123},goodsList:[{goodsId:1,skuList:[{skuId:2,stockNum:1}]}],quantityEditType:0}}});expect(partial.isError).toBe(true);expect(read(partial).result.status).toBe('partial_or_failed');expect(JSON.stringify(partial)).not.toContain('private provider failure');
 const remove={action:'weimob_shop.goods.delete',parameters:{goodsIdList:[1],basicInfo:{vid:123}}};expect((await restarted.callTool({name:'execute_high_impact',arguments:remove})).isError).toBe(true);expect((await restarted.callTool({name:'execute_destructive',arguments:remove})).isError).not.toBe(true);
 const calls=fs.readFileSync(journal,'utf8').trim().split('\n').map(line=>JSON.parse(line).path);expect(calls.filter((x:string)=>!x.startsWith('/apigw/bos/'))).toEqual(['/apigw/weimob_shop/v2.0/order/detail/get','/apigw/weimob_shop/v2.0/order/flag/update','/apigw/weimob_shop/v2.0/goods/price/update','/apigw/weimob_shop/v2.0/stock/update','/apigw/weimob_shop/v2.0/goods/delete']);expect(codec.readCredentialFile(file,key)).toEqual(grant);expect(stderr).toEqual([]);expect(JSON.stringify([order,partial])).not.toContain('fixture-private-access');
 }finally{await Promise.allSettled(clients.map(c=>c.close()));fs.rmSync(dir,{recursive:true,force:true});}
},20000);
