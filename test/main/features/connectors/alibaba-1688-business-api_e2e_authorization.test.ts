import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {expect,it} from 'vitest';
const require=createRequire(import.meta.url),codec=require('../../../../bin/local-api-credential-codec.cjs');
it('preserves the 1688 seller grant, full order fields and partial inventory receipts through real MCP restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-1688-journey-')),file=path.join(dir,'grant.enc'),key=crypto.randomBytes(32).toString('base64url'),preload=path.join(dir,'provider.cjs'),journal=path.join(dir,'wire.jsonl');
 const grant={provider:'alibaba_1688',app_key:'123456',app_secret:'fixture-secret',access_token:'fixture-access',refresh_token:'fixture-refresh',expires_at:Date.now()+3600000,identity:{member_id:'seller1',ali_id:'100',login_id:'fixture'}};codec.writeCredentialFile(file,key,grant);
 fs.writeFileSync(preload,`
 const fs=require('node:fs'),crypto=require('node:crypto');global.fetch=async(raw,init)=>{const u=new URL(raw),form=new URLSearchParams(init.body),method=u.pathname.split('/').at(-2);if(u.origin!=='https://gw.open.1688.com'||form.get('access_token')!=='fixture-access'||init.method!=='POST'||init.redirect!==(method==='alibaba.account.basic'?'manual':'error'))throw Error('Wrong merchant authority');const sign=form.get('_aop_signature');form.delete('_aop_signature');const signed=u.pathname.slice('/openapi/'.length)+[...form].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>k+v).join('');if(sign!==crypto.createHmac('sha1','fixture-secret').update(signed).digest('hex').toUpperCase())throw Error('Wrong signature');fs.appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify({method})+'\\n');let data;
 if(method==='alibaba.account.basic')data={success:true,result:{memberId:'seller1',loginId:'fixture'}};
 else if(method==='alibaba.product.get'){if(form.get('webSite')!=='1688'||form.get('scene')!=='1688')throw Error('Wrong site');data={productInfo:{productID:'9223372036854775807',subject:'Fixture'}};}
 else if(method==='alibaba.trade.getSellerOrderList'){if(form.get('needBuyerAddressAndPhone')!=='true')throw Error('Lost order field');data={success:true,result:[{baseInfo:{id:10,sellerID:'seller1',buyerContact:{email:'buyer@example.test'},remark:'Business memo'}}]};}
 else if(method==='alibaba.product.modifyStock'){const rows=JSON.parse(form.get('productStockChange'));if(rows[0].productId!==11||rows[1].productId!==12)throw Error('Lost stock targets');data={success:true,result:[{productId:11,result:true},{productId:12,result:false,code:'DENIED',desc:'private diagnostic'}]};}
 else throw Error('Unexpected method');return new Response(JSON.stringify(data));};`);
 const clients:Client[]=[],stderr:string[]=[];async function connect(){const client=new Client({name:'1688-journey',version:'1'});clients.push(client);const t=new StdioClientTransport({command:process.execPath,args:['--require',preload,path.resolve(__dirname,'../../../../bin/direct-commerce-mcp-server.cjs')],stderr:'pipe',env:{...Object.fromEntries(Object.entries(process.env).filter((r):r is[string,string]=>typeof r[1]==='string')),ELECTRON_RUN_AS_NODE:'1',ORKAS_LOCAL_API_PROVIDER:'alibaba_1688',ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,ORKAS_LOCAL_API_METADATA_JSON:'{}',FIXTURE_JOURNAL:journal}});t.stderr?.on('data',d=>stderr.push(String(d)));await client.connect(t);return client;}
 const parsed=(r:any)=>JSON.parse(r.content[0].text),call=(c:Client,name:string,action:string,parameters={})=>c.callTool({name,arguments:{action,parameters}});
 try{const c=await connect();expect((await c.listTools()).tools).toHaveLength(6);
 expect((await c.callTool({name:'describe_action',arguments:{action:'products.update'}})).isError).toBe(true);expect((await call(c,'execute_high_impact','products.update',{product_id:'1',subject:'Unqualified'})).isError).toBe(true);
 const product='api.com.alibaba.product.alibaba.product.get.v1';expect((await c.callTool({name:'describe_action',arguments:{action:product}})).isError).not.toBe(true);
 const read=await call(c,'execute_read',product,{productID:'9223372036854775807'});expect(read.isError).not.toBe(true);expect(parsed(read).result.data.productInfo.productID).toBe('9223372036854775807');
 const orders=await call(c,'execute_read','api.com.alibaba.trade.alibaba.trade.getSellerOrderList.v1',{needBuyerAddressAndPhone:true});expect(orders.isError).not.toBe(true);expect(parsed(orders).result.data.result[0].baseInfo.buyerContact.email).toBe('buyer@example.test');
 const stock='api.com.alibaba.product.alibaba.product.modifyStock.v1',p={productStockChange:[{productId:'11',productAmountChange:1,skuStocks:[]},{productId:'12',productAmountChange:1,skuStocks:[]}]};expect((await call(c,'execute_read',stock,p)).isError).toBe(true);
 const write=await call(c,'execute_high_impact',stock,p);expect(write.isError).toBe(true);expect(parsed(write).result).toMatchObject({status:'partial_or_failed',data:{result:[{productId:11,result:true},{productId:12,result:false,code:'DENIED'}]}});expect(JSON.stringify(write)).not.toContain('private diagnostic');await c.close();
 const restarted=await connect();expect((await call(restarted,'execute_read',product,{productID:'9223372036854775807'})).isError).not.toBe(true);expect(codec.readCredentialFile(file,key)).toEqual(grant);
 expect(fs.readFileSync(journal,'utf8').trim().split('\n').map(l=>JSON.parse(l)).filter(r=>r.method==='alibaba.product.modifyStock')).toHaveLength(1);expect(stderr).toEqual([]);
 }finally{await Promise.allSettled(clients.map(c=>c.close()));fs.rmSync(dir,{recursive:true,force:true});}
},20000);
