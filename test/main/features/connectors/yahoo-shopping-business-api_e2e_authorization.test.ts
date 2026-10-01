import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {expect,it} from 'vitest';
const require=createRequire(import.meta.url),codec=require('../../../../bin/local-api-credential-codec.cjs');
// Real MCP child, encrypted grants and persisted merchant journal. HTTP alone is mocked;
// the final stock state and receipts reveal lost/duplicated writes across reconnects.
it('executes Yahoo merchant reads, exact stock deltas and partial destructive batches through six authorized MCP tools',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-yahoo-native-')),file=path.join(dir,'grant.enc'),key=crypto.randomBytes(32).toString('base64url'),preload=path.join(dir,'provider.cjs'),state=path.join(dir,'state.json'),journal=path.join(dir,'journal.jsonl');
 const metadata={seller_id:'fixture-store'};const credentials:any={provider:'yahoo_shopping',client_id:'fixture-client',client_secret:'fixture-secret',access_token:'fixture-token',refresh_token:'fixture-refresh',expires_at:Date.now()+3600000};credentials.identity={fingerprint:crypto.createHash('sha256').update(JSON.stringify([metadata.seller_id,'',credentials.client_id,credentials.client_secret,''])).digest('hex')};codec.writeCredentialFile(file,key,credentials);fs.writeFileSync(state,JSON.stringify({quantity:4}));
 fs.writeFileSync(preload,`
 const fs=require('node:fs');global.fetch=async(raw,init)=>{
  const url=new URL(raw);if(url.origin!=='https://circus.shopping.yahooapis.jp'||init.headers.authorization!=='Bearer fixture-token')throw Error('Wrong merchant binding');
  fs.appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify({route:url.pathname,method:init.method,time:Date.now()})+'\\n');
  const form=new URLSearchParams(init.body);const state=JSON.parse(fs.readFileSync(process.env.FIXTURE_STATE,'utf8'));const xml=(body,status=200)=>new Response(body,{status});
  if(url.pathname.endsWith('/getShopCategory')){if(url.searchParams.get('seller_id')!=='fixture-store')throw Error('Missing seller');return xml('<ResultSet totalResultsAvailable="0" totalResultsReturned="0"/>');}
  if(url.pathname.endsWith('/orderInfo'))return xml('<ResultSet><Result><Status>OK</Status><OrderInfo><OrderId>fixture-store-1</OrderId><BillMailAddress>buyer@example.test</BillMailAddress><Id>9007199254740993</Id></OrderInfo></Result></ResultSet>');
  if(form.get('seller_id')!=='fixture-store')throw Error('Wrong bound seller');
  if(url.pathname.endsWith('/getStock'))return xml('<ResultSet totalResultsAvailable="1" totalResultsReturned="1"><Result><ItemCode>item1</ItemCode><Status>1</Status><AllowOverdraft>1</AllowOverdraft><Quantity>'+state.quantity+'</Quantity></Result></ResultSet>');
  if(url.pathname.endsWith('/setStock')){if(form.get('quantity')!=='+2'||form.get('allow_overdraft')!=='1')throw Error('Wrong stock delta');state.quantity+=2;fs.writeFileSync(process.env.FIXTURE_STATE,JSON.stringify(state));return xml('<ResultSet><Result><ItemCode>item1</ItemCode><Quantity>'+state.quantity+'</Quantity></Result></ResultSet>');}
  if(url.pathname.endsWith('/deleteItemImage'))return xml('<ResultSet totalResultsAvailable="2" okResultsCount="1" ngResultsCount="1"><Result><Id>fixture-store_a</Id><Status>OK</Status></Result><Result><Id>fixture-store_b</Id><Status>NG</Status><Error><Code>img-1</Code><Message>private provider detail</Message></Error></Result></ResultSet>',207);
  throw Error('Unexpected merchant request');
 };`);
 const clients:Client[]=[],stderr:string[]=[];
 const connect=async()=>{const c=new Client({name:'yahoo-native',version:'1'});clients.push(c);const t=new StdioClientTransport({command:process.execPath,args:['--require',preload,path.resolve(__dirname,'../../../../bin/direct-commerce-mcp-server.cjs')],stderr:'pipe',env:{...Object.fromEntries(Object.entries(process.env).filter((x):x is [string,string]=>typeof x[1]==='string')),ELECTRON_RUN_AS_NODE:'1',ORKAS_LOCAL_API_PROVIDER:'yahoo_shopping',ORKAS_LOCAL_API_METADATA_JSON:JSON.stringify(metadata),ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,FIXTURE_STATE:state,FIXTURE_JOURNAL:journal}});t.stderr?.on('data',x=>stderr.push(String(x)));await c.connect(t);return c;};
 const parse=(r:any)=>JSON.parse(r.content[0].text);
 try{
  const c=await connect();expect((await c.listTools()).tools).toHaveLength(6);expect(parse(await c.callTool({name:'list_capabilities',arguments:{}})).actions).toHaveLength(82);
  const described=parse(await c.callTool({name:'describe_action',arguments:{action:'yahoo.v1.editItem'}}));expect(described.input_schema.properties.parameters.properties).toHaveProperty('variation5_free_title');
  const shop=await c.callTool({name:'execute_read',arguments:{action:'yahoo.v1.getShopCategory'}});expect(shop.isError).not.toBe(true);
  const order=await c.callTool({name:'execute_read',arguments:{action:'yahoo.v1.orderInfo',parameters:{body:{Target:{OrderId:'fixture-store-1',Field:['OrderId','BillMailAddress']}}}}});expect(parse(order).result.data.ResultSet.Result.OrderInfo).toMatchObject({BillMailAddress:'buyer@example.test',Id:'9007199254740993'});
  const parameters={parameters:{item_code:'item1',quantity:'+2'}};expect((await c.callTool({name:'execute_read',arguments:{action:'yahoo.v1.setStock',parameters}})).isError).toBe(true);
  const changed=await c.callTool({name:'execute_high_impact',arguments:{action:'yahoo.v1.setStock',parameters}});expect(changed.isError).not.toBe(true);expect(JSON.parse(fs.readFileSync(state,'utf8')).quantity).toBe(6);
  const deletion={parameters:{image_id:'fixture-store_a,fixture-store_b'}};expect((await c.callTool({name:'execute_high_impact',arguments:{action:'yahoo.v1.deleteItemImage',parameters:deletion}})).isError).toBe(true);
  const partial=await c.callTool({name:'execute_destructive',arguments:{action:'yahoo.v1.deleteItemImage',parameters:deletion}});expect(partial.isError).toBe(true);expect(parse(partial).result.status).toBe('partial_or_failed');expect(JSON.stringify(partial)).toContain('fixture-store_b');expect(JSON.stringify(partial)).not.toContain('private provider detail');
  await c.close();const resumed=await connect();const after=await resumed.callTool({name:'execute_read',arguments:{action:'yahoo.v1.getStock',parameters:{parameters:{item_code:'item1'}}}});expect(parse(after).result.data.ResultSet.Result.Quantity).toBe('6');
  const calls=fs.readFileSync(journal,'utf8').trim().split('\n').map(x=>JSON.parse(x));expect(calls.filter(x=>x.route.endsWith('/setStock'))).toHaveLength(1);expect(calls.filter(x=>x.route.endsWith('/deleteItemImage'))).toHaveLength(1);expect(stderr).toEqual([]);expect(JSON.stringify([described,shop,order,changed,partial,after])).not.toContain('fixture-token');expect(fs.readFileSync(file,'utf8')).not.toContain('fixture-secret');
 }finally{await Promise.allSettled(clients.map(c=>c.close()));fs.rmSync(dir,{recursive:true,force:true});}
},20000);
