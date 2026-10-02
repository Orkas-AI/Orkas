import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {expect,it} from 'vitest';
const require=createRequire(import.meta.url),codec=require('../../../../bin/local-api-credential-codec.cjs');
it('preserves JD seller identity, full SKU fields and partial stock receipts across real MCP restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-jd-journey-')),file=path.join(dir,'grant.enc'),key=crypto.randomBytes(32).toString('base64url'),preload=path.join(dir,'provider.cjs'),journal=path.join(dir,'wire.jsonl');
 const grant={provider:'jd_jos',app_key:'fixture-app',app_secret:'fixture-secret',access_token:'fixture-access',refresh_token:'fixture-refresh',expires_at:Date.now()+3600000,identity:{vender_id:'100',shop_id:'200',shop_name:'Fixture'}};codec.writeCredentialFile(file,key,grant);
 fs.writeFileSync(preload,`
 const fs=require('node:fs'),crypto=require('node:crypto');global.fetch=async(raw,init)=>{const u=new URL(raw),form=new URLSearchParams(init.body),method=form.get('method');if(u.href!=='https://api.jd.com/routerjson'||form.get('access_token')!=='fixture-access'||form.get('app_key')!=='fixture-app'||init.method!=='POST')throw Error('Wrong merchant authority');const sign=form.get('sign');form.delete('sign');if(sign!==crypto.createHash('md5').update('fixture-secret'+[...form].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>k+v).join('')+'fixture-secret').digest('hex').toUpperCase())throw Error('Wrong signature');fs.appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify({method})+'\\n');let value;
 if(method==='jingdong.seller.vender.info.get')value={vender_info_result:{vender_id:'100',shop_id:'200',shop_name:'Fixture'}};
 else if(method==='jingdong.sku.read.findSkuById'){if(form.get('360buy_param_json')!=='{"skuId":9007199254740993}')throw Error('Rounded SKU');value={sku:{skuId:'9007199254740993',wareId:1,skuName:'Fixture',customerPhone:'123',message:'Business memo'}};}
 else if(method==='jingdong.ware.stock.sku.set'){const p=JSON.parse(form.get('360buy_param_json'));if(p.req.skuStocks[0].skuId!==11||p.req.skuStocks[1].skuId!==12)throw Error('Lost stock targets');value={returnType:{success:true,obj:{updateStockResult:[{data:'11',success:true,storeId:0},{data:'12',success:false,storeId:0,message:'private diagnostic'}]}}};}
 else throw Error('Unexpected method');return new Response(JSON.stringify({[method.replaceAll('.','_')+'_responce']:value}));};`);
 const clients:Client[]=[],stderr:string[]=[];async function connect(){const client=new Client({name:'jd-journey',version:'1'});clients.push(client);const t=new StdioClientTransport({command:process.execPath,args:['--require',preload,path.resolve(__dirname,'../../../../bin/direct-commerce-mcp-server.cjs')],stderr:'pipe',env:{...Object.fromEntries(Object.entries(process.env).filter((r):r is[string,string]=>typeof r[1]==='string')),ELECTRON_RUN_AS_NODE:'1',ORKAS_LOCAL_API_PROVIDER:'jd_jos',ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,ORKAS_LOCAL_API_METADATA_JSON:'{}',FIXTURE_JOURNAL:journal}});t.stderr?.on('data',d=>stderr.push(String(d)));await client.connect(t);return client;}
 const parsed=(r:any)=>JSON.parse(r.content[0].text),call=(c:Client,name:string,action:string,parameters={})=>c.callTool({name,arguments:{action,parameters}});
 try{const c=await connect();expect((await c.listTools()).tools).toHaveLength(6);
 for(const action of ['orders.list','orders.get','api.jingdong.pop.order.search','api.jingdong.pushChatMessage'])expect((await c.callTool({name:'describe_action',arguments:{action}})).isError).toBe(true);
 const product='api.jingdong.sku.read.findSkuById';expect((await c.callTool({name:'describe_action',arguments:{action:product}})).isError).not.toBe(true);
 const read=await call(c,'execute_read',product,{skuId:'9007199254740993'});expect(read.isError).not.toBe(true);expect(parsed(read).result.data.jingdong_sku_read_findSkuById_responce.sku).toMatchObject({skuId:'9007199254740993',customerPhone:'123',message:'Business memo'});
 const stock='api.jingdong.ware.stock.sku.set',p={req:{updateModel:'fullStockIn',stockRfId:'once',skuStocks:[{skuId:'11',stockNum:2},{skuId:'12',stockNum:3}]}};expect((await call(c,'execute_read',stock,p)).isError).toBe(true);
 const write=await call(c,'execute_high_impact',stock,p);expect(write.isError).toBe(true);expect(parsed(write).result.status).toBe('partial_or_failed');expect(JSON.stringify(write)).not.toContain('private diagnostic');expect(parsed(write).result.data.jingdong_ware_stock_sku_set_responce.returnType.obj.updateStockResult[1].data).toBe('12');await c.close();
 const restarted=await connect();expect((await call(restarted,'execute_read',product,{skuId:'9007199254740993'})).isError).not.toBe(true);expect(codec.readCredentialFile(file,key)).toEqual(grant);
 expect(fs.readFileSync(journal,'utf8').trim().split('\n').map(l=>JSON.parse(l)).filter(r=>r.method==='jingdong.ware.stock.sku.set')).toHaveLength(1);expect(stderr).toEqual([]);
 }finally{await Promise.allSettled(clients.map(c=>c.close()));fs.rmSync(dir,{recursive:true,force:true});}
},20000);
