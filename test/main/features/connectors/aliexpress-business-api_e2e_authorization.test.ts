import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {expect,it} from 'vitest';
import {findCatalogEntry} from '../../../../src/main/features/connectors/catalog';
const require=createRequire(import.meta.url),codec=require('../../../../bin/local-api-credential-codec.cjs');
it('uses an encrypted existing seller grant for native reads, confirmed stock, partial batches and destructive receipts across restart',async()=>{
 const card=findCatalogEntry('aliexpress-seller')!;expect(card.allowed_tools).toContain('execute_destructive');expect(card.tool_policies?.execute_destructive).toMatchObject({risk:'D',confirmation:'destructive'});
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-aliexpress-native-')),file=path.join(dir,'grant.enc'),key=crypto.randomBytes(32).toString('base64url'),preload=path.join(dir,'provider.cjs'),state=path.join(dir,'state.json'),journal=path.join(dir,'journal.jsonl');
 const credentials={provider:'aliexpress',app_key:'fixture-app',app_secret:'fixture-secret',access_token:'fixture-token',refresh_token:'fixture-refresh',seller_id:'123',expires_at:Date.now()+3600000,refresh_expires_at:Date.now()+7200000,identity:{seller_id:'123',shop_id:'456',app_fingerprint:crypto.createHash('sha256').update('fixture-app').digest('hex')}};codec.writeCredentialFile(file,key,credentials);fs.writeFileSync(state,JSON.stringify({quantity:7,online:[],deleted:[]}));
 fs.writeFileSync(preload,`
 const fs=require('node:fs'),crypto=require('node:crypto');global.fetch=async(raw,init)=>{
  if(String(raw)!=='https://api-sg.aliexpress.com/sync')throw Error('Wrong merchant origin');
  const p=new URLSearchParams(init.body),method=p.get('method');if(p.get('session')!=='fixture-token'||p.get('simplify')!==(method==='aliexpress.solution.merchant.profile.get'?'false':'true'))throw Error('Wrong seller token or response protocol');
  const signed=Object.fromEntries(p),sign=crypto.createHmac('sha256','fixture-secret').update(Object.keys(signed).filter(k=>k!=='sign').sort().map(k=>k+signed[k]).join('')).digest('hex').toUpperCase();if(p.get('sign')!==sign)throw Error('Wrong merchant signature');
  fs.appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify({method})+'\\n');const state=JSON.parse(fs.readFileSync(process.env.FIXTURE_STATE,'utf8'));const reply=x=>new Response(JSON.stringify({code:'0',...x}));
  if(method==='aliexpress.solution.merchant.profile.get')return reply({aliexpress_solution_merchant_profile_get_response:{shop_id:456,shop_name:'Fixture shop'}});
  if(method==='aliexpress.merchant.profile.get')return reply({profile:{seller_id:'123',country:'CN'}});
  if(method==='aliexpress.offer.product.query'){if(p.get('product_id')!=='9007199254740993')throw Error('Rounded or changed product');return new Response('{"code":"0","result":{"product_id":9007199254740993,"aeop_ae_product_s_k_us":[{"id":"<none>","ipm_sku_stock":'+state.quantity+'}],"contact":{"email":"buyer@example.test"}}}');}
  if(method==='aliexpress.postproduct.redefining.editsingleskustock'){if(p.get('product_id')!=='9007199254740993'||p.get('sku_id')!=='<none>')throw Error('Wrong stock target');state.quantity=Number(p.get('ipm_sku_stock'));fs.writeFileSync(process.env.FIXTURE_STATE,JSON.stringify(state));return reply({result:{success:true,modify_count:1,product_id:'9007199254740993'}});}
  if(method==='aliexpress.postproduct.redefining.onlineaeproduct'){if(p.get('product_ids')!=='11;12')throw Error('Wrong product batch');state.online.push('11');fs.writeFileSync(process.env.FIXTURE_STATE,JSON.stringify(state));return reply({result:{success:true,modify_count:1,product_id:11,error_details:[{product_ids:[12],error_code:'FAIL',error_message:'private provider detail'}]}});}
  if(method==='aliexpress.offer.product.delete'){if(p.get('product_id')!=='11')throw Error('Wrong deletion');state.deleted.push('11');fs.writeFileSync(process.env.FIXTURE_STATE,JSON.stringify(state));return reply({product_id:11});}
  throw Error('Unexpected merchant request');
 };`);
 const clients:Client[]=[],stderr:string[]=[];const parse=(r:any)=>JSON.parse(r.content[0].text);
 const connect=async()=>{const c=new Client({name:'aliexpress-native',version:'1'});clients.push(c);const t=new StdioClientTransport({command:process.execPath,args:['--require',preload,path.resolve(__dirname,'../../../../bin/direct-commerce-mcp-server.cjs')],stderr:'pipe',env:{...Object.fromEntries(Object.entries(process.env).filter((x):x is [string,string]=>typeof x[1]==='string')),ELECTRON_RUN_AS_NODE:'1',ORKAS_LOCAL_API_PROVIDER:'aliexpress',ORKAS_LOCAL_API_METADATA_JSON:'{}',ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,FIXTURE_STATE:state,FIXTURE_JOURNAL:journal}});t.stderr?.on('data',x=>stderr.push(String(x)));await c.connect(t);return c;};
 try{
  const c=await connect();expect((await c.listTools()).tools).toHaveLength(6);expect(parse(await c.callTool({name:'list_capabilities',arguments:{}})).actions).toHaveLength(221);
  const described=parse(await c.callTool({name:'describe_action',arguments:{action:'aliexpress.postproduct.redefining.findproductinfolistquery'}}));expect(described.input_schema.properties.aeop_a_e_product_list_query.properties).toHaveProperty('audit_failure_reason');
  const read=await c.callTool({name:'execute_read',arguments:{action:'aliexpress.offer.product.query',parameters:{product_id:'9007199254740993'}}});expect(read.isError).not.toBe(true);expect(parse(read).result.data.result).toMatchObject({product_id:'9007199254740993',contact:{email:'buyer@example.test'}});
  const parameters={product_id:'9007199254740993',sku_id:'<none>',ipm_sku_stock:0};expect((await c.callTool({name:'execute_read',arguments:{action:'aliexpress.postproduct.redefining.editsingleskustock',parameters}})).isError).toBe(true);
  const changed=await c.callTool({name:'execute_high_impact',arguments:{action:'aliexpress.postproduct.redefining.editsingleskustock',parameters}});expect(changed.isError).not.toBe(true);expect(JSON.parse(fs.readFileSync(state,'utf8')).quantity).toBe(0);
  const partial=await c.callTool({name:'execute_high_impact',arguments:{action:'aliexpress.postproduct.redefining.onlineaeproduct',parameters:{product_ids:'11;12'}}});expect(partial.isError).toBe(true);expect(parse(partial).result.status).toBe('partial_or_failed');expect(JSON.stringify(partial)).not.toContain('private provider detail');
  expect((await c.callTool({name:'execute_high_impact',arguments:{action:'aliexpress.offer.product.delete',parameters:{product_id:11}}})).isError).toBe(true);const deleted=await c.callTool({name:'execute_destructive',arguments:{action:'aliexpress.offer.product.delete',parameters:{product_id:11}}});expect(deleted.isError).not.toBe(true);
  await c.close();const resumed=await connect();const after=await resumed.callTool({name:'execute_read',arguments:{action:'aliexpress.offer.product.query',parameters:{product_id:'9007199254740993'}}});expect(parse(after).result.data.result.aeop_ae_product_s_k_us[0].ipm_sku_stock).toBe(0);
  expect(JSON.parse(fs.readFileSync(state,'utf8'))).toEqual({quantity:0,online:['11'],deleted:['11']});const calls=fs.readFileSync(journal,'utf8').trim().split('\n').map(x=>JSON.parse(x));for(const method of ['aliexpress.postproduct.redefining.editsingleskustock','aliexpress.postproduct.redefining.onlineaeproduct','aliexpress.offer.product.delete'])expect(calls.filter(x=>x.method===method)).toHaveLength(1);expect(stderr).toEqual([]);expect(JSON.stringify([read,changed,partial,deleted,after])).not.toContain('fixture-token');expect(fs.readFileSync(file,'utf8')).not.toContain('fixture-secret');
 }finally{await Promise.allSettled(clients.map(c=>c.close()));fs.rmSync(dir,{recursive:true,force:true});}
},15000);
